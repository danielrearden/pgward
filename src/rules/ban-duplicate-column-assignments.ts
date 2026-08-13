import { relationName, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const banDuplicateColumnAssignments = defineRule<void>({
  name: 'ban-duplicate-column-assignments',
  meta: {
    description: 'Do not assign the same column twice in one UPDATE.',
    rationale:
      'Postgres rejects `SET a = 1, a = 2` outright. It is almost always a merge artifact, and ' +
      'the migration fails at execution rather than in review.',
    help: 'Assign each column exactly once.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      UpdateStmt(node, path) {
        const seen = new Set<string>();
        const duplicates = new Set<string>();

        for (const target of node.targetList ?? []) {
          const name = (target as AstNode)?.['ResTarget']?.['name'];
          if (typeof name !== 'string' || name === '') continue;
          if (seen.has(name)) duplicates.add(name);
          else seen.add(name);
        }

        if (duplicates.size === 0) return;

        const relation = relationName(node.relation);
        context.report({
          statement: path.statement,
          message: `This UPDATE assigns ${[...duplicates].map((name) => `"${name}"`).join(', ')} more than once${relation.name ? ` on ${relation.qualified}` : ''}. Postgres rejects duplicate assignments, so this fails at execution.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'UPDATE t SET a = 1, b = 2;',
      'UPDATE t SET a = 1;',
      'UPDATE t SET a = 1 WHERE a = 2;',
      { name: 'the same column in different statements', sql: 'UPDATE t SET a = 1;\nUPDATE t SET a = 2;' },
      { name: 'INSERT is not an UPDATE', sql: 'INSERT INTO t (a, b) VALUES (1, 2);' },
    ],
    invalid: [
      {
        sql: 'UPDATE public.t SET a = 1, a = 2;',
        errors: [
          { line: 1, column: 1, message: 'assigns "a" more than once on public.t' },
        ],
      },
      {
        name: 'says it fails at execution',
        sql: 'UPDATE t SET a = 1, a = 2;',
        errors: [{ message: 'Postgres rejects duplicate assignments' }],
      },
      {
        name: 'lists every duplicated column once',
        sql: 'UPDATE t SET a = 1, b = 2, a = 3, b = 4;',
        errors: [{ message: '"a", "b"' }],
      },
      {
        name: 'three assignments to the same column',
        sql: 'UPDATE t SET a = 1, a = 2, a = 3;',
        errors: 1,
      },
    ],
  },
});
