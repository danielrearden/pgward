import { defineRule } from '../define-rule.ts';
import { assertKnownStatementKinds, matchesAnyStatementKind } from '../statement-kinds.ts';

export interface LimitLongRunningStatementsOptions {
  /** How many long-running statements a single migration may contain. */
  maxPerMigration: number;
  /** Which statements count towards the limit. */
  countedStatements: string[];
}

export const limitLongRunningStatements = defineRule<LimitLongRunningStatementsOptions>({
  name: 'limit-long-running-statements',
  meta: {
    description: 'Cap the number of long-running statements in one migration.',
    rationale:
      "The timeout budget is per statement, but the deploy job's ceiling covers the whole run. " +
      'Two hour-long index builds in one file fit every per-statement limit and still blow the ' +
      'deploy budget.',
    help: 'Split the rest into separate migrations.',
    defaultSeverity: 'error',
    defaultOptions: {
      maxPerMigration: 1,
      // A paired DROP INDEX CONCURRENTLY is cheap; only the build is slow.
      countedStatements: ['CREATE INDEX CONCURRENTLY'],
    },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      assertKnownStatementKinds(
        'limit-long-running-statements',
        'countedStatements',
        options.countedStatements,
      );
      if (!Number.isInteger(options.maxPerMigration) || options.maxPerMigration < 0) {
        throw new TypeError(
          `pgward: rule "limit-long-running-statements" option maxPerMigration must be a ` +
            `non-negative integer, got ${String(options.maxPerMigration)}`,
        );
      }
      return options;
    },
  },
  create(context) {
    const { options, source } = context;

    return {
      'file:exit'() {
        const matched = source.statements.filter((statement) =>
          matchesAnyStatementKind(statement, options.countedStatements),
        );
        if (matched.length <= options.maxPerMigration) return;

        for (const statement of matched.slice(options.maxPerMigration)) {
          context.report({
            statement,
            message: `This migration has ${matched.length} long-running statements; at most ${options.maxPerMigration} is allowed.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'CREATE INDEX CONCURRENTLY idx ON t (a);',
      {
        name: 'one build plus unrelated statements',
        sql: "SET statement_timeout = '45min';\nCREATE INDEX CONCURRENTLY idx ON t (a);\nRESET statement_timeout;",
      },
      {
        name: 'a paired concurrent drop is not a build',
        sql: 'DROP INDEX CONCURRENTLY old_idx;\nCREATE INDEX CONCURRENTLY new_idx ON t (a);',
      },
      {
        name: 'a plain build is not counted by default',
        sql: 'CREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX b ON t (y);',
      },
      {
        name: 'a higher limit',
        sql: 'CREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);',
        options: { maxPerMigration: 2 },
      },
    ],
    invalid: [
      {
        name: 'two builds in one migration',
        sql: 'CREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);',
        errors: [{ line: 2, message: 'This migration has 2 long-running statements' }],
      },
      {
        name: 'reports every statement past the limit',
        sql: 'CREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);\nCREATE INDEX CONCURRENTLY c ON t (z);',
        errors: 2,
      },
      {
        name: 'the counted set is configurable',
        sql: 'ALTER TABLE a ADD COLUMN x int;\nALTER TABLE b ADD COLUMN y int;',
        options: { countedStatements: ['ALTER TABLE'] },
        errors: 1,
      },
      {
        name: 'a limit of zero forbids them entirely',
        sql: 'CREATE INDEX CONCURRENTLY a ON t (x);',
        options: { maxPerMigration: 0 },
        errors: 1,
      },
    ],
  },
});
