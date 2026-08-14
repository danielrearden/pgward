import type { AnyRuleEntry, OptionsOf, RuleEntry } from '../types.ts';

import { addingFieldWithDefault } from './adding-field-with-default.ts';
import { addingForeignKeyConstraint } from './adding-foreign-key-constraint.ts';
import { addingNotNullableField } from './adding-not-nullable-field.ts';
import { addingRequiredField } from './adding-required-field.ts';
import { addingSerialPrimaryKeyField } from './adding-serial-primary-key-field.ts';
import { banAlterDomainWithAddConstraint } from './ban-alter-domain-with-add-constraint.ts';
import { banCharField } from './ban-char-field.ts';
import { banConcurrentIndexCreationInTransaction } from './ban-concurrent-index-creation-in-transaction.ts';
import { banCreateDomainWithConstraint } from './ban-create-domain-with-constraint.ts';
import { banDdlInDynamicSql } from './ban-ddl-in-dynamic-sql.ts';
import { banDropColumn } from './ban-drop-column.ts';
import { banDropDatabase } from './ban-drop-database.ts';
import { banDropNotNull } from './ban-drop-not-null.ts';
import { banDropTable } from './ban-drop-table.ts';
import { banDuplicateColumnAssignments } from './ban-duplicate-column-assignments.ts';
import { banMixedTransactionalModes } from './ban-mixed-transactional-modes.ts';
import { banTruncateCascade } from './ban-truncate-cascade.ts';
import { banUncommittedTransaction } from './ban-uncommitted-transaction.ts';
import { boundSessionDefaultTimeouts } from './bound-session-default-timeouts.ts';
import { boundStatementTimeout } from './bound-statement-timeout.ts';
import { changingColumnType } from './changing-column-type.ts';
import { constraintMissingNotValid } from './constraint-missing-not-valid.ts';
import { invalidSuppression, parseError } from './core.ts';
import { disallowedUniqueConstraint } from './disallowed-unique-constraint.ts';
import { identifierTooLong } from './identifier-too-long.ts';
import { limitLongRunningStatements } from './limit-long-running-statements.ts';
import { migrationFilenameFormat } from './migration-filename-format.ts';
import { preferBigintOverInt } from './prefer-bigint-over-int.ts';
import { preferBigintOverSmallint } from './prefer-bigint-over-smallint.ts';
import { preferIdentity } from './prefer-identity.ts';
import { preferRepack } from './prefer-repack.ts';
import { preferRobustStmts } from './prefer-robust-stmts.ts';
import { preferTextField } from './prefer-text-field.ts';
import { preferTimestamptz } from './prefer-timestamptz.ts';
import { renamingColumn } from './renaming-column.ts';
import { renamingTable } from './renaming-table.ts';
import { requireBoundedLockTimeout } from './require-bounded-lock-timeout.ts';
import { requireConcurrentIndexCreation } from './require-concurrent-index-creation.ts';
import { requireConcurrentIndexDeletion } from './require-concurrent-index-deletion.ts';
import { requireConcurrentPartitionDetach } from './require-concurrent-partition-detach.ts';
import { requireConcurrentReindex } from './require-concurrent-reindex.ts';
import { requireEnumValueOrdering } from './require-enum-value-ordering.ts';
import { requireGrantsOnNewTable } from './require-grants-on-new-table.ts';
import { requireNamedCheckConstraint } from './require-named-check-constraint.ts';
import { requireTableComment } from './require-table-comment.ts';
import { requireTableSchema } from './require-table-schema.ts';
import { restrictLongTimeoutToSafeStatements } from './restrict-long-timeout-to-safe-statements.ts';
import { transactionNesting } from './transaction-nesting.ts';

/**
 * Every rule that ships with pgward, keyed by the name you configure it under.
 *
 * `parse-error` and `invalid-suppression` are the linter's own diagnostics.
 * They're on unless you explicitly turn them off, since a silent parse failure
 * would look exactly like a clean file.
 */
