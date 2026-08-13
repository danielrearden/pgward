import { relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const banTruncateCascade = defineRule<void>({
  name: 'ban-truncate-cascade',
  meta: {
    description: 'Do not use TRUNCATE … CASCADE.',
    rationale:
      'CASCADE silently truncates every referencing table, including ones the author never ' +
      'named. List the tables explicitly so the blast radius is visible in review.',
    help: 'Name the tables you intend to truncate explicitly.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      TruncateStmt(node, path) {
        if (node.behavior !== 'DROP_CASCADE') return;

        const tables = (node.relations ?? [])
          .map((relation) => relationName((relation as any)?.RangeVar).qualified)
          .filter(Boolean);

        context.report({
          statement: path.statement,
          message: `TRUNCATE … CASCADE silently empties every table referencing ${tables.length > 0 ? tables.join(', ') : 'these tables'}.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'TRUNCATE t;',
      'TRUNCATE a, b;',
      'TRUNCATE t RESTRICT;',
      'DROP TABLE t CASCADE;',
    ],
    invalid: [
      {
        sql: 'TRUNCATE public.t CASCADE;',
        errors: [{ line: 1, column: 1, message: 'silently empties every table referencing public.t' }],
      },
      {
        name: 'lists every named table',
        sql: 'TRUNCATE a, b CASCADE;',
        errors: [{ message: 'referencing a, b' }],
      },
      {
        name: 'points at the explicit replacement',
        sql: 'TRUNCATE t CASCADE;',
        errors: [{ help: 'Name the tables you intend to truncate explicitly' }],
      },
    ],
  },
});
