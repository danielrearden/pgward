export { Linter, type LinterConfig } from './linter.ts';
export { defineRule } from './define-rule.ts';
export { formatResults, type FormatOptions } from './format.ts';

export {
  builtinRules,
  configs,
  all,
  recommended,
  type BuiltinRuleName,
  type RulesConfig,
} from './rules/index.ts';

export {
  CORE_RULE_IDS,
  defaultMigrationDate,
  parserVersionFor,
  type CoreRuleId,
} from './config.ts';

export {
  alterTableCommands,
  columnConstraints,
  describeType,
  hasColumnConstraint,
  hasDefElem,
  hasTypeModifiers,
  objectName,
  relationName,
  stringList,
  stringValue,
  tableElements,
  typeNameOf,
  typeNameParts,
  usesConcurrently,
  type RelationName,
} from './ast.ts';
export { findAncestor, hasAncestor, unwrap } from './walk.ts';
export {
  KNOWN_STATEMENT_KINDS,
  matchesAnyStatementKind,
  matchesStatementKind,
} from './statement-kinds.ts';
export { parseDuration, describeMs, type Duration } from './analysis/duration.ts';

export type {
  AnyRule,
  AnyRuleEntry,
  Comment,
  Diagnostic,
  ExpectedError,
  InvalidRuleCase,
  RuleCase,
  RuleTests,
  SettingsInput,
  LintInput,
  LintResult,
  NodeMap,
  NodeOf,
  NodePath,
  NodeType,
  OptionsOf,
  Position,
  ReportDescriptor,
  ReportedSeverity,
  ResolvedSettings,
  Rule,
  RuleContext,
  RuleEntry,
  RuleEntryObject,
  RuleListener,
  RuleMeta,
  RuleOptionsInput,
  SessionSettingsAnalysis,
  SettingAssignment,
  SettingAssignmentKind,
  Severity,
  SourceFile,
  Statement,
  SuppressedDiagnostic,
  TransactionAnalysis,
} from './types.ts';
