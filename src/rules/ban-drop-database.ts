import { defineRule } from '../define-rule.ts';

export const banDropDatabase = defineRule<void>({
  name: 'ban-drop-database',
  meta: {
    description: 'Do not drop databases.',
    rationale: 'Dropping a database destroys data irrecoverably and cannot be rolled back.',
    help: 'Do this by hand, outside a migration.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      DropdbStmt(node, path) {
        context.report({
          statement: path.statement,
          message: `Dropping database ${node.dbname} destroys its data irrecoverably and cannot be rolled back.`,
        });
      },
    };
  },
  tests: {
    valid: ['DROP TABLE t;', 'DROP SCHEMA s;', 'CREATE DATABASE d;'],
    invalid: [
      {
        sql: 'DROP DATABASE app;',
        errors: [{ line: 1, column: 1, message: 'Dropping database app destroys its data' }],
      },
      {
        name: 'says it cannot be rolled back',
        sql: 'DROP DATABASE IF EXISTS app;',
        errors: [{ message: 'cannot be rolled back' }],
      },
    ],
  },
});
