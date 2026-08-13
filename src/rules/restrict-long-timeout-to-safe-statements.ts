import { describeMs, parseDuration } from '../analysis/duration.ts';
import { defineRule } from '../define-rule.ts';
import { assertKnownStatementKinds, matchesAnyStatementKind } from '../statement-kinds.ts';

export interface RestrictLongTimeoutToSafeStatementsOptions {
  /**
   * A `statement_timeout` above this counts as raised. `0` — the timeout
   * disabled outright — always counts.
   */
  raisedAboveMs: number;
  /** Statements that are safe to run for a long time. */
  safeStatements: string[];
}

export const restrictLongTimeoutToSafeStatements =
  defineRule<RestrictLongTimeoutToSafeStatementsOptions>({
    name: 'restrict-long-timeout-to-safe-statements',
    meta: {
      description:
        'A migration that raises statement_timeout may contain only statements safe to run long.',
      rationale:
        'A concurrent index build blocks no traffic, so giving it an hour is fine. An ALTER ' +
        'TABLE or a backfill does not become safe by being given more time — it just holds ' +
        'its lock for longer.',
      help: 'Move this statement to its own migration.',
      defaultSeverity: 'error',
      defaultOptions: {
        raisedAboveMs: 60_000,
        safeStatements: ['CREATE INDEX CONCURRENTLY', 'DROP INDEX CONCURRENTLY', 'SET', 'RESET'],
      },
      normalizeOptions(raw, defaults) {
        const options = { ...defaults, ...(raw as object) };
        assertKnownStatementKinds(
          'restrict-long-timeout-to-safe-statements',
          'safeStatements',
          options.safeStatements,
        );
        return options;
      },
    },
    create(context) {
      const { options, source } = context;

      return {
        'file:exit'() {
          let raisedTo: string | null = null;

          for (const assignment of source.sessionSettings.assignments('statement_timeout')) {
            if (assignment.kind !== 'set' && assignment.kind !== 'set_local') continue;
            const duration = parseDuration(assignment.raw ?? '');
            if (!duration) continue;
            if (duration.disabled) {
              raisedTo = 'disabled (0)';
              break;
            }
            if (duration.ms > options.raisedAboveMs) {
              raisedTo = describeMs(duration.ms);
              break;
            }
          }

          if (raisedTo === null) return;

          for (const statement of source.statements) {
            if (matchesAnyStatementKind(statement, options.safeStatements)) continue;
            context.report({
              statement,
              message: `This migration raises statement_timeout to ${raisedTo}, so it may contain only ${formatList(options.safeStatements)}.`,
            });
          }
        },
      };
    },
    tests: {
      valid: [
        {
          name: 'a raised timeout with only a concurrent build',
          sql: "SET statement_timeout = '45min';\nCREATE INDEX CONCURRENTLY idx ON t (a);\nRESET statement_timeout;",
        },
        {
          name: 'a raised timeout with a concurrent drop',
          sql: "SET statement_timeout = '45min';\nDROP INDEX CONCURRENTLY idx;",
        },
        {
          name: 'no raise, so anything goes',
          sql: 'ALTER TABLE t ADD COLUMN c int;\nUPDATE t SET c = 1;',
        },
        {
          name: 'a timeout below the raise threshold',
          sql: "SET statement_timeout = '30s';\nALTER TABLE t ADD COLUMN c int;",
        },
        {
          name: 'the safe list is configurable',
          sql: "SET statement_timeout = '45min';\nUPDATE t SET c = 1;",
          options: { safeStatements: ['SET', 'RESET', 'UPDATE'] },
        },
      ],
      invalid: [
        {
          name: 'a rewrite does not become safe by being given more time',
          sql: "SET statement_timeout = '45min';\nALTER TABLE t ADD COLUMN c int;",
          errors: [{ line: 2, message: 'raises statement_timeout to 45min' }],
        },
        {
          name: 'a backfill alongside the build',
          sql: "SET statement_timeout = '45min';\nCREATE INDEX CONCURRENTLY idx ON t (a);\nUPDATE t SET c = 1;",
          errors: [{ line: 3, help: 'Move this statement to its own migration' }],
        },
        {
          name: 'disabling the timeout counts as raising it',
          sql: "SET statement_timeout = '0';\nALTER TABLE t ADD COLUMN c int;",
          errors: [{ message: 'raises statement_timeout to disabled (0)' }],
        },
        {
          name: 'every unsafe statement is reported',
          sql: "SET statement_timeout = '45min';\nALTER TABLE a ADD COLUMN c int;\nALTER TABLE b ADD COLUMN d int;",
          errors: 2,
        },
        {
          name: 'a lower raise threshold catches more',
          sql: "SET statement_timeout = '30s';\nALTER TABLE t ADD COLUMN c int;",
          options: { raisedAboveMs: 10_000 },
          errors: 1,
        },
      ],
    },
  });

function formatList(items: readonly string[]): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
