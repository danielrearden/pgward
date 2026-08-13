import { PgParser } from '@supabase/pg-parser';

import {
  CORE_RULE_IDS,
  isGatedOut,
  parserVersionFor,
  resolveRules,
  resolveSettings,
  type ResolvedRule,
} from './config.ts';
import { builtinRules, type RulesConfig } from './rules/index.ts';
import { buildSourceFile } from './source.ts';
import { findSuppression, scanSuppressions } from './suppressions.ts';
import type {
  AnyRule,
  Diagnostic,
  LintInput,
  LintResult,
  NodeType,
  ReportDescriptor,
  RuleContext,
  ResolvedSettings,
  RuleListener,
  SettingsInput,
  SourceFile,
  Statement,
  SuppressedDiagnostic,
} from './types.ts';
import { findLocation, walkStatement } from './walk.ts';

const LIFECYCLE_KEYS = new Set(['file', 'file:exit', 'statement', 'statement:exit', 'comment']);
const CORE_RULE_ID_SET: ReadonlySet<string> = new Set(CORE_RULE_IDS);

export interface LinterConfig {
  settings?: SettingsInput;
  /**
   * Which rules to run. Rules you don't list are off — spread
   * `configs.recommended` for a curated starting set.
   */
  rules?: RulesConfig;
  /** Rules built with `defineRule`, configurable under their own names. */
  customRules?: readonly AnyRule[];
}

export class Linter {
  #parser: PgParser<15 | 16 | 17>;
  #settings: ResolvedSettings;
  #rules: ResolvedRule[];
  #registry: Map<string, AnyRule>;

  constructor(config: LinterConfig = {}) {
    this.#settings = resolveSettings(config.settings);
    this.#registry = buildRegistry(config.customRules);
    this.#rules = resolveRules(config.rules, this.#registry);
    this.#parser = new PgParser({
      version: parserVersionFor(this.#settings.targetPostgresVersion),
    });
  }

  /** Every rule this linter knows about, built-in and custom. */
  get rules(): ReadonlyMap<string, AnyRule> {
    return this.#registry;
  }

  async lint(input: LintInput): Promise<LintResult> {
    const [parsed, scanned] = await Promise.all([
      this.#parser.parse(input.sql),
      this.#parser.scan(input.sql),
    ]);

    const source = buildSourceFile({
      sql: input.sql,
      filename: input.filename ?? null,
      stmts: parsed.tree?.stmts ?? [],
      tokens: scanned.tokens ?? [],
      implicitTransactionDefault: this.#settings.implicitTransaction,
      implicitTransaction: input.implicitTransaction,
    });

    const collected: Diagnostic[] = [];
    const enabled = this.#rules.filter(
      (resolved) =>
        !isGatedOut(resolved.enabledFrom, source.filename, this.#settings.migrationDate),
    );
    const severityOf = (ruleId: string): ResolvedRule | undefined =>
      enabled.find((resolved) => resolved.ruleId === ruleId);

    if (parsed.error) {
      const rule = severityOf('parse-error');
      if (rule) {
        collected.push(
          buildDiagnostic(source, rule, {
            message: `Could not parse this file: ${parsed.error.message}`,
            offset: parsed.error.position,
          }),
        );
      }
    } else {
      this.#runRules(enabled, source, collected);
    }

    const { suppressions, invalid } = scanSuppressions(source, new Set(this.#registry.keys()));

    const invalidRule = severityOf('invalid-suppression');
    if (invalidRule) {
      for (const item of invalid) {
        collected.push(
          buildDiagnostic(source, invalidRule, {
            message: `This pgward-ignore directive was ignored because ${item.problem}.`,
            offset: item.comment.start,
            endOffset: item.comment.end,
          }),
        );
      }
    }

    const diagnostics: Diagnostic[] = [];
    const suppressed: SuppressedDiagnostic[] = [];

    for (const diagnostic of collected) {
      const suppression = CORE_RULE_ID_SET.has(diagnostic.ruleId)
        ? null
        : findSuppression(suppressions, diagnostic.ruleId, diagnostic.statementIndex);

      if (suppression) {
        suppressed.push({
          ...diagnostic,
          suppressionReason: suppression.reason,
          suppressionLine: suppression.comment.line,
        });
      } else {
        diagnostics.push(diagnostic);
      }
    }

    diagnostics.sort(byPosition);
    suppressed.sort(byPosition);

    return {
      filename: source.filename,
      diagnostics,
      suppressed,
      errorCount: diagnostics.filter((item) => item.severity === 'error').length,
      warningCount: diagnostics.filter((item) => item.severity === 'warn').length,
    };
  }

  async lintAll(inputs: readonly LintInput[]): Promise<LintResult[]> {
    const results: LintResult[] = [];
    for (const input of inputs) results.push(await this.lint(input));
    return results;
  }

  #runRules(enabled: readonly ResolvedRule[], source: SourceFile, collected: Diagnostic[]): void {
    // `report` needs to know which statement is being visited so diagnostics
    // can be matched against statement-scoped suppressions without every rule
    // having to thread the statement through by hand.
    let currentStatement: Statement | null = null;

    const listeners: Array<{ resolved: ResolvedRule; listener: RuleListener }> = [];

    for (const resolved of enabled) {
      const context: RuleContext<any> = {
        ruleId: resolved.ruleId,
        options: resolved.options,
        settings: this.#settings,
        source,
        report: (descriptor: ReportDescriptor) => {
          collected.push(buildDiagnostic(source, resolved, descriptor, currentStatement));
        },
      };
      listeners.push({
        resolved,
        listener: attribute(resolved.ruleId, 'rule setup', () => resolved.rule.create(context)),
      });
    }

    interface BoundVisitor {
      ruleId: string;
      visit: (node: any, path: any) => void;
    }

    const nodeVisitors = new Map<string, BoundVisitor[]>();
    for (const { resolved, listener } of listeners) {
      for (const key of Object.keys(listener)) {
        if (LIFECYCLE_KEYS.has(key)) continue;
        const visitor = (listener as Record<string, unknown>)[key];
        if (typeof visitor !== 'function') continue;
        const bound: BoundVisitor = {
          ruleId: resolved.ruleId,
          visit: visitor as (node: any, path: any) => void,
        };
        const bucket = nodeVisitors.get(key);
        if (bucket) bucket.push(bound);
        else nodeVisitors.set(key, [bound]);
      }
    }

    for (const { resolved, listener } of listeners) {
      attribute(resolved.ruleId, 'the start of the file', () => listener.file?.(source));
    }

    for (const comment of source.comments) {
      for (const { resolved, listener } of listeners) {
        attribute(resolved.ruleId, `the comment on line ${comment.line}`, () =>
          listener.comment?.(comment),
        );
      }
    }

    const shouldVisit = (type: NodeType): boolean => nodeVisitors.has(type);

    for (const statement of source.statements) {
      currentStatement = statement;
      const where = `the ${statement.type} on line ${source.positionAt(statement.start).line}`;

      for (const { resolved, listener } of listeners) {
        attribute(resolved.ruleId, where, () => listener.statement?.(statement));
      }

      if (nodeVisitors.size > 0) {
        walkStatement(
          statement,
          (type, node, path) => {
            const visitors = nodeVisitors.get(type);
            if (!visitors) return;
            for (const { ruleId, visit } of visitors) {
              attribute(ruleId, `a ${type} in ${where}`, () => visit(node, path));
            }
          },
          shouldVisit,
        );
      }

      for (const { resolved, listener } of listeners) {
        attribute(resolved.ruleId, where, () => listener['statement:exit']?.(statement));
      }
    }

    currentStatement = null;
    for (const { resolved, listener } of listeners) {
      attribute(resolved.ruleId, 'the end of the file', () => listener['file:exit']?.(source));
    }
  }
}

