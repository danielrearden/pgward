import { relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const renamingTable = defineRule<void>({
  name: 'renaming-table',
  meta: {
    description: 'Do not rename tables.',
    rationale:
      'A rename breaks every client still using the old name. Create the new table, dual-write, ' +
      'backfill, migrate reads, then drop the old one.',
    help: 'Create the new table, dual-write, backfill, then retire the old one.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      RenameStmt(node, path) {
        if (node.renameType !== 'OBJECT_TABLE') return;

        const relation = relationName(node.relation);
        context.report({
          statement: path.statement,
          message: `Renaming ${relation.qualified} to ${node.newname} breaks every client still using the old name.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t RENAME COLUMN a TO b;',
      'CREATE TABLE t2 (a int);',
      'ALTER INDEX i RENAME TO i2;',
    ],
    invalid: [
      {
        sql: 'ALTER TABLE public.t RENAME TO t2;',
        errors: [{ line: 1, column: 1, message: 'Renaming public.t to t2' }],
      },
      {
        name: 'points at the dual-write replacement',
        sql: 'ALTER TABLE t RENAME TO t2;',
        errors: [{ help: 'Create the new table, dual-write, backfill' }],
      },
    ],
  },
});
