import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultMigrationDate,
  isGatedOut,
  parserVersionFor,
  resolveRules,
  resolveSettings,
} from '../../src/config.ts';
import { defineRule } from '../../src/define-rule.ts';
import { Linter } from '../../src/linter.ts';
import { builtinRules, configs } from '../../src/rules/index.ts';
import type { AnyRule } from '../../src/types.ts';

const registry = new Map<string, AnyRule>(Object.entries(builtinRules));

const byId = (rules: ReturnType<typeof resolveRules>, id: string) =>
  rules.find((rule) => rule.ruleId === id);

test('config: rule entry forms', async (t) => {
  await t.test('accepts a bare severity', () => {
    const rules = resolveRules({ 'ban-drop-table': 'warn' }, registry);
    assert.equal(byId(rules, 'ban-drop-table')?.severity, 'warn');
  });

  await t.test('accepts a [severity, options] tuple and merges defaults', () => {
    const rules = resolveRules(
      { 'require-bounded-lock-timeout': ['error', { maxMs: 5000 }] },
      registry,
    );
    const resolved = byId(rules, 'require-bounded-lock-timeout');

    assert.equal(resolved?.severity, 'error');
    assert.equal((resolved?.options as any).maxMs, 5000);
    // Untouched keys keep their defaults rather than being dropped.
    assert.deepEqual((resolved?.options as any).guardedStatements, [
      'ALTER TABLE',
      'DROP TABLE',
      'TRUNCATE',
    ]);
  });

  await t.test('accepts the object form with shared keys', () => {
    const rules = resolveRules(
      { 'identifier-too-long': { severity: 'warn', options: { maxLength: 30 }, enabledFrom: 20260101 } },
      registry,
    );
    const resolved = byId(rules, 'identifier-too-long');

    assert.equal(resolved?.severity, 'warn');
    assert.equal((resolved?.options as any).maxLength, 30);
    assert.equal(resolved?.enabledFrom, 20260101);
  });

  await t.test('falls back to the rule’s default severity', () => {
    const rules = resolveRules({ 'ban-drop-column': {} }, registry);
    assert.equal(byId(rules, 'ban-drop-column')?.severity, 'warn');
  });

  await t.test('omits rules turned off', () => {
    const rules = resolveRules({ 'ban-drop-table': 'off' }, registry);
    assert.equal(byId(rules, 'ban-drop-table'), undefined);
  });

  await t.test('leaves unlisted rules off', () => {
    const rules = resolveRules({}, registry);
    assert.deepEqual(
      rules.map((rule) => rule.ruleId).sort(),
      ['invalid-suppression', 'parse-error'],
    );
  });

  await t.test('keeps core diagnostics on unless disabled explicitly', () => {
    assert.ok(byId(resolveRules({}, registry), 'parse-error'));
    assert.equal(byId(resolveRules({ 'parse-error': 'off' }, registry), 'parse-error'), undefined);
  });
});

test('config: validation', async (t) => {
  await t.test('rejects an unknown rule id', () => {
    assert.throws(
      () => resolveRules({ 'no-such-rule': 'error' }, registry),
      /unknown rule "no-such-rule"/,
    );
  });

  await t.test('rejects an invalid severity', () => {
    assert.throws(() => resolveRules({ 'ban-drop-table': 'loud' as never }, registry), /expected "off", "warn", or "error"/);
  });

  await t.test('rejects a malformed entry', () => {
    assert.throws(() => resolveRules({ 'ban-drop-table': 42 as never }, registry), /invalid configuration/);
  });

  await t.test('rejects a non-numeric enabledFrom', () => {
    assert.throws(
      () => resolveRules({ 'ban-drop-table': { enabledFrom: 'yesterday' as never } }, registry),
      /non-numeric enabledFrom/,
    );
  });

  await t.test('surfaces a rule’s own option validation', () => {
    assert.throws(
      () =>
        resolveRules(
          { 'require-bounded-lock-timeout': ['error', { guardedStatements: ['ALTER TABEL'] }] },
          registry,
        ),
      /unknown statement kind "ALTER TABEL"/,
    );
  });

  await t.test('rejects a duplicate custom rule name', () => {
    const clashing = defineRule<void>({
      name: 'ban-drop-table',
      meta: { description: 'x', defaultSeverity: 'error', defaultOptions: undefined },
      create: () => ({}),
    });
    assert.throws(() => new Linter({ customRules: [clashing] }), /collides with an existing rule/);
  });

  await t.test('rejects a nameless custom rule', () => {
    assert.throws(
      () => new Linter({ customRules: [{ name: '', meta: {}, create: () => ({}) } as never] }),
      /non-empty name/,
    );
  });
});

test('config: settings', async (t) => {
  await t.test('defaults to Postgres 17 with an implicit transaction', () => {
    const settings = resolveSettings(undefined);
    assert.equal(settings.targetPostgresVersion, 17);
    assert.equal(settings.implicitTransaction, true);
  });

  await t.test('rejects a nonsense version', () => {
    assert.throws(() => resolveSettings({ targetPostgresVersion: 0 }), /positive integer/);
  });

  await t.test('clamps the parser version to what the parser ships', () => {
    assert.equal(parserVersionFor(13), 15);
    assert.equal(parserVersionFor(15), 15);
    assert.equal(parserVersionFor(16), 16);
    assert.equal(parserVersionFor(18), 17);
  });
});

