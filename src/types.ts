import type { ScanToken } from '@supabase/pg-parser';
import type { Node } from '@supabase/pg-parser/17/types';

/**
 * libpg_query encodes every AST node as a single-key object — `{ IndexStmt: { ... } }`.
 * The generated `Node` type is the union of all of those, which is awkward to index into.
 * Collapsing it to an intersection turns it into the map we actually want:
 * `{ IndexStmt: IndexStmt, AlterTableStmt: AlterTableStmt, ... }`.
 */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

export type NodeMap = UnionToIntersection<Node>;

/** Every AST node type name libpg_query can emit, e.g. `'AlterTableStmt'`. */
export type NodeType = keyof NodeMap & string;

export type NodeOf<T extends NodeType> = NodeMap[T];

/** A node still wrapped in its single-key envelope. */
export type WrappedNode = { [K in NodeType]: { [P in K]: NodeMap[K] } }[NodeType];

/**
 * All offsets in this library are **UTF-8 byte offsets**, matching libpg_query.
 * They are not string indices; the two diverge as soon as the SQL contains a
 * non-ASCII character.
 */
export interface Position {
  /** 1-based */
  line: number;
  /** 1-based, counted in UTF-16 code units so it lines up with editors */
  column: number;
}

export interface Comment {
  /** Raw comment text, including the leading `--` or `/*`. */
  text: string;
  /** Byte offset of the first character. */
  start: number;
  /** Byte offset one past the last character. */
  end: number;
  line: number;
  column: number;
}

export interface Statement {
  /** Zero-based position in the file. */
  index: number;
  /** The statement still wrapped, e.g. `{ AlterTableStmt: {...} }`. */
  stmt: WrappedNode;
  /** The wrapper's key, e.g. `'AlterTableStmt'`. */
  type: NodeType;
  /** The unwrapped statement node. */
  node: unknown;
  /**
   * Byte offset of the statement's first real token. libpg_query's own
   * `stmt_location` points at whatever whitespace or comment preceded the
   * statement, which makes for confusing diagnostics.
   */
  start: number;
  /** Byte offset one past the statement's last character (excluding `;`). */
  end: number;
  /** Source text between `start` and `end`. */
  text: string;
}

export interface TransactionAnalysis {
  /**
   * True when the migration runner wraps the whole file in a transaction, so
   * statements are transactional without an explicit `BEGIN`.
   */
  implicit: boolean;
  /** Explicit `BEGIN` depth before each statement runs, indexed by statement. */
  depthBefore: readonly number[];
  /** Explicit `BEGIN` depth after each statement runs. */
  depthAfter: readonly number[];
  /** True when the file ends with an explicit transaction still open. */
  unclosed: boolean;
  /** True when the statement runs inside an explicit `BEGIN` block. */
  inExplicitTransaction(index: number): boolean;
  /** True when the statement runs inside any transaction, implicit or explicit. */
  inTransaction(index: number): boolean;
}

export type SettingAssignmentKind = 'set' | 'set_local' | 'reset' | 'reset_all' | 'default';

export interface SettingAssignment {
  statementIndex: number;
  /** Lower-cased GUC name, e.g. `'lock_timeout'`. */
  name: string;
  kind: SettingAssignmentKind;
  /** The literal as written, e.g. `'3s'` or `'0'`. Null for resets. */
  raw: string | null;
  /** True when the assignment came from `SET LOCAL`. */
  local: boolean;
  /** The `VariableSetStmt` node the assignment came from. */
  node: unknown;
}

export interface SessionSettingsAnalysis {
  /**
   * The assignment in effect when the statement at `index` runs, or null when
   * the setting is unset — which includes having been `RESET`, since a reset
   * value provides no guarantee either.
   *
   * `SET LOCAL` is scoped to its enclosing transaction, so it stops applying
   * once that transaction ends.
   */
  effective(index: number, name: string): SettingAssignment | null;
  /** Every assignment to `name`, in file order, including resets. */
  assignments(name: string): readonly SettingAssignment[];
  /** Every assignment in the file, in file order. */
  all(): readonly SettingAssignment[];
}

