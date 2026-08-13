import { relationName, type RelationName } from '../ast.ts';
import type { SourceFile } from '../types.ts';

/**
 * Recognizes tables created by the migration being linted.
 *
 * Most lock hazards don't apply to a table that doesn't exist yet — nothing is
 * reading it, so an exclusive lock costs nothing.
 *
 * Matching allows one side to be unqualified, because `CREATE TABLE public.thing`
 * is routinely followed by `ALTER TABLE thing`. It stops there: two *different*
 * explicit schemas name two different tables, and treating `staging.thing` as
 * cover for `public.thing` would silently exempt a live table from every rule
 * that consults this.
 */
export function createdTableMatcher(source: SourceFile): (relation: RelationName | null) => boolean {
  const qualified = new Set<string>();
  const unqualified = new Set<string>();
  /** Bare names of created tables, whether or not a schema was written. */
  const anySchema = new Set<string>();

  for (const statement of source.statements) {
    const node = statement.node as Record<string, any>;
    const relation =
      statement.type === 'CreateStmt' || statement.type === 'CreateTableAsStmt'
        ? (node['relation'] ?? node['into']?.['rel'])
        : null;
    if (!relation) continue;

    const name = relationName(relation);
    if (name.name === '') continue;
    anySchema.add(name.name);
    if (name.schema) qualified.add(name.qualified);
    else unqualified.add(name.name);
  }

  return (relation) => {
    if (!relation || relation.name === '') return false;
    if (relation.schema ? qualified.has(relation.qualified) : unqualified.has(relation.name)) {
      return true;
    }
    // One side omitted the schema, so they may well be the same table.
    return relation.schema ? unqualified.has(relation.name) : anySchema.has(relation.name);
  };
}
