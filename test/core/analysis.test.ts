import assert from 'node:assert/strict';
import test from 'node:test';

import { describeMs, parseDuration } from '../../src/analysis/duration.ts';
import { checkTimeoutValue } from '../../src/analysis/timeout-check.ts';
import { createdTableMatcher } from '../../src/analysis/new-tables.ts';
import type { RelationName } from '../../src/ast.ts';
import { makeSource } from '../helpers/source.ts';

test('analysis: durations', async (t) => {
  await t.test('parses units', () => {
    assert.equal(parseDuration('3s')?.ms, 3_000);
    assert.equal(parseDuration('45min')?.ms, 2_700_000);
    assert.equal(parseDuration('1h')?.ms, 3_600_000);
    assert.equal(parseDuration('250ms')?.ms, 250);
    assert.equal(parseDuration('1d')?.ms, 86_400_000);
  });

  await t.test('treats a bare number as the base unit', () => {
    assert.equal(parseDuration('15000')?.ms, 15_000);
    assert.equal(parseDuration(15_000)?.ms, 15_000);
    assert.equal(parseDuration('30', 's')?.ms, 30_000);
  });

  await t.test('records the unit as written', () => {
    assert.equal(parseDuration('45min')?.unit, 'min');
    assert.equal(parseDuration('2700000')?.unit, null);
  });

  await t.test('flags zero as disabling the timeout', () => {
    assert.equal(parseDuration('0')?.disabled, true);
    assert.equal(parseDuration('1s')?.disabled, false);
  });

  await t.test('tolerates whitespace and rejects nonsense', () => {
    assert.equal(parseDuration(' 3 s ')?.ms, 3_000);
    assert.equal(parseDuration('soon'), null);
    assert.equal(parseDuration('3 fortnights'), null);
    assert.equal(parseDuration(''), null);
  });

  await t.test('describeMs picks the largest exact unit', () => {
    assert.equal(describeMs(0), '0');
    assert.equal(describeMs(15_000), '15s');
    assert.equal(describeMs(2_700_000), '45min');
    assert.equal(describeMs(250), '250ms');
  });
});

test('analysis: timeout policy', async (t) => {
  const policy = { maxMs: 2_700_000, requiredUnit: 'min', allowDefault: true, banZero: true };

  await t.test('accepts a value within range in the required unit', () => {
    assert.equal(checkTimeoutValue('set', '45min', policy), null);
  });

  await t.test('rejects zero', () => {
    assert.match(checkTimeoutValue('set', '0', policy)!, /disables the timeout/);
  });

  await t.test('rejects the wrong unit and suggests the right one', () => {
    const problem = checkTimeoutValue('set', '60s', policy)!;
    assert.match(problem, /whole minutes/);
    assert.match(problem, /'1min'/);
  });

  await t.test('rejects a value over the ceiling', () => {
    assert.match(checkTimeoutValue('set', '90min', policy)!, /above the 45min maximum/);
  });

  await t.test('honors allowDefault and passes resets through', () => {
    assert.equal(checkTimeoutValue('default', null, policy), null);
    assert.equal(checkTimeoutValue('reset', null, policy), null);
    assert.match(
      checkTimeoutValue('default', null, { ...policy, allowDefault: false })!,
      /does not allow/,
    );
  });

  await t.test('rejects a value at or above a hard ceiling', () => {
    const problem = checkTimeoutValue('set', '60min', {
      ...policy,
      maxMs: 7_200_000,
      ceilingMs: 3_600_000,
      ceilingLabel: "the driver's socket timeout",
    })!;
    assert.match(problem, /connection drops before it fires/);
  });
});