test('config: enabledFrom gating', async (t) => {
  await t.test('extracts an 8-digit date from a version-prefixed filename', () => {
    assert.equal(defaultMigrationDate('V20260812.1__add_index.sql'), 20260812);
    assert.equal(defaultMigrationDate('20260101_init.sql'), 20260101);
  });

  await t.test('takes the leading 8 digits of a 14-digit timestamp', () => {
    assert.equal(defaultMigrationDate('20260812143000_add_index.sql'), 20260812);
    assert.equal(defaultMigrationDate('V20260812143000__add_index.sql'), 20260812);
  });

  await t.test('returns null when there is no 8- or 14-digit run', () => {
    assert.equal(defaultMigrationDate('V1_2__add_index.sql'), null);
    assert.equal(defaultMigrationDate('V202608123__x.sql'), null, 'a 9-digit run is not a date');
    assert.equal(
      defaultMigrationDate('1700000000000_x.sql'),
      null,
      'a 13-digit epoch is not comparable to a YYYYMMDD cutoff',
    );
  });

  await t.test('skips migrations older than the cutoff', () => {
    assert.equal(isGatedOut(20260812, 'V20260811.1__x.sql', defaultMigrationDate), true);
    assert.equal(isGatedOut(20260812, 'V20260812.1__x.sql', defaultMigrationDate), false);
    assert.equal(isGatedOut(20260812, 'V20260813.1__x.sql', defaultMigrationDate), false);
  });

  await t.test('fails closed when the date is unknown', () => {
    assert.equal(isGatedOut(20260812, null, defaultMigrationDate), false);
    assert.equal(isGatedOut(20260812, 'no-date-here.sql', defaultMigrationDate), false);
  });

  await t.test('honors a custom extractor', () => {
    const rules = resolveRules({ 'ban-drop-table': { enabledFrom: 5 } }, registry);
    assert.equal(byId(rules, 'ban-drop-table')?.enabledFrom, 5);
    assert.equal(isGatedOut(5, 'rev-4.sql', (name) => Number(name.match(/\d+/)?.[0] ?? 0)), true);
  });
});

test('config: option validation', async (t) => {
  await t.test('rejects an option key the rule does not declare', () => {
    // A misspelled key merged in silently would leave the rule running on its
    // defaults, which is the miscalibration this linter exists to prevent.
    assert.throws(
      () => resolveRules({ 'require-bounded-lock-timeout': ['error', { maxMS: 5000 }] }, registry),
      /unknown option "maxMS"/,
    );
  });

  await t.test('names every unknown key and lists the accepted ones', () => {
    assert.throws(
      () =>
        resolveRules(
          { 'constraint-missing-not-valid': ['error', { constraintType: [], newTables: true }] },
          registry,
        ),
      /unknown options "constraintType", "newTables".*Accepted options: constraintTypes, allowOnNewTables/s,
    );
  });

  await t.test('checks keys on rules that define normalizeOptions too', () => {
    assert.throws(
      () => resolveRules({ 'identifier-too-long': ['error', { maxLen: 63 }] }, registry),
      /unknown option "maxLen"/,
    );
  });

  await t.test('accepts declared keys, including a partial set', () => {
    const rules = resolveRules(
      { 'require-bounded-lock-timeout': ['error', { maxMs: 5000 }] },
      registry,
    );
    const options = byId(rules, 'require-bounded-lock-timeout')?.options as Record<string, unknown>;

    assert.equal(options['maxMs'], 5000);
    assert.deepEqual(options['guardedStatements'], ['ALTER TABLE', 'DROP TABLE', 'TRUNCATE']);
  });

  await t.test('leaves rules with no options alone', () => {
    assert.doesNotThrow(() => resolveRules({ 'ban-drop-database': 'error' }, registry));
  });
});

test('config: presets', async (t) => {
  await t.test('every name in a preset is a real rule', () => {
    for (const preset of ['all', 'recommended'] as const) {
      for (const name of Object.keys(configs[preset])) {
        assert.ok(registry.has(name), `${preset} names unknown rule "${name}"`);
      }
    }
  });

  await t.test('`all` covers every built-in', () => {
    assert.deepEqual(Object.keys(configs.all).sort(), [...registry.keys()].sort());
  });

  await t.test('presets are frozen so one consumer cannot reconfigure another', () => {
    assert.throws(() => {
      (configs.recommended as Record<string, string>)['ban-drop-table'] = 'off';
    }, TypeError);
    assert.throws(() => {
      (configs as { all?: unknown }).all = {};
    }, TypeError);
  });

  await t.test('a preset still spreads and overrides', () => {
    const rules = resolveRules({ ...configs.recommended, 'ban-drop-table': 'off' }, registry);
    assert.equal(byId(rules, 'ban-drop-table'), undefined);
    assert.ok(byId(rules, 'ban-drop-column'));
  });
});
