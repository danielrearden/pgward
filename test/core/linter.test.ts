import assert from 'node:assert/strict';
import test from 'node:test';

import { Linter, configs, defineRule, formatResults } from '../../src/index.ts';

test('linter: diagnostics', async (t) => {
  await t.test('reports position, severity, rule id and statement', async () => {
    const linter = new Linter({ rules: { 'require-concurrent-index-creation': 'error' } });
    const result = await linter.lint({
      filename: 'V1__x.sql',
      sql: 'SELECT 1;\nCREATE INDEX idx ON t (a);',
    });

    assert.equal(result.filename, 'V1__x.sql');
    assert.equal(result.diagnostics.length, 1);
    assert.deepEqual(
      {
        ruleId: result.diagnostics[0]!.ruleId,
        severity: result.diagnostics[0]!.severity,
        line: result.diagnostics[0]!.line,
        column: result.diagnostics[0]!.column,
        statementIndex: result.diagnostics[0]!.statementIndex,
      },
      {
        ruleId: 'require-concurrent-index-creation',
        severity: 'error',
        line: 2,
        column: 1,
        statementIndex: 1,
      },
    );
  });

  await t.test('counts errors and warnings separately', async () => {
    const linter = new Linter({
      rules: { 'ban-drop-table': 'error', 'ban-drop-column': 'warn' },
    });
    const result = await linter.lint({ sql: 'DROP TABLE a;\nALTER TABLE b DROP COLUMN c;' });

    assert.equal(result.errorCount, 1);
    assert.equal(result.warningCount, 1);
  });

  await t.test('sorts diagnostics by position', async () => {
    const linter = new Linter({ rules: { ...configs.recommended } });
    const result = await linter.lint({
      sql: 'ALTER TABLE b DROP COLUMN c;\nDROP TABLE a;',
    });

    const lines = result.diagnostics.map((diagnostic) => diagnostic.line);
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
  });

  await t.test('a severity override wins over the rule default', async () => {
    const linter = new Linter({ rules: { 'ban-drop-column': 'error' } });
    const result = await linter.lint({ sql: 'ALTER TABLE b DROP COLUMN c;' });

    assert.equal(result.diagnostics[0]?.severity, 'error');
    assert.equal(result.errorCount, 1);
  });
});

test('linter: parse errors', async (t) => {
  await t.test('reports a parse failure instead of throwing', async () => {
    const linter = new Linter({ rules: { ...configs.recommended } });
    const result = await linter.lint({ sql: 'ALTER TABLE t SET STATISTICS 100;' });

    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.ruleId, 'parse-error');
    assert.match(result.diagnostics[0]!.message, /Could not parse this file/);
  });

  await t.test('runs no rules on an unparseable file', async () => {
    const linter = new Linter({ rules: { 'ban-drop-table': 'error' } });
    const result = await linter.lint({ sql: 'DROP TABLE a;\nTHIS IS NOT SQL;' });

    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.ruleId),
      ['parse-error'],
    );
  });

  await t.test('can be turned off like any other rule', async () => {
    const linter = new Linter({ rules: { 'parse-error': 'off' } });
    const result = await linter.lint({ sql: 'THIS IS NOT SQL;' });
    assert.deepEqual(result.diagnostics, []);
  });
});

test('linter: suppressions', async (t) => {
  await t.test('moves a suppressed diagnostic out of diagnostics', async () => {
    const linter = new Linter({ rules: { 'ban-drop-table': 'error' } });
    const result = await linter.lint({
      sql: '-- pgward-ignore ban-drop-table: table was never released\nDROP TABLE a;',
    });

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.errorCount, 0);
    assert.equal(result.suppressed.length, 1);
    assert.equal(result.suppressed[0]?.suppressionReason, 'table was never released');
    assert.equal(result.suppressed[0]?.suppressionLine, 1);
  });

  await t.test('reports a suppression that names no reason', async () => {
    const linter = new Linter({ rules: { 'ban-drop-table': 'error' } });
    const result = await linter.lint({ sql: '-- pgward-ignore ban-drop-table\nDROP TABLE a;' });

    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.ruleId).sort(),
      ['ban-drop-table', 'invalid-suppression'],
    );
  });

  await t.test('a suppression cannot silence the suppression check itself', async () => {
    const linter = new Linter({ rules: {} });
    const result = await linter.lint({
      sql: '-- pgward-ignore-file invalid-suppression: nice try\n-- pgward-ignore ban-drop-table\nDROP TABLE a;',
    });

    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.ruleId === 'invalid-suppression'),
    );
  });
});