test('analysis: transactions', async (t) => {
  await t.test('tracks explicit depth across the file', async () => {
    const source = await makeSource('SELECT 1;\nBEGIN;\nSELECT 2;\nCOMMIT;\nSELECT 3;', {
      implicitTransactionDefault: false,
    });

    assert.deepEqual(source.transactions.depthBefore, [0, 0, 1, 1, 0]);
    assert.equal(source.transactions.inExplicitTransaction(2), true);
    assert.equal(source.transactions.inExplicitTransaction(4), false);
    assert.equal(source.transactions.unclosed, false);
  });

  await t.test('notices a transaction left open', async () => {
    const source = await makeSource('BEGIN;\nSELECT 1;', { implicitTransactionDefault: false });
    assert.equal(source.transactions.unclosed, true);
  });

  await t.test('savepoints do not change the depth', async () => {
    const source = await makeSource('BEGIN;\nSAVEPOINT a;\nRELEASE a;\nCOMMIT;', {
      implicitTransactionDefault: false,
    });
    assert.deepEqual(source.transactions.depthBefore, [0, 1, 1, 1]);
  });

  await t.test('an implicit transaction covers statements until the first commit', async () => {
    const source = await makeSource('SELECT 1;\nCOMMIT;\nSELECT 2;', {
      implicitTransactionDefault: true,
    });

    assert.equal(source.transactions.implicit, true);
    assert.equal(source.transactions.inTransaction(0), true);
    assert.equal(source.transactions.inTransaction(2), false);
  });
});

test('analysis: session settings', async (t) => {
  await t.test('resolves the value in effect at each statement', async () => {
    const source = await makeSource(
      "SET lock_timeout = '3s';\nALTER TABLE a ADD COLUMN x int;\nSET lock_timeout = '9s';\nALTER TABLE b ADD COLUMN y int;",
    );

    assert.equal(source.sessionSettings.effective(1, 'lock_timeout')?.raw, '3s');
    assert.equal(source.sessionSettings.effective(3, 'lock_timeout')?.raw, '9s');
    assert.equal(source.sessionSettings.effective(0, 'lock_timeout'), null);
  });

  await t.test('RESET clears the value — the case a presence check misses', async () => {
    const source = await makeSource(
      "SET lock_timeout = '3s';\nRESET lock_timeout;\nALTER TABLE a ADD COLUMN x int;",
    );
    assert.equal(source.sessionSettings.effective(2, 'lock_timeout'), null);
  });

  await t.test('RESET ALL clears every setting', async () => {
    const source = await makeSource(
      "SET lock_timeout = '3s';\nRESET ALL;\nALTER TABLE a ADD COLUMN x int;",
    );
    assert.equal(source.sessionSettings.effective(2, 'lock_timeout'), null);
  });

  await t.test('SET … = DEFAULT clears the value', async () => {
    const source = await makeSource(
      "SET lock_timeout = '3s';\nSET lock_timeout = DEFAULT;\nALTER TABLE a ADD COLUMN x int;",
    );
    assert.equal(source.sessionSettings.effective(2, 'lock_timeout'), null);
  });

  await t.test('SET LOCAL expires when its transaction ends', async () => {
    const source = await makeSource(
      "BEGIN;\nSET LOCAL lock_timeout = '3s';\nALTER TABLE a ADD COLUMN x int;\nCOMMIT;\nALTER TABLE b ADD COLUMN y int;",
      { implicitTransactionDefault: false },
    );

    assert.equal(source.sessionSettings.effective(2, 'lock_timeout')?.raw, '3s');
    assert.equal(source.sessionSettings.effective(4, 'lock_timeout'), null);
  });

  await t.test('an expired SET LOCAL reveals the session value it was masking', async () => {
    // The session-level SET is still in effect after the transaction ends.
    // Reporting "unset" here would fail a migration that is correctly guarded.
    const source = await makeSource(
      [
        "SET lock_timeout = '3s';",
        'BEGIN;',
        "SET LOCAL lock_timeout = '5s';",
        'ALTER TABLE a ADD COLUMN x int;',
        'COMMIT;',
        'ALTER TABLE b ADD COLUMN y int;',
      ].join('\n'),
      { implicitTransactionDefault: false },
    );

    assert.equal(source.sessionSettings.effective(3, 'lock_timeout')?.raw, '5s', 'local wins inside');
    assert.equal(source.sessionSettings.effective(5, 'lock_timeout')?.raw, '3s', 'session survives');
  });

  await t.test('a plain SET inside a transaction overrides an active SET LOCAL', async () => {
    const source = await makeSource(
      [
        'BEGIN;',
        "SET LOCAL lock_timeout = '5s';",
        "SET lock_timeout = '3s';",
        'ALTER TABLE a ADD COLUMN x int;',
        'COMMIT;',
        'ALTER TABLE b ADD COLUMN y int;',
      ].join('\n'),
      { implicitTransactionDefault: false },
    );

    assert.equal(source.sessionSettings.effective(3, 'lock_timeout')?.raw, '3s');
    assert.equal(source.sessionSettings.effective(5, 'lock_timeout')?.raw, '3s');
  });

  await t.test('a RESET clears the session value a SET LOCAL was masking', async () => {
    const source = await makeSource(
      [
        "SET lock_timeout = '3s';",
        'BEGIN;',
        'RESET lock_timeout;',
        "SET LOCAL lock_timeout = '5s';",
        'COMMIT;',
        'ALTER TABLE b ADD COLUMN y int;',
      ].join('\n'),
      { implicitTransactionDefault: false },
    );

    assert.equal(source.sessionSettings.effective(5, 'lock_timeout'), null);
  });

  await t.test('SET LOCAL outside a transaction establishes nothing', async () => {
    const source = await makeSource(
      "SET LOCAL lock_timeout = '3s';\nALTER TABLE a ADD COLUMN x int;",
      { implicitTransactionDefault: false },
    );
    assert.equal(source.sessionSettings.effective(1, 'lock_timeout'), null);
  });

  await t.test('records every assignment, including the ones later overwritten', async () => {
    const source = await makeSource(
      "SET statement_timeout = '45min';\nSET statement_timeout = '0';",
    );

    assert.deepEqual(
      source.sessionSettings.assignments('statement_timeout').map((entry) => entry.raw),
      ['45min', '0'],
    );
  });

  await t.test('reads integer values as well as strings', async () => {
    const source = await makeSource('SET lock_timeout = 15000;\nALTER TABLE a ADD COLUMN x int;');
    assert.equal(source.sessionSettings.effective(1, 'lock_timeout')?.raw, '15000');
  });
});

