import { createdTableMatcher } from '../analysis/new-tables.ts';
import {
  alterTableCommands,
  columnConstraints,
  relationName,
  stringList,
  type AstNode,
} from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface AddingFieldWithDefaultOptions {
  /**
   * Functions whose results differ per row, so Postgres must rewrite the table
   * to materialize them. A constant or stable default is stored once in the
   * catalog instead.
   */
  volatileFunctions: string[];
  allowOnNewTables: boolean;
}

/** Constant defaults stopped rewriting the table in this release. */
const NON_REWRITING_DEFAULTS_SINCE = 11;

export const addingFieldWithDefault = defineRule<AddingFieldWithDefaultOptions>({
  name: 'adding-field-with-default',
  meta: {
    description: 'Adding a column with a rewriting default locks the table.',
    rationale:
      'Since Postgres 11 a constant default is stored in the catalog rather than written to ' +
      'every row. A volatile default has to be evaluated per row, so the table is rewritten ' +
      'under ACCESS EXCLUSIVE regardless of version.',
    help: 'Add the column without a default, backfill in batches, then set the default.',
    defaultSeverity: 'error',
    defaultOptions: {
      volatileFunctions: [
        'random',
        'clock_timestamp',
        'timeofday',
        'gen_random_uuid',
        'uuid_generate_v1',
        'uuid_generate_v4',
        'nextval',
      ],
      allowOnNewTables: true,
    },
  },
  create(context) {
    const isNewTable = createdTableMatcher(context.source);
    const version = context.settings.targetPostgresVersion;
    const volatile = new Set(context.options.volatileFunctions.map((name) => name.toLowerCase()));

    return {
      AlterTableStmt(node, path) {
        const relation = relationName(node.relation);
        if (context.options.allowOnNewTables && isNewTable(relation)) return;

        for (const command of alterTableCommands(node)) {
          if (command['subtype'] !== 'AT_AddColumn') continue;

          const columnDef = (command['def'] as AstNode)?.['ColumnDef'];
          if (!columnDef) continue;

          const defaults = columnConstraints(columnDef).filter(
            (constraint) => constraint['contype'] === 'CONSTR_DEFAULT',
          );
          if (defaults.length === 0) continue;

          const column = String(columnDef['colname'] ?? 'the new column');

          if (version < NON_REWRITING_DEFAULTS_SINCE) {
            context.report({
              statement: path.statement,
              message: `On Postgres ${version}, adding column ${column} with a default rewrites the whole table under ACCESS EXCLUSIVE.`,
            });
            continue;
          }

          const culprit = defaults
            .flatMap((constraint) => calledFunctions(constraint['raw_expr']))
            .find((name) => volatile.has(name));

          if (!culprit) continue;

          context.report({
            statement: path.statement,
            message: `Column ${column} defaults to ${culprit}(), which is evaluated per row and rewrites the whole table under ACCESS EXCLUSIVE.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t ADD COLUMN c int;',
      {
        name: 'a constant default is stored in the catalog on Postgres 11+',
        sql: 'ALTER TABLE t ADD COLUMN c int DEFAULT 0;',
      },
      {
        name: 'a stable default is evaluated once',
        sql: 'ALTER TABLE t ADD COLUMN c timestamptz DEFAULT now();',
      },
      {
        name: 'defaults in CREATE TABLE rewrite nothing',
        sql: 'CREATE TABLE t (c int DEFAULT 0);',
      },
      {
        name: 'a table created in the same migration',
        sql: 'CREATE TABLE t (a int);\nALTER TABLE t ADD COLUMN c uuid DEFAULT gen_random_uuid();',
      },
      {
        name: 'the volatile list is configurable',
        sql: 'ALTER TABLE t ADD COLUMN c uuid DEFAULT gen_random_uuid();',
        options: { volatileFunctions: [] },
      },
    ],
    invalid: [
      {
        name: 'a volatile default must be evaluated per row',
        sql: 'ALTER TABLE t ADD COLUMN c uuid DEFAULT gen_random_uuid();',
        errors: [
          { line: 1, column: 1, message: 'defaults to gen_random_uuid(), which is evaluated per row' },
        ],
      },
      {
        name: 'points at the backfill replacement',
        sql: 'ALTER TABLE t ADD COLUMN c float DEFAULT random();',
        errors: [{ help: 'backfill in batches, then set the default' }],
      },
      {
        name: 'a volatile call nested in an expression',
        sql: 'ALTER TABLE t ADD COLUMN c timestamptz DEFAULT (clock_timestamp() + interval \'1 day\');',
        errors: 1,
      },
      {
        name: 'before Postgres 11 any default rewrites the table',
        sql: 'ALTER TABLE t ADD COLUMN c int DEFAULT 0;',
        settings: { targetPostgresVersion: 10 },
        errors: [{ message: 'On Postgres 10, adding column c with a default rewrites' }],
      },
      {
        name: 'each column is reported',
        sql: 'ALTER TABLE t ADD COLUMN a uuid DEFAULT gen_random_uuid(), ADD COLUMN b float DEFAULT random();',
        errors: 2,
      },
    ],
  },
});

/** Every function name called anywhere in an expression, lower-cased. */
function calledFunctions(expression: unknown): string[] {
  const found: string[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    const record = value as AstNode;
    const funcCall = record['FuncCall'];
    if (funcCall) {
      const parts = stringList(funcCall['funcname']);
      if (parts.length > 0) found.push(parts[parts.length - 1]!.toLowerCase());
    }
    for (const key of Object.keys(record)) visit(record[key]);
  };

  visit(expression);
  return found;
}
