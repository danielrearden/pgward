import type { SettingAssignmentKind } from '../types.ts';
import { UNIT_TO_MS, describeMs, parseDuration } from './duration.ts';

export interface TimeoutPolicy {
  /** Largest value the setting may be given. */
  maxMs: number;
  /** Unit the literal must be written in, e.g. `'min'`. Null allows any. */
  requiredUnit: string | null;
  /** Whether `SET … = DEFAULT` is acceptable. */
  allowDefault: boolean;
  /** Whether `0` — which disables the timeout — is rejected. */
  banZero: boolean;
  /**
   * A hard ceiling the value must stay under, such as the driver's socket
   * timeout. Exceeding it means the connection dies before the timeout fires.
   */
  ceilingMs?: number | null;
  /** What the ceiling represents, for the message. */
  ceilingLabel?: string;
}

/**
 * Validates one timeout assignment against a policy.
 *
 * Returns a clause describing the problem — phrased to follow "`statement_timeout`" —
 * or null when the assignment is acceptable.
 */
export function checkTimeoutValue(
  kind: SettingAssignmentKind,
  raw: string | null,
  policy: TimeoutPolicy,
): string | null {
  if (kind === 'reset' || kind === 'reset_all') return null;

  if (kind === 'default') {
    return policy.allowDefault ? null : 'is set to DEFAULT, which this project does not allow';
  }

  if (raw === null) return 'has a value this linter could not read';

  const duration = parseDuration(raw);
  if (!duration) return `has the unreadable value ${JSON.stringify(raw)}`;

  if (duration.disabled) {
    return policy.banZero
      ? 'is set to 0, which disables the timeout entirely'
      : null;
  }

  if (duration.ms < 0) return `is negative (${raw})`;

  if (policy.requiredUnit && duration.unit !== policy.requiredUnit) {
    const suggestion = describeInUnit(duration.ms, policy.requiredUnit);
    return (
      `is written as ${JSON.stringify(raw)}; it must be given in whole ` +
      `${unitNoun(policy.requiredUnit)}${suggestion ? ` (e.g. '${suggestion}')` : ''}`
    );
  }

  if (duration.ms > policy.maxMs) {
    return `is ${describeMs(duration.ms)}, above the ${describeMs(policy.maxMs)} maximum`;
  }

  if (policy.ceilingMs && duration.ms >= policy.ceilingMs) {
    const label = policy.ceilingLabel ?? 'the configured ceiling';
    return (
      `is ${describeMs(duration.ms)}, at or above ${label} ` +
      `(${describeMs(policy.ceilingMs)}), so the connection drops before it fires`
    );
  }

  return null;
}

function describeInUnit(ms: number, unit: string): string | null {
  const factor = UNIT_TO_MS[unit];
  if (!factor) return null;
  const value = ms / factor;
  return Number.isInteger(value) ? `${value}${unit}` : null;
}

function unitNoun(unit: string): string {
  switch (unit) {
    case 'min':
      return 'minutes';
    case 's':
      return 'seconds';
    case 'ms':
      return 'milliseconds';
    case 'h':
      return 'hours';
    case 'd':
      return 'days';
    default:
      return unit;
  }
}
