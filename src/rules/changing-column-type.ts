import { createdTableMatcher } from '../analysis/new-tables.ts';
import { alterTableCommands, describeType, relationName, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface ChangingColumnTypeOptions {
  /** Skip tables created by this same migration. */
  allowOnNewTables: boolean;
}

export const changingColumnType = defineRule<ChangingColumnTypeOptions>({
  name: 'changing-column-type',
  meta: {
    description: 'Do not change a column type in place.',
    rationale:
      'Most type changes rewrite the table under an exclusive lock, and every client holding a ' +
      'cached statement for the old type breaks. Add a new column, backfill, swap reads, drop ' +
      'the old one.',
    help: 'Add a new column, backfill, migrate reads, then drop the old one.',
    defaultSeverity: 'error',
    defaultOptions: { allowOnNewTables: true },
  },
  create(context) {
    const isNewTable = createdTableMatcher(context.source);

    return {
      AlterTableStmt(node, path) {
        const relation = relationName(node.relation);
        if (context.options.allowOnNewTables && isNewTable(relation)) return;

        for (const command of alterTableCommands(node)) {
          if (command['subtype'] !== 'AT_AlterColumnType') continue;

          const column = String(command['name'] ?? 'this column');
          const columnDef = (command['def'] as AstNode)?.['ColumnDef'];
          const target = columnDef ? describeType(columnDef['typeName']) : '';

          context.report({
            statement: path.statement,
            message: `Changing ${relation.qualified}.${column}${target ? ` to ${target}` : ''} rewrites the table under an exclusive lock and breaks clients with cached statements.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t ADD COLUMN c bigint;',
      'ALTER TABLE t DROP COLUMN c;',
      {
        name: 'declaring types in CREATE TABLE changes nothing',
        sql: 'CREATE TABLE t (c bigint);',
      },
      {
        name: 'a table created in the same migration has nothing to rewrite',
        sql: 'CREATE TABLE t (c int);\nALTER TABLE t ALTER COLUMN c TYPE bigint;',
      },
    ],
    invalid: [
      {
        sql: 'ALTER TABLE public.t ALTER COLUMN c TYPE bigint;',
        errors: [{ line: 1, column: 1, message: 'Changing public.t.c to bigint rewrites the table' }],
      },
      {
        name: 'explains the cached-statement breakage',
        sql: 'ALTER TABLE t ALTER COLUMN c TYPE text;',
        errors: [{ message: 'breaks clients with cached statements' }],
      },
      {
        name: 'the new-table exemption can be turned off',
        sql: 'CREATE TABLE t (c int);\nALTER TABLE t ALTER COLUMN c TYPE bigint;',
        options: { allowOnNewTables: false },
        errors: 1,
      },
      {
        name: 'each altered column is reported',
        sql: 'ALTER TABLE t ALTER COLUMN a TYPE bigint, ALTER COLUMN b TYPE text;',
        errors: 2,
      },
    ],
  },
});
