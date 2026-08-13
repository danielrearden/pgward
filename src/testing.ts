import assert from 'node:assert/strict';
import test from 'node:test';

import { Linter } from './linter.ts';
import { builtinRules } from './rules/index.ts';
import type { AnyRule, Diagnostic, InvalidRuleCase, Rule, RuleCase } from './types.ts';

/**
 * One fixture from a rule's `tests`, ready to hand to a test runner.
 *
 * `run` throws on failure and resolves on success, which is the contract every
 * runner's `test(name, fn)` already expects — so registering these is a
 * one-line loop regardless of which runner you use.
 */
export interface RuleTestCase {
  /** Which half of `rule.tests` this came from. */
  kind: 'valid' | 'invalid';
  /** The case's own `name`, or a label derived from its SQL. */
  name: string;
  run(): Promise<void>;
}

/**
 * Turns a rule's `tests` into cases any runner can register.
 *
 * This is the runner-agnostic half of `runRuleTests`: it does the linting and
 * the asserting, but leaves registration to the caller. Use it directly with
 * anything that isn't `node:test`:
 *
 * ```ts
 * import { describe, test } from 'vitest';
 * import { ruleTestCases } from 'pgward/testing';
 *
 * describe(banTempTables.name, () => {
 *   for (const testCase of ruleTestCases(banTempTables)) {
 *     test(`${testCase.kind} · ${testCase.name}`, testCase.run);
 *   }
 * });
 * ```
 */
export function ruleTestCases<Options>(
  rule: Rule<Options>,
  customRules: readonly AnyRule[] = [],
): RuleTestCase[] {
  const tests = rule.tests;
  if (!tests) {
    throw new Error(`pgward: rule "${rule.name}" has no tests to run`);
  }

  const cases: RuleTestCase[] = [];

  for (const [index, entry] of tests.valid.entries()) {
    const testCase = typeof entry === 'string' ? ({ sql: entry } as RuleCase<Options>) : entry;
    cases.push({
      kind: 'valid',
      name: testCase.name ?? label(testCase.sql, index),
      run: async () => {
        const diagnostics = await lintRuleCase(rule, testCase, customRules);
        assert.deepEqual(diagnostics.map(describeOne), []);
      },
    });
  }

  for (const [index, testCase] of tests.invalid.entries()) {
    cases.push({
      kind: 'invalid',
      name: testCase.name ?? label(testCase.sql, index),
      run: () => assertInvalid(rule, testCase, customRules),
    });
  }

  return cases;
}

/**
 * Lints one case and returns only the diagnostics the rule under test reported.
 *
 * The escape hatch for tests that don't use the `tests` field — table-driven
 * cases, or a one-off assertion in whatever style the surrounding suite uses.
 * It encodes the two things a hand-rolled linter setup gets wrong: only the
 * rule under test is enabled, so every diagnostic returned is attributable to
 * it, and an unparseable fixture throws instead of passing quietly as "no
 * diagnostics". (`parse-error` stays on for exactly that reason — the linter
 * keeps the core diagnostics enabled unless you turn them off.)
 */
export async function lintRuleCase<Options>(
  rule: Rule<Options>,
  input: RuleCase<Options>,
  customRules: readonly AnyRule[] = [],
): Promise<Diagnostic[]> {
  const result = await linterFor(rule, input, customRules).lint({
    sql: input.sql,
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.implicitTransaction !== undefined
      ? { implicitTransaction: input.implicitTransaction }
      : {}),
  });

  assert.deepEqual(
    result.diagnostics
      .filter((diagnostic) => diagnostic.ruleId === 'parse-error')
      .map((diagnostic) => diagnostic.message),
    [],
    'fixture SQL failed to parse',
  );

  return result.diagnostics.filter((diagnostic) => diagnostic.ruleId === rule.name);
}

/**
 * Runs the `tests` a rule carries, as a `node:test` suite.
 *
 * ```ts
 * import { runRuleTests } from 'pgward/testing';
 * runRuleTests(myRule);
 * ```
 *
 * This is a thin adapter over `ruleTestCases`, and it is `node:test`-specific.
 * Under another runner it registers nothing that runner can see — vitest, for
 * one, reports `no tests` and exits 0 while node's runner quietly prints the
 * real failures to stdout. Use `ruleTestCases` there instead.
 */
export function runRuleTests<Options>(
  rule: Rule<Options>,
  customRules: readonly AnyRule[] = [],
): void {
  const cases = ruleTestCases(rule, customRules);

  test(rule.name, async (t) => {
    for (const kind of ['valid', 'invalid'] as const) {
      await t.test(kind, async (group) => {
        for (const testCase of cases) {
          if (testCase.kind !== kind) continue;
          await group.test(testCase.name, testCase.run);
        }
      });
    }
  });
}

