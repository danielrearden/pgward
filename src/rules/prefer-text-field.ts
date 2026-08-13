import { hasTypeModifiers, typeNameOf } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface PreferTextFieldOptions {
  /**
   * Also flag `varchar` with no length. It behaves identically to text, so
   * this is style rather than safety, and is off by default.
   */
  flagUnboundedVarchar: boolean;
}

export const preferTextField = defineRule<PreferTextFieldOptions>({
  name: 'prefer-text-field',
  meta: {
    description: 'Use text instead of varchar(n).',
    rationale:
      'Changing a varchar(n) length is a schema migration that takes ACCESS EXCLUSIVE; ' +
      'changing a CHECK constraint on a text column can be done NOT VALID and validated online.',
    defaultSeverity: 'error',
    defaultOptions: { flagUnboundedVarchar: false },
  },
  create(context) {
    return {
      ColumnDef(node, path) {
        if (typeNameOf(node.typeName) !== 'varchar') return;

        const bounded = hasTypeModifiers(node.typeName);
        if (!bounded && !context.options.flagUnboundedVarchar) return;

        const column = node.colname ? `Column ${node.colname}` : 'This column';
        context.report({
          statement: path.statement,
          message: bounded
            ? `${column} is varchar(n); changing the length later rewrites the table.`
            : `${column} is varchar, which behaves identically to text.`,
          help: bounded
            ? 'Use text with a CHECK constraint — the length can then be changed online with ' +
              'NOT VALID plus VALIDATE.'
            : 'Use text, for consistency.',
        });
      },
    };
  },
  tests: {
    valid: [
      'CREATE TABLE t (name text);',
      'CREATE TABLE t (a int);',
      {
        name: 'unbounded varchar behaves like text, so it passes by default',
        sql: 'CREATE TABLE t (name varchar);',
      },
      {
        name: 'char is a different rule’s business',
        sql: 'CREATE TABLE t (code char(2));',
      },
    ],
    invalid: [
      {
        sql: 'CREATE TABLE t (name varchar(20));',
        errors: [{ line: 1, column: 1, message: 'Column name is varchar(n)' }],
      },
      {
        name: 'explains why a CHECK is easier to change',
        sql: 'CREATE TABLE t (name varchar(20));',
        errors: [{ help: 'changed online with NOT VALID plus VALIDATE' }],
      },
      {
        name: 'the character varying spelling too',
        sql: 'ALTER TABLE t ADD COLUMN name character varying(20);',
        errors: 1,
      },
      {
        name: 'unbounded varchar when explicitly flagged',
        sql: 'CREATE TABLE t (name varchar);',
        options: { flagUnboundedVarchar: true },
        errors: [{ message: 'behaves identically to text' }],
      },
      {
        name: 'each offending column is reported',
        sql: 'CREATE TABLE t (a varchar(1), b varchar(2));',
        errors: 2,
      },
    ],
  },
});
