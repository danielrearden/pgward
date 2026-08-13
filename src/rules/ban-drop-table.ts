import { objectName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const banDropTable = defineRule<void>({
  name: 'ban-drop-table',
  meta: {
    description: 'Do not drop tables.',
    rationale:
      'Dropping a table breaks every instance still querying it and destroys the data. Stop ' +
      'reading the table, ship that, then drop it in a later migration.',
    help: 'Retire the reads first, then drop it in a follow-up migration.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      DropStmt(node, path) {
        if (node.removeType !== 'OBJECT_TABLE') return;

        const names = (node.objects ?? []).map(objectName).filter(Boolean);
        context.report({
          statement: path.statement,
          message: `Dropping ${names.length > 0 ? names.join(', ') : 'this table'} destroys its data and breaks instances still querying it.`,
        });
      },
    };
  },
  tests: {
    valid: ['DROP INDEX CONCURRENTLY idx;', 'DROP VIEW v;', 'ALTER TABLE t DROP COLUMN c;'],
    invalid: [
      {
        sql: 'DROP TABLE public.thing;',
        errors: [{ line: 1, column: 1, message: 'Dropping public.thing destroys its data' }],
      },
      {
        name: 'points at the two-step retirement',
        sql: 'DROP TABLE t;',
        errors: [{ help: 'Retire the reads first' }],
      },
      {
        name: 'lists every table in the statement',
        sql: 'DROP TABLE a, b;',
        errors: [{ message: 'Dropping a, b' }],
      },
      {
        name: 'IF EXISTS does not make it safe',
        sql: 'DROP TABLE IF EXISTS t;',
        errors: 1,
      },
    ],
  },
});