export const builtinRules = {
  'parse-error': parseError,
  'invalid-suppression': invalidSuppression,

  'require-concurrent-index-creation': requireConcurrentIndexCreation,
  'require-concurrent-index-deletion': requireConcurrentIndexDeletion,
  'require-bounded-lock-timeout': requireBoundedLockTimeout,
  'bound-statement-timeout': boundStatementTimeout,
  'restrict-long-timeout-to-safe-statements': restrictLongTimeoutToSafeStatements,
  'limit-long-running-statements': limitLongRunningStatements,
  'bound-session-default-timeouts': boundSessionDefaultTimeouts,
  'ban-ddl-in-dynamic-sql': banDdlInDynamicSql,
  'ban-mixed-transactional-modes': banMixedTransactionalModes,
  'migration-filename-format': migrationFilenameFormat,

  'constraint-missing-not-valid': constraintMissingNotValid,
  'disallowed-unique-constraint': disallowedUniqueConstraint,
  'adding-foreign-key-constraint': addingForeignKeyConstraint,
  'adding-required-field': addingRequiredField,
  'adding-not-nullable-field': addingNotNullableField,
  'adding-field-with-default': addingFieldWithDefault,
  'adding-serial-primary-key-field': addingSerialPrimaryKeyField,
  'changing-column-type': changingColumnType,
  'ban-drop-column': banDropColumn,
  'ban-drop-not-null': banDropNotNull,
  'ban-drop-table': banDropTable,
  'ban-drop-database': banDropDatabase,
  'renaming-column': renamingColumn,
  'renaming-table': renamingTable,
  'require-concurrent-reindex': requireConcurrentReindex,
  'require-concurrent-partition-detach': requireConcurrentPartitionDetach,
  'ban-truncate-cascade': banTruncateCascade,
  'prefer-repack': preferRepack,
  'prefer-robust-stmts': preferRobustStmts,

  'ban-concurrent-index-creation-in-transaction': banConcurrentIndexCreationInTransaction,
  'transaction-nesting': transactionNesting,
  'ban-uncommitted-transaction': banUncommittedTransaction,

  'ban-create-domain-with-constraint': banCreateDomainWithConstraint,
  'ban-alter-domain-with-add-constraint': banAlterDomainWithAddConstraint,

  'require-grants-on-new-table': requireGrantsOnNewTable,
  'require-table-comment': requireTableComment,
  'require-table-schema': requireTableSchema,
  'require-named-check-constraint': requireNamedCheckConstraint,
  'require-enum-value-ordering': requireEnumValueOrdering,
  'identifier-too-long': identifierTooLong,
  'prefer-identity': preferIdentity,
  'prefer-timestamptz': preferTimestamptz,
  'prefer-text-field': preferTextField,
  'prefer-bigint-over-int': preferBigintOverInt,
  'prefer-bigint-over-smallint': preferBigintOverSmallint,
  'ban-char-field': banCharField,
  'ban-duplicate-column-assignments': banDuplicateColumnAssignments,
} as const;

export type BuiltinRuleName = keyof typeof builtinRules;

/**
 * The `rules` map. Built-in names are typed against their own option shapes;
 * custom rules registered through `customRules` fall through to the index
 * signature.
 */
export type RulesConfig = {
  [Name in BuiltinRuleName]?: RuleEntry<OptionsOf<(typeof builtinRules)[Name]>>;
} & {
  [name: string]: AnyRuleEntry;
};

/**
 * Every built-in rule, each at its own default severity.
 *
 * Frozen: presets are shared module state, so a stray `configs.all[x] = 'off'`
 * would reconfigure every linter in the process. Spread it and override in the
 * copy instead.
 */
export const all: RulesConfig = Object.freeze(
  Object.fromEntries(Object.keys(builtinRules).map((name) => [name, {}])),
);

/**
 * The curated set: every hazard rule, and the schema conventions that don't
 * depend on a particular project's taste. Style preferences that reasonable
 * teams disagree about — `ban-char-field`, `prefer-bigint-over-int`,
 * `prefer-text-field`, `prefer-bigint-over-smallint`,
 * `require-enum-value-ordering` — are left off; enable them explicitly.
 */
export const recommended: RulesConfig = Object.freeze(
  Object.fromEntries(
    ([
    'parse-error',
    'invalid-suppression',

    'require-concurrent-index-creation',
    'require-concurrent-index-deletion',
    'require-bounded-lock-timeout',
    'bound-statement-timeout',
    'restrict-long-timeout-to-safe-statements',
    'limit-long-running-statements',
    'bound-session-default-timeouts',
    'ban-ddl-in-dynamic-sql',
    'ban-mixed-transactional-modes',
    'migration-filename-format',

    'constraint-missing-not-valid',
    'disallowed-unique-constraint',
    'adding-foreign-key-constraint',
    'adding-required-field',
    'adding-not-nullable-field',
    'adding-field-with-default',
    'adding-serial-primary-key-field',
    'changing-column-type',
    'ban-drop-column',
    'ban-drop-not-null',
    'ban-drop-table',
    'ban-drop-database',
    'renaming-column',
    'renaming-table',
    'require-concurrent-reindex',
    'require-concurrent-partition-detach',
    'ban-truncate-cascade',
    'prefer-repack',
    'prefer-robust-stmts',

    'ban-concurrent-index-creation-in-transaction',
    'transaction-nesting',
    'ban-uncommitted-transaction',

    'ban-create-domain-with-constraint',
    'ban-alter-domain-with-add-constraint',

    'require-grants-on-new-table',
    'require-table-comment',
    'require-table-schema',
    'require-named-check-constraint',
    'identifier-too-long',
    'prefer-identity',
    'prefer-timestamptz',
    'ban-duplicate-column-assignments',
    ] satisfies BuiltinRuleName[]).map((name) => [name, {}]),
  ),
);

export const configs = Object.freeze({ all, recommended });