test('linter: enabledFrom', async (t) => {
  const linter = new Linter({
    rules: { 'require-concurrent-index-creation': { severity: 'error', enabledFrom: 20260812 } },
  });
  const sql = 'CREATE INDEX idx ON t (a);';

  await t.test('skips migrations dated before the cutoff', async () => {
    const result = await linter.lint({ filename: 'V20260811.1__x.sql', sql });
    assert.deepEqual(result.diagnostics, []);
  });

  await t.test('runs from the cutoff onwards', async () => {
    const result = await linter.lint({ filename: 'V20260812.1__x.sql', sql });
    assert.equal(result.diagnostics.length, 1);
  });

  await t.test('fails closed on a filename with no date', async () => {
    assert.equal((await linter.lint({ filename: 'x.sql', sql })).diagnostics.length, 1);
    assert.equal((await linter.lint({ sql })).diagnostics.length, 1);
  });

  await t.test('honors a custom date extractor', async () => {
    const custom = new Linter({
      settings: { migrationDate: (name) => Number(name.match(/rev-(\d+)/)?.[1] ?? '') || null },
      rules: { 'require-concurrent-index-creation': { severity: 'error', enabledFrom: 10 } },
    });

    assert.deepEqual((await custom.lint({ filename: 'rev-9.sql', sql })).diagnostics, []);
    assert.equal((await custom.lint({ filename: 'rev-11.sql', sql })).diagnostics.length, 1);
  });
});

