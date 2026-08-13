import type { Statement, TransactionAnalysis } from '../types.ts';

export interface TransactionAnalysisInternal extends TransactionAnalysis {
  /**
   * An id that changes every time a transaction ends. Two statements share an
   * epoch only if no `COMMIT`/`ROLLBACK` ran between them, which is what makes
   * `SET LOCAL` scoping computable.
   */
  epochBefore: readonly number[];
}

const OPENS = new Set(['TRANS_STMT_BEGIN', 'TRANS_STMT_START']);
const CLOSES = new Set(['TRANS_STMT_COMMIT', 'TRANS_STMT_ROLLBACK']);

/** True when the statement is `BEGIN` or `START TRANSACTION`. */
export function opensTransaction(statement: Statement): boolean {
  return statement.type === 'TransactionStmt' && OPENS.has(transactionKind(statement));
}

/** True when the statement is `COMMIT` or `ROLLBACK`. */
export function closesTransaction(statement: Statement): boolean {
  return statement.type === 'TransactionStmt' && CLOSES.has(transactionKind(statement));
}

export function transactionKind(statement: Statement): string {
  if (statement.type !== 'TransactionStmt') return '';
  const kind = (statement.node as Record<string, unknown>)['kind'];
  return typeof kind === 'string' ? kind : '';
}

/**
 * Tracks explicit transaction depth across a file.
 *
 * Savepoints deliberately don't change the depth — they nest within a
 * transaction rather than starting one, and the rules that care about nesting
 * are looking for a second `BEGIN`.
 */
export function analyzeTransactions(
  statements: readonly Statement[],
  implicit: boolean,
): TransactionAnalysisInternal {
  const depthBefore: number[] = [];
  const depthAfter: number[] = [];
  const epochBefore: number[] = [];

  let depth = 0;
  let epoch = 0;

  for (const statement of statements) {
    depthBefore.push(depth);
    epochBefore.push(epoch);

    if (opensTransaction(statement)) {
      depth += 1;
    } else if (closesTransaction(statement)) {
      if (depth > 0) depth -= 1;
      // An implicit transaction also ends here, so the epoch advances either way.
      epoch += 1;
    }

    depthAfter.push(depth);
  }

  return {
    implicit,
    depthBefore,
    depthAfter,
    epochBefore,
    unclosed: depth > 0,
    inExplicitTransaction(index) {
      return (depthBefore[index] ?? 0) > 0;
    },
    inTransaction(index) {
      // Once an implicit transaction has been committed, later statements are
      // no longer covered by it.
      if (implicit && (epochBefore[index] ?? 0) === 0) return true;
      return (depthBefore[index] ?? 0) > 0;
    },
  };
}
