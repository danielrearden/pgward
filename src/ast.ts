import type { Statement } from './types.ts';

export type AstNode = Record<string, any>;

/** Reads the payload of a `{ String: { sval } }` node, or any bare string. */
export function stringValue(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (node === null || typeof node !== 'object') return null;
  const record = node as AstNode;
  if (record['String']) return String(record['String']['sval'] ?? '');
  if (record['Integer']) return String(record['Integer']['ival'] ?? 0);
  return null;
}

/** Reads a list of `String` nodes into plain strings, e.g. a qualified name. */
export function stringList(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map(stringValue).filter((value): value is string => value !== null);
}

/**
 * The parts of a type name with the implicit `pg_catalog` schema removed.
 *
 * Postgres canonicalizes keyword types during parsing, so `bigint` arrives as
 * `pg_catalog.int8` and `char(10)` as `pg_catalog.bpchar`. Types that aren't
 * grammar keywords — `text`, `serial`, `uuid` — come through unqualified.
 */
export function typeNameParts(typeName: unknown): string[] {
  if (!typeName || typeof typeName !== 'object') return [];
  const parts = stringList((typeName as AstNode)['names']);
  if (parts.length > 1 && parts[0] === 'pg_catalog') return parts.slice(1);
  return parts;
}

/** The normalized, lower-cased type name, e.g. `int8`, `text`, `timestamptz`. */
export function typeNameOf(typeName: unknown): string {
  return typeNameParts(typeName).join('.').toLowerCase();
}

/** True when the type carries a length or precision, as in `varchar(20)`. */
export function hasTypeModifiers(typeName: unknown): boolean {
  if (!typeName || typeof typeName !== 'object') return false;
  const typmods = (typeName as AstNode)['typmods'];
  return Array.isArray(typmods) && typmods.length > 0;
}

const FRIENDLY_TYPE_NAMES: Record<string, string> = {
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  bpchar: 'char',
  varchar: 'varchar',
  float4: 'real',
  float8: 'double precision',
  bool: 'boolean',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  timetz: 'timetz',
};

/** The name a person would write, for use in messages. */
export function describeType(typeName: unknown): string {
  const name = typeNameOf(typeName);
  return FRIENDLY_TYPE_NAMES[name] ?? name;
}

export interface RelationName {
  schema: string | null;
  name: string;
  /** `schema.name` when schema-qualified, otherwise just the name. */
  qualified: string;
}

/** Reads a `RangeVar` into its schema and relation name. */
export function relationName(rangeVar: unknown): RelationName {
  const record = (rangeVar ?? {}) as AstNode;
  const schema = record['schemaname'] ? String(record['schemaname']) : null;
  const name = String(record['relname'] ?? '');
  return { schema, name, qualified: schema ? `${schema}.${name}` : name };
}

/**
 * Reads the name out of a `DropStmt`/`CommentStmt` object entry, which is
 * either a `List` of name parts or a single `String`.
 */
export function objectName(object: unknown): string {
  if (object === null || typeof object !== 'object') return '';
  const record = object as AstNode;
  if (record['List']) return stringList(record['List']['items']).join('.');
  return stringValue(object) ?? '';
}

/** Lower-cased `defname`s from a `DefElem` list — REINDEX params, VACUUM options. */
export function defElemNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (entry as AstNode)?.['DefElem']?.['defname'])
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.toLowerCase());
}

export function hasDefElem(list: unknown, name: string): boolean {
  return defElemNames(list).includes(name.toLowerCase());
}

/** The `Constraint` payloads attached to a `ColumnDef`. */
export function columnConstraints(columnDef: unknown): AstNode[] {
  const constraints = (columnDef as AstNode)?.['constraints'];
  if (!Array.isArray(constraints)) return [];
  return constraints
    .map((entry) => (entry as AstNode)?.['Constraint'])
    .filter((entry): entry is AstNode => Boolean(entry));
}

export function hasColumnConstraint(columnDef: unknown, contype: string): boolean {
  return columnConstraints(columnDef).some((constraint) => constraint['contype'] === contype);
}

export interface TableElements {
  columns: AstNode[];
  constraints: AstNode[];
}

/** Splits `CREATE TABLE` elements into column definitions and table constraints. */
export function tableElements(createStmt: unknown): TableElements {
  const elements = (createStmt as AstNode)?.['tableElts'];
  const columns: AstNode[] = [];
  const constraints: AstNode[] = [];
  if (!Array.isArray(elements)) return { columns, constraints };

  for (const element of elements) {
    const record = element as AstNode;
    if (record['ColumnDef']) columns.push(record['ColumnDef']);
    else if (record['Constraint']) constraints.push(record['Constraint']);
  }
  return { columns, constraints };
}

/** The `AlterTableCmd` payloads of an `AlterTableStmt`. */
export function alterTableCommands(alterTableStmt: unknown): AstNode[] {
  const cmds = (alterTableStmt as AstNode)?.['cmds'];
  if (!Array.isArray(cmds)) return [];
  return cmds
    .map((entry) => (entry as AstNode)?.['AlterTableCmd'])
    .filter((entry): entry is AstNode => Boolean(entry));
}

export function isCreateIndexConcurrently(statement: Statement): boolean {
  return statement.type === 'IndexStmt' && Boolean((statement.node as AstNode)['concurrent']);
}

export function isDropIndex(statement: Statement): boolean {
  return (
    statement.type === 'DropStmt' && (statement.node as AstNode)['removeType'] === 'OBJECT_INDEX'
  );
}

export function isDropIndexConcurrently(statement: Statement): boolean {
  return isDropIndex(statement) && Boolean((statement.node as AstNode)['concurrent']);
}

export function isReindexConcurrently(statement: Statement): boolean {
  return (
    statement.type === 'ReindexStmt' &&
    hasDefElem((statement.node as AstNode)['params'], 'concurrently')
  );
}

export function isDetachPartitionConcurrently(statement: Statement): boolean {
  if (statement.type !== 'AlterTableStmt') return false;
  return alterTableCommands(statement.node).some(
    (cmd) =>
      cmd['subtype'] === 'AT_DetachPartition' &&
      Boolean(cmd['def']?.['PartitionCmd']?.['concurrent']),
  );
}

export function usesConcurrently(statement: Statement): boolean {
  return (
    isCreateIndexConcurrently(statement) ||
    isDropIndexConcurrently(statement) ||
    isReindexConcurrently(statement) ||
    isDetachPartitionConcurrently(statement)
  );
}

const SET_KINDS = new Set(['VAR_SET_VALUE', 'VAR_SET_CURRENT', 'VAR_SET_MULTI', 'VAR_SET_DEFAULT']);
const RESET_KINDS = new Set(['VAR_RESET', 'VAR_RESET_ALL']);

export function isSetStatement(statement: Statement): boolean {
  return (
    statement.type === 'VariableSetStmt' &&
    SET_KINDS.has(String((statement.node as AstNode)['kind'] ?? ''))
  );
}

export function isResetStatement(statement: Statement): boolean {
  return (
    statement.type === 'VariableSetStmt' &&
    RESET_KINDS.has(String((statement.node as AstNode)['kind'] ?? ''))
  );
}

export function isTransactionControl(statement: Statement): boolean {
  return statement.type === 'TransactionStmt';
}

/** The table a statement operates on, when it names exactly one. */
export function statementRelation(statement: Statement): RelationName | null {
  const node = statement.node as AstNode;
  if (node['relation']) return relationName(node['relation']);
  return null;
}
