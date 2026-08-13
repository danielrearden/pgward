import assert from 'node:assert/strict';
import test from 'node:test';

import { makeSource } from '../helpers/source.ts';

test('source: positions', async (t) => {
  await t.test('maps offset 0 to line 1, column 1', async () => {
    const source = await makeSource('SELECT 1;');
    assert.deepEqual(source.positionAt(0), { line: 1, column: 1 });
  });

  await t.test('counts lines from newlines', async () => {
    const source = await makeSource('SELECT 1;\nSELECT 2;\nSELECT 3;');
    assert.deepEqual(source.positionAt(10), { line: 2, column: 1 });
    assert.deepEqual(source.positionAt(20), { line: 3, column: 1 });
  });

  await t.test('reports columns in characters, not bytes', async () => {
    // "é" is two bytes in UTF-8 but one UTF-16 code unit, so the byte offset of
    // the closing quote and its column diverge.
    const sql = "SELECT 'éé' AS x;";
    const source = await makeSource(sql);
    const byteOffsetOfAs = new TextEncoder().encode(sql).indexOf(0x41); // 'A' of AS

    assert.equal(byteOffsetOfAs, 14, 'byte offset accounts for the two-byte characters');
    assert.deepEqual(source.positionAt(byteOffsetOfAs), { line: 1, column: 13 });
  });

  await t.test('clamps out-of-range offsets', async () => {
    const source = await makeSource('SELECT 1;');
    assert.deepEqual(source.positionAt(-5), { line: 1, column: 1 });
    assert.deepEqual(source.positionAt(9999), { line: 1, column: 10 });
  });
});

test('source: statements', async (t) => {
  await t.test('starts at the first real token, not the preceding whitespace', async () => {
    const source = await makeSource('SELECT 1;\n\n   SELECT 2;');
    const [first, second] = source.statements;

    assert.equal(first?.text, 'SELECT 1');
    assert.equal(second?.text, 'SELECT 2');
    assert.deepEqual(source.positionAt(second!.start), { line: 3, column: 4 });
  });

  await t.test('skips leading comments', async () => {
    const source = await makeSource('-- a note\n-- another\nSELECT 1;');
    const statement = source.statements[0]!;

    assert.equal(statement.text, 'SELECT 1');
    assert.deepEqual(source.positionAt(statement.start), { line: 3, column: 1 });
  });

  await t.test('handles a trailing statement with no semicolon', async () => {
    const source = await makeSource('SELECT 1;\nSELECT 2\n');
    assert.equal(source.statements.length, 2);
    assert.equal(source.statements[1]?.text, 'SELECT 2');
  });

  await t.test('exposes the unwrapped node and its type', async () => {
    const source = await makeSource('ALTER TABLE t ADD COLUMN c int;');
    const statement = source.statements[0]!;

    assert.equal(statement.type, 'AlterTableStmt');
    assert.equal((statement.node as any).relation.relname, 't');
    assert.equal(statement.index, 0);
  });

  await t.test('textBetween slices on byte offsets', async () => {
    const source = await makeSource('SELECT 1;');
    assert.equal(source.textBetween(0, 6), 'SELECT');
  });
});

test('source: comments', async (t) => {
  await t.test('collects line and block comments with positions', async () => {
    const source = await makeSource('-- first\nSELECT 1; /* second */\nSELECT 2;');

    assert.deepEqual(
      source.comments.map((comment) => [comment.text, comment.line, comment.column]),
      [
        ['-- first', 1, 1],
        ['/* second */', 2, 11],
      ],
    );
  });

  await t.test('keeps comments out of statement text', async () => {
    const source = await makeSource('SELECT 1; -- trailing');
    assert.equal(source.statements[0]?.text, 'SELECT 1');
  });
});