export interface SourceFile {
  /** The SQL as given. */
  sql: string;
  /** Migration filename, when one was supplied. Used by `enabledFrom`. */
  filename: string | null;
  statements: readonly Statement[];
  comments: readonly Comment[];
  /**
   * Every non-comment token from the scanner, with its raw source text.
   *
   * Needed whenever the AST has already lost something the source still has —
   * most notably identifiers, which Postgres truncates to 63 characters during
   * parsing, exactly the silent damage `identifier-too-long` reports.
   */
  tokens: readonly ScanToken[];
  transactions: TransactionAnalysis;
  sessionSettings: SessionSettingsAnalysis;
  /** Converts a UTF-8 byte offset to a 1-based line/column. */
  positionAt(offset: number): Position;
  /** Source text between two byte offsets. */
  textBetween(start: number, end: number): string;
  /** The statement containing a byte offset, or null if it falls between them. */
  statementAt(offset: number): Statement | null;
}

export type Severity = 'off' | 'warn' | 'error';
export type ReportedSeverity = 'warn' | 'error';

export interface Diagnostic {
  ruleId: string;
  severity: ReportedSeverity;
  /** What is wrong, and why it matters. */
  message: string;
  /** What to do about it. Null when the rule offers no specific remedy. */
  help: string | null;
  /** UTF-8 byte offset. */
  offset: number;
  line: number;
  column: number;
  endOffset: number | null;
  endLine: number | null;
  endColumn: number | null;
  /** Index of the statement the diagnostic belongs to, when known. */
  statementIndex: number | null;
}

export interface SuppressedDiagnostic extends Diagnostic {
  /** The reason text from the `pgward-ignore` comment. */
  suppressionReason: string;
  suppressionLine: number;
}

export interface LintResult {
  filename: string | null;
  diagnostics: Diagnostic[];
  suppressed: SuppressedDiagnostic[];
  errorCount: number;
  warningCount: number;
}

export interface PathEntry {
  type: NodeType;
  node: unknown;
}

export interface NodePath {
  type: NodeType;
  /** Outermost first, innermost last, excluding the node itself. */
  ancestors: readonly PathEntry[];
  /** The statement the node belongs to. */
  statement: Statement;
}

export interface ReportDescriptor {
  /** What is wrong, and why it matters. Keep the remedy in `help`. */
  message: string;
  /** What to do about it. Overrides `meta.help` for this one report. */
  help?: string;
  /**
   * The offending node. Its location is resolved from the smallest `location`
   * in its subtree, since libpg_query only records positions on some nodes.
   */
  node?: unknown;
  /** Supplies ancestors to fall back through when `node` carries no location. */
  path?: NodePath;
  /** Reports at the start of a whole statement. */
  statement?: Statement;
  /** An explicit byte offset, taking precedence over everything else. */
  offset?: number;
  endOffset?: number;
}

export interface RuleContext<Options = void> {
  /** The rule's name, as configured. */
  ruleId: string;
  /** Options after defaults have been merged in and normalized. */
  options: Options;
  settings: ResolvedSettings;
  source: SourceFile;
  report(descriptor: ReportDescriptor): void;
}

/**
 * Visitors keyed by AST node type. Node type names are always capitalized, so
 * they can never collide with the lower-case lifecycle hooks below.
 */
export type NodeVisitors = {
  [K in NodeType]?: (node: NodeMap[K], path: NodePath) => void;
};

export interface LifecycleVisitors {
  /** Before traversal. */
  file?(source: SourceFile): void;
  /** After traversal — where cross-statement rules do their work. */
  'file:exit'?(source: SourceFile): void;
  statement?(statement: Statement): void;
  'statement:exit'?(statement: Statement): void;
  /** Called for every comment, in file order. */
  comment?(comment: Comment): void;
}

export type RuleListener = NodeVisitors & LifecycleVisitors;

export interface RuleMeta<Options> {
  /** One-line summary of what the rule enforces. */
  description: string;
  /**
   * The remedy, shared by every diagnostic the rule reports. A report can
   * override it with its own `help` when one branch needs different advice.
   */
  help?: string;
  /** Longer explanation of the hazard, surfaced in docs. */
  rationale?: string;
  /** Severity used when the rule is enabled without an explicit one. */
  defaultSeverity: ReportedSeverity;
  defaultOptions: Options;
  /**
   * Validates and normalizes user-supplied options. Should throw on invalid
   * input — the linter surfaces the error at construction time, not lint time.
   */
  normalizeOptions?(raw: unknown, defaults: Options): Options;
}