/** Runs the fixtures of every rule that ships with pgward. */
export function runBuiltinRuleTests(): void {
  for (const rule of Object.values(builtinRules) as AnyRule[]) {
    if (rule.tests) runRuleTests(rule);
  }
}

async function assertInvalid<Options>(
  rule: Rule<Options>,
  testCase: InvalidRuleCase<Options>,
  customRules: readonly AnyRule[],
): Promise<void> {
  const diagnostics = await lintRuleCase(rule, testCase, customRules);
  const expected = testCase.errors;

  if (typeof expected === 'number') {
    assert.equal(
      diagnostics.length,
      expected,
      `expected ${expected} diagnostic(s), got ${describe(diagnostics)}`,
    );
    return;
  }

  assert.equal(
    diagnostics.length,
    expected.length,
    `expected ${expected.length} diagnostic(s), got ${describe(diagnostics)}`,
  );

  for (const [position, want] of expected.entries()) {
    const actual = diagnostics[position]!;

    if (typeof want.message === 'string') {
      assert.ok(
        actual.message.includes(want.message),
        `diagnostic ${position} message ${JSON.stringify(actual.message)} does not ` +
          `contain ${JSON.stringify(want.message)}`,
      );
    } else if (want.message instanceof RegExp) {
      assert.match(actual.message, want.message);
    }

    if (typeof want.help === 'string') {
      assert.ok(
        actual.help?.includes(want.help),
        `diagnostic ${position} help ${JSON.stringify(actual.help)} does not ` +
          `contain ${JSON.stringify(want.help)}`,
      );
    } else if (want.help instanceof RegExp) {
      assert.match(actual.help ?? '', want.help);
    }

    if (want.line !== undefined) {
      assert.equal(actual.line, want.line, `diagnostic ${position} line`);
    }
    if (want.column !== undefined) {
      assert.equal(actual.column, want.column, `diagnostic ${position} column`);
    }
    if (want.severity !== undefined) {
      assert.equal(actual.severity, want.severity, `diagnostic ${position} severity`);
    }
  }
}

/**
 * A `Linter` holds no state across `lint()` calls, so instances are shared by
 * every case that resolves to the same configuration. Keyed off the rule object
 * so the entry goes away with the rule.
 */
const linterCache = new WeakMap<AnyRule, Map<string, Linter>>();

function linterFor<Options>(
  rule: Rule<Options>,
  testCase: RuleCase<Options>,
  customRules: readonly AnyRule[],
): Linter {
  const entry = {
    severity: testCase.severity ?? rule.meta.defaultSeverity,
    ...(testCase.options ? { options: testCase.options } : {}),
    ...(testCase.enabledFrom !== undefined ? { enabledFrom: testCase.enabledFrom } : {}),
  };
  const key = cacheKey([entry, testCase.settings ?? null, customRules.map(identityOf)]);

  let byConfig = linterCache.get(rule as AnyRule);
  if (!byConfig) {
    byConfig = new Map();
    linterCache.set(rule as AnyRule, byConfig);
  }

  let linter = byConfig.get(key);
  if (!linter) {
    linter = new Linter({
      ...(testCase.settings ? { settings: testCase.settings } : {}),
      rules: { [rule.name]: entry },
      // Built-ins are already registered; passing one again would collide.
      customRules: [rule as AnyRule, ...customRules].filter(
        (candidate) => !(candidate.name in builtinRules),
      ),
    });
    byConfig.set(key, linter);
  }

  return linter;
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/** A stable id per object, so functions can take part in a cache key. */
function identityOf(value: object): number {
  let id = identities.get(value);
  if (id === undefined) {
    id = nextIdentity += 1;
    identities.set(value, id);
  }
  return id;
}

/**
 * JSON, but with functions folded in by identity rather than dropped.
 *
 * `settings.migrationDate` is a function, and plain `JSON.stringify` omits it —
 * so two cases differing only in how they date a filename would collide on one
 * key and the second would silently reuse the first one's linter.
 */
function cacheKey(value: unknown): string {
  return JSON.stringify(value, (_key, raw) =>
    typeof raw === 'function' ? `[fn ${identityOf(raw)}]` : raw,
  );
}

function label(sql: string, index: number): string {
  const single = sql.replace(/\s+/g, ' ').trim();
  return `${index + 1}. ${single.length > 72 ? `${single.slice(0, 69)}…` : single}`;
}

function describeOne(diagnostic: Diagnostic): string {
  return `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`;
}

function describe(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.length === 0 ? 'none' : diagnostics.map(describeOne).join(' | ');
}
