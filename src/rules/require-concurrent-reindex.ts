import { hasDefElem, relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const requireConcurrentReindex = defineRule<void>({
  name: 'require-concurrent-reindex',
  meta: {
    description: 'Rebuild indexes with REINDEX CONCURRENTLY.',
    rationale:
      'A plain REINDEX locks out writes for the whole rebuild — the same hazard the index ' +
      'creation and deletion rules cover, on a statement that is easy to overlook.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      ReindexStmt(node, path) {
        if (hasDefElem(node.params, 'concurrently')) return;

        const target = node.relation ? relationName(node.relation).qualified : node.name || '';
        context.report({
          statement: path.statement,
          message: 'A plain REINDEX blocks writes for the entire rebuild.',
          help: `Use REINDEX ${reindexObject(node.kind)} CONCURRENTLY${target ? ` ${target}` : ''}.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'REINDEX INDEX CONCURRENTLY i;',
      'REINDEX TABLE CONCURRENTLY t;',
      'REINDEX SCHEMA CONCURRENTLY public;',
      { name: 'other statements are not this rule’s business', sql: 'CREATE INDEX CONCURRENTLY i ON t (a);' },
    ],
    invalid: [
      {
        sql: 'REINDEX INDEX i;',
        errors: [{ line: 1, column: 1, help: 'Use REINDEX INDEX CONCURRENTLY i' }],
      },
      {
        name: 'explains the write lock',
        sql: 'REINDEX TABLE public.t;',
        errors: [{ message: 'blocks writes for the entire rebuild' }],
      },
      {
        name: 'names the object kind',
        sql: 'REINDEX TABLE public.t;',
        errors: [{ help: 'REINDEX TABLE CONCURRENTLY public.t' }],
      },
    ],
  },
});

function reindexObject(kind: unknown): string {
  switch (String(kind ?? '')) {
    case 'REINDEX_OBJECT_INDEX':
      return 'INDEX';
    case 'REINDEX_OBJECT_TABLE':
      return 'TABLE';
    case 'REINDEX_OBJECT_SCHEMA':
      return 'SCHEMA';
    case 'REINDEX_OBJECT_DATABASE':
      return 'DATABASE';
    case 'REINDEX_OBJECT_SYSTEM':
      return 'SYSTEM';
    default:
      return '';
  }
}
