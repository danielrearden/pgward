import { type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';
import { matchesStatementKind, normalizeStatementKind } from '../statement-kinds.ts';

export interface PreferRobustStmtsOptions {
  /** Which statements must be written idempotently. */
  checkedStatements: string[];
  /**
   * Only enforce in migrations that don't run in a transaction. A
   * transactional migration rolls back cleanly, so re-running it is already
   * safe.
   */
  onlyWhenNonTransactional: boolean;
}

interface IdempotencyCheck {
  kind: string;
  flag: string;
  suggestion: string;
}

const CHECKS: IdempotencyCheck[] = [
  { kind: 'CREATE TABLE', flag: 'if_not_exists', suggestion: 'CREATE TABLE IF NOT EXISTS' },
  { kind: 'CREATE INDEX', flag: 'if_not_exists', suggestion: 'CREATE INDEX … IF NOT EXISTS' },
  { kind: 'CREATE SCHEMA', flag: 'if_not_exists', suggestion: 'CREATE SCHEMA IF NOT EXISTS' },
  { kind: 'DROP TABLE', flag: 'missing_ok', suggestion: 'DROP TABLE IF EXISTS' },
  { kind: 'DROP INDEX', flag: 'missing_ok', suggestion: 'DROP INDEX IF EXISTS' },
  { kind: 'ALTER TABLE', flag: 'missing_ok', suggestion: 'ALTER TABLE IF EXISTS' },
];

const BY_KIND = new Map(CHECKS.map((check) => [check.kind, check]));

export const preferRobustStmts = defineRule<PreferRobustStmtsOptions>({
  name: 'prefer-robust-stmts',
  meta: {
    description: 'Write statements idempotently so a partial migration can be re-run.',
    rationale:
      'A non-transactional migration that fails halfway leaves its earlier statements applied. ' +
      'IF EXISTS / IF NOT EXISTS lets the same file be re-run instead of hand-repaired.',
    defaultSeverity: 'error',
    defaultOptions: {
      checkedStatements: [
        'CREATE TABLE',
        'CREATE INDEX',
        'CREATE SCHEMA',
        'DROP TABLE',
        'DROP INDEX',
      ],
      onlyWhenNonTransactional: false,
    },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      for (const kind of options.checkedStatements) {
        if (!BY_KIND.has(normalizeStatementKind(kind))) {
          throw new TypeError(
            `pgward: rule "prefer-robust-stmts" option checkedStatements has unsupported ` +
              `statement kind ${JSON.stringify(kind)}. Supported: ` +
              `${[...BY_KIND.keys()].join(', ')}`,
          );
        }
      }
      return options;
    },
  },
  create(context) {
    const { options, source } = context;

    return {
      statement(statement) {
        if (options.onlyWhenNonTransactional && source.transactions.inTransaction(statement.index)) {
          return;
        }

        for (const kind of options.checkedStatements) {
          const check = BY_KIND.get(normalizeStatementKind(kind));
          if (!check || !matchesStatementKind(statement, check.kind)) continue;
          if ((statement.node as AstNode)[check.flag]) continue;

          context.report({
            statement,
            message: 'As written, a partially-applied migration cannot be re-run without hand-repair.',
            help: `Write this as ${check.suggestion}.`,
          });
          return;
        }
      },
    };
  },
  tests: {
    valid: [
      'CREATE TABLE IF NOT EXISTS t (a int);',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON t (a);',
      'CREATE SCHEMA IF NOT EXISTS s;',
      'DROP TABLE IF EXISTS t;',
      'DROP INDEX CONCURRENTLY IF EXISTS idx;',
      {
        name: 'ALTER TABLE is not checked by default',
        sql: 'ALTER TABLE t ADD COLUMN c int;',
      },
      {
        name: 'unchecked statement kinds pass',
        sql: 'TRUNCATE t;',
      },
      {
        name: 'a narrower checked set',
        sql: 'CREATE TABLE t (a int);',
        options: { checkedStatements: ['DROP TABLE'] },
      },
      {
        name: 'skipped in a transactional migration when so configured',
        sql: 'CREATE TABLE t (a int);',
        options: { onlyWhenNonTransactional: true },
      },
    ],
    invalid: [
      {
        sql: 'CREATE TABLE t (a int);',
        errors: [{ line: 1, column: 1, help: 'Write this as CREATE TABLE IF NOT EXISTS' }],
      },
      {
        name: 'explains why it matters',
        sql: 'DROP TABLE t;',
        errors: [{ message: 'partially-applied migration cannot be re-run' }],
      },
      {
        name: 'a plain index build',
        sql: 'CREATE INDEX idx ON t (a);',
        errors: [{ help: 'CREATE INDEX … IF NOT EXISTS' }],
      },
      {
        name: 'still enforced in a non-transactional migration',
        sql: 'CREATE TABLE t (a int);',
        implicitTransaction: false,
        options: { onlyWhenNonTransactional: true },
        errors: 1,
      },
      {
        name: 'ALTER TABLE when explicitly checked',
        sql: 'ALTER TABLE t ADD COLUMN c int;',
        options: { checkedStatements: ['ALTER TABLE'] },
        errors: [{ help: 'ALTER TABLE IF EXISTS' }],
      },
      {
        name: 'each statement is reported once',
        sql: 'CREATE TABLE a (x int);\nDROP TABLE b;',
        errors: 2,
      },
    ],
  },
});
