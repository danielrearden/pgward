import { typeNameOf } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const preferBigintOverSmallint = defineRule<void>({
  name: 'prefer-bigint-over-smallint',
  meta: {
    description: 'Use bigint instead of smallint.',
    rationale:
      'A 16-bit column runs out at 32,767. Widening it afterwards rewrites the table under an ' +
      'exclusive lock, and alignment padding means the saving was often zero anyway.',
    help: 'Use bigint.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      ColumnDef(node, path) {
        if (typeNameOf(node.typeName) !== 'int2') return;

        const column = node.colname ? `Column ${node.colname}` : 'This column';
        context.report({
          statement: path.statement,
          message: `${column} is smallint, which overflows at 32,767; widening it later rewrites the table under an exclusive lock.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'CREATE TABLE t (a bigint);',
      'CREATE TABLE t (a int);',
      'CREATE TABLE t (a text);',
    ],
    invalid: [
      {
        sql: 'CREATE TABLE t (a smallint);',
        errors: [
          { line: 1, column: 1, message: 'Column a is smallint, which overflows at 32,767' },
        ],
      },
      {
        name: 'the int2 spelling too',
        sql: 'CREATE TABLE t (a int2);',
        errors: 1,
      },
      {
        name: 'a column added later',
        sql: 'ALTER TABLE t ADD COLUMN a smallint;',
        errors: 1,
      },
    ],
  },
});