test('analysis: implicit transaction resolution', async (t) => {
  await t.test('a per-file declaration overrides the runner default', async () => {
    const opted = await makeSource('SELECT 1;', {
      implicitTransaction: false,
      implicitTransactionDefault: true,
    });
    assert.equal(opted.transactions.implicit, false);

    const wrapped = await makeSource('SELECT 1;', {
      implicitTransaction: true,
      implicitTransactionDefault: false,
    });
    assert.equal(wrapped.transactions.implicit, true);
  });

  await t.test('falls back to the runner default when the file says nothing', async () => {
    const source = await makeSource('SELECT 1;', { implicitTransactionDefault: false });
    assert.equal(source.transactions.implicit, false);
  });
});

test('analysis: tables created by this migration', async (t) => {
  const matches = async (sql: string, target: RelationName) =>
    createdTableMatcher(await makeSource(sql))(target);

  const rel = (schema: string | null, name: string): RelationName => ({
    schema,
    name,
    qualified: schema ? `${schema}.${name}` : name,
  });

  await t.test('matches the same name written the same way', async () => {
    assert.equal(await matches('CREATE TABLE public.t (a int);', rel('public', 't')), true);
    assert.equal(await matches('CREATE TABLE t (a int);', rel(null, 't')), true);
  });

  await t.test('matches when one side omits the schema', async () => {
    assert.equal(await matches('CREATE TABLE public.t (a int);', rel(null, 't')), true);
    assert.equal(await matches('CREATE TABLE t (a int);', rel('public', 't')), true);
  });

  await t.test('does not match a different explicit schema', async () => {
    // Treating staging.t as cover for public.t would silently exempt a live
    // table from every rule that consults this.
    assert.equal(await matches('CREATE TABLE staging.t (a int);', rel('public', 't')), false);
  });

  await t.test('does not match an unrelated table', async () => {
    assert.equal(await matches('CREATE TABLE public.t (a int);', rel('public', 'other')), false);
    assert.equal(await matches('SELECT 1;', rel('public', 't')), false);
  });

  await t.test('covers CREATE TABLE AS', async () => {
    assert.equal(await matches('CREATE TABLE public.t AS SELECT 1;', rel('public', 't')), true);
  });
});
