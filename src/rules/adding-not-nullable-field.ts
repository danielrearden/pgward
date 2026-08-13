import { createdTableMatcher } from '../analysis/new-tables.ts';
import { alterTableCommands, relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface AddingNotNullableFieldOptions {
  allowOnNewTables: boolean;
}

/** A validated CHECK can stand in for the scan from this release onward. */
const CHECK_SHORTCUT_SINCE = 12;

export const addingNotNullableField = defineRule<AddingNotNullableFieldOptions>({
  name: 'adding-not-nullable-field',
  meta: {
    description: 'SET NOT NULL scans the whole table under an exclusive lock.',
    rationale:
      'On Postgres 12 and later the scan can be avoided: add a CHECK (col IS NOT NULL) ' +
      'NOT VALID, VALIDATE it, then SET NOT NULL, which reuses the validated constraint.',
    defaultSeverity: 'error',
    defaultOptions: { allowOnNewTables: true },
  },
  create(context) {
    const isNewTable = createdTableMatcher(context.source);
    const version = context.settings.targetPostgresVersion;

    return {
      AlterTableStmt(node, path) {
        const relation = relationName(node.relation);
        if (context.options.allowOnNewTables && isNewTable(relation)) return;

        for (const command of alterTableCommands(node)) {
          if (command['subtype'] !== 'AT_SetNotNull') continue;

          const column = String(command['name'] ?? 'this column');
          const remedy =
            version >= CHECK_SHORTCUT_SINCE
              ? `Add CHECK (${column} IS NOT NULL) NOT VALID, VALIDATE it, then SET NOT NULL — ` +
                `Postgres reuses the validated constraint and skips the scan.`
              : `Postgres ${version} has no way to skip the scan; schedule this for a ` +
                `maintenance window.`;

          context.report({
            statement: path.statement,
            message:
              `SET NOT NULL on ${relation.qualified}.${column} scans the whole table under ` +
              `ACCESS EXCLUSIVE.`,
            help: remedy,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t ALTER COLUMN c DROP NOT NULL;',
      'ALTER TABLE t ADD COLUMN c int NOT NULL DEFAULT 0;',
      'CREATE TABLE t (c int NOT NULL);',
      {
        name: 'a table created in the same migration is empty',
        sql: 'CREATE TABLE t (c int);\nALTER TABLE t ALTER COLUMN c SET NOT NULL;',
      },
    ],
    invalid: [
      {
        sql: 'ALTER TABLE public.t ALTER COLUMN c SET NOT NULL;',
        errors: [
          { line: 1, column: 1, message: 'SET NOT NULL on public.t.c scans the whole table' },
        ],
      },
      {
        name: 'suggests the validated-CHECK shortcut on Postgres 12+',
        sql: 'ALTER TABLE t ALTER COLUMN c SET NOT NULL;',
        settings: { targetPostgresVersion: 16 },
        errors: [{ help: 'Add CHECK (c IS NOT NULL) NOT VALID, VALIDATE it, then SET NOT NULL' }],
      },
      {
        name: 'says there is no shortcut before Postgres 12',
        sql: 'ALTER TABLE t ALTER COLUMN c SET NOT NULL;',
        settings: { targetPostgresVersion: 11 },
        errors: [{ help: 'Postgres 11 has no way to skip the scan' }],
      },
      {
        name: 'the new-table exemption can be turned off',
        sql: 'CREATE TABLE t (c int);\nALTER TABLE t ALTER COLUMN c SET NOT NULL;',
        options: { allowOnNewTables: false },
        errors: 1,
      },
    ],
  },
});
