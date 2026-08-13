import { alterTableCommands, relationName, tableElements, type AstNode } from '../ast.ts';
import { columnConstraints } from '../ast.ts';
import { defineRule } from '../define-rule.ts';
import type { Statement } from '../types.ts';

export interface RequireNamedCheckConstraintOptions {
  /**
   * A regular expression the constraint name must match. `{table}` and
   * `{column}` are substituted with the actual names before compiling, so
   * `'^{table}_{column}_check$'` enforces the usual convention. Null — the
   * default — only requires that a name be given at all.
   */
  namePattern: string | null;
}

export const requireNamedCheckConstraint = defineRule<RequireNamedCheckConstraintOptions>({
  name: 'require-named-check-constraint',
  meta: {
    description: 'Name every CHECK constraint explicitly.',
    rationale:
      "An unnamed CHECK gets an auto-generated name that truncates mid-word once the table's " +
      'name is long, leaving a constraint nobody can reference in a later migration.',
    defaultSeverity: 'error',
    defaultOptions: { namePattern: null },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      if (options.namePattern !== null) {
        // Compile once with the placeholders removed, so a bad pattern fails at
        // construction rather than on the first file that trips it.
        try {
          new RegExp(options.namePattern.replaceAll('{table}', 'x').replaceAll('{column}', 'y'));
        } catch (cause) {
          throw new TypeError(
            `pgward: rule "require-named-check-constraint" option namePattern is not a valid ` +
              `regular expression: ${(cause as Error).message}`,
          );
        }
      }
      return options;
    },
  },
  create(context) {
    const { options } = context;

    const check = (
      constraint: AstNode,
      table: string,
      column: string | null,
      statement: Statement,
    ): void => {
      if (constraint['contype'] !== 'CONSTR_CHECK') return;

      const name = String(constraint['conname'] ?? '');
      if (name === '') {
        context.report({
          statement,
          message: `This CHECK constraint on ${table} has no explicit name, so Postgres generates one that truncates at 63 characters.`,
          help: `Give it an explicit name${options.namePattern ? ` matching ${options.namePattern}` : ''}.`,
        });
        return;
      }

      if (options.namePattern === null) return;
      // A pattern that names a column can't be applied to a table-level check.
      if (options.namePattern.includes('{column}') && column === null) return;

      const source = options.namePattern
        .replaceAll('{table}', escapeRegExp(table))
        .replaceAll('{column}', escapeRegExp(column ?? ''));

      if (new RegExp(source).test(name)) return;

      context.report({
        statement,
        message: `CHECK constraint "${name}" does not match the required naming pattern (${options.namePattern}).`,
        help: `Rename it to match ${options.namePattern}.`,
      });
    };

    return {
      CreateStmt(node, path) {
        const table = relationName(node.relation).name;
        const { columns, constraints } = tableElements(node);

        for (const column of columns) {
          for (const constraint of columnConstraints(column)) {
            check(constraint, table, String(column['colname'] ?? ''), path.statement);
          }
        }
        for (const constraint of constraints) {
          check(constraint, table, null, path.statement);
        }
      },

      AlterTableStmt(node, path) {
        const table = relationName(node.relation).name;

        for (const command of alterTableCommands(node)) {
          const def = command['def'] as AstNode | undefined;
          if (!def) continue;

          if (command['subtype'] === 'AT_AddConstraint' && def['Constraint']) {
            check(def['Constraint'], table, null, path.statement);
          }
          if (command['subtype'] === 'AT_AddColumn' && def['ColumnDef']) {
            const column = String(def['ColumnDef']['colname'] ?? '');
            for (const constraint of columnConstraints(def['ColumnDef'])) {
              check(constraint, table, column, path.statement);
            }
          }
        }
      },
    };
  },
  tests: {
    valid: [
      'CREATE TABLE thing (amount int, CONSTRAINT thing_amount_check CHECK (amount > 0));',
      'CREATE TABLE thing (amount int CONSTRAINT thing_amount_check CHECK (amount > 0));',
      'ALTER TABLE thing ADD CONSTRAINT thing_amount_check CHECK (amount > 0) NOT VALID;',
      {
        name: 'other constraint kinds are not checked',
        sql: 'CREATE TABLE thing (a int UNIQUE, b int PRIMARY KEY);',
      },
      {
        name: 'a name matching the configured pattern',
        sql: 'CREATE TABLE thing (amount int CONSTRAINT thing_amount_check CHECK (amount > 0));',
        options: { namePattern: '^{table}_{column}_check$' },
      },
      {
        name: 'a table-level check is exempt from a column-based pattern',
        sql: 'CREATE TABLE thing (amount int, CONSTRAINT anything_at_all CHECK (amount > 0));',
        options: { namePattern: '^{table}_{column}_check$' },
      },
      {
        name: 'a table-only pattern',
        sql: 'CREATE TABLE thing (amount int, CONSTRAINT thing_check CHECK (amount > 0));',
        options: { namePattern: '^{table}_' },
      },
    ],
    invalid: [
      {
        name: 'an unnamed table-level check',
        sql: 'CREATE TABLE thing (amount int, CHECK (amount > 0));',
        errors: [{ line: 1, column: 1, message: 'This CHECK constraint on thing has no explicit name' }],
      },
      {
        name: 'explains the truncation hazard',
        sql: 'CREATE TABLE thing (amount int CHECK (amount > 0));',
        errors: [{ message: 'truncates at 63 characters' }],
      },
      {
        name: 'an unnamed check added by ALTER TABLE',
        sql: 'ALTER TABLE thing ADD CHECK (amount > 0);',
        errors: 1,
      },
      {
        name: 'an unnamed check on an added column',
        sql: 'ALTER TABLE thing ADD COLUMN amount int CHECK (amount > 0);',
        errors: 1,
      },
      {
        name: 'a name that does not match the pattern',
        sql: 'CREATE TABLE thing (amount int CONSTRAINT weird_name CHECK (amount > 0));',
        options: { namePattern: '^{table}_{column}_check$' },
        errors: [{ message: 'does not match the required naming pattern' }],
      },
      {
        name: 'each unnamed check is reported',
        sql: 'CREATE TABLE thing (a int CHECK (a > 0), b int CHECK (b > 0));',
        errors: 2,
      },
    ],
  },
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
