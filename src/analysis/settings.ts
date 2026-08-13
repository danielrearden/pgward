import type {
  SessionSettingsAnalysis,
  SettingAssignment,
  SettingAssignmentKind,
  Statement,
} from '../types.ts';
import type { TransactionAnalysisInternal } from './transactions.ts';

/**
 * Pulls the literal out of a constant expression node. Handles the shapes
 * `SET` arguments actually take: string, integer, float and boolean constants,
 * plus casts like `'3s'::text` and bare identifiers.
 */
export function extractConstant(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, any>;

  if (record['A_Const']) {
    const constant = record['A_Const'] as Record<string, any>;
    if (constant['isnull']) return null;
    if (constant['sval']) return String(constant['sval']['sval'] ?? '');
    if (constant['ival']) return String(constant['ival']['ival'] ?? 0);
    if (constant['fval']) return String(constant['fval']['fval'] ?? '');
    if (constant['boolval']) return String(Boolean(constant['boolval']['boolval']));
    return null;
  }
  if (record['String']) return String(record['String']['sval'] ?? '');
  if (record['Integer']) return String(record['Integer']['ival'] ?? 0);
  if (record['Float']) return String(record['Float']['fval'] ?? '');
  if (record['TypeCast']) return extractConstant(record['TypeCast']['arg']);

  return null;
}

const KIND_BY_VARIABLE_SET_KIND: Record<string, SettingAssignmentKind> = {
  VAR_SET_VALUE: 'set',
  VAR_SET_CURRENT: 'set',
  VAR_SET_DEFAULT: 'default',
  VAR_RESET: 'reset',
  VAR_RESET_ALL: 'reset_all',
};

/**
 * Reads a `VariableSetStmt` into a normalized assignment, or null when the
 * statement isn't one we model (`SET TRANSACTION`, `SET CONSTRAINTS`, …).
 */
export function readAssignment(
  node: Record<string, any>,
  statementIndex: number,
): SettingAssignment | null {
  const kind = KIND_BY_VARIABLE_SET_KIND[String(node['kind'] ?? '')];
  if (!kind) return null;

  const args = Array.isArray(node['args']) ? node['args'] : [];
  const parts = args.map(extractConstant).filter((part): part is string => part !== null);
  const local = Boolean(node['is_local']);

  return {
    statementIndex,
    name: String(node['name'] ?? '').toLowerCase(),
    kind: kind === 'set' && local ? 'set_local' : kind,
    raw: parts.length > 0 ? parts.join(', ') : null,
    local,
    node,
  };
}

/** Collects every `SET`/`RESET` in the file, in order. */
export function collectAssignments(statements: readonly Statement[]): SettingAssignment[] {
  const assignments: SettingAssignment[] = [];
  for (const statement of statements) {
    if (statement.type !== 'VariableSetStmt') continue;
    const assignment = readAssignment(statement.node as Record<string, any>, statement.index);
    if (assignment) assignments.push(assignment);
  }
  return assignments;
}

/**
 * Resolves what each session setting is actually set to at every point in the
 * file.
 *
 * This is what separates a real check from a presence check. Squawk's
 * `require-lock-timeout` is satisfied by
 * `SET lock_timeout='3s'; RESET lock_timeout; ALTER TABLE …` because it only
 * looks for the `SET`; following the value through the resets shows there is
 * no timeout in effect by the time the `ALTER` runs.
 */
export function analyzeSessionSettings(
  statements: readonly Statement[],
  transactions: TransactionAnalysisInternal,
): SessionSettingsAnalysis {
  const assignments = collectAssignments(statements);

  return {
    all() {
      return assignments;
    },

    assignments(name) {
      const wanted = name.toLowerCase();
      return assignments.filter((assignment) => assignment.name === wanted);
    },

    effective(index, name) {
      const wanted = name.toLowerCase();
      // Session-level and transaction-local values are tracked separately: a
      // `SET LOCAL` that falls out of scope has to reveal the session value
      // underneath it, not report the setting as unset.
      let session: SettingAssignment | null = null;
      let local: SettingAssignment | null = null;

      for (const assignment of assignments) {
        if (assignment.statementIndex >= index) break;

        if (assignment.kind === 'reset_all') {
          session = null;
          local = null;
          continue;
        }
        if (assignment.name !== wanted) continue;

        if (assignment.kind === 'reset' || assignment.kind === 'default') {
          session = null;
          local = null;
          continue;
        }

        if (assignment.local) {
          // `SET LOCAL` outside a transaction is silently ignored by Postgres,
          // so it establishes nothing.
          if (!transactions.inTransaction(assignment.statementIndex)) continue;
          local = assignment;
        } else {
          // A plain `SET` takes effect immediately, overriding any `SET LOCAL`
          // already active in the transaction.
          session = assignment;
          local = null;
        }
      }

      // A `SET LOCAL` only survives until its transaction ends; past that, the
      // session value it was masking is what's in effect again.
      if (local && transactions.epochBefore[local.statementIndex] === transactions.epochBefore[index]) {
        return local;
      }

      return session;
    },
  };
}
