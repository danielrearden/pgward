import { alterTableCommands, relationName, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

/** `DETACH PARTITION … CONCURRENTLY` arrived in this release. */
const CONCURRENT_DETACH_SINCE = 14;

export const requireConcurrentPartitionDetach = defineRule<void>({
  name: 'require-concurrent-partition-detach',
  meta: {
    description: 'Detach partitions with CONCURRENTLY.',
    rationale:
      'A plain DETACH PARTITION takes ACCESS EXCLUSIVE on the parent table, blocking every ' +
      'query against the whole partition set until it completes.',
    help: 'Use DETACH PARTITION … CONCURRENTLY.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    const version = context.settings.targetPostgresVersion;

    return {
      AlterTableStmt(node, path) {
        // The CONCURRENTLY form doesn't exist before Postgres 14, so there is
        // nothing actionable to report.
        if (version < CONCURRENT_DETACH_SINCE) return;

        const parent = relationName(node.relation);

        for (const command of alterTableCommands(node)) {
          if (command['subtype'] !== 'AT_DetachPartition') continue;

          const partitionCmd = (command['def'] as AstNode)?.['PartitionCmd'];
          if (partitionCmd?.['concurrent']) continue;

          const partition = partitionCmd?.['name']
            ? relationName(partitionCmd['name']).qualified
            : 'this partition';

          context.report({
            statement: path.statement,
            message: `Detaching ${partition} without CONCURRENTLY takes ACCESS EXCLUSIVE on ${parent.qualified} and blocks the whole partition set.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t DETACH PARTITION p CONCURRENTLY;',
      'ALTER TABLE t ATTACH PARTITION p FOR VALUES FROM (1) TO (2);',
      'ALTER TABLE t ADD COLUMN c int;',
      {
        name: 'the CONCURRENTLY form does not exist before Postgres 14',
        sql: 'ALTER TABLE t DETACH PARTITION p;',
        settings: { targetPostgresVersion: 13 },
      },
    ],
    invalid: [
      {
        sql: 'ALTER TABLE public.parent DETACH PARTITION public.p;',
        errors: [
          { line: 1, column: 1, message: 'Detaching public.p without CONCURRENTLY' },
        ],
      },
      {
        name: 'names the parent it would lock',
        sql: 'ALTER TABLE public.parent DETACH PARTITION p;',
        errors: [{ message: 'ACCESS EXCLUSIVE on public.parent' }],
      },
      {
        name: 'enforced from Postgres 14 onwards',
        sql: 'ALTER TABLE t DETACH PARTITION p;',
        settings: { targetPostgresVersion: 14 },
        errors: 1,
      },
    ],
  },
});
