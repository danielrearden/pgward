import { alterTableCommands, relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const banDropNotNull = defineRule<void>({
  name: 'ban-drop-not-null',
  meta: {
    description: 'Do not drop a NOT NULL constraint.',
    rationale:
      'Running instances were compiled against a column that could not be null. Once nulls ' +
      'start arriving, code that never checked for them fails at read time, far from this change.',
    help: 'Deploy code that handles nulls first.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      AlterTableStmt(node, path) {
        const relation = relationName(node.relation);

        for (const command of alterTableCommands(node)) {
          if (command['subtype'] !== 'AT_DropNotNull') continue;

          context.report({
            statement: path.statement,
            message: `Dropping NOT NULL on ${relation.qualified}.${command['name']} lets nulls reach clients that never expected them.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t ALTER COLUMN c SET NOT NULL;',
      'ALTER TABLE t DROP COLUMN c;',
      'CREATE TABLE t (c int);',
    ],
    invalid: [
      {
        sql: 'ALTER TABLE public.t ALTER COLUMN c DROP NOT NULL;',
        errors: [
          { line: 1, column: 1, message: 'Dropping NOT NULL on public.t.c lets nulls reach clients' },
        ],
      },
      {
        name: 'points at the ordering fix',
        sql: 'ALTER TABLE t ALTER COLUMN c DROP NOT NULL;',
        errors: [{ help: 'Deploy code that handles nulls first' }],
      },
      {
        name: 'each column is reported',
        sql: 'ALTER TABLE t ALTER COLUMN a DROP NOT NULL, ALTER COLUMN b DROP NOT NULL;',
        errors: 2,
      },
    ],
  },
});
