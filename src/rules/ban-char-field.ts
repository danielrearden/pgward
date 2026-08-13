import { typeNameOf } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const banCharField = defineRule<void>({
  name: 'ban-char-field',
  meta: {
    description: 'Do not use char(n).',
    rationale:
      'char(n) blank-pads every value to the full width, so comparisons and concatenation ' +
      'behave differently from text and varchar. Use text with a CHECK on length instead.',
    help: 'Use text, with a CHECK constraint if the length matters.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      ColumnDef(node, path) {
        // Postgres canonicalizes `char`/`character` to `bpchar` — blank-padded char.
        if (typeNameOf(node.typeName) !== 'bpchar') return;

        const column = node.colname ? `Column ${node.colname}` : 'This column';
        context.report({
          statement: path.statement,
          message: `${column} is char(n), which blank-pads every value to the full width.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'CREATE TABLE t (code text);',
      'CREATE TABLE t (code varchar(10));',
      'CREATE TABLE t (a int);',
    ],
    invalid: [
      {
        sql: 'CREATE TABLE t (code char(10));',
        errors: [{ line: 1, column: 1, message: 'Column code is char(n), which blank-pads' }],
      },
      {
        name: 'the character spelling too',
        sql: 'CREATE TABLE t (code character(10));',
        errors: 1,
      },
      {
        name: 'char with no length is still blank-padded',
        sql: 'CREATE TABLE t (code char);',
        errors: 1,
      },
      {
        name: 'points at the text replacement',
        sql: 'ALTER TABLE t ADD COLUMN code char(2);',
        errors: [{ help: 'Use text, with a CHECK constraint if the length matters' }],
      },
      {
        name: 'each offending column is reported',
        sql: 'CREATE TABLE t (a char(2), b char(3));',
        errors: 2,
      },
    ],
  },
});
