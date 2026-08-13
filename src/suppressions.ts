import type { Comment, SourceFile, Statement } from './types.ts';

export interface Suppression {
  /** Rule ids this comment silences. */
  rules: readonly string[];
  /** The mandatory justification. */
  reason: string;
  scope: 'statement' | 'file';
  comment: Comment;
  /** The statement the suppression covers; null when file-scoped. */
  statementIndex: number | null;
}

export interface InvalidSuppression {
  comment: Comment;
  /** Why the directive was rejected, phrased for a diagnostic message. */
  problem: string;
}

export interface SuppressionScan {
  suppressions: Suppression[];
  invalid: InvalidSuppression[];
}

const DIRECTIVE = /^pgward-ignore(-file)?\b(.*)$/is;

/** Strips `--` or block-comment delimiters, leaving the comment's text. */
function commentBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('--')) return trimmed.slice(2).trim();
  if (trimmed.startsWith('/*')) {
    return trimmed
      .slice(2, trimmed.endsWith('*/') ? -2 : undefined)
      .trim();
  }
  return trimmed;
}

/**
 * Reads `pgward-ignore` directives out of the file's comments.
 *
 * A statement-scoped suppression applies to the next statement, or — when it
 * trails a statement on the same line — to that statement. A file-scoped one
 * applies everywhere. The reason is required, and every rule named has to
 * exist: a suppression that silences nothing is the same class of unreviewable
 * change the rules exist to catch, so it is reported rather than honored.
 *
 * `knownRuleIds` is the linter's registry. Pass it to have typo'd rule names
 * rejected; omit it to skip that check.
 */
export function scanSuppressions(
  source: SourceFile,
  knownRuleIds?: ReadonlySet<string>,
): SuppressionScan {
  const suppressions: Suppression[] = [];
  const invalid: InvalidSuppression[] = [];

  for (const comment of source.comments) {
    const match = DIRECTIVE.exec(commentBody(comment.text));
    if (!match) continue;

    const scope = match[1] ? 'file' : 'statement';
    const rest = (match[2] ?? '').trim();

    const separator = rest.indexOf(':');
    if (separator === -1) {
      invalid.push({
        comment,
        problem: 'it gives no reason — write `pgward-ignore <rule>: <reason>`',
      });
      continue;
    }

    const rules = rest
      .slice(0, separator)
      .split(',')
      .map((rule) => rule.trim())
      .filter((rule) => rule !== '');
    const reason = rest.slice(separator + 1).trim();

    if (rules.length === 0) {
      invalid.push({ comment, problem: 'it names no rule to suppress' });
      continue;
    }
    if (reason === '') {
      invalid.push({
        comment,
        problem: 'it gives no reason — write `pgward-ignore <rule>: <reason>`',
      });
      continue;
    }

    if (knownRuleIds) {
      const unknown = rules.filter((rule) => !knownRuleIds.has(rule));
      if (unknown.length > 0) {
        invalid.push({
          comment,
          problem:
            `no rule is named ${unknown.map((rule) => JSON.stringify(rule)).join(' or ')}, ` +
            `so it suppresses nothing`,
        });
        continue;
      }
    }

    if (scope === 'file') {
      suppressions.push({ rules, reason, scope, comment, statementIndex: null });
      continue;
    }

    const target = trailingStatement(source, comment) ?? followingStatement(source, comment);
    if (!target) {
      invalid.push({ comment, problem: 'no statement follows it, so it suppresses nothing' });
      continue;
    }

    suppressions.push({ rules, reason, scope, comment, statementIndex: target.index });
  }

  return { suppressions, invalid };
}

/**
 * The statement a directive trails on the same line.
 *
 * `ALTER TABLE t DROP COLUMN a;  -- pgward-ignore ban-drop-column: …` means
 * *this* statement. Reading it as "the next statement" would leave the line the
 * author annotated still failing while silently waiving the one after it.
 */
function trailingStatement(source: SourceFile, comment: Comment): Statement | null {
  for (let index = source.statements.length - 1; index >= 0; index -= 1) {
    const statement = source.statements[index]!;
    if (statement.end > comment.start) continue;
    return source.positionAt(statement.end).line === comment.line ? statement : null;
  }
  return null;
}

function followingStatement(source: SourceFile, comment: Comment): Statement | null {
  return source.statements.find((statement) => statement.start >= comment.end) ?? null;
}

/**
 * Finds the suppression covering a diagnostic, or null when it isn't
 * suppressed.
 */
export function findSuppression(
  suppressions: readonly Suppression[],
  ruleId: string,
  statementIndex: number | null,
): Suppression | null {
  for (const suppression of suppressions) {
    if (!suppression.rules.includes(ruleId)) continue;
    if (suppression.scope === 'file') return suppression;
    if (statementIndex !== null && suppression.statementIndex === statementIndex) {
      return suppression;
    }
  }
  return null;
}
