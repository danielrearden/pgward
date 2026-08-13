import { createdTableMatcher } from '../analysis/new-tables.ts';
import { relationName } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface RequireConcurrentIndexCreationOptions {
  /**
   * Allow a plain `CREATE INDEX` on a table created earlier in the same file.
   * Nothing is reading a table that doesn't exist yet, so the lock costs
   * nothing.
   */
  allowOnNewTables: boolean;
}

export const requireConcurrentIndexCreation = defineRule<RequireConcurrentIndexCreationOptions>({
  name: 'require-concurrent-index-creation',
  meta: {
    description: 'Build indexes with CONCURRENTLY.',
    rationale:
      'A plain CREATE INDEX holds a SHARE lock on the table for the whole build, blocking ' +
      'every write until it finishes.',
    help: 'Build it with CREATE INDEX CONCURRENTLY, outside a transaction.',
    defaultSeverity: 'error',
    defaultOptions: { allowOnNewTables: true },
  },
  create(context) {
    const isNewTable = createdTableMatcher(context.source);

    return {
      IndexStmt(node, path) {
        if (node.concurrent) return;

        const table = relationName(node.relation);
        if (context.options.allowOnNewTables && isNewTable(table)) return;

        context.report({
          statement: path.statement,
          message: `A plain index build holds a SHARE lock on ${table.qualified || 'the table'} and blocks writes until it completes.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'CREATE INDEX CONCURRENTLY idx ON public.foo (bar);',
      'CREATE UNIQUE INDEX CONCURRENTLY idx ON public.foo (bar);',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON public.foo (bar);',
      {
        name: 'a plain build on a table created in the same migration',
        sql: 'CREATE TABLE public.foo (bar int);\nCREATE INDEX idx ON public.foo (bar);',
      },
      {
        name: 'matches the new table across schema qualification',
        sql: 'CREATE TABLE public.foo (bar int);\nCREATE INDEX idx ON foo (bar);',
      },
    ],
    invalid: [
      {
        sql: 'CREATE INDEX idx ON public.foo (bar);',
        errors: [{ line: 1, column: 1, help: 'CREATE INDEX CONCURRENTLY' }],
      },
      {
        name: 'names the table it would lock',
        sql: 'SELECT 1;\nCREATE INDEX idx ON public.foo (bar);',
        errors: [{ line: 2, message: 'SHARE lock on public.foo' }],
      },
      {
        name: 'the new-table exemption can be turned off',
        sql: 'CREATE TABLE public.foo (bar int);\nCREATE INDEX idx ON public.foo (bar);',
        options: { allowOnNewTables: false },
        errors: 1,
      },
      {
        name: 'each plain build is reported',
        sql: 'CREATE INDEX a ON t (x);\nCREATE INDEX b ON t (y);',
        errors: 2,
      },
    ],
  },
});
