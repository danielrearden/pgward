import assert from 'node:assert/strict';
import test from 'node:test';

import { findSuppression, scanSuppressions } from '../../src/suppressions.ts';
import { makeSource } from '../helpers/source.ts';

const scan = async (sql: string) => scanSuppressions(await makeSource(sql));

test('suppressions: parsing', async (t) => {
  await t.test('reads a rule and its reason', async () => {
    const { suppressions, invalid } = await scan(
      '-- pgward-ignore ban-drop-table: superseded by V123\nDROP TABLE t;',
    );

    assert.deepEqual(invalid, []);
    assert.equal(suppressions.length, 1);
    assert.deepEqual(suppressions[0]?.rules, ['ban-drop-table']);
    assert.equal(suppressions[0]?.reason, 'superseded by V123');
    assert.equal(suppressions[0]?.scope, 'statement');
    assert.equal(suppressions[0]?.statementIndex, 0);
  });

  await t.test('reads several rules from one comment', async () => {
    const { suppressions } = await scan(
      '-- pgward-ignore ban-drop-table, renaming-table: one-off backfill\nDROP TABLE t;',
    );
    assert.deepEqual(suppressions[0]?.rules, ['ban-drop-table', 'renaming-table']);
  });

  await t.test('accepts block comments', async () => {
    const { suppressions } = await scan(
      '/* pgward-ignore ban-drop-table: legacy cleanup */\nDROP TABLE t;',
    );
    assert.equal(suppressions[0]?.reason, 'legacy cleanup');
  });

  await t.test('ignores unrelated comments', async () => {
    const { suppressions, invalid } = await scan('-- just a note\nDROP TABLE t;');
    assert.deepEqual(suppressions, []);
    assert.deepEqual(invalid, []);
  });
});

test('suppressions: scope', async (t) => {
  await t.test('applies to the next statement, not the preceding one', async () => {
    const { suppressions } = await scan(
      'DROP TABLE a;\n-- pgward-ignore ban-drop-table: only b is expendable\nDROP TABLE b;',
    );
    assert.equal(suppressions[0]?.statementIndex, 1);
  });

  await t.test('a directive trailing a statement applies to that statement', async () => {
    // Read as "the next statement", this would leave line 1 failing while
    // silently waiving line 2 — the author's annotation landing on the wrong
    // statement without anything saying so.
    const { suppressions } = await scan(
      'DROP TABLE a; -- pgward-ignore ban-drop-table: this one is expendable\nDROP TABLE b;',
    );

    assert.equal(suppressions.length, 1);
    assert.equal(suppressions[0]?.statementIndex, 0);
  });

  await t.test('a trailing directive still works when the statement spans lines', async () => {
    const { suppressions } = await scan(
      'ALTER TABLE t\n  DROP COLUMN a; -- pgward-ignore ban-drop-column: read path gone\nDROP TABLE b;',
    );
    assert.equal(suppressions[0]?.statementIndex, 0);
  });

  await t.test('a directive on its own line still targets the next statement', async () => {
    const { suppressions } = await scan(
      'DROP TABLE a;\n-- pgward-ignore ban-drop-table: only b\nDROP TABLE b;',
    );
    assert.equal(suppressions[0]?.statementIndex, 1);
  });

  await t.test('file scope covers every statement', async () => {
    const { suppressions } = await scan(
      '-- pgward-ignore-file ban-drop-table: teardown migration\nDROP TABLE a;\nDROP TABLE b;',
    );

    assert.equal(suppressions[0]?.scope, 'file');
    assert.equal(suppressions[0]?.statementIndex, null);
    assert.ok(findSuppression(suppressions, 'ban-drop-table', 0));
    assert.ok(findSuppression(suppressions, 'ban-drop-table', 1));
  });

  await t.test('matches only the named rule and statement', async () => {
    const { suppressions } = await scan(
      'DROP TABLE a;\n-- pgward-ignore ban-drop-table: expendable\nDROP TABLE b;',
    );

    assert.ok(findSuppression(suppressions, 'ban-drop-table', 1));
    assert.equal(findSuppression(suppressions, 'ban-drop-table', 0), null);
    assert.equal(findSuppression(suppressions, 'renaming-table', 1), null);
    assert.equal(findSuppression(suppressions, 'ban-drop-table', null), null);
  });
});

test('suppressions: rejected directives', async (t) => {
  await t.test('a missing reason is reported, not honored', async () => {
    const { suppressions, invalid } = await scan('-- pgward-ignore ban-drop-table\nDROP TABLE t;');

    assert.deepEqual(suppressions, []);
    assert.equal(invalid.length, 1);
    assert.match(invalid[0]!.problem, /gives no reason/);
  });

  await t.test('an empty reason after the colon is rejected', async () => {
    const { invalid } = await scan('-- pgward-ignore ban-drop-table:   \nDROP TABLE t;');
    assert.match(invalid[0]!.problem, /gives no reason/);
  });

  await t.test('naming no rule is rejected', async () => {
    const { invalid } = await scan('-- pgward-ignore : because\nDROP TABLE t;');
    assert.match(invalid[0]!.problem, /names no rule/);
  });

  await t.test('a directive with nothing after it is rejected', async () => {
    const { invalid } = await scan('DROP TABLE t;\n-- pgward-ignore ban-drop-table: too late');
    assert.match(invalid[0]!.problem, /no statement follows it/);
  });

  await t.test('an unknown rule name is rejected when the registry is supplied', async () => {
    // A typo'd id would otherwise suppress nothing at all, which reads to the
    // author exactly like a rule that was successfully waived.
    const source = await makeSource('-- pgward-ignore ban-drop-tabel: typo\nDROP TABLE t;');
    const { suppressions, invalid } = scanSuppressions(source, new Set(['ban-drop-table']));

    assert.deepEqual(suppressions, []);
    assert.equal(invalid.length, 1);
    assert.match(invalid[0]!.problem, /no rule is named "ban-drop-tabel"/);
  });

  await t.test('one bad name in a list rejects the whole directive', async () => {
    const source = await makeSource(
      '-- pgward-ignore ban-drop-table, renaming-tabel: mixed\nDROP TABLE t;',
    );
    const { suppressions, invalid } = scanSuppressions(
      source,
      new Set(['ban-drop-table', 'renaming-table']),
    );

    assert.deepEqual(suppressions, []);
    assert.match(invalid[0]!.problem, /"renaming-tabel"/);
  });

  await t.test('known names pass the registry check', async () => {
    const source = await makeSource('-- pgward-ignore ban-drop-table: fine\nDROP TABLE t;');
    const { suppressions, invalid } = scanSuppressions(source, new Set(['ban-drop-table']));

    assert.deepEqual(invalid, []);
    assert.equal(suppressions.length, 1);
  });
});
