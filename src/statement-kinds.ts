import {
  isCreateIndexConcurrently,
  isDetachPartitionConcurrently,
  isDropIndex,
  isDropIndexConcurrently,
  isReindexConcurrently,
  isResetStatement,
  isSetStatement,
  type AstNode,
} from './ast.ts';
import type { Statement } from './types.ts';

/**
 * Human-readable statement kinds, so rule options read like the SQL they
 * describe (`guardedStatements: ['ALTER TABLE', 'TRUNCATE']`) rather than like
 * libpg_query node names.
 */
const MATCHERS: Record<string, (statement: Statement) => boolean> = {
  'ALTER TABLE': (statement) => statement.type === 'AlterTableStmt',
  'CREATE TABLE': (statement) => statement.type === 'CreateStmt',
  'DROP TABLE': (statement) =>
    statement.type === 'DropStmt' && (statement.node as AstNode)['removeType'] === 'OBJECT_TABLE',
  TRUNCATE: (statement) => statement.type === 'TruncateStmt',

  'CREATE INDEX': (statement) => statement.type === 'IndexStmt',
  'CREATE INDEX CONCURRENTLY': isCreateIndexConcurrently,
  'DROP INDEX': isDropIndex,
  'DROP INDEX CONCURRENTLY': isDropIndexConcurrently,
  REINDEX: (statement) => statement.type === 'ReindexStmt',
  'REINDEX CONCURRENTLY': isReindexConcurrently,
  'DETACH PARTITION CONCURRENTLY': isDetachPartitionConcurrently,

  SET: isSetStatement,
  RESET: isResetStatement,
  BEGIN: (statement) =>
    statement.type === 'TransactionStmt' &&
    ['TRANS_STMT_BEGIN', 'TRANS_STMT_START'].includes(
      String((statement.node as AstNode)['kind'] ?? ''),
    ),
  COMMIT: (statement) =>
    statement.type === 'TransactionStmt' &&
    ['TRANS_STMT_COMMIT', 'TRANS_STMT_ROLLBACK'].includes(
      String((statement.node as AstNode)['kind'] ?? ''),
    ),

  'CREATE SCHEMA': (statement) => statement.type === 'CreateSchemaStmt',
  'ALTER INDEX': (statement) => statement.type === 'AlterTableStmt' && isIndexTarget(statement),
  COMMENT: (statement) => statement.type === 'CommentStmt',
  GRANT: (statement) => statement.type === 'GrantStmt',
  VACUUM: (statement) => statement.type === 'VacuumStmt',
  CLUSTER: (statement) => statement.type === 'ClusterStmt',
  INSERT: (statement) => statement.type === 'InsertStmt',
  UPDATE: (statement) => statement.type === 'UpdateStmt',
  DELETE: (statement) => statement.type === 'DeleteStmt',
  SELECT: (statement) => statement.type === 'SelectStmt',
};

function isIndexTarget(statement: Statement): boolean {
  return (statement.node as AstNode)['objtype'] === 'OBJECT_INDEX';
}

/**
 * Source-text patterns for the same kinds, used where there is no AST to match
 * against — the inside of a dollar-quoted function body, for instance.
 */
const PATTERNS: Record<string, RegExp> = {
  'ALTER TABLE': /\bALTER\s+TABLE\b/i,
  'CREATE TABLE': /\bCREATE\s+(?:\w+\s+)*TABLE\b/i,
  'DROP TABLE': /\bDROP\s+TABLE\b/i,
  TRUNCATE: /\bTRUNCATE\b/i,
  'CREATE INDEX': /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  'CREATE INDEX CONCURRENTLY': /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i,
  'DROP INDEX': /\bDROP\s+INDEX\b/i,
  'DROP INDEX CONCURRENTLY': /\bDROP\s+INDEX\s+CONCURRENTLY\b/i,
  REINDEX: /\bREINDEX\b/i,
  'REINDEX CONCURRENTLY': /\bREINDEX\b[\s\S]{0,40}?\bCONCURRENTLY\b/i,
  'DETACH PARTITION CONCURRENTLY': /\bDETACH\s+PARTITION\b[\s\S]{0,60}?\bCONCURRENTLY\b/i,
  SET: /\bSET\b/i,
  RESET: /\bRESET\b/i,
  BEGIN: /\bBEGIN\b/i,
  COMMIT: /\bCOMMIT\b/i,
  'CREATE SCHEMA': /\bCREATE\s+SCHEMA\b/i,
  'ALTER INDEX': /\bALTER\s+INDEX\b/i,
  COMMENT: /\bCOMMENT\s+ON\b/i,
  GRANT: /\bGRANT\b/i,
  VACUUM: /\bVACUUM\b/i,
  CLUSTER: /\bCLUSTER\b/i,
  INSERT: /\bINSERT\s+INTO\b/i,
  UPDATE: /\bUPDATE\b/i,
  DELETE: /\bDELETE\s+FROM\b/i,
  SELECT: /\bSELECT\b/i,
};

/**
 * Every value accepted by the statement-kind options — `guardedStatements`,
 * `safeStatements`, `checkedStatements`.
 */
export const KNOWN_STATEMENT_KINDS: readonly string[] = Object.keys(MATCHERS);

// Each kind needs both an AST matcher and a source-text pattern; a kind present
// in only one silently degrades whichever path is missing it.
for (const kind of KNOWN_STATEMENT_KINDS) {
  if (!PATTERNS[kind]) {
    throw new Error(`pgward: statement kind ${JSON.stringify(kind)} has no source-text pattern`);
  }
}
for (const kind of Object.keys(PATTERNS)) {
  if (!MATCHERS[kind]) {
    throw new Error(`pgward: statement kind ${JSON.stringify(kind)} has no AST matcher`);
  }
}

export function matchesStatementKind(statement: Statement, kind: string): boolean {
  return MATCHERS[normalize(kind)]?.(statement) ?? false;
}

export function matchesAnyStatementKind(statement: Statement, kinds: readonly string[]): boolean {
  return kinds.some((kind) => matchesStatementKind(statement, kind));
}

export function statementKindPattern(kind: string): RegExp | null {
  return PATTERNS[normalize(kind)] ?? null;
}

/** Canonical spelling of a statement kind, so option values can be written loosely. */
export function normalizeStatementKind(kind: string): string {
  return kind.trim().replace(/\s+/g, ' ').toUpperCase();
}

const normalize = normalizeStatementKind;

/**
 * Rejects unrecognized statement kinds at construction time. A typo in an
 * option list would otherwise silently narrow a rule to nothing, which is the
 * quiet failure this linter exists to prevent.
 */
export function assertKnownStatementKinds(
  ruleId: string,
  optionName: string,
  kinds: readonly string[],
): void {
  for (const kind of kinds) {
    if (MATCHERS[normalize(kind)]) continue;
    throw new TypeError(
      `pgward: rule "${ruleId}" option ${optionName} has unknown statement kind ` +
        `${JSON.stringify(kind)}. Known kinds: ${KNOWN_STATEMENT_KINDS.join(', ')}`,
    );
  }
}
