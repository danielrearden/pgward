import type {
  AnyRule,
  AnyRuleEntry,
  ReportedSeverity,
  ResolvedSettings,
  Severity,
  SettingsInput,
} from './types.ts';

/** Rule ids the linter reports under that don't come from a rule's `create`. */
export const CORE_RULE_IDS = ['parse-error', 'invalid-suppression'] as const;
export type CoreRuleId = (typeof CORE_RULE_IDS)[number];

const CORE_RULE_DEFAULTS: Record<CoreRuleId, ReportedSeverity> = {
  'parse-error': 'error',
  'invalid-suppression': 'error',
};

const SEVERITIES = new Set<Severity>(['off', 'warn', 'error']);

/**
 * Pulls a comparable date out of a migration filename — `20260812` from both
 * `V20260812.1__add_index.sql` and `20260812143000_add_index.sql`.
 *
 * Matches a standalone run of exactly 8 or exactly 14 digits and keeps its
 * leading 8, which covers the `YYYYMMDD` and `YYYYMMDDHHMMSS` conventions
 * without guessing at runs of other lengths — a 13-digit epoch, say, isn't
 * comparable to a `YYYYMMDD` cutoff at all. Returns null when the name carries
 * no date, in which case `enabledFrom` gating doesn't apply and the rule runs.
 */
export function defaultMigrationDate(filename: string): number | null {
  const match = /(?<!\d)(\d{8})(?:\d{6})?(?!\d)/.exec(filename);
  return match ? Number(match[1]) : null;
}

export const DEFAULT_SETTINGS: ResolvedSettings = {
  targetPostgresVersion: 17,
  implicitTransaction: true,
  migrationDate: defaultMigrationDate,
};

export function resolveSettings(input: SettingsInput | undefined): ResolvedSettings {
  const version = input?.targetPostgresVersion ?? DEFAULT_SETTINGS.targetPostgresVersion;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(
      `pgward: settings.targetPostgresVersion must be a positive integer, got ${String(version)}`,
    );
  }
  return {
    targetPostgresVersion: version,
    implicitTransaction: input?.implicitTransaction ?? DEFAULT_SETTINGS.implicitTransaction,
    migrationDate: input?.migrationDate ?? DEFAULT_SETTINGS.migrationDate,
  };
}

/** The parser only ships grammars for these; anything else is clamped. */
export function parserVersionFor(targetPostgresVersion: number): 15 | 16 | 17 {
  if (targetPostgresVersion <= 15) return 15;
  if (targetPostgresVersion === 16) return 16;
  return 17;
}

export interface ResolvedRule {
  ruleId: string;
  rule: AnyRule;
  severity: ReportedSeverity;
  options: unknown;
  enabledFrom: number | null;
}

interface NormalizedEntry {
  severity: Severity | null;
  options: unknown;
  enabledFrom: number | null;
}

function normalizeEntry(ruleId: string, entry: AnyRuleEntry): NormalizedEntry {
  if (typeof entry === 'string') {
    assertSeverity(ruleId, entry);
    return { severity: entry, options: undefined, enabledFrom: null };
  }

  if (Array.isArray(entry)) {
    const [severity, options] = entry as [Severity, unknown];
    assertSeverity(ruleId, severity);
    return { severity, options, enabledFrom: null };
  }

  if (entry && typeof entry === 'object') {
    const object = entry as { severity?: Severity; options?: unknown; enabledFrom?: number };
    if (object.severity !== undefined) assertSeverity(ruleId, object.severity);
    if (object.enabledFrom !== undefined && !Number.isFinite(object.enabledFrom)) {
      throw new TypeError(
        `pgward: rule "${ruleId}" has a non-numeric enabledFrom (${String(object.enabledFrom)})`,
      );
    }
    return {
      severity: object.severity ?? null,
      options: object.options,
      enabledFrom: object.enabledFrom ?? null,
    };
  }

  throw new TypeError(
    `pgward: rule "${ruleId}" has an invalid configuration; expected a severity, ` +
      `a [severity, options] tuple, or an object`,
  );
}

