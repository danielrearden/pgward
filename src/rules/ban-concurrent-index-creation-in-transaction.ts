import { usesConcurrently } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const banConcurrentIndexCreationInTransaction = defineRule<void>({
  name: 'ban-concurrent-index-creation-in-transaction',
  meta: {
    description: 'CONCURRENTLY cannot run inside an explicit transaction block.',
    rationale:
      'Postgres rejects CREATE INDEX CONCURRENTLY inside BEGIN … COMMIT outright. This covers ' +
      'the explicit BEGIN in the file; ban-mixed-transactional-modes covers the transaction the ' +
      'migration runner opens for you.',
    help: 'Move it outside the BEGIN … COMMIT.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    const { source } = context;

    return {
      statement(statement) {
        if (!usesConcurrently(statement)) return;
        if (!source.transactions.inExplicitTransaction(statement.index)) return;

        context.report({
          statement,
          message: `CONCURRENTLY cannot run inside an explicit transaction block — Postgres rejects this statement at execution.`,
        });
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'outside any explicit transaction',
        sql: 'CREATE INDEX CONCURRENTLY idx ON t (a);',
      },
      {
        name: 'after the transaction has been committed',
        sql: 'BEGIN;\nALTER TABLE t ADD COLUMN c int;\nCOMMIT;\nCREATE INDEX CONCURRENTLY idx ON t (a);',
      },
      {
        name: 'a non-concurrent build inside a transaction is legal',
        sql: 'BEGIN;\nCREATE INDEX idx ON t (a);\nCOMMIT;',
      },
    ],
    invalid: [
      {
        name: 'a concurrent build inside BEGIN … COMMIT',
        sql: 'BEGIN;\nCREATE INDEX CONCURRENTLY idx ON t (a);\nCOMMIT;',
        errors: [
          {
            line: 2,
            column: 1,
            message: 'CONCURRENTLY cannot run inside an explicit transaction block',
          },
        ],
      },
      {
        name: 'a concurrent drop too',
        sql: 'BEGIN;\nDROP INDEX CONCURRENTLY idx;\nCOMMIT;',
        errors: 1,
      },
      {
        name: 'a concurrent reindex too',
        sql: 'BEGIN;\nREINDEX TABLE CONCURRENTLY t;\nCOMMIT;',
        errors: 1,
      },
      {
        name: 'points outside the block',
        sql: 'START TRANSACTION;\nCREATE INDEX CONCURRENTLY idx ON t (a);\nCOMMIT;',
        errors: [{ help: 'Move it outside the BEGIN … COMMIT' }],
      },
    ],
  },
});
