import assert from 'node:assert/strict';
import test from 'node:test';

import { findAncestor, findLocation, hasAncestor, isWrappedNode, unwrap, walkStatement } from '../../src/walk.ts';
import type { NodePath, NodeType } from '../../src/types.ts';
import { makeSource } from '../helpers/source.ts';

test('walk: node detection', async (t) => {
  await t.test('treats a single capitalized key as a node envelope', () => {
    assert.equal(isWrappedNode({ IndexStmt: { concurrent: true } }), true);
    assert.equal(isWrappedNode({ A_Const: { isnull: true } }), true);
    // An empty payload is still a node — `A_Star` has no fields.
    assert.equal(isWrappedNode({ A_Star: {} }), true);
  });

  await t.test('rejects payloads, multi-key objects and arrays', () => {
    assert.equal(isWrappedNode({ colname: 'x', typeName: {} }), false);
    assert.equal(isWrappedNode({ String: {}, Integer: {} }), false);
    assert.equal(isWrappedNode([{ String: {} }]), false);
    assert.equal(isWrappedNode({ sval: 'text' }), false);
    assert.equal(isWrappedNode(null), false);
  });

  await t.test('unwrap splits type from payload', () => {
    const { type, node } = unwrap({ RangeVar: { relname: 'foo' } });
    assert.equal(type, 'RangeVar');
    assert.deepEqual(node, { relname: 'foo' });
  });
});

test('walk: traversal', async (t) => {
  await t.test('visits parents before children, in document order', async () => {
    const source = await makeSource('ALTER TABLE public.foo ADD COLUMN baz text;');
    const seen: NodeType[] = [];
    walkStatement(source.statements[0]!, (type) => {
      seen.push(type);
    });

    assert.equal(seen[0], 'AlterTableStmt');
    assert.ok(seen.indexOf('AlterTableCmd') < seen.indexOf('ColumnDef'));
    // Reached through the embedded TypeName struct, proving the walk descends
    // into concrete fields even though it doesn't announce them.
    assert.ok(seen.includes('String'));
  });

  await t.test('announces only polymorphic fields as nodes', async () => {
    // `AlterTableStmt.relation` is a concrete RangeVar field, so it is walked
    // into but never visited; `TruncateStmt.relations` is a Node list, so it is.
    const embedded = await makeSource('ALTER TABLE t ADD COLUMN c int;');
    const seenEmbedded: NodeType[] = [];
    walkStatement(embedded.statements[0]!, (type) => void seenEmbedded.push(type));
    assert.equal(seenEmbedded.includes('RangeVar'), false);

    const wrapped = await makeSource('TRUNCATE t;');
    const seenWrapped: NodeType[] = [];
    walkStatement(wrapped.statements[0]!, (type) => void seenWrapped.push(type));
    assert.equal(seenWrapped.includes('RangeVar'), true);
  });

  await t.test('honors the shouldVisit filter', async () => {
    const source = await makeSource('ALTER TABLE t ADD COLUMN c int;');
    const seen: NodeType[] = [];
    walkStatement(
      source.statements[0]!,
      (type) => {
        seen.push(type);
      },
      (type) => type === 'ColumnDef',
    );

    assert.deepEqual(seen, ['ColumnDef']);
  });

  await t.test('builds an ancestor chain from outermost to innermost', async () => {
    const columnPath = await pathToColumnDef();

    assert.deepEqual(
      columnPath.ancestors.map((entry) => entry.type),
      ['AlterTableStmt', 'AlterTableCmd'],
    );
    assert.equal(columnPath.statement.index, 0);
  });

  await t.test('findAncestor walks outward from the node', async () => {
    const columnPath = await pathToColumnDef();

    assert.equal((findAncestor(columnPath, 'AlterTableCmd') as any)?.subtype, 'AT_AddColumn');
    assert.equal(hasAncestor(columnPath, 'AlterTableStmt'), true);
    assert.equal(hasAncestor(columnPath, 'SelectStmt'), false);
    assert.equal(findAncestor(columnPath, 'SelectStmt'), null);
  });
});

/** The `NodePath` of the single ColumnDef in `ALTER TABLE t ADD COLUMN c int`. */
async function pathToColumnDef(): Promise<NodePath> {
  const source = await makeSource('ALTER TABLE t ADD COLUMN c int;');
  const found: NodePath[] = [];
  walkStatement(source.statements[0]!, (type, _node, path) => {
    if (type === 'ColumnDef') found.push(path);
  });

  const columnPath = found[0];
  assert.ok(columnPath, 'expected to reach a ColumnDef');
  return columnPath;
}

test('walk: findLocation', async (t) => {
  await t.test('returns the smallest location in the subtree', () => {
    assert.equal(findLocation({ a: { location: 40 }, b: { location: 12 } }), 12);
  });

  await t.test('ignores the -1 placeholder libpg_query uses for "unknown"', () => {
    assert.equal(findLocation({ kind: 'TRANS_STMT_BEGIN', location: -1 }), null);
    assert.equal(findLocation({ outer: { location: -1 }, inner: { location: 7 } }), 7);
  });

  await t.test('returns null when nothing carries a location', () => {
    assert.equal(findLocation({ subtype: 'AT_DropColumn', name: 'a' }), null);
  });
});