function assertSeverity(ruleId: string, severity: unknown): asserts severity is Severity {
  if (typeof severity !== 'string' || !SEVERITIES.has(severity as Severity)) {
    throw new TypeError(
      `pgward: rule "${ruleId}" has severity ${JSON.stringify(severity)}; ` +
        `expected "off", "warn", or "error"`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rejects option keys the rule doesn't declare.
 *
 * A misspelled key would otherwise be merged in and ignored, leaving the rule
 * silently running on its defaults — the quiet miscalibration this linter is
 * meant to prevent, and the same reason unknown statement kinds are rejected.
 */
function assertKnownOptionKeys(ruleId: string, defaults: unknown, raw: unknown): void {
  if (!isPlainObject(defaults) || !isPlainObject(raw)) return;

  const known = Object.keys(defaults);
  const unknown = Object.keys(raw).filter((key) => !known.includes(key));
  if (unknown.length === 0) return;

  throw new TypeError(
    `pgward: rule "${ruleId}" got unknown option${unknown.length === 1 ? '' : 's'} ` +
      `${unknown.map((key) => JSON.stringify(key)).join(', ')}. ` +
      `Accepted options: ${known.join(', ')}`,
  );
}

function resolveOptions(ruleId: string, rule: AnyRule, raw: unknown): unknown {
  const defaults = rule.meta.defaultOptions;
  assertKnownOptionKeys(ruleId, defaults, raw);

  if (rule.meta.normalizeOptions) return rule.meta.normalizeOptions(raw, defaults);
  if (raw === undefined) return defaults;
  if (isPlainObject(defaults) && isPlainObject(raw)) {
    return { ...defaults, ...raw };
  }
  return raw;
}

/**
 * Turns the user's rule map into the enabled set, throwing on anything
 * misconfigured. Rules absent from the map are off — spread `configs.recommended`
 * to turn on a curated set.
 *
 * The core diagnostics are the exception: they're on unless explicitly
 * disabled, since a silent parse failure would look like a clean file.
 */
export function resolveRules(
  entries: Readonly<Record<string, AnyRuleEntry>> | undefined,
  registry: ReadonlyMap<string, AnyRule>,
): ResolvedRule[] {
  const resolved: ResolvedRule[] = [];
  const seen = new Set<string>();

  for (const [ruleId, entry] of Object.entries(entries ?? {})) {
    const rule = registry.get(ruleId);
    if (!rule) {
      throw new Error(
        `pgward: unknown rule "${ruleId}". Pass it via customRules to configure a rule ` +
          `this linter doesn't ship.`,
      );
    }

    seen.add(ruleId);
    const normalized = normalizeEntry(ruleId, entry);
    const severity = normalized.severity ?? rule.meta.defaultSeverity;
    if (severity === 'off') continue;

    resolved.push({
      ruleId,
      rule,
      severity,
      options: resolveOptions(ruleId, rule, normalized.options),
      enabledFrom: normalized.enabledFrom,
    });
  }

  for (const coreRuleId of CORE_RULE_IDS) {
    if (seen.has(coreRuleId)) continue;
    const rule = registry.get(coreRuleId);
    if (!rule) continue;
    resolved.push({
      ruleId: coreRuleId,
      rule,
      severity: CORE_RULE_DEFAULTS[coreRuleId],
      options: rule.meta.defaultOptions,
      enabledFrom: null,
    });
  }

  return resolved;
}

/**
 * Whether `enabledFrom` excludes this file. Fails closed: a missing filename or
 * an undated one runs the rule rather than skipping it.
 */
export function isGatedOut(
  enabledFrom: number | null,
  filename: string | null,
  migrationDate: (filename: string) => number | null,
): boolean {
  if (enabledFrom === null) return false;
  if (!filename) return false;
  const date = migrationDate(filename);
  if (date === null) return false;
  return date < enabledFrom;
}
