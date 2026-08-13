import { isTransactionControl, usesConcurrently } from '../ast.ts';
import { defineRule } from '../define-rule.ts';
import { assertKnownStatementKinds, matchesAnyStatementKind } from '../statement-kinds.ts';

export interface BanMixedTransactionalModesOptions {
  /**
   * Statement kinds the runner doesn't count when it decides a file mixes
   * execution modes. `SET` and `RESET` by default, which is what a runner that
   * special-cases session settings does.
   *
   * Which statements get that treatment is the runner's business, not
   * Postgres's: Flyway counts them like any other, so a `SET` beside a
   * concurrent build is rejected at parse time on the deploy. Pass `[]` for a
   * runner like that.
   */
  exemptStatements: string[];
  /**
   * Whether a migration made up entirely of CONCURRENTLY statements and
   * exempt statements still has to declare itself non-transactional. It does by
   * default: the runner wraps it regardless, and CONCURRENTLY cannot run
   * inside a transaction block.
   *
   * Set false when your runner detects such migrations and skips the wrap.
   */
  requireDeclarationWhenOnlyConcurrent: boolean;
}

export const banMixedTransactionalModes = defineRule<BanMixedTransactionalModesOptions>({
  name: 'ban-mixed-transactional-modes',
  meta: {
    description: 'Migrations using CONCURRENTLY must declare themselves non-transactional.',
    rationale:
      'CONCURRENTLY cannot run inside a transaction block. The runner wraps every migration ' +
      'unless told otherwise, so an undeclared file fails on the production deploy rather than ' +
      'in review.',
    help: "Declare this migration non-transactional so the runner doesn't wrap it.",
    defaultSeverity: 'error',
    defaultOptions: {
      exemptStatements: ['SET', 'RESET'],
      requireDeclarationWhenOnlyConcurrent: true,
    },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      assertKnownStatementKinds(
        'ban-mixed-transactional-modes',
        'exemptStatements',
        options.exemptStatements,
      );
      return options;
    },
  },
  create(context) {
    const { options, source } = context;

    return {
      'file:exit'() {
        // The file is already declared non-transactional; nothing to enforce.
        if (!source.transactions.implicit) return;

        const concurrent = source.statements.filter(usesConcurrently);
        if (concurrent.length === 0) return;

        // BEGIN/COMMIT are never counted: they are what the mode is, not a statement the file
        // runs under it, and transaction-nesting owns them.
        const transactional = source.statements.filter(
          (statement) =>
            !usesConcurrently(statement) &&
            !isTransactionControl(statement) &&
            !matchesAnyStatementKind(statement, options.exemptStatements),
        );

        if (transactional.length === 0 && !options.requireDeclarationWhenOnlyConcurrent) return;

        const detail =
          transactional.length > 0
            ? `it also contains ${transactional.length} transactional statement` +
              `${transactional.length === 1 ? '' : 's'}`
            : 'the runner still wraps it in a transaction';

        for (const statement of concurrent) {
          context.report({
            statement,
            message: `This statement uses CONCURRENTLY but the migration is not declared non-transactional, and ${detail}.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'the file declares itself non-transactional',
        sql: "SET statement_timeout = '45min';\nCREATE INDEX CONCURRENTLY idx ON t (a);",
        implicitTransaction: false,
      },
      {
        name: 'a concurrent drop with the declaration in place',
        sql: 'DROP INDEX CONCURRENTLY idx;\nALTER TABLE t ADD COLUMN c int;',
        implicitTransaction: false,
      },
      {
        name: 'no CONCURRENTLY at all, so the wrap is fine',
        sql: 'ALTER TABLE t ADD COLUMN c int;\nUPDATE t SET c = 1;',
      },
      {
        name: 'the runner default can be flipped globally',
        sql: 'CREATE INDEX CONCURRENTLY idx ON t (a);',
        settings: { implicitTransaction: false },
      },
      {
        name: 'a concurrent-only migration can be exempted',
        sql: 'REINDEX TABLE CONCURRENTLY t;',
        options: { requireDeclarationWhenOnlyConcurrent: false },
      },
      {
        name: 'session settings do not count against the exemption',
        sql: "SET statement_timeout = '45min';\nRESET lock_timeout;\nREINDEX TABLE CONCURRENTLY t;",
        options: { requireDeclarationWhenOnlyConcurrent: false },
      },
      {
        name: 'a runner that counts settings still accepts a concurrent-only file',
        sql: 'CREATE INDEX CONCURRENTLY idx ON t (a);',
        options: { exemptStatements: [], requireDeclarationWhenOnlyConcurrent: false },
      },
      {
        name: 'widening the exemption covers another statement kind',
        sql: 'CREATE INDEX CONCURRENTLY idx ON t (a);\nTRUNCATE t;',
        options: { exemptStatements: ['TRUNCATE'], requireDeclarationWhenOnlyConcurrent: false },
      },
    ],
    invalid: [
      {
        name: 'CONCURRENTLY in a migration the runner will wrap',
        sql: 'CREATE INDEX CONCURRENTLY idx ON t (a);\nALTER TABLE t ADD COLUMN c int;',
        errors: [
          {
            line: 1,
            column: 1,
            message: 'not declared non-transactional',
          },
        ],
      },
      {
        name: 'counts the transactional statements it is mixed with',
        sql: 'CREATE INDEX CONCURRENTLY idx ON t (a);\nALTER TABLE a ADD COLUMN c int;\nALTER TABLE b ADD COLUMN d int;',
        errors: [{ message: 'it also contains 2 transactional statements' }],
      },
      {
        name: 'a concurrent-only migration is still wrapped, and points at the fix',
        sql: 'CREATE INDEX CONCURRENTLY idx ON t (a);',
        errors: [
          {
            message: 'the runner still wraps it in a transaction',
            help: 'Declare this migration non-transactional',
          },
        ],
      },
      {
        name: 'reports each concurrent statement',
        sql: 'CREATE INDEX CONCURRENTLY a ON t (x);\nDROP INDEX CONCURRENTLY b;',
        errors: 2,
      },
      {
        name: 'a concurrent-only migration is not exempt by default',
        sql: 'REINDEX TABLE CONCURRENTLY t;',
        options: { requireDeclarationWhenOnlyConcurrent: true },
        errors: 1,
      },
      {
        name: 'the exemption does not extend to a mixed migration',
        sql: 'REINDEX TABLE CONCURRENTLY t;\nALTER TABLE t ADD COLUMN c int;',
        options: { requireDeclarationWhenOnlyConcurrent: false },
        errors: [{ message: 'it also contains 1 transactional statement' }],
      },
      {
        // Flyway is one of these: it marks a SET as executable in a transaction, so it refuses
        // the file at parse time rather than running it.
        name: 'a runner that counts settings rejects a SET beside a concurrent build',
        sql: "SET statement_timeout = '45min';\nCREATE INDEX CONCURRENTLY idx ON t (a);\nRESET statement_timeout;",
        options: { exemptStatements: [], requireDeclarationWhenOnlyConcurrent: false },
        errors: [{ line: 2, message: 'it also contains 2 transactional statements' }],
      },
    ],
  },
});
