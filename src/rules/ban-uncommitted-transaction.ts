import { opensTransaction } from '../analysis/transactions.ts';
import { defineRule } from '../define-rule.ts';

const standalone = { implicitTransaction: false };

export const banUncommittedTransaction = defineRule<void>({
  name: 'ban-uncommitted-transaction',
  meta: {
    description: 'Close every transaction the migration opens.',
    rationale:
      'A migration that ends mid-transaction leaves its locks held on the shared connection. ' +
      'Whatever runs next inherits them, so the failure surfaces in an unrelated migration.',
    help: 'Add the matching COMMIT.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    const { source } = context;

    return {
      'file:exit'() {
        if (!source.transactions.unclosed) return;

        // Point at the BEGIN that is still open rather than the end of the file.
        const opener = [...source.statements]
          .reverse()
          .find(
            (statement) =>
              opensTransaction(statement) &&
              (source.transactions.depthBefore[statement.index] ?? 0) === 0,
          );

        context.report({
          ...(opener ? { statement: opener } : { offset: source.sql.length }),
          message: 'This migration ends with a transaction still open. Its locks carry over to whatever runs next on the same connection.',
        });
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'a balanced transaction',
        sql: 'BEGIN;\nALTER TABLE t ADD COLUMN c int;\nCOMMIT;',
        settings: standalone,
      },
      {
        name: 'closed by ROLLBACK',
        sql: 'BEGIN;\nSELECT 1;\nROLLBACK;',
        settings: standalone,
      },
      {
        name: 'no transaction control at all',
        sql: 'ALTER TABLE t ADD COLUMN c int;',
      },
      {
        name: 'two balanced transactions',
        sql: 'BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;',
        settings: standalone,
      },
    ],
    invalid: [
      {
        name: 'a BEGIN that is never closed',
        sql: 'BEGIN;\nALTER TABLE t ADD COLUMN c int;',
        settings: standalone,
        errors: [
          { line: 1, column: 1, message: 'ends with a transaction still open' },
        ],
      },
      {
        name: 'explains that the locks leak onto the shared connection',
        sql: 'BEGIN;\nSELECT 1;',
        settings: standalone,
        errors: [{ message: 'locks carry over to whatever runs next' }],
      },
      {
        name: 'points at the BEGIN that is still open, not the end of the file',
        sql: 'BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;',
        settings: standalone,
        errors: [{ line: 4 }],
      },
    ],
  },
});
