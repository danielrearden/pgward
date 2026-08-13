import type { LintResult } from './types.ts';

export interface FormatOptions {
  /** Include suppressed diagnostics, annotated with their reasons. */
  includeSuppressed?: boolean;
  /** Print each diagnostic's remedy on a continuation line. Defaults to true. */
  includeHelp?: boolean;
}

interface Row {
  offset: number;
  position: string;
  severity: string;
  message: string;
  help: string | null;
  ruleId: string;
}

/**
 * Renders lint results as plain text:
 *
 * ```
 * V20260812.1__add_index.sql
 *   2:1  error  Building this index takes an exclusive lock on thing.  require-concurrent-index-creation
 *               help: Use CREATE INDEX CONCURRENTLY, outside a transaction.
 *
 * 1 problem (1 error, 0 warnings)
 * ```
 */
export function formatResults(results: readonly LintResult[], options: FormatOptions = {}): string {
  const includeHelp = options.includeHelp ?? true;
  const blocks: string[] = [];
  let errors = 0;
  let warnings = 0;

  for (const result of results) {
    const rows: Row[] = result.diagnostics.map((diagnostic) => ({
      offset: diagnostic.offset,
      position: `${diagnostic.line}:${diagnostic.column}`,
      severity: diagnostic.severity,
      message: diagnostic.message,
      help: diagnostic.help,
      ruleId: diagnostic.ruleId,
    }));

    if (options.includeSuppressed) {
      for (const diagnostic of result.suppressed) {
        rows.push({
          offset: diagnostic.offset,
          position: `${diagnostic.line}:${diagnostic.column}`,
          severity: 'suppressed',
          message: `${diagnostic.message} (suppressed on line ${diagnostic.suppressionLine}: ${diagnostic.suppressionReason})`,
          help: diagnostic.help,
          ruleId: diagnostic.ruleId,
        });
      }
      // Keep suppressed entries in source order rather than tacked on at the end.
      rows.sort((a, b) => a.offset - b.offset);
    }

    errors += result.errorCount;
    warnings += result.warningCount;
    if (rows.length === 0) continue;

    const positionWidth = Math.max(...rows.map((row) => row.position.length));
    const severityWidth = Math.max(...rows.map((row) => row.severity.length));
    // Help lines hang under the message so the remedy reads as part of the same
    // entry rather than as another problem.
    const indent = ' '.repeat(2 + positionWidth + 2 + severityWidth + 2);

    const lines: string[] = [];
    for (const row of rows) {
      lines.push(
        `  ${row.position.padEnd(positionWidth)}  ${row.severity.padEnd(severityWidth)}  ` +
          `${row.message}  ${row.ruleId}`,
      );
      if (includeHelp && row.help) lines.push(`${indent}help: ${row.help}`);
    }

    blocks.push([result.filename ?? '<input>', ...lines].join('\n'));
  }

  const total = errors + warnings;
  if (total === 0 && blocks.length === 0) return 'No problems found.';

  const summary =
    `${total} problem${total === 1 ? '' : 's'} ` +
    `(${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'})`;

  return [...blocks, summary].join('\n\n');
}
