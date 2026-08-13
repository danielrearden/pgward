import assert from 'node:assert/strict';
import test from 'node:test';

import { defineRule } from '../../src/define-rule.ts';
import { lintRuleCase, ruleTestCases } from '../../src/testing.ts';
import type { Rule } from '../../src/types.ts';

/** Reports once per `CREATE TABLE`, so a fixture's expectations are easy to state. */
const banCreateTable = defineRule<void>({
  name: 'test-ban-create-table',
  meta: {
    description: 'No CREATE TABLE.',
    help: 'Do something else.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      CreateStmt(_node, path) {
        context.report({ statement: path.statement, message: 'No CREATE TABLE here.' });
      },
    };
  },
  tests: {
    valid: ['SELECT 1;', { name: 'named case', sql: 'DROP TABLE t;' }],
    invalid: [{ sql: 'CREATE TABLE t (a int);', errors: [{ line: 1, column: 1 }] }],
  },
});

test('ruleTestCases', async (t) => {
  await t.test('enumerates both halves of tests, labelling each case', () => {
    assert.deepEqual(
      ruleTestCases(banCreateTable).map((testCase) => [testCase.kind, testCase.name]),
      [
        ['valid', '1. SELECT 1;'],
        ['valid', 'named case'],
        ['invalid', '1. CREATE TABLE t (a int);'],
      ],
    );
  });

  await t.test('a passing case resolves', async () => {
    for (const testCase of ruleTestCases(banCreateTable)) {
      await testCase.run();
    }
  });

  await t.test('a wrong expectation rejects rather than resolving quietly', async () => {
    // The property every runner relies on: failure arrives as a rejection, not
    // as output written somewhere only node:test is listening.
    const wrongCount = defineRule<void>({
      ...banCreateTable,
      name: 'test-wrong-count',
      tests: { valid: [], invalid: [{ sql: 'SELECT 1;', errors: 1 }] },
    });

    const [testCase] = ruleTestCases(wrongCount);
    await assert.rejects(() => testCase!.run(), /expected 1 diagnostic\(s\), got none/);
  });

  await t.test('a valid case that does report rejects', async () => {
    const wronglyValid = defineRule<void>({
      ...banCreateTable,
      name: 'test-wrongly-valid',
      tests: { valid: ['CREATE TABLE t (a int);'], invalid: [] },
    });

    const [testCase] = ruleTestCases(wronglyValid);
    await assert.rejects(() => testCase!.run(), /No CREATE TABLE here\./);
  });

  await t.test('a rule with no fixtures is a mistake, not an empty suite', () => {
    const untested = defineRule<void>({ ...banCreateTable, name: 'test-untested' });
    delete (untested as { tests?: unknown }).tests;

    assert.throws(() => ruleTestCases(untested), /has no tests to run/);
  });
});

test('lintRuleCase', async (t) => {
  await t.test('returns only the diagnostics of the rule under test', async () => {
    // `require-table-schema` and friends would also fire on this SQL if the
    // helper enabled anything beyond the rule it was handed.
    const diagnostics = await lintRuleCase(banCreateTable, { sql: 'CREATE TABLE t (a int);' });

    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.ruleId),
      ['test-ban-create-table'],
    );
    assert.equal(diagnostics[0]?.help, 'Do something else.');
  });

  await t.test('an unparseable fixture fails instead of reading as no diagnostics', async () => {
    await assert.rejects(
      () => lintRuleCase(banCreateTable, { sql: 'CREATE TABL' }),
      /fixture SQL failed to parse/,
    );
  });

  await t.test('a custom rule passed alongside can report too', async () => {
    const other = defineRule<void>({
      name: 'test-other-rule',
      meta: { description: 'Flags DROP.', defaultSeverity: 'error', defaultOptions: undefined },
      create(context) {
        return {
          DropStmt(_node, path) {
            context.report({ statement: path.statement, message: 'No DROP.' });
          },
        };
      },
    });

    // Only the rule under test is enabled, so the extra rule is registered but
    // silent — which is what keeps every returned diagnostic attributable.
    const diagnostics = await lintRuleCase(banCreateTable, { sql: 'DROP TABLE t;' }, [
      other as Rule<never>,
    ]);
    assert.deepEqual(diagnostics, []);
  });

  await t.test('settings that differ only by a function are not treated as equal', async () => {
    // The cached linter is keyed on the case's config. `migrationDate` is a
    // function, so a JSON-only key drops it and the second case here would
    // silently reuse the first one's linter — and its gating decision.
    const gated = defineRule<void>({
      ...banCreateTable,
      name: 'test-gated',
    });
    const input = { sql: 'CREATE TABLE t (a int);', filename: 'rev-1.sql', enabledFrom: 20260101 };

    const before = await lintRuleCase(gated, {
      ...input,
      settings: { migrationDate: () => 20200101 },
    });
    const after = await lintRuleCase(gated, {
      ...input,
      settings: { migrationDate: () => 20270101 },
    });

    assert.equal(before.length, 0, 'a migration dated before enabledFrom is gated out');
    assert.equal(after.length, 1, 'a migration dated after enabledFrom runs the rule');
  });
});