test('linter: custom rules', async (t) => {
  const banTempTables = defineRule<{ allow: string[] }>({
    name: 'ban-temp-tables',
    meta: {
      description: 'No temporary tables in migrations.',
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

  await t.test('runs a rule registered through customRules', async () => {
    const linter = new Linter({
      customRules: [banTempTables],
      rules: { 'ban-temp-tables': 'error' },
    });
    const result = await linter.lint({ sql: 'CREATE TEMP TABLE scratch (a int);' });

    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.ruleId, 'ban-temp-tables');
    assert.match(result.diagnostics[0]!.message, /Temporary table scratch/);
  });

  await t.test('accepts options like any built-in', async () => {
    const linter = new Linter({
      customRules: [banTempTables],
      rules: { 'ban-temp-tables': ['error', { allow: ['scratch'] }] },
    });
    const result = await linter.lint({ sql: 'CREATE TEMP TABLE scratch (a int);' });

    assert.deepEqual(result.diagnostics, []);
  });

  await t.test('is suppressible under its own name', async () => {
    const linter = new Linter({
      customRules: [banTempTables],
      rules: { 'ban-temp-tables': 'error' },
    });
    const result = await linter.lint({
      sql: '-- pgward-ignore ban-temp-tables: one-off data fix\nCREATE TEMP TABLE scratch (a int);',
    });

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.suppressed.length, 1);
  });

  await t.test('appears in the rules registry', () => {
    const linter = new Linter({ customRules: [banTempTables] });
    assert.ok(linter.rules.has('ban-temp-tables'));
    assert.ok(linter.rules.has('ban-drop-table'));
  });
});

test('linter: report locations', async (t) => {
  const reportWith = async (
    descriptor: (statement: any, node: any, path: any) => Record<string, unknown>,
  ) => {
    const rule = defineRule<void>({
      name: 'probe',
      meta: { description: 'x', defaultSeverity: 'error', defaultOptions: undefined },
      create(context) {
        return {
          ColumnDef(node, path) {
            context.report({ message: 'here', ...descriptor(path.statement, node, path) });
          },
        };
      },
    });

    const linter = new Linter({ customRules: [rule], rules: { probe: 'error' } });
    const result = await linter.lint({ sql: '\nALTER TABLE t\n  ADD COLUMN c int;' });
    return result.diagnostics[0]!;
  };

  await t.test('an explicit offset wins', async () => {
    const diagnostic = await reportWith(() => ({ offset: 1 }));
    assert.deepEqual([diagnostic.line, diagnostic.column], [2, 1]);
  });

  await t.test('a statement points at its first token', async () => {
    const diagnostic = await reportWith((statement) => ({ statement }));
    assert.deepEqual([diagnostic.line, diagnostic.column], [2, 1]);
  });

  await t.test('a node points into the node’s own subtree', async () => {
    const diagnostic = await reportWith((_statement, node) => ({ node }));
    // The ColumnDef's only location is its TypeName, on the `int`.
    assert.equal(diagnostic.line, 3);
  });

  await t.test('a locationless node falls back to its nearest located ancestor', async () => {
    const diagnostic = await reportWith((_statement, _node, path) => ({
      node: { subtype: 'AT_AddColumn' },
      path,
    }));
    // Ancestors are searched innermost-first, so the enclosing AlterTableCmd —
    // whose subtree holds the `int` on line 3 — wins over the outer statement.
    assert.equal(diagnostic.line, 3);
  });

  await t.test('falls all the way back to the statement when no ancestor has a location', async () => {
    const rule = defineRule<void>({
      name: 'probe-outer',
      meta: { description: 'x', defaultSeverity: 'error', defaultOptions: undefined },
      create(context) {
        return {
          TransactionStmt(_node, path) {
            // BEGIN carries location -1, and its only ancestor chain is empty.
            context.report({ message: 'here', node: { nothing: true }, path });
          },
        };
      },
    });

    const linter = new Linter({ customRules: [rule], rules: { 'probe-outer': 'error' } });
    const result = await linter.lint({ sql: 'SELECT 1;\n\nBEGIN;' });

    assert.deepEqual([result.diagnostics[0]?.line, result.diagnostics[0]?.column], [3, 1]);
  });

  await t.test('the current statement is used when nothing else is given', async () => {
    const diagnostic = await reportWith(() => ({}));
    assert.equal(diagnostic.statementIndex, 0);
    assert.deepEqual([diagnostic.line, diagnostic.column], [2, 1]);
  });
});

test('linter: lintAll and formatting', async (t) => {
  await t.test('lints several inputs in order', async () => {
    const linter = new Linter({ rules: { 'ban-drop-table': 'error' } });
    const results = await linter.lintAll([
      { filename: 'a.sql', sql: 'DROP TABLE a;' },
      { filename: 'b.sql', sql: 'SELECT 1;' },
    ]);

    assert.deepEqual(
      results.map((result) => [result.filename, result.errorCount]),
      [
        ['a.sql', 1],
        ['b.sql', 0],
      ],
    );
  });

  await t.test('formats results as text', async () => {
    const linter = new Linter({ rules: { 'ban-drop-table': 'error' } });
    const results = await linter.lintAll([{ filename: 'a.sql', sql: 'DROP TABLE a;' }]);
    const text = formatResults(results);

    assert.match(text, /^a\.sql/m);
    assert.match(text, /1:1\s+error/);
    assert.match(text, /ban-drop-table/);
    assert.match(text, /1 problem \(1 error, 0 warnings\)/);
  });

  await t.test('says so when there is nothing to report', async () => {
    const linter = new Linter({ rules: { 'ban-drop-table': 'error' } });
    const results = await linter.lintAll([{ filename: 'a.sql', sql: 'SELECT 1;' }]);
    assert.equal(formatResults(results), 'No problems found.');
  });

  await t.test('can include suppressed diagnostics with their reasons', async () => {
    const linter = new Linter({ rules: { 'ban-drop-table': 'error' } });
    const results = await linter.lintAll([
      { filename: 'a.sql', sql: '-- pgward-ignore ban-drop-table: dead since V90\nDROP TABLE a;' },
    ]);

    assert.equal(formatResults(results), 'No problems found.');
    assert.match(formatResults(results, { includeSuppressed: true }), /dead since V90/);
  });
});

test('linter: presets', async (t) => {
  await t.test('configs.all enables every built-in rule', () => {
    const linter = new Linter({ rules: { ...configs.all } });
    assert.equal(Object.keys(configs.all).length, linter.rules.size);
  });

  await t.test('configs.recommended is a subset that leaves style rules off', () => {
    assert.ok(Object.keys(configs.recommended).length < Object.keys(configs.all).length);
    assert.equal('ban-char-field' in configs.recommended, false);
    assert.equal('require-concurrent-index-creation' in configs.recommended, true);
  });

  await t.test('a preset can be overridden by spreading', async () => {
    const linter = new Linter({
      rules: { ...configs.recommended, 'ban-drop-table': 'off' },
    });
    const result = await linter.lint({ sql: 'DROP TABLE a;' });

    assert.equal(
      result.diagnostics.some((diagnostic) => diagnostic.ruleId === 'ban-drop-table'),
      false,
    );
  });
});

test('linter: rule failures name the rule', async (t) => {
  const thrower = (name: string, listener: Record<string, unknown>) =>
    defineRule<void>({
      name,
      meta: { description: 'x', defaultSeverity: 'error', defaultOptions: undefined },
      create: () => listener,
    });

  await t.test('a throwing node visitor is attributed', async () => {
    // Unattributed, this surfaces as a stack trace inside the traversal, which
    // says nothing about which of the configured rules is at fault.
    const rule = thrower('boom-node', {
      AlterTableStmt() {
        throw new Error('inner failure');
      },
    });
    const linter = new Linter({ customRules: [rule], rules: { 'boom-node': 'error' } });

    await assert.rejects(() => linter.lint({ sql: 'ALTER TABLE t DROP COLUMN a;' }), (error: Error) => {
      assert.match(error.message, /rule "boom-node" threw/);
      assert.match(error.message, /AlterTableStmt/);
      assert.match(error.message, /inner failure/);
      assert.equal((error.cause as Error)?.message, 'inner failure');
      return true;
    });
  });

  await t.test('a throwing lifecycle hook is attributed', async () => {
    const rule = thrower('boom-exit', {
      'file:exit'() {
        throw new Error('inner failure');
      },
    });
    const linter = new Linter({ customRules: [rule], rules: { 'boom-exit': 'error' } });

    await assert.rejects(
      () => linter.lint({ sql: 'SELECT 1;' }),
      /rule "boom-exit" threw while handling the end of the file/,
    );
  });

  await t.test('a throwing create() is attributed', async () => {
    const rule = defineRule<void>({
      name: 'boom-create',
      meta: { description: 'x', defaultSeverity: 'error', defaultOptions: undefined },
      create() {
        throw new Error('inner failure');
      },
    });
    const linter = new Linter({ customRules: [rule], rules: { 'boom-create': 'error' } });

    await assert.rejects(
      () => linter.lint({ sql: 'SELECT 1;' }),
      /rule "boom-create" threw while handling rule setup/,
    );
  });
});

test('linter: suppression integration', async (t) => {
  const linter = new Linter({ rules: { 'ban-drop-column': 'error' } });

  await t.test('a trailing directive silences its own line, not the next', async () => {
    const result = await linter.lint({
      sql: [
        'ALTER TABLE t DROP COLUMN a; -- pgward-ignore ban-drop-column: read path gone',
        'ALTER TABLE t DROP COLUMN b;',
      ].join('\n'),
    });

    assert.deepEqual(
      result.diagnostics.map((d) => [d.ruleId, d.line]),
      [['ban-drop-column', 2]],
    );
    assert.equal(result.suppressed.length, 1);
    assert.equal(result.suppressed[0]?.line, 1);
    assert.equal(result.suppressed[0]?.suppressionReason, 'read path gone');
  });

  await t.test('a typo in the rule name is reported instead of silently passing', async () => {
    const result = await linter.lint({
      sql: '-- pgward-ignore ban-drop-colum: typo\nALTER TABLE t DROP COLUMN a;',
    });

    const ids = result.diagnostics.map((d) => d.ruleId).sort();
    assert.deepEqual(ids, ['ban-drop-column', 'invalid-suppression']);
    assert.deepEqual(result.suppressed, []);
  });

  await t.test('a custom rule can be suppressed by name', async () => {
    const rule = defineRule<void>({
      name: 'ban-selects',
      meta: { description: 'x', defaultSeverity: 'error', defaultOptions: undefined },
      create: (context) => ({
        SelectStmt(_node, path) {
          context.report({ statement: path.statement, message: 'no selects' });
        },
      }),
    });
    const custom = new Linter({ customRules: [rule], rules: { 'ban-selects': 'error' } });
    const result = await custom.lint({
      sql: '-- pgward-ignore ban-selects: needed here\nSELECT 1;',
    });

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.suppressed.length, 1);
  });
});

