import { defineRule } from '../define-rule.ts';

export const requireTableSchema = defineRule<void>({
  name: 'require-table-schema',
  meta: {
    description: 'Schema-qualify new tables.',
    rationale:
      'An unqualified name resolves through search_path, which differs between the migration ' +
      'runner, psql and the application. The table can land in a schema nobody intended.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      CreateStmt(node, path) {
        if (node.relation?.schemaname) return;

        context.report({
          statement: path.statement,
          message: `Table ${node.relation?.relname ?? 'this table'} is not schema-qualified, so where it lands depends on search_path.`,
          help: `Write it as <schema>.${node.relation?.relname ?? 'table'}.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'CREATE TABLE public.thing (a int);',
      'CREATE TABLE internal.thing (a int);',
      { name: 'altering a table does not create one', sql: 'ALTER TABLE thing ADD COLUMN c int;' },
      { name: 'indexes are not tables', sql: 'CREATE INDEX CONCURRENTLY idx ON thing (a);' },
    ],
    invalid: [
      {
        sql: 'CREATE TABLE thing (a int);',
        errors: [{ line: 1, column: 1, message: 'Table thing is not schema-qualified' }],
      },
      {
        name: 'explains the search_path hazard',
        sql: 'CREATE TABLE thing (a int);',
        errors: [{ message: 'where it lands depends on search_path' }],
      },
      {
        name: 'each unqualified table is reported',
        sql: 'CREATE TABLE a (x int);\nCREATE TABLE b (y int);',
        errors: 2,
      },
    ],
  },
});