/**
 * Names the rule responsible when a visitor throws.
 *
 * Without this, a single broken rule aborts the whole run with a stack trace
 * pointing into the traversal, which is close to useless when the rule came
 * from `customRules`.
 */
function attribute<T>(ruleId: string, where: string, run: () => T): T {
  try {
    return run();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`pgward: rule "${ruleId}" threw while handling ${where}: ${detail}`, {
      cause,
    });
  }
}

function buildRegistry(customRules: readonly AnyRule[] | undefined): Map<string, AnyRule> {
  const registry = new Map<string, AnyRule>(Object.entries(builtinRules));

  for (const rule of customRules ?? []) {
    if (typeof rule?.name !== 'string' || rule.name === '') {
      throw new TypeError('pgward: every custom rule needs a non-empty name');
    }
    if (typeof rule.create !== 'function') {
      throw new TypeError(`pgward: custom rule "${rule.name}" has no create() function`);
    }
    if (registry.has(rule.name)) {
      throw new Error(
        `pgward: custom rule "${rule.name}" collides with an existing rule of that name`,
      );
    }
    registry.set(rule.name, rule);
  }

  return registry;
}

function buildDiagnostic(
  source: SourceFile,
  resolved: ResolvedRule,
  descriptor: ReportDescriptor,
  currentStatement: Statement | null = null,
): Diagnostic {
  const offset = resolveOffset(descriptor, currentStatement);
  const start = source.positionAt(offset);

  const endOffset =
    descriptor.endOffset ??
    (descriptor.statement ? descriptor.statement.end : null);
  const end = endOffset === null ? null : source.positionAt(endOffset);

  const statementIndex =
    descriptor.statement?.index ?? descriptor.path?.statement.index ?? currentStatement?.index ?? null;

  return {
    ruleId: resolved.ruleId,
    severity: resolved.severity,
    message: descriptor.message,
    help: descriptor.help ?? resolved.rule.meta.help ?? null,
    offset,
    line: start.line,
    column: start.column,
    endOffset,
    endLine: end?.line ?? null,
    endColumn: end?.column ?? null,
    statementIndex,
  };
}

/**
 * Resolves where to point a diagnostic. libpg_query records positions on only
 * some node types, so this falls back outward — the node's own subtree, then
 * each ancestor, then the statement.
 */
function resolveOffset(descriptor: ReportDescriptor, currentStatement: Statement | null): number {
  if (descriptor.offset !== undefined) return descriptor.offset;

  if (descriptor.node !== undefined) {
    const location = findLocation(descriptor.node);
    if (location !== null) return location;
  }

  if (descriptor.path) {
    for (let index = descriptor.path.ancestors.length - 1; index >= 0; index -= 1) {
      const location = findLocation(descriptor.path.ancestors[index]!.node);
      if (location !== null) return location;
    }
    return descriptor.path.statement.start;
  }

  if (descriptor.statement) return descriptor.statement.start;
  return currentStatement?.start ?? 0;
}

function byPosition(a: Diagnostic, b: Diagnostic): number {
  return a.offset - b.offset || a.ruleId.localeCompare(b.ruleId);
}
