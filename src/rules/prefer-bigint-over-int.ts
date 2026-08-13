import { typeNameOf } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const preferBigintOverInt = defineRule<void>({
  name: 'prefer-bigint-over-int',
  meta: {
    description: 'Use bigint instead of integer.',
    rationale:
      'A 32-bit key runs out at about 2.1 billion rows, and widening it afterwards rewrites the ' +
      'table under an exclusive lock. The extra four bytes now are cheaper than that migration.',
    help: 'Use bigint.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      ColumnDef(node, path) {
        if (typeNameOf(node.typeName) !== 'int4') return;

        const column = node.colname ? `Column ${node.colname}` : 'This column';
        context.report({
          statement: path.statement,
          message: `${column} is integer; widening it later rewrites the table under an exclusive lock.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'CREATE TABLE t (a bigint);',
      'CREATE TABLE t (a int8);',
      'CREATE TABLE t (a text);',
      { name: 'smallint is a different rule’s business', sql: 'CREATE TABLE t (a smallint);' },
    ],
    invalid: [
      {
        sql: 'CREATE TABLE t (a int);',
        errors: [{ line: 1, column: 1, message: 'Column a is integer', help: 'Use bigint' }],
      },
      {
        name: 'the integer spelling too',
        sql: 'CREATE TABLE t (a integer);',
        errors: 1,
      },
      {
        name: 'explains the rewrite cost of widening later',
        sql: 'ALTER TABLE t ADD COLUMN a int4;',
        errors: [{ message: 'widening it later rewrites the table under an exclusive lock' }],
      },
      {
        name: 'each offending column is reported',
        sql: 'CREATE TABLE t (a int, b int);',
        errors: 2,
      },
    ],
  },
});