test('linter: formatting suppressed output', async (t) => {
  await t.test('suppressed rows appear in source order', async () => {
    const linter = new Linter({ rules: { 'ban-drop-column': 'error', 'ban-drop-table': 'error' } });
    const result = await linter.lint({
      filename: 'V1__x.sql',
      sql: [
        'ALTER TABLE t DROP COLUMN a;',
        '-- pgward-ignore ban-drop-table: intentional',
        'DROP TABLE u;',
        'ALTER TABLE t DROP COLUMN b;',
      ].join('\n'),
    });

    const text = formatResults([result], { includeSuppressed: true });
    const rows = text.split('\n').filter((line) => /^ {2}\d+:\d+ /.test(line));

    assert.deepEqual(
      rows.map((line) => line.trim().split(/\s+/)[0]),
      ['1:1', '3:1', '4:1'],
    );
    assert.match(rows[1]!, /suppressed/);
  });

  await t.test('each remedy hangs under its own diagnostic', async () => {
    const linter = new Linter({ rules: { 'ban-drop-column': 'error' } });
    const result = await linter.lint({
      filename: 'V1__x.sql',
      sql: 'ALTER TABLE t DROP COLUMN a;',
    });

    const lines = formatResults([result]).split('\n');
    assert.match(lines[1]!, /^ {2}1:1\s+error\s+Dropping t\.a breaks instances/);
    assert.match(lines[2]!, /^\s+help: Deploy the code that stops reading it first/);
    // The help line is indented past the severity column so it reads as a
    // continuation rather than as another problem.
    assert.ok(
      lines[2]!.indexOf('help:') > lines[1]!.indexOf('error'),
      'help should hang past the message column',
    );
  });

  await t.test('help can be turned off', async () => {
    const linter = new Linter({ rules: { 'ban-drop-column': 'error' } });
    const result = await linter.lint({ sql: 'ALTER TABLE t DROP COLUMN a;' });

    assert.doesNotMatch(formatResults([result], { includeHelp: false }), /help:/);
  });
});
