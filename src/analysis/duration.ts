export interface Duration {
  ms: number;
  /** The numeric part as written. */
  value: number;
  /** The unit as written, or null when the literal was a bare number. */
  unit: string | null;
  /** True when the value is `0`, which disables the timeout entirely. */
  disabled: boolean;
}

/** Every duration unit Postgres accepts on a timeout GUC, in milliseconds. */
export const UNIT_TO_MS: Record<string, number> = {
  us: 0.001,
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses a Postgres duration literal — `'3s'`, `'45min'`, `15000`, `'0'`.
 *
 * A bare number is interpreted in `baseUnit`, which is milliseconds for the
 * timeout GUCs this linter cares about. Returns null when the literal isn't a
 * duration at all.
 */
export function parseDuration(raw: string | number, baseUnit = 'ms'): Duration | null {
  const text = String(raw).trim();
  const match = /^([+-]?\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const written = match[2]!.toLowerCase();
  const unit = written === '' ? null : written;
  const factor = UNIT_TO_MS[unit ?? baseUnit];
  if (factor === undefined) return null;

  return { ms: value * factor, value, unit, disabled: value === 0 };
}

/** Renders milliseconds as the shortest exact Postgres literal, for messages. */
export function describeMs(ms: number): string {
  if (ms === 0) return '0';
  for (const unit of ['d', 'h', 'min', 's'] as const) {
    const factor = UNIT_TO_MS[unit]!;
    if (ms % factor === 0) return `${ms / factor}${unit}`;
  }
  return `${ms}ms`;
}
