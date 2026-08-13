import { describeType, typeNameOf } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface PreferTimestamptzOptions {
  /** Type name to the type that should be used instead. */
  replacements: Record<string, string>;
}

export const preferTimestamptz = defineRule<PreferTimestamptzOptions>({
  name: 'prefer-timestamptz',
  meta: {
    description: 'Use timestamptz instead of timestamp.',
    rationale:
      '`timestamp` discards the offset, so the same value means different instants depending on ' +
      "the writer's timezone. Changing the type later rewrites the table.",
    defaultSeverity: 'error',
    defaultOptions: {
      replacements: { timestamp: 'timestamptz', time: 'timetz' },
    },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      const replacements: Record<string, string> = {};
      for (const [from, to] of Object.entries(options.replacements)) {
        replacements[from.toLowerCase()] = String(to);
      }
      return { ...options, replacements };
    },
  },
  create(context) {
    return {
      ColumnDef(node, path) {
        const type = typeNameOf(node.typeName);
        const replacement = context.options.replacements[type];
        if (!replacement) return;

        const column = node.colname ? `Column ${node.colname}` : 'This column';
        context.report({
          statement: path.statement,
          message: `${column} is ${describeType(node.typeName)}. Without an offset the same value means different instants to different writers.`,
          help: `Use ${replacement}.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'CREATE TABLE t (created_at timestamptz);',
      'CREATE TABLE t (created_at timestamp with time zone);',
      'CREATE TABLE t (a int, b text, c date);',
      'ALTER TABLE t ADD COLUMN created_at timestamptz;',
      {
        name: 'the replacement map is configurable',
        sql: 'CREATE TABLE t (created_at timestamp);',
        options: { replacements: {} },
      },
    ],
    invalid: [
      {
        name: 'timestamp without time zone',
        sql: 'CREATE TABLE t (created_at timestamp);',
        errors: [
          { line: 1, column: 1, message: 'Column created_at is timestamp', help: 'Use timestamptz' },
        ],
      },
      {
        name: 'the explicit spelling too',
        sql: 'CREATE TABLE t (created_at timestamp without time zone);',
        errors: 1,
      },
      {
        name: 'explains the offset problem',
        sql: 'CREATE TABLE t (created_at timestamp);',
        errors: [{ message: 'different instants to different writers' }],
      },
      {
        name: 'a column added later',
        sql: 'ALTER TABLE t ADD COLUMN created_at timestamp;',
        errors: 1,
      },
      {
        name: 'a column whose type is changed to timestamp',
        sql: 'ALTER TABLE t ALTER COLUMN created_at TYPE timestamp;',
        errors: 1,
      },
      {
        name: 'time without time zone is covered too',
        sql: 'CREATE TABLE t (at time);',
        errors: [{ help: 'Use timetz' }],
      },
      {
        name: 'each offending column is reported',
        sql: 'CREATE TABLE t (a timestamp, b timestamp);',
        errors: 2,
      },
    ],
  },
});