export interface RuleCase<Options> {
  /** Shown in the test name; defaults to the SQL itself. */
  name?: string;
  sql: string;
  filename?: string;
  /** Overrides `settings.implicitTransaction` for this case. */
  implicitTransaction?: boolean;
  options?: Options extends void | undefined ? never : Partial<Options>;
  settings?: SettingsInput;
  severity?: Severity;
  enabledFrom?: number;
}

export interface ExpectedError {
  message?: string | RegExp;
  help?: string | RegExp;
  line?: number;
  column?: number;
  severity?: ReportedSeverity;
}

export interface InvalidRuleCase<Options> extends RuleCase<Options> {
  /** Either how many diagnostics to expect, or a matcher per diagnostic. */
  errors: number | ExpectedError[];
}

/**
 * The SQL a rule must accept and reject, carried on the rule itself so the
 * examples are written alongside the logic they pin down. Run them with
 * `runRuleTests` from `pgward/testing`.
 */
export interface RuleTests<Options> {
  valid: Array<RuleCase<Options> | string>;
  invalid: Array<InvalidRuleCase<Options>>;
}

export interface Rule<Options = void> {
  name: string;
  meta: RuleMeta<Options>;
  create(context: RuleContext<Options>): RuleListener;
  tests?: RuleTests<Options>;
}

export type AnyRule = Rule<any>;

export type OptionsOf<R> = R extends Rule<infer O> ? O : never;

/**
 * The options a rule accepts in config. A rule with no options gets `never`
 * rather than `void`, so `RuleEntry<void>` stays assignable to `RuleEntry<any>`
 * — which is what lets a preset be spread and then overridden per rule.
 */
export type RuleOptionsInput<Options> = [Options] extends [void | undefined]
  ? never
  : Partial<Options>;

export interface RuleEntryObject<Options> {
  severity?: Severity;
  options?: RuleOptionsInput<Options>;
  /**
   * Skip the rule for migrations dated before this value. Compared against the
   * date extracted from the filename by `settings.migrationDate`.
   */
  enabledFrom?: number;
}

export type RuleEntry<Options = unknown> =
  | Severity
  | readonly [Severity]
  | readonly [Severity, RuleOptionsInput<Options>]
  | RuleEntryObject<Options>;

/**
 * A rule entry with its options left untyped.
 *
 * `RuleEntry<any>` can't serve here: `[any] extends [void]` is true, which
 * would collapse the options slot to `never` and reject every real entry. This
 * is what the config's index signature uses for custom rule names, and what
 * the resolver accepts.
 */
export type AnyRuleEntry =
  | Severity
  | readonly [Severity]
  | readonly [Severity, Record<string, any>]
  | { severity?: Severity; options?: Record<string, any>; enabledFrom?: number };

export interface SettingsInput {
  /**
   * The Postgres version being targeted. Drives version-dependent rules and
   * selects the parser build (clamped to the 15–17 range the parser supports).
   */
  targetPostgresVersion?: number;
  /**
   * Whether the migration runner wraps files in a transaction unless told
   * otherwise. Most runners do, so this defaults to true. Pass
   * `implicitTransaction` on a lint input to override it for one file.
   */
  implicitTransaction?: boolean;
  /**
   * Extracts a comparable date from a migration filename for `enabledFrom`.
   * Defaults to the first standalone run of 8 or 14 digits, taking its leading
   * 8 — so both `V20260812.1__add_index.sql` and `20260812143000_add_index.sql`
   * yield `20260812`. Return null when the filename carries no date.
   */
  migrationDate?: (filename: string) => number | null;
}

export interface ResolvedSettings {
  targetPostgresVersion: number;
  implicitTransaction: boolean;
  migrationDate: (filename: string) => number | null;
}

export interface LintInput {
  sql: string;
  /** Enables `enabledFrom` gating and is echoed back on the result. */
  filename?: string;
  /**
   * Whether the runner wraps *this* file in a transaction, overriding
   * `settings.implicitTransaction`. However your runner declares that — a
   * sidecar config, a directive comment, a naming convention — read it
   * yourself and pass the answer in; the library performs no file I/O.
   */
  implicitTransaction?: boolean;
}
