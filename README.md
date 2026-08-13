# pgward

A configurable linter for Postgres DDL and migrations, built on
[`@supabase/pg-parser`](https://github.com/supabase-community/pg-parser).

pgward is a **programmatic API** — no config files, no CLI. You construct a `Linter` and call it
from your own script. The library performs no filesystem I/O: you read the SQL, it lints it.

```bash
pnpm add pgward
```

Requires Node 22.6+ and ESM.

## Quick start

```ts
import { readFile } from 'node:fs/promises';
import { Linter, configs, formatResults } from 'pgward';

const linter = new Linter({
  settings: { targetPostgresVersion: 16 },
  rules: {
    ...configs.recommended,
    'require-bounded-lock-timeout': ['error', { maxMs: 15_000 }],
    'ban-drop-column': 'warn',
    'prefer-repack': 'off',
  },
});

const result = await linter.lint({
  filename: 'V20260812.1__add_index.sql',
  sql: await readFile('migrations/V20260812.1__add_index.sql', 'utf8'),
  // Does your runner wrap this file in a transaction? See "Transactional mode".
  implicitTransaction: false,
});

console.log(formatResults([result]));
if (result.errorCount > 0) process.exitCode = 1;
```

Only `sql` is required. `filename` comes back on the result, and is where `enabledFrom` reads the
migration's date from; `implicitTransaction` tells the linter whether the runner will wrap this
file in a transaction.

`lintAll(inputs)` lints several files and returns one result each. A `Linter` holds no state
across calls, so one instance serves the whole run.

### What a result looks like

```ts
{
  filename: 'V20260812.1__add_index.sql',
  diagnostics: [
    {
      ruleId: 'require-concurrent-index-creation',
      severity: 'error',
      message: 'A plain index build holds a SHARE lock on public.thing and blocks writes…',
      help: 'Build it with CREATE INDEX CONCURRENTLY, outside a transaction.',
      line: 2, column: 1,          // 1-based; column in UTF-16 code units, like editors
      offset: 25,                  // UTF-8 byte offset, as libpg_query reports
      endOffset: 75, endLine: 2, endColumn: 51,
      statementIndex: 1,
    },
  ],
  suppressed: [ /* diagnostics silenced by a pgward-ignore, with their reasons */ ],
  errorCount: 1,
  warningCount: 0,
}
```

`help` is null when a rule has no specific remedy to offer. The `end*` fields are null when the
rule pointed at a bare offset instead of a node or a statement.

Every diagnostic splits into two parts: `message` says what is wrong and why it matters, `help`
says what to do about it. `formatResults` hangs the remedy under the problem:

```
V20260812.1__tidy_thing.sql
  1:1  error  This UNIQUE constraint builds its index under an exclusive lock on public.thing.  disallowed-unique-constraint
              help: Build the index with CREATE UNIQUE INDEX CONCURRENTLY, then adopt it with ADD CONSTRAINT … USING INDEX.
  2:1  warn   Dropping public.thing.legacy_note breaks instances still selecting it.  ban-drop-column
              help: Deploy the code that stops reading it first, then drop it in a follow-up.

2 problems (1 error, 1 warning)
```

`formatResults` takes two options. `{ includeHelp: false }` drops the continuation lines, leaving
one line per problem. `{ includeSuppressed: true }` prints `result.suppressed` alongside the
rest, in source order, marked `suppressed` and annotated with the line and reason that silenced
each one.

A clean file gets no block of its own, and when nothing at all was reported the whole string is
`No problems found.` Results with no filename are headed `<input>`. If the format doesn't suit
you, read `message` and `help` off the diagnostics and print them yourself.

A file that fails to parse reports a `parse-error` diagnostic rather than throwing. No rules run
against it, since there's no tree to run them on.

## Configuring rules

**Rules you don't list are off.** Spread a preset to start from a curated set:

- `configs.recommended` — every hazard rule plus the schema conventions that aren't a matter of
  taste. This is the sensible default.
- `configs.all` — every built-in rule at its own default severity.

Each entry accepts three forms:

```ts
rules: {
  'ban-drop-table': 'error',                                  // severity only
  'require-bounded-lock-timeout': ['error', { maxMs: 5000 }], // severity + options
  'require-concurrent-index-creation': {                      // full form
    severity: 'error',
    options: { allowOnNewTables: false },
    enabledFrom: 20260812,
  },
}
```

Options are shallow-merged over the rule's defaults, so you only specify what you're changing.

Misconfiguration throws at construction rather than silently narrowing a rule to nothing:

- an unknown rule id, or a severity that isn't `off`/`warn`/`error`
- an option key the rule doesn't declare — `{ maxMS: 5000 }` names the accepted keys and stops
- a typo in an option value like `guardedStatements: ['ALTER TABEL']`

`KNOWN_STATEMENT_KINDS` is exported if you want to check statement-kind values yourself.

Presets are frozen. Spread them and override in the copy — `{ ...configs.recommended,
'ban-drop-table': 'off' }` — rather than mutating the shared object.

To generate docs or a settings UI from the rule set: `builtinRules` maps every shipped name to
its rule, and so to its `meta`. `linter.rules` is the same map with your `customRules` added.

### Settings

```ts
settings: {
  targetPostgresVersion: 16,   // default 17; drives version-dependent rules
  implicitTransaction: true,   // default true; does the runner wrap files in a transaction?
  migrationDate: (filename) => number | null,  // for enabledFrom; see below
}
```

`targetPostgresVersion` also selects the parser grammar, clamped to the 15–17 range the parser
ships. It must be a positive integer; anything else throws at construction.

`implicitTransaction` is the runner-wide default; a per-file `implicitTransaction` on the lint
input overrides it, as below.

### `enabledFrom`

A per-rule cutoff for grandfathering an existing corpus. It's compared against a date extracted
from the migration filename — by default the first standalone run of 8 or 14 digits, keeping its
leading 8. So `V20260812.1__add_index.sql` and `20260812143000_add_index.sql` both yield
`20260812`. Runs of other lengths return null, since a 13-digit epoch timestamp isn't comparable
to a `YYYYMMDD` cutoff.

```ts
'require-concurrent-index-creation': { severity: 'error', enabledFrom: 20260812 }
```

Migrations dated before the cutoff skip the rule; everything from the cutoff onward runs it.
It **fails closed**: a file with no filename, or a filename with no date, runs the rule. Supply
`settings.migrationDate` for a different naming scheme.

This is per-rule data rather than a global flag on purpose — a single shared cutoff makes it
easy to gate rules you never meant to gate.

## Transactional mode

Whether a file runs inside a transaction changes what counts as hazardous. `CREATE INDEX
CONCURRENTLY` is exactly right in a file the runner leaves alone, and a guaranteed production
failure in one it wraps. No amount of reading the SQL will tell you which you have, so you tell
the linter instead.

`settings.implicitTransaction` is the runner-wide default. Pass `implicitTransaction` on a lint
input to override it for one file:

```ts
await linter.lint({
  filename: 'V20260812.1__add_index.sql',
  sql,
  implicitTransaction: false,
});
```

Runners declare this in whatever way they declare it — a config file beside the migration, a
directive comment, a naming convention, a per-directory setting. pgward takes no position and
does no I/O: work out the answer however your runner expresses it, and pass the boolean.

```ts
// A runner that uses a `<migration>.sql.conf` file beside each migration:
const conf = await readFile(`migrations/${name}.conf`, 'utf8').catch(() => '');
await linter.lint({
  filename: name,
  sql,
  implicitTransaction: !/^\s*executeInTransaction\s*=\s*false\s*$/im.test(conf),
});

// A runner that uses a directive comment in the file itself:
await linter.lint({
  filename: name,
  sql,
  implicitTransaction: !/^--\s*migrate:no-transaction\b/im.test(sql),
});
```

Omit the field and the file inherits `settings.implicitTransaction`. The answer lands on
`source.transactions.implicit`, which `ban-mixed-transactional-modes` and the other transaction
rules read.

## Suppressions

```sql
-- pgward-ignore ban-drop-column: read path removed in #4821
ALTER TABLE public.thing DROP COLUMN legacy_note;
```

Applies to the **next statement** — or, when the directive trails a statement on the same line,
to *that* statement:

```sql
ALTER TABLE public.thing DROP COLUMN legacy_note;  -- pgward-ignore ban-drop-column: read path removed
```

`pgward-ignore-file` applies to the whole file. Several rules can be named at once,
comma-separated. Block comments work too.

**The reason is required, and the rule has to exist.** A directive that gives no reason, names no
rule, names a rule that doesn't exist, or has no statement to attach to is reported as an
`invalid-suppression` diagnostic rather than quietly doing nothing. A suppression that silences
nothing is worse than none: the author believes a rule is waived, and the reviewer sees a
justification that never applied.

Suppressed diagnostics don't disappear: they move to `result.suppressed` with their reason and
the line the directive was on, so you can audit them.

`parse-error` and `invalid-suppression` are the exception: they ignore suppressions entirely. A
directive that could silence the complaint about itself would be no check at all. Turn them off
in `rules` if you really don't want them.

Suppressions only help for migrations you're still writing. If a migration runner
checksums file contents, an already-applied migration can't be annotated after the fact — that's
what `enabledFrom` is for.

## Custom rules

```ts
import { Linter, defineRule } from 'pgward';

const banTempTables = defineRule<{ allow: string[] }>({
  name: 'ban-temp-tables',
  meta: {
    description: 'No temporary tables in migrations.',
    help: 'Use a real table and drop it at the end of the migration.',
    defaultSeverity: 'error',
    defaultOptions: { allow: [] },
  },
  create(context) {
    return {
      CreateStmt(node, path) {
        if (node.relation?.relpersistence !== 't') return;
        if (context.options.allow.includes(node.relation.relname ?? '')) return;
        context.report({
          statement: path.statement,
          message: `Temporary table ${node.relation.relname} is not allowed.`,
        });
      },
    };
  },
});

const linter = new Linter({
  customRules: [banTempTables],
  rules: { 'ban-temp-tables': ['error', { allow: ['scratch'] }] },
});
```

Custom rules are configured, suppressed, and gated exactly like built-ins. A rule with no name,
no `create`, or a name that collides with a built-in throws at construction.

`meta` carries:

| Field | Required | |
| --- | --- | --- |
| `description` | yes | One-line summary of what the rule enforces. |
| `defaultSeverity` | yes | `'warn'` or `'error'`, used when the rule is enabled without one. |
| `defaultOptions` | yes | The option defaults, or `undefined` for a rule that takes none. |
| `help` | | The remedy, shared by every diagnostic the rule reports. |
| `rationale` | | Longer explanation of the hazard, for docs. |
| `normalizeOptions` | | Validates and normalizes the user's options. |

Unknown option keys are rejected before `normalizeOptions` runs, so it only ever sees keys the
rule declares. Its job is the values. Throw from it and the complaint arrives when the linter is
constructed, not on whatever file first trips the bad config:

```ts
normalizeOptions(raw, defaults) {
  const options = { ...defaults, ...(raw as object) };
  if (!Number.isInteger(options.maxLength) || options.maxLength < 1) {
    throw new TypeError(`pgward: rule "identifier-too-long" option maxLength must be a ` +
      `positive integer, got ${String(options.maxLength)}`);
  }
  return options;
}
```

Without it, options are just shallow-merged over the defaults. It's also where a statement-kind
option gets checked against `KNOWN_STATEMENT_KINDS`, which is what the built-ins do with it.

### Rule tests

A rule carries the SQL it must accept and reject, so the examples are written next to the logic
they pin down rather than in a parallel file that can drift out of sync:

```ts
const banTempTables = defineRule<{ allow: string[] }>({
  name: 'ban-temp-tables',
  meta: { /* … */ },
  create(context) { /* … */ },
  tests: {
    valid: [
      'CREATE TABLE t (a int);',
      { name: 'allow-listed', sql: 'CREATE TEMP TABLE scratch (a int);', options: { allow: ['scratch'] } },
    ],
    invalid: [
      {
        sql: 'CREATE TEMP TABLE scratch (a int);',
        errors: [{ line: 1, column: 1, message: 'Temporary table scratch' }],
      },
    ],
  },
});
```

Run them with the same harness the built-ins use:

```ts
import { runRuleTests } from 'pgward/testing';

runRuleTests(banTempTables);   // emits a node:test suite
```

Only the rule under test is enabled, so any diagnostic that shows up came from it. A fixture that
fails to parse fails the test rather than passing quietly.

`errors` is either a count or one matcher per diagnostic, matched in order. A matcher can pin
`message` and `help` (a string has to appear in the text, a RegExp has to match it) plus `line`,
`column` and `severity`. Every field is optional, so `[{ line: 2 }]` asserts one diagnostic on
line 2 and says nothing about the rest of it.

A case can also set `name`, `options`, `settings`, `filename`, `implicitTransaction`, `severity`
and `enabledFrom`. A `valid` entry that needs none of those can be a bare SQL string.

All three entry points take a second argument, `customRules`, for any other rules a fixture needs
registered alongside the one under test. `runBuiltinRuleTests()` runs the fixtures of every rule
pgward ships.

#### On another test runner

`runRuleTests` registers with `node:test`, so it is the wrong entry point anywhere else.
**Under vitest it silently does nothing useful:** vitest sees no tests and exits 0, while node's
runner prints the real pass/fail lines to stdout where nothing is checking them — a broken
fixture reports green.

`ruleTestCases` is the runner-agnostic half. It lints and asserts; you register:

```ts
import { describe, test } from 'vitest';
import { ruleTestCases } from 'pgward/testing';

describe(banTempTables.name, () => {
  for (const testCase of ruleTestCases(banTempTables)) {
    test(`${testCase.kind} · ${testCase.name}`, testCase.run);
  }
});
```

`run()` rejects on failure, which is all any runner needs — the loop above is identical for
`node:test`, and `runRuleTests` is itself a four-line adapter over it. Assertions come from
`node:assert/strict`, so a failure is an ordinary `AssertionError`; runners that read `actual`
and `expected` off it, vitest among them, still render their own diff alongside pgward's message:

```
FAIL  never-reports > invalid · 1. CREATE TABLE t (a int);
AssertionError: expected 1 diagnostic(s), got none
 ❯ assertInvalid node_modules/pgward/src/testing.ts:155:11
```

The frame points into pgward's own source because the package ships `src` alongside its
declaration maps.

For tests that don't use the `tests` field at all — table-driven cases, or one assertion in the
style of the surrounding suite — `lintRuleCase` gives you the diagnostics directly:

```ts
import { lintRuleCase } from 'pgward/testing';

const diagnostics = await lintRuleCase(banTempTables, {
  sql: 'CREATE TEMP TABLE scratch (a int);',
  options: { allow: [] },
});
expect(diagnostics).toHaveLength(1);
```

It takes the same case shape and keeps the two properties that make the result trustworthy: only
the rule under test is enabled, and unparseable SQL throws instead of returning an empty array.

`tests` is optional on the type — custom rules aren't forced to carry fixtures — but the suite
asserts that every built-in has both valid and invalid cases, so none can ship untested.

### The rule listener

Visitors are keyed by libpg_query node type (`CreateStmt`, `ColumnDef`, `AlterTableCmd`, …).
Node type names are capitalized, so they never collide with the lifecycle hooks:

| Hook | When |
| --- | --- |
| `file(source)` | before traversal |
| `comment(comment)` | once per comment |
| `statement(stmt)` / `statement:exit` | around each statement |
| `file:exit(source)` | after traversal — where cross-statement rules do their work |

They fire in that order, and comments are not interleaved with the statements they sit next to:
every comment arrives up front, before the first statement. If a rule cares where a comment sits
relative to a statement, compare offsets, or read `source.comments` at `file:exit`.

**One thing to know about the AST:** libpg_query only wraps *polymorphic* fields in its
single-key node envelope. Fields whose type is fixed by the grammar — `AlterTableStmt.relation`,
`ColumnDef.typeName`, `AlterRoleSetStmt.setstmt` — are embedded directly. The walk descends
through them, but never announces them as nodes. So a `RangeVar` visitor fires for
`TruncateStmt.relations` and not for `CreateStmt.relation`; read those off the parent node.

`context.report()` takes `{ message }` plus one of `statement`, `node` (+ `path`), or an explicit
`offset`. Locations resolve outward: the node's own subtree, then each ancestor innermost-first,
then the statement.

Keep the remedy out of `message` and put it in `help`. `meta.help` covers every diagnostic the
rule reports; pass `help` on an individual `report()` when one branch needs different advice —
`require-bounded-lock-timeout` says something different for "no timeout set" than for "timeout
too high". The suite asserts that every built-in diagnostic carries one.

A rule that throws aborts the run — deliberately, since a rule that can't complete isn't a
passing file. The error names the rule and where it was, and keeps the original as `cause`:
`pgward: rule "ban-temp-tables" threw while handling a CreateStmt in the CreateStmt on line 4: …`

### Shared analyses

`context.source` carries work the core does once, so rules stay small:

- `source.transactions` — explicit `BEGIN` depth per statement, whether the runner's implicit
  transaction is in effect, whether the file ends mid-transaction.
- `source.sessionSettings` — the value of any GUC *actually in effect* at a given statement,
  following `SET` / `SET LOCAL` / `RESET` / `RESET ALL` and transaction scope. This is what lets
  `require-bounded-lock-timeout` catch
  `SET lock_timeout='3s'; RESET lock_timeout; ALTER TABLE …`, which a presence check passes.
  Session and transaction-local values are tracked separately, so a `SET LOCAL` that goes out of
  scope reveals the session value underneath it rather than reading as unset.
- `source.tokens` — raw scanner tokens, for anything the AST has already lost. Postgres truncates
  identifiers to 63 characters *during parsing*, so `identifier-too-long` reads the tokens.
- `source.statements`, `source.comments`, `positionAt`, `textBetween` and `statementAt`, plus the
  raw inputs: `source.sql` and `source.filename`.

Helpers like `relationName`, `typeNameOf`, `alterTableCommands`, `columnConstraints`,
`findAncestor` and `parseDuration` are exported for rule authors.

## Rules

46 rules. `rec` marks membership in `configs.recommended`.

### Timeouts, locks and migration mechanics

| Rule | Default | rec | Options |
| --- | --- | --- | --- |
| `require-concurrent-index-creation` | error | ✓ | `allowOnNewTables` |
| `require-concurrent-index-deletion` | error | ✓ | |
| `require-bounded-lock-timeout` | error | ✓ | `maxMs`, `guardedStatements`, `exemptSubcommands`, `exemptSingleOnly` |
| `bound-statement-timeout` | error | ✓ | `maxMinutes`, `requiredUnit`, `allowDefault`, `banZero`, `driverSocketTimeoutMs` |
| `restrict-long-timeout-to-safe-statements` | error | ✓ | `raisedAboveMs`, `safeStatements` |
| `limit-long-running-statements` | error | ✓ | `maxPerMigration`, `countedStatements` |
| `bound-session-default-timeouts` | error | ✓ | `governedSettings`, `requiredUnit`, `allowDefault`, `banZero` |
| `ban-ddl-in-dynamic-sql` | error | ✓ | `watchedStatements`, `banDynamicExecute` |
| `ban-mixed-transactional-modes` | error | ✓ | `requireDeclarationWhenOnlyConcurrent` |

`ban-ddl-in-dynamic-sql` is what makes a parser sufficient: it removes the only case a parser
can't see.

### Locks, rewrites, and changes that break running clients

| Rule | Default | rec | Options |
| --- | --- | --- | --- |
| `constraint-missing-not-valid` | error | ✓ | `constraintTypes`, `allowOnNewTables` |
| `disallowed-unique-constraint` | error | ✓ | `includePrimaryKey`, `allowOnNewTables` |
| `adding-foreign-key-constraint` | error | ✓ | `allowOnNewTables` |
| `adding-required-field` | error | ✓ | `allowOnNewTables` |
| `adding-not-nullable-field` | error | ✓ | `allowOnNewTables` |
| `adding-field-with-default` | error | ✓ | `volatileFunctions`, `allowOnNewTables` |
| `adding-serial-primary-key-field` | error | ✓ | |
| `changing-column-type` | error | ✓ | `allowOnNewTables` |
| `ban-drop-column` | **warn** | ✓ | |
| `ban-drop-not-null` | error | ✓ | |
| `ban-drop-table` | error | ✓ | |
| `ban-drop-database` | error | ✓ | |
| `renaming-column` | error | ✓ | |
| `renaming-table` | error | ✓ | |
| `require-concurrent-reindex` | error | ✓ | |
| `require-concurrent-partition-detach` | error | ✓ | |
| `ban-truncate-cascade` | error | ✓ | |
| `prefer-repack` | error | ✓ | |
| `prefer-robust-stmts` | error | ✓ | `checkedStatements`, `onlyWhenNonTransactional` |

Rules with `allowOnNewTables` skip tables created by the same migration — nothing is reading a
table that doesn't exist yet, so the lock costs nothing. Matching tolerates one side omitting the
schema (`CREATE TABLE public.thing` then `ALTER TABLE thing`) but not two different explicit
schemas, so a new `staging.thing` never exempts a live `public.thing`.

### Transactions and domains

| Rule | Default | rec |
| --- | --- | --- |
| `ban-concurrent-index-creation-in-transaction` | error | ✓ |
| `transaction-nesting` | error | ✓ |
| `ban-uncommitted-transaction` | error | ✓ |
| `ban-create-domain-with-constraint` | error | ✓ |
| `ban-alter-domain-with-add-constraint` | error | ✓ |

### Schema conventions

| Rule | Default | rec | Options |
| --- | --- | --- | --- |
| `require-grants-on-new-table` | error | ✓ | `schemas`, `requiredGrants` |
| `require-table-comment` | error | ✓ | `requireOnTable`, `requireOnColumn`, `schemas` |
| `require-table-schema` | error | ✓ | |
| `require-named-check-constraint` | error | ✓ | `namePattern` |
| `identifier-too-long` | error | ✓ | `maxLength` |
| `prefer-identity` | error | ✓ | `allowSerial`, `allowUuid`, `requiredUuidDefaults` |
| `prefer-timestamptz` | error | ✓ | `replacements` |
| `ban-duplicate-column-assignments` | error | ✓ | |
| `require-enum-value-ordering` | error | | `requireNeighborOnAdd` |
| `prefer-text-field` | error | | `flagUnboundedVarchar` |
| `prefer-bigint-over-int` | error | | |
| `prefer-bigint-over-smallint` | error | | |
| `ban-char-field` | error | | |

The last five are left out of `recommended` because reasonable teams disagree about them; enable
them explicitly.

`require-grants-on-new-table` encodes a project-specific convention, so it starts out inert: it
does nothing until you give it a `requiredGrants` map. `require-named-check-constraint` is
stricter out of the box. At its defaults it requires every CHECK constraint to carry an explicit
name; the `namePattern` option adds a naming convention on top, substituting `{table}` and
`{column}` before the pattern is applied.

### Core diagnostics

`parse-error` and `invalid-suppression` are reported under their own ids and are **on unless you
turn them off**, since a silent parse failure would look exactly like a clean file. They're
configured like any other rule.

## Relationship to Squawk

The rule set is a superset of [Squawk](https://squawkhq.com/docs/rules), with a few deliberate
differences:

- `require-lock-timeout`, `require-statement-timeout` and `require-timeout-settings` are not
  ported. `require-bounded-lock-timeout` and `bound-statement-timeout` supersede them: they check
  the value in effect, not merely that a `SET` appears somewhere in the file.
- `syntax-error` is the core `parse-error` diagnostic instead.
- `disallowed-unique-constraint` also covers `PRIMARY KEY` by default (`includePrimaryKey`), which
  is the identical hazard.

## Development

```bash
pnpm run typecheck   # tsc over src and test
pnpm test            # node:test, no framework, runs .ts directly
pnpm run build       # emits dist/ with .js + .d.ts
pnpm run check       # all three
```

`tsconfig.json` is the default project and covers **src and test**, so an editor checks the same
files CI does. `tsconfig.build.json` narrows to `src` and turns emit on — it is the only config
that writes `dist/`. Keeping the emitting config out of the default slot is what stops test files
from landing in an inferred project with no `@types/node`.

Tests run straight off the TypeScript sources via Node's native type stripping, so there's no
build step in the loop. That's on by default from Node 22.18; on an older 22.x the `test` script
needs `--experimental-strip-types`.

`test/smoke.test.ts` is the exception to the no-build rule. It imports the built package by name,
through the exports map, and skips if `dist/` isn't there. That's what catches a build that
stopped rewriting `.ts` import specifiers to `.js`.
