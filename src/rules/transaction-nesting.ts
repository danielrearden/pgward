import { closesTransaction, opensTransaction } from '../analysis/transactions.ts';
import { defineRule } from '../define-rule.ts';

const standalone = { implicitTransaction: false };

export const transactionNesting = defineRule<void>({
  name: 'transaction-nesting',
  meta: {
    description: 'Do not nest transactions or close one that was never opened.',
    rationale:
      'Postgres has no nested transactions: a second BEGIN warns and is ignored, so the COMMIT ' +
      'the author expected to be inner actually commits everything. A stray COMMIT is the same ' +
      'confusion from the other end.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    const { source } = context;

    return {
      statement(statement) {
        const depth = source.transactions.depthBefore[statement.index] ?? 0;

        if (opensTransaction(statement)) {
          if (depth > 0) {
            context.report({
              statement,
              message: 'A transaction is already open here. Postgres ignores the nested BEGIN, so the next COMMIT ends the outer transaction — not this one.',
              help: 'Remove this BEGIN.',
            });
          } else if (source.transactions.implicit) {
            context.report({
              statement,
              message: 'The migration runner already wraps this file in a transaction, so this BEGIN nests.',
              help: 'Declare the migration non-transactional, or drop the BEGIN.',
            });
          }
          return;
        }

        if (closesTransaction(statement) && depth === 0 && !source.transactions.implicit) {
          context.report({
            statement,
            message: 'No transaction is open here, so this has nothing to close.',
            help: 'Remove it, or add the matching BEGIN.',
          });
        }
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'a single balanced transaction',
        sql: 'BEGIN;\nALTER TABLE t ADD COLUMN c int;\nCOMMIT;',
        settings: standalone,
      },
      {
        name: 'two sequential transactions',
        sql: 'BEGIN;\nSELECT 1;\nCOMMIT;\nBEGIN;\nSELECT 2;\nCOMMIT;',
        settings: standalone,
      },
      {
        name: 'savepoints nest within a transaction without opening one',
        sql: 'BEGIN;\nSAVEPOINT a;\nRELEASE a;\nCOMMIT;',
        settings: standalone,
      },
      {
        name: 'no transaction control at all',
        sql: 'ALTER TABLE t ADD COLUMN c int;',
      },
      {
        name: 'a commit closing the runner’s implicit transaction',
        sql: 'ALTER TABLE t ADD COLUMN c int;\nCOMMIT;',
      },
    ],
    invalid: [
      {
        name: 'a second BEGIN is silently ignored by Postgres',
        sql: 'BEGIN;\nBEGIN;\nCOMMIT;',
        settings: standalone,
        errors: [{ line: 2, column: 1, message: 'A transaction is already open here' }],
      },
      {
        name: 'explains which COMMIT the nested BEGIN breaks',
        sql: 'BEGIN;\nBEGIN;\nCOMMIT;',
        settings: standalone,
        errors: [{ message: 'the next COMMIT ends the outer transaction' }],
      },
      {
        name: 'a BEGIN inside the runner’s implicit transaction',
        sql: 'BEGIN;\nALTER TABLE t ADD COLUMN c int;\nCOMMIT;',
        errors: [{ message: 'runner already wraps this file in a transaction' }],
      },
      {
        name: 'a non-transactional declaration makes the outer BEGIN legitimate',
        sql: 'BEGIN;\nBEGIN;\nCOMMIT;\nCOMMIT;',
        implicitTransaction: false,
        errors: [{ line: 2, message: 'already open' }],
      },
      {
        name: 'a COMMIT with nothing open',
        sql: 'SELECT 1;\nCOMMIT;',
        settings: standalone,
        errors: [{ line: 2, message: 'No transaction is open here' }],
      },
    ],
  },
});
