import { checkTimeoutValue } from '../analysis/timeout-check.ts';
import { defineRule } from '../define-rule.ts';

export interface BoundStatementTimeoutOptions {
  /** Ceiling for `statement_timeout`, in whole minutes. */
  maxMinutes: number;
  /** Unit the literal must be written in. Null accepts any unit. */
  requiredUnit: string | null;
  /** Whether `SET statement_timeout = DEFAULT` is acceptable. */
  allowDefault: boolean;
  /** Whether `0` — which disables the timeout — is rejected. */
  banZero: boolean;
  /**
   * The driver's socket timeout in milliseconds. A statement_timeout at or
   * above it can never fire: the connection dies first. Null disables the check.
   */
  driverSocketTimeoutMs: number | null;
}

export const boundStatementTimeout = defineRule<BoundStatementTimeoutOptions>({
  name: 'bound-statement-timeout',
  meta: {
    description: 'Keep every statement_timeout assignment readable and within the ceiling.',
    rationale:
      'Every assignment is checked, not just the largest — `SET statement_timeout = \'45min\'` ' +
      'followed by `SET statement_timeout = \'0\'` leaves the timeout disabled.',
    defaultSeverity: 'error',
    defaultOptions: {
      maxMinutes: 45,
      requiredUnit: 'min',
      allowDefault: true,
      banZero: true,
      driverSocketTimeoutMs: 3_600_000,
    },
  },
  create(context) {
    const { options, source } = context;
    const policy = {
      maxMs: options.maxMinutes * 60_000,
      requiredUnit: options.requiredUnit,
      allowDefault: options.allowDefault,
      banZero: options.banZero,
      ceilingMs: options.driverSocketTimeoutMs,
      ceilingLabel: "the driver's socket timeout",
    };

    return {
      'file:exit'() {
        for (const assignment of source.sessionSettings.assignments('statement_timeout')) {
          const problem = checkTimeoutValue(assignment.kind, assignment.raw, policy);
          if (!problem) continue;

          const statement = source.statements[assignment.statementIndex];
          context.report({
            ...(statement ? { statement } : {}),
            message: `This statement_timeout ${problem}.`,
            help:
              `Set it to at most ${options.maxMinutes} minutes` +
              `${options.requiredUnit ? `, written in whole ${options.requiredUnit}` : ''}.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      "SET statement_timeout = '45min';",
      "SET statement_timeout = '5min';",
      'SET statement_timeout = DEFAULT;',
      'RESET statement_timeout;',
      'RESET ALL;',
      { name: 'other settings are not this rule’s business', sql: "SET lock_timeout = '3s';" },
      {
        name: 'a different unit when none is required',
        sql: "SET statement_timeout = '30s';",
        options: { requiredUnit: null },
      },
      {
        name: 'zero when explicitly permitted',
        sql: "SET statement_timeout = '0';",
        options: { banZero: false, requiredUnit: null },
      },
    ],
    invalid: [
      {
        name: 'zero disables the timeout outright',
        sql: "SET statement_timeout = '0';",
        errors: [{ line: 1, column: 1, message: 'is set to 0, which disables the timeout entirely' }],
      },
      {
        name: 'above the ceiling',
        sql: "SET statement_timeout = '90min';",
        errors: [{ message: 'is 90min, above the 45min maximum' }],
      },
      {
        name: 'the wrong unit, with the right one suggested',
        sql: "SET statement_timeout = '60s';",
        errors: [{ message: /whole minutes \(e\.g\. '1min'\)/ }],
      },
      {
        name: 'every assignment is checked, not just the largest',
        sql: "SET statement_timeout = '45min';\nSET statement_timeout = '0';",
        errors: [{ line: 2, message: 'disables the timeout entirely' }],
      },
      {
        name: 'DEFAULT when it is not allowed',
        sql: 'SET statement_timeout = DEFAULT;',
        options: { allowDefault: false },
        errors: [{ message: 'is set to DEFAULT, which this project does not allow' }],
      },
      {
        name: 'at or above the driver socket timeout it can never fire',
        sql: "SET statement_timeout = '60min';",
        options: { maxMinutes: 120 },
        errors: [{ message: 'connection drops before it fires' }],
      },
      {
        name: 'a lower configured ceiling',
        sql: "SET statement_timeout = '20min';",
        options: { maxMinutes: 10 },
        errors: [{ message: 'above the 10min maximum' }],
      },
    ],
  },
});
