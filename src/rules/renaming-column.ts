import { relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const renamingColumn = defineRule<void>({
  name: 'renaming-column',
  meta: {
    description: 'Do not rename columns.',
    rationale:
      'A rename breaks every client still using the old name, and there is no window in which ' +
      'both work. Add the new column, backfill, migrate reads and writes, then remove the old one.',
    help: 'Add the new column, backfill, migrate reads and writes, then drop the old one.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      RenameStmt(node, path) {
        if (node.renameType !== 'OBJECT_COLUMN') return;

        const relation = relationName(node.relation);
        const from = node.subname ? `${relation.qualified}.${node.subname}` : relation.qualified;

        context.report({
          statement: path.statement,
          message: `Renaming ${from} to ${node.newname} breaks every client still using the old name.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t RENAME TO t2;',
      'ALTER TABLE t ADD COLUMN c int;',
      'ALTER INDEX i RENAME TO i2;',
    ],
    invalid: [
      {
        sql: 'ALTER TABLE public.t RENAME COLUMN a TO b;',
        errors: [{ line: 1, column: 1, message: 'Renaming public.t.a to b' }],
      },
      {
        name: 'points at the expand-and-contract replacement',
        sql: 'ALTER TABLE t RENAME COLUMN a TO b;',
        errors: [{ help: 'Add the new column, backfill, migrate reads and writes' }],
      },
    ],
  },
});
