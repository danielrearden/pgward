import { objectName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const requireConcurrentIndexDeletion = defineRule<void>({
  name: 'require-concurrent-index-deletion',
  meta: {
    description: 'Drop indexes with CONCURRENTLY.',
    rationale:
      'A plain DROP INDEX takes an ACCESS EXCLUSIVE lock on the indexed table, which blocks ' +
      'reads as well as writes.',
    help: 'Use DROP INDEX CONCURRENTLY, outside a transaction.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      DropStmt(node, path) {
        if (node.removeType !== 'OBJECT_INDEX' || node.concurrent) return;

        const names = (node.objects ?? []).map(objectName).filter(Boolean);
        const subject = names.length > 0 ? names.join(', ') : 'this index';

        context.report({
          statement: path.statement,
          message: `Dropping ${subject} without CONCURRENTLY takes ACCESS EXCLUSIVE on the table, blocking reads as well as writes.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'DROP INDEX CONCURRENTLY idx;',
      'DROP INDEX CONCURRENTLY IF EXISTS public.idx;',
      { name: 'other DROP statements are not this rule’s business', sql: 'DROP TABLE foo;' },
      'DROP VIEW v;',
    ],
    invalid: [
      {
        sql: 'DROP INDEX idx;',
        errors: [{ line: 1, column: 1, help: 'DROP INDEX CONCURRENTLY' }],
      },
      {
        name: 'names the index and the lock it takes',
        sql: 'DROP INDEX public.idx;',
        errors: [{ message: /public\.idx[\s\S]*ACCESS\s+EXCLUSIVE/ }],
      },
      {
        name: 'a multi-index drop reports once for the statement',
        sql: 'DROP INDEX a, b;',
        errors: [{ message: 'a, b' }],
      },
    ],
  },
});
