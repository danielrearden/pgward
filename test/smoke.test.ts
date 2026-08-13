import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import type * as PgWard from '../src/index.ts';

// The specifier is held in a variable so type resolution doesn't chase
// `dist/index.d.ts`, which doesn't exist until the build has run. Types come
// from the source instead, and the runtime value comes from the built package —
// which is the whole point of this file.
const PACKAGE = 'pgward';

/**
 * Exercises the published entry point rather than the source tree.
 *
 * This is what catches a broken build: `tsc` rewrites the `.ts` import
 * specifiers in src to `.js`, and nothing else in the suite would notice if
 * that stopped working.
 */
test('smoke: the built package', async (t) => {
  if (!existsSync(new URL('../dist/index.js', import.meta.url))) {
    t.skip('run `npm run build` first');
    return;
  }

  // Self-reference through the package name, so the exports map is exercised too.
  const pgward: typeof PgWard = await import(PACKAGE);
  const { Linter, configs, defineRule, formatResults } = pgward;

  await t.test('the testing subpath resolves through the exports map', async () => {
    const testing = await import(`${PACKAGE}/testing`);
    assert.deepEqual(Object.keys(testing).sort(), [
      'lintRuleCase',
      'ruleTestCases',
      'runBuiltinRuleTests',
      'runRuleTests',
    ]);
  });

  await t.test('the published export surface is intact', () => {
    // Runtime exports only — types are erased. Pinned so an export can't be
    // dropped without the break showing up here rather than in a consumer.
    assert.deepEqual(Object.keys(pgward).sort(), [
      'CORE_RULE_IDS',
      'KNOWN_STATEMENT_KINDS',
      'Linter',
      'all',
      'alterTableCommands',
      'builtinRules',
      'columnConstraints',
      'configs',
      'defaultMigrationDate',
      'defineRule',
      'describeMs',
      'describeType',
      'findAncestor',
      'formatResults',
      'hasAncestor',
      'hasColumnConstraint',
      'hasDefElem',
      'hasTypeModifiers',
      'matchesAnyStatementKind',
      'matchesStatementKind',
      'objectName',
      'parseDuration',
      'parserVersionFor',
      'recommended',
      'relationName',
      'stringList',
      'stringValue',
      'tableElements',
      'typeNameOf',
      'typeNameParts',
      'unwrap',
      'usesConcurrently',
    ]);
  });

  const banTempTables = defineRule<void>({
    name: 'ban-temp-tables',
    meta: {
      description: 'No temporary tables in migrations.',
      defaultSeverity: 'error',
      defaultOptions: undefined,
    },
    create(context) {
      return {
        CreateStmt(node, path) {
          if (node.relation?.relpersistence !== 't') return;
          context.report({
            statement: path.statement,
            message: `Temporary table ${node.relation.relname} is not allowed.`,
          });
        },
      };
    },
  });

  const linter = new Linter({
    settings: { targetPostgresVersion: 16 },
    customRules: [banTempTables],
    rules: {
      ...configs.recommended,
      'ban-temp-tables': 'error',
      'require-concurrent-index-creation': { severity: 'error', enabledFrom: 20260812 },
      'require-table-comment': 'off',
    },
  });

  const result = await linter.lint({
    filename: 'V20260901.1__widen_thing.sql',
    implicitTransaction: false,
    sql: [
      "SET lock_timeout = '3s';",
      'CREATE TEMP TABLE scratch (a int);',
      'RESET lock_timeout;',
      'ALTER TABLE public.thing ADD COLUMN note text;',
      '-- pgward-ignore ban-drop-column: read path removed in #4821',
      'ALTER TABLE public.thing DROP COLUMN legacy_note;',
    ].join('\n'),
  });

  const byRule = (id: string) => result.diagnostics.filter((d) => d.ruleId === id);

  await t.test('the custom rule ran', () => {
    assert.equal(byRule('ban-temp-tables').length, 1);
    assert.equal(byRule('ban-temp-tables')[0]?.line, 2);
  });

  await t.test('the flow-sensitive lock timeout rule saw through the RESET', () => {
    const found = byRule('require-bounded-lock-timeout');
    assert.deepEqual(
      found.map((d) => d.line),
      [4, 6],
      'both ALTERs run after lock_timeout was reset',
    );
  });

  await t.test('the suppression moved its diagnostic aside, with the reason kept', () => {
    assert.equal(byRule('ban-drop-column').length, 0);
    assert.equal(result.suppressed.length, 1);
    assert.equal(result.suppressed[0]?.ruleId, 'ban-drop-column');
    assert.equal(result.suppressed[0]?.suppressionReason, 'read path removed in #4821');
  });

  await t.test('the non-transactional declaration satisfied the transactional-mode rule', () => {
    assert.deepEqual(byRule('ban-mixed-transactional-modes'), []);
  });

  await t.test('nothing failed to parse', () => {
    assert.deepEqual(byRule('parse-error'), []);
  });

  await t.test('results format as text', () => {
    const text = formatResults([result]);
    assert.match(text, /^V20260901\.1__widen_thing\.sql/m);
    assert.match(text, /ban-temp-tables/);
    assert.match(text, /problems \(\d+ errors, \d+ warnings\)/);
  });
});
