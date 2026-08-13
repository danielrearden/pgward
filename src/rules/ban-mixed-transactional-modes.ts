import { isResetStatement, isSetStatement, isTransactionControl, usesConcurrently } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface BanMixedTransactionalModesOptions {
  /**
   * Whether a migration made up entirely of CONCURRENTLY statements and
   * session settings still has to declare itself non-transactional. It does by
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
    defaultOptions: { requireDeclarationWhenOnlyConcurrent: true },
  },
  create(context) {
    const { options, source } = context;

    return {
      'file:exit'() {
        // The file is already declared non-transactional; nothing to enforce.
        if (!source.transactions.implicit) return;

        const concurrent = source.statements.filter(usesConcurrently);
        if (concurrent.length === 0) return;

        const transactional = source.statements.filter(
          (statement) =>
            !usesConcurrently(statement) &&
            !isSetStatement(statement) &&
            !isResetStatement(statement) &&
            !isTransactionControl(statement),
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
    ],
  },
});
