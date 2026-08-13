import { alterTableCommands, relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const banDropColumn = defineRule<void>({
  name: 'ban-drop-column',
  meta: {
    description: 'Do not drop columns.',
    rationale:
      'Dropping a column breaks every running instance that still selects it. Ship the code ' +
      'that stops reading the column first, then drop it in a follow-up migration.',
    // A judgment call rather than a hard hazard: warn keeps it advisory, error
    // forces the two-step.
    help: 'Deploy the code that stops reading it first, then drop it in a follow-up.',
    defaultSeverity: 'warn',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      AlterTableStmt(node, path) {
        const relation = relationName(node.relation);

        for (const command of alterTableCommands(node)) {
          if (command['subtype'] !== 'AT_DropColumn') continue;

          const column = String(command['name'] ?? 'this column');
          context.report({
            statement: path.statement,
            message: `Dropping ${relation.qualified}.${column} breaks instances still selecting it.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t ADD COLUMN c int;',
      'ALTER TABLE t ALTER COLUMN c DROP NOT NULL;',
      'DROP TABLE t;',
    ],
    invalid: [
      {
        name: 'warns rather than errors, keeping it advisory',
        sql: 'ALTER TABLE public.t DROP COLUMN c;',
        errors: [
          {
            line: 1,
            column: 1,
            severity: 'warn',
            message: 'Dropping public.t.c breaks instances still selecting it',
          },
        ],
      },
      {
        name: 'points at the two-step replacement',
        sql: 'ALTER TABLE t DROP COLUMN c;',
        errors: [{ help: 'Deploy the code that stops reading it first' }],
      },
      {
        name: 'can be raised to an error to force the two-step',
        sql: 'ALTER TABLE t DROP COLUMN c;',
        severity: 'error',
        errors: [{ severity: 'error' }],
      },
      {
        name: 'each dropped column is reported',
        sql: 'ALTER TABLE t DROP COLUMN a, DROP COLUMN b;',
        errors: 2,
      },
    ],
  },
});
