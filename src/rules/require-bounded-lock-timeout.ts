import { describeMs, parseDuration } from '../analysis/duration.ts';
import { alterTableCommands, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';
import { assertKnownStatementKinds, matchesAnyStatementKind } from '../statement-kinds.ts';
import type { Statement } from '../types.ts';

export interface RequireBoundedLockTimeoutOptions {
  /** The largest `lock_timeout` that counts as bounded. */
  maxMs: number;
  /** Statements that must run under a bounded timeout. */
  guardedStatements: string[];
  /**
   * `ALTER TABLE` subcommands that don't take a disruptive lock and so don't
   * need the guard.
   */
  exemptSubcommands: string[];
  /**
   * Only exempt a statement when the exempt subcommand is the *only* one.
   * `ALTER TABLE t VALIDATE CONSTRAINT c, ADD COLUMN x int` takes the strong
   * lock the second command needs, so the list as a whole isn't exempt.
   */
  exemptSingleOnly: boolean;
}

const EXEMPT_MATCHERS: Record<string, (cmd: AstNode) => boolean> = {
  'VALIDATE CONSTRAINT': (cmd) => cmd['subtype'] === 'AT_ValidateConstraint',
  'SET STATISTICS': (cmd) => cmd['subtype'] === 'AT_SetStatistics',
  'SET STORAGE': (cmd) => cmd['subtype'] === 'AT_SetStorage',
  'SET (...)': (cmd) =>
    cmd['subtype'] === 'AT_SetRelOptions' || cmd['subtype'] === 'AT_ResetRelOptions',
  'ATTACH PARTITION': (cmd) => cmd['subtype'] === 'AT_AttachPartition',
  'DETACH PARTITION CONCURRENTLY': (cmd) =>
    cmd['subtype'] === 'AT_DetachPartition' && Boolean(cmd['def']?.['PartitionCmd']?.['concurrent']),
};

function normalizeSubcommand(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .replace(/\(\s*(?:…|\.\.\.)?\s*\)/, '(...)');
}

export const requireBoundedLockTimeout = defineRule<RequireBoundedLockTimeoutOptions>({
  name: 'require-bounded-lock-timeout',
  meta: {
    description: 'Take disruptive locks only under a bounded lock_timeout.',
    rationale:
      'Without a bounded lock_timeout, a statement waiting on ACCESS EXCLUSIVE queues behind ' +
      'every open transaction and blocks every query arriving after it. This checks the value ' +
      'actually in effect at each statement, so an intervening RESET is caught.',
    defaultSeverity: 'error',
    defaultOptions: {
      maxMs: 15_000,
      guardedStatements: ['ALTER TABLE', 'DROP TABLE', 'TRUNCATE'],
      exemptSubcommands: [
        'VALIDATE CONSTRAINT',
        'SET STATISTICS',
        'SET (...)',
        'DETACH PARTITION CONCURRENTLY',
      ],
      exemptSingleOnly: true,
    },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      assertKnownStatementKinds(
        'require-bounded-lock-timeout',
        'guardedStatements',
        options.guardedStatements,
      );
      for (const name of options.exemptSubcommands) {
        if (!EXEMPT_MATCHERS[normalizeSubcommand(name)]) {
          throw new TypeError(
            `pgward: rule "require-bounded-lock-timeout" option exemptSubcommands has unknown ` +
              `subcommand ${JSON.stringify(name)}. Known: ${Object.keys(EXEMPT_MATCHERS).join(', ')}`,
          );
        }
      }
      return options;
    },
  },
  create(context) {
    const { options, source } = context;

    const isExempt = (statement: Statement): boolean => {
      if (statement.type !== 'AlterTableStmt') return false;
      const commands = alterTableCommands(statement.node);
      if (commands.length === 0) return false;
      if (options.exemptSingleOnly && commands.length > 1) return false;

      return commands.every((command) =>
        options.exemptSubcommands.some((name) =>
          EXEMPT_MATCHERS[normalizeSubcommand(name)]?.(command),
        ),
      );
    };

    return {
      statement(statement) {
        if (!matchesAnyStatementKind(statement, options.guardedStatements)) return;
        if (isExempt(statement)) return;

        const effective = source.sessionSettings.effective(statement.index, 'lock_timeout');
        const limit = describeMs(options.maxMs);

        if (!effective) {
          context.report({
            statement,
            message: 'No lock_timeout is in effect for this statement.',
            help: `Set one of at most ${limit} before it — and check nothing RESETs it in between.`,
          });
          return;
        }

        const duration = parseDuration(effective.raw ?? '');
        if (!duration) {
          context.report({
            statement,
            message: `The lock_timeout in effect here (${JSON.stringify(effective.raw)}) could not be read as a duration.`,
            help: `Set it to a duration of at most ${limit}.`,
          });
          return;
        }

        if (duration.disabled) {
          context.report({
            statement,
            message: 'The lock_timeout in effect here is 0, which disables it entirely.',
            help: `Set a value of at most ${limit}.`,
          });
          return;
        }

        if (duration.ms > options.maxMs) {
          context.report({
            statement,
            message: `The lock_timeout in effect here is ${describeMs(duration.ms)}, above the ${limit} maximum.`,
            help: `Lower it to at most ${limit}.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'a bounded timeout set before the statement',
        sql: "SET lock_timeout = '3s';\nALTER TABLE t ADD COLUMN c int;",
      },
      {
        name: 'exactly at the maximum',
        sql: "SET lock_timeout = '15s';\nALTER TABLE t ADD COLUMN c int;",
      },
      {
        name: 'a bare integer is read as milliseconds',
        sql: 'SET lock_timeout = 15000;\nALTER TABLE t ADD COLUMN c int;',
      },
      {
        name: 'still in effect for a later statement',
        sql: "SET lock_timeout = '3s';\nALTER TABLE a ADD COLUMN c int;\nALTER TABLE b ADD COLUMN d int;",
      },
      {
        name: 'SET LOCAL inside a transaction',
        sql: "BEGIN;\nSET LOCAL lock_timeout = '3s';\nALTER TABLE t ADD COLUMN c int;\nCOMMIT;",
      },
      {
        name: 'unguarded statements need no timeout',
        sql: 'CREATE INDEX CONCURRENTLY idx ON t (a);\nSELECT 1;',
      },
      {
        name: 'VALIDATE CONSTRAINT is exempt — it takes no disruptive lock',
        sql: 'ALTER TABLE t VALIDATE CONSTRAINT c;',
      },
      {
        name: 'SET STATISTICS is exempt',
        sql: 'ALTER TABLE t ALTER COLUMN a SET STATISTICS 100;',
      },
      {
        name: 'DETACH PARTITION CONCURRENTLY is exempt',
        sql: 'ALTER TABLE t DETACH PARTITION p CONCURRENTLY;',
      },
      {
        name: 'a higher configured maximum',
        sql: "SET lock_timeout = '30s';\nALTER TABLE t ADD COLUMN c int;",
        options: { maxMs: 30_000 },
      },
      {
        name: 'a statement kind that is not guarded',
        sql: 'DROP TABLE t;',
        options: { guardedStatements: ['ALTER TABLE'] },
      },
    ],
    invalid: [
      {
        name: 'no timeout at all',
        sql: 'ALTER TABLE t ADD COLUMN c int;',
        errors: [{ line: 1, column: 1, message: 'No lock_timeout is in effect' }],
      },
      {
        name: 'a RESET in between — the shape a presence check passes',
        sql: "SET lock_timeout = '3s';\nRESET lock_timeout;\nALTER TABLE t ADD COLUMN c int;",
        errors: [{ line: 3, message: 'No lock_timeout is in effect' }],
      },
      {
        name: 'RESET ALL in between',
        sql: "SET lock_timeout = '3s';\nRESET ALL;\nALTER TABLE t ADD COLUMN c int;",
        errors: [{ line: 3, message: 'No lock_timeout is in effect' }],
      },
      {
        name: 'above the maximum',
        sql: "SET lock_timeout = '30s';\nALTER TABLE t ADD COLUMN c int;",
        errors: [{ line: 2, message: 'is 30s, above the 15s maximum' }],
      },
      {
        name: 'zero disables the timeout',
        sql: "SET lock_timeout = '0';\nALTER TABLE t ADD COLUMN c int;",
        errors: [{ line: 2, message: 'is 0, which disables it entirely' }],
      },
      {
        name: 'SET LOCAL expires with its transaction',
        sql: "BEGIN;\nSET LOCAL lock_timeout = '3s';\nCOMMIT;\nALTER TABLE t ADD COLUMN c int;",
        errors: [{ line: 4, message: 'No lock_timeout is in effect' }],
      },
      {
        name: 'DROP TABLE and TRUNCATE are guarded too',
        sql: 'DROP TABLE a;\nTRUNCATE b;',
        errors: 2,
      },
      {
        name: 'an exempt subcommand in a list is not exempt',
        sql: 'ALTER TABLE t VALIDATE CONSTRAINT c, ADD COLUMN x int;',
        errors: [{ message: 'No lock_timeout is in effect' }],
      },
      {
        name: 'exemptSingleOnly can be relaxed',
        sql: 'ALTER TABLE t VALIDATE CONSTRAINT c, ADD COLUMN x int;',
        options: { exemptSingleOnly: false },
        errors: 1,
      },
      {
        name: 'an unreadable value is not a bounded timeout',
        sql: "SET lock_timeout = 'soon';\nALTER TABLE t ADD COLUMN c int;",
        errors: [{ message: 'could not be read as a duration' }],
      },
    ],
  },
});
