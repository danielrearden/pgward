import type { ScanToken } from '@supabase/pg-parser';

import { analyzeSessionSettings } from './analysis/settings.ts';
import { analyzeTransactions } from './analysis/transactions.ts';
import type { Comment, Position, SourceFile, Statement, WrappedNode } from './types.ts';
import { unwrap } from './walk.ts';

const COMMENT_KINDS = new Set(['SQL_COMMENT', 'C_COMMENT']);
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

export interface BuildSourceFileArgs {
  sql: string;
  filename?: string | null;
  /** `tree.stmts` straight from the parser. */
  stmts: readonly unknown[];
  tokens: readonly ScanToken[];
  /** Whether the runner wraps migrations in a transaction by default. */
  implicitTransactionDefault: boolean;
  /** Overrides `implicitTransactionDefault` for this file, when known. */
  implicitTransaction?: boolean | undefined;
}

interface RawStatement {
  stmt?: unknown;
  stmt_location?: number;
  stmt_len?: number;
}

export function buildSourceFile(args: BuildSourceFileArgs): SourceFile {
  const { sql, tokens } = args;
  const bytes = new TextEncoder().encode(sql);
  const decoder = new TextDecoder();

  const lineStarts: number[] = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) lineStarts.push(index + 1);
  }

  const clamp = (offset: number): number => Math.max(0, Math.min(offset, bytes.length));

  const textBetween = (start: number, end: number): string => {
    const from = clamp(start);
    const to = Math.max(from, clamp(end));
    return decoder.decode(bytes.subarray(from, to));
  };

  const positionAt = (offset: number): Position => {
    const target = clamp(offset);
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= target) low = mid;
      else high = mid - 1;
    }
    const lineStart = lineStarts[low]!;
    // Column is counted in UTF-16 code units so it matches what editors show.
    return { line: low + 1, column: decoder.decode(bytes.subarray(lineStart, target)).length + 1 };
  };

  const comments: Comment[] = [];
  const realTokens: ScanToken[] = [];
  for (const token of tokens) {
    if (COMMENT_KINDS.has(token.kind)) {
      comments.push({
        text: token.text,
        start: token.start,
        end: token.end,
        ...positionAt(token.start),
      });
    } else {
      realTokens.push(token);
    }
  }

  const statements: Statement[] = [];
  let cursor = 0;

  for (const raw of args.stmts as readonly RawStatement[]) {
    if (!raw || typeof raw !== 'object' || raw.stmt === undefined) continue;

    const rawStart = raw.stmt_location ?? 0;
    // `stmt_len` is 0 for a trailing statement with no semicolon.
    const rawEnd = raw.stmt_len && raw.stmt_len > 0 ? rawStart + raw.stmt_len : bytes.length;

    // libpg_query's `stmt_location` points at the whitespace and comments that
    // preceded the statement, which would put every diagnostic on the wrong
    // line. Walk forward to the first token that is actually part of it.
    while (cursor < realTokens.length && realTokens[cursor]!.start < rawStart) cursor += 1;

    let start = realTokens[cursor]?.start ?? rawStart;
    if (start >= rawEnd) start = skipWhitespaceForward(bytes, rawStart, rawEnd);

    let end = start;
    let scan = cursor;
    while (scan < realTokens.length && realTokens[scan]!.start < rawEnd) {
      end = realTokens[scan]!.end;
      scan += 1;
    }
    if (end <= start) end = trimWhitespaceBackward(bytes, start, rawEnd);

    const { type, node } = unwrap(raw.stmt as Record<string, object>);
    statements.push({
      index: statements.length,
      stmt: raw.stmt as WrappedNode,
      type,
      node,
      start,
      end,
      text: textBetween(start, end),
    });
  }

  const transactions = analyzeTransactions(
    statements,
    args.implicitTransaction ?? args.implicitTransactionDefault,
  );

  return {
    sql,
    filename: args.filename ?? null,
    statements,
    comments,
    tokens: realTokens,
    transactions,
    sessionSettings: analyzeSessionSettings(statements, transactions),
    positionAt,
    textBetween,
    statementAt(offset) {
      return (
        statements.find(
          (statement) => offset >= statement.start && offset <= statement.end,
        ) ?? null
      );
    },
  };
}

function skipWhitespaceForward(bytes: Uint8Array, from: number, limit: number): number {
  let offset = from;
  while (offset < limit && WHITESPACE.has(bytes[offset] ?? 0)) offset += 1;
  return offset;
}

function trimWhitespaceBackward(bytes: Uint8Array, from: number, limit: number): number {
  let offset = Math.min(limit, bytes.length);
  while (offset > from && WHITESPACE.has(bytes[offset - 1] ?? 0)) offset -= 1;
  return offset;
}
