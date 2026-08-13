import type { NodePath, NodeType, PathEntry, Statement, WrappedNode } from './types.ts';

/**
 * libpg_query wraps every node in a single-key envelope whose key is the node
 * type: `{ IndexStmt: { ... } }`. Node *fields*, by contrast, are always
 * lower-camel or snake case (`colname`, `typeName`, `is_local`), so a
 * single-key object with a capitalized key is unambiguously a node.
 */
export function isWrappedNode(value: unknown): value is Record<string, object> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0]!;
  if (!/^[A-Z]/.test(key)) return false;
  const inner = (value as Record<string, unknown>)[key];
  return typeof inner === 'object' && inner !== null;
}

/** Splits a wrapped node into its type name and payload. */
export function unwrap(wrapped: WrappedNode | Record<string, object>): {
  type: NodeType;
  node: Record<string, unknown>;
} {
  const type = Object.keys(wrapped)[0] as NodeType;
  return { type, node: (wrapped as Record<string, Record<string, unknown>>)[type]! };
}

export type NodeVisit = (type: NodeType, node: Record<string, unknown>, path: NodePath) => void;

/**
 * Walks every node in a statement in document order, parents before children.
 *
 * `shouldVisit` lets the caller skip node types no rule listens for, which
 * avoids building a `NodePath` (and copying the ancestor stack) for the vast
 * majority of nodes in a typical tree.
 *
 * One thing to know when writing visitors: libpg_query only wraps *polymorphic*
 * fields in the single-key envelope. A field whose type is fixed in the grammar
 * — `AlterTableStmt.relation`, `ColumnDef.typeName`, `AlterRoleSetStmt.setstmt` —
 * is embedded directly, so the walk descends through it but never announces it
 * as a node. A `RangeVar` visitor therefore fires for `TruncateStmt.relations`
 * (a Node list) but not for `CreateStmt.relation`; read those off the parent
 * node instead.
 */
export function walkStatement(
  statement: Statement,
  visit: NodeVisit,
  shouldVisit?: (type: NodeType) => boolean,
): void {
  const ancestors: PathEntry[] = [];

  const walkValue = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walkValue(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    if (isWrappedNode(value)) {
      const { type, node } = unwrap(value);
      if (!shouldVisit || shouldVisit(type)) {
        visit(type, node, { type, ancestors: ancestors.slice(), statement });
      }
      ancestors.push({ type, node });
      walkFields(node);
      ancestors.pop();
      return;
    }

    walkFields(value as Record<string, unknown>);
  };

  const walkFields = (object: Record<string, unknown>): void => {
    for (const key of Object.keys(object)) walkValue(object[key]);
  };

  walkValue(statement.stmt);
}

/** Finds the innermost ancestor of the given type, or null. */
export function findAncestor(path: NodePath, type: NodeType): Record<string, unknown> | null {
  for (let i = path.ancestors.length - 1; i >= 0; i -= 1) {
    const entry = path.ancestors[i]!;
    if (entry.type === type) return entry.node as Record<string, unknown>;
  }
  return null;
}

export function hasAncestor(path: NodePath, type: NodeType): boolean {
  return findAncestor(path, type) !== null;
}

/**
 * The smallest `location` anywhere in a subtree, or null when none is present.
 *
 * libpg_query records positions on only some node types, and uses `-1` for
 * "unknown" — `BEGIN`, for instance, has `location: -1`. Taking the minimum of
 * the real ones approximates where the construct starts in the source.
 */
export function findLocation(value: unknown): number | null {
  let best: number | null = null;

  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    const location = record['location'];
    if (typeof location === 'number' && location >= 0 && (best === null || location < best)) {
      best = location;
    }
    for (const key of Object.keys(record)) {
      if (key === 'location') continue;
      visit(record[key]);
    }
  };

  visit(value);
  return best;
}
