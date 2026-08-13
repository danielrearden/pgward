import { hasDefElem, relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const preferRepack = defineRule<void>({
  name: 'prefer-repack',
  meta: {
    description: 'Use pg_repack instead of VACUUM FULL or CLUSTER.',
    rationale:
      'Both rewrite the table under ACCESS EXCLUSIVE, blocking reads and writes for the whole ' +
      'rewrite. pg_repack achieves the same compaction while only taking a brief lock at the end.',
    help: 'Use pg_repack instead.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      VacuumStmt(node, path) {
        if (!hasDefElem(node.options, 'full')) return;

        context.report({
          statement: path.statement,
          message: 'VACUUM FULL rewrites the table under ACCESS EXCLUSIVE, blocking reads and writes for the whole rewrite.',
        });
      },

      ClusterStmt(node, path) {
        const target = node.relation ? relationName(node.relation).qualified : 'the table';
        context.report({
          statement: path.statement,
          message: `CLUSTER rewrites ${target} under ACCESS EXCLUSIVE, blocking reads and writes for the whole rewrite.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'VACUUM t;',
      'VACUUM ANALYZE t;',
      'VACUUM (VERBOSE) t;',
      'ANALYZE t;',
    ],
    invalid: [
      {
        sql: 'VACUUM FULL t;',
        errors: [{ line: 1, column: 1, message: 'VACUUM FULL rewrites the table under ACCESS EXCLUSIVE' }],
      },
      {
        name: 'the parenthesised form too',
        sql: 'VACUUM (FULL) t;',
        errors: 1,
      },
      {
        name: 'CLUSTER is the same hazard',
        sql: 'CLUSTER public.t USING idx;',
        errors: [{ message: 'CLUSTER rewrites public.t under ACCESS EXCLUSIVE' }],
      },
      {
        name: 'points at pg_repack',
        sql: 'VACUUM FULL t;',
        errors: [{ help: 'Use pg_repack instead' }],
      },
    ],
  },
});
