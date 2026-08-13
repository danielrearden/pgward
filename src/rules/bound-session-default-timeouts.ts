import { checkTimeoutValue } from '../analysis/timeout-check.ts';
import { readAssignment } from '../analysis/settings.ts';
import { type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface BoundSessionDefaultTimeoutsOptions {
  /** Setting name to the largest value it may be defaulted to, in milliseconds. */
  governedSettings: Record<string, number>;
  /** Unit the literal must be written in. Null accepts any unit. */
  requiredUnit: string | null;
  allowDefault: boolean;
  banZero: boolean;
}

/** `ALTER ROLE|USER … SET` and `ALTER DATABASE … SET` both carry a `setstmt`. */
const CARRIERS: Record<string, string> = {
  AlterRoleSetStmt: 'role',
  AlterDatabaseSetStmt: 'database',
};

export const boundSessionDefaultTimeouts = defineRule<BoundSessionDefaultTimeoutsOptions>({
  name: 'bound-session-default-timeouts',
  meta: {
    description: 'Keep role and database default timeouts within range.',
    rationale:
      'A default set on a role or database applies to every later connection, so it escapes ' +
      'every per-migration timeout rule. A later `SET … = 0` silently reverts the guard for ' +
      'the whole fleet.',
    defaultSeverity: 'error',
    defaultOptions: {
      governedSettings: {
        statement_timeout: 600_000,
        lock_timeout: 600_000,
        idle_in_transaction_session_timeout: 600_000,
      },
      requiredUnit: 'min',
      allowDefault: true,
      banZero: true,
    },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      for (const [name, max] of Object.entries(options.governedSettings)) {
        if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
          throw new TypeError(
            `pgward: rule "bound-session-default-timeouts" option governedSettings.${name} ` +
              `must be a non-negative number of milliseconds, got ${String(max)}`,
          );
        }
      }
      return options;
    },
  },
  create(context) {
    const { options } = context;

    return {
      statement(statement) {
        const scope = CARRIERS[statement.type];
        if (!scope) return;

        const setstmt = (statement.node as AstNode)['setstmt'];
        if (!setstmt) return;

        const assignment = readAssignment(setstmt as AstNode, statement.index);
        if (!assignment) return;

        if (assignment.kind === 'reset_all') {
          context.report({
            statement,
            message: `This RESET ALL clears every ${scope} default, including the governed timeouts (${Object.keys(options.governedSettings).join(', ')}).`,
            help: `Reset them individually instead.`,
          });
          return;
        }

        const maxMs = options.governedSettings[assignment.name];
        if (maxMs === undefined) return;

        const problem = checkTimeoutValue(assignment.kind, assignment.raw, {
          maxMs,
          requiredUnit: options.requiredUnit,
          allowDefault: options.allowDefault,
          banZero: options.banZero,
        });
        if (!problem) return;

        context.report({
          statement,
          message: `This ${scope} default for ${assignment.name} ${problem}. It applies to every later connection, so it overrides the per-migration limits.`,
          help: `Set the timeout per migration rather than as a ${scope} default.`,
        });
      },
    };
  },
  tests: {
    valid: [
      "ALTER ROLE app SET statement_timeout = '10min';",
      "ALTER USER app SET lock_timeout = '5min';",
      "ALTER DATABASE app SET idle_in_transaction_session_timeout = '10min';",
      'ALTER ROLE app SET statement_timeout = DEFAULT;',
      'ALTER ROLE app RESET statement_timeout;',
      {
        name: 'ungoverned settings pass through',
        sql: "ALTER ROLE app SET search_path = 'public';",
      },
      {
        name: 'a plain session SET is the other rule’s business',
        sql: "SET statement_timeout = '45min';",
      },
      {
        name: 'a higher configured ceiling',
        sql: "ALTER ROLE app SET statement_timeout = '30min';",
        options: { governedSettings: { statement_timeout: 1_800_000 } },
      },
    ],
    invalid: [
      {
        name: 'above the ceiling for a role default',
        sql: "ALTER ROLE app SET statement_timeout = '45min';",
        errors: [
          { line: 1, column: 1, message: 'This role default for statement_timeout is 45min' },
        ],
      },
      {
        name: 'explains that it escapes the per-migration limits',
        sql: "ALTER ROLE app SET lock_timeout = '30min';",
        errors: [{ message: 'applies to every later connection' }],
      },
      {
        name: 'zero disables the timeout for every connection',
        sql: "ALTER ROLE app SET statement_timeout = '0';",
        errors: [{ message: 'disables the timeout entirely' }],
      },
      {
        name: 'the wrong unit',
        sql: "ALTER ROLE app SET statement_timeout = '600s';",
        errors: [{ message: 'whole minutes' }],
      },
      {
        name: 'a database default is governed too',
        sql: "ALTER DATABASE app SET lock_timeout = '45min';",
        errors: [{ message: 'This database default for lock_timeout' }],
      },
      {
        name: 'RESET ALL silently clears the governed timeouts',
        sql: 'ALTER ROLE app RESET ALL;',
        errors: [{ message: 'clears every role default' }],
      },
      {
        name: 'idle_in_transaction_session_timeout is governed',
        sql: "ALTER ROLE app SET idle_in_transaction_session_timeout = '60min';",
        errors: 1,
      },
    ],
  },
});
