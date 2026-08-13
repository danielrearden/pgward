import assert from 'node:assert/strict';
import test from 'node:test';

import { Linter } from '../src/linter.ts';
import { builtinRules } from '../src/rules/index.ts';
import { runBuiltinRuleTests } from '../src/testing.ts';
import type { AnyRule } from '../src/types.ts';

runBuiltinRuleTests();

test('every rule carries its own fixtures', async (t) => {
  const CORE = new Set(['parse-error', 'invalid-suppression']);
  const rules = Object.entries(builtinRules).filter(([name]) => !CORE.has(name)) as Array<
    [string, AnyRule]
  >;

  await t.test('no rule ships without valid and invalid cases', () => {
    // Collected rather than asserted one at a time so a failure names every
    // rule at fault, not just the first.
    assert.deepEqual(
      rules.filter(([, rule]) => !rule.tests?.valid.length).map(([name]) => name),
      [],
      'these rules have no valid cases',
    );
    assert.deepEqual(
      rules.filter(([, rule]) => !rule.tests?.invalid.length).map(([name]) => name),
      [],
      'these rules have no invalid cases',
    );
  });

  await t.test('every diagnostic offers a remedy', async () => {
    // A rule that says what is wrong but not what to do is half a rule. Each
    // invalid fixture is linted and every diagnostic must carry `help`.
    const missing: string[] = [];

    for (const [name, rule] of rules) {
      for (const testCase of rule.tests?.invalid ?? []) {
        const linter = new Linter({
          ...(testCase.settings ? { settings: testCase.settings } : {}),
          rules: {
            [name]: {
              severity: testCase.severity ?? rule.meta.defaultSeverity,
              ...(testCase.options ? { options: testCase.options } : {}),
              ...(testCase.enabledFrom !== undefined ? { enabledFrom: testCase.enabledFrom } : {}),
            },
          },
        });
        const result = await linter.lint({
          sql: testCase.sql,
          ...(testCase.filename ? { filename: testCase.filename } : {}),
          ...(testCase.implicitTransaction !== undefined
            ? { implicitTransaction: testCase.implicitTransaction }
            : {}),
        });

        for (const diagnostic of result.diagnostics) {
          if (diagnostic.ruleId !== name) continue;
          if (diagnostic.help && diagnostic.help.trim() !== '') continue;
          missing.push(`${name}: ${diagnostic.message}`);
        }
      }
    }

    assert.deepEqual(missing, [], 'these diagnostics have no help text');
  });

  await t.test('a remedy never repeats the message', () => {
    for (const [name, rule] of rules) {
      const help = rule.meta.help;
      if (!help) continue;
      assert.ok(help.trim().length > 0, `rule "${name}" has empty help`);
      assert.notEqual(help, rule.meta.description, `rule "${name}" help restates its description`);
    }
  });

  await t.test('the core diagnostics have no fixtures of their own', () => {
    // They carry no visitors; the linter emits them directly, and the linter
    // suite covers them.
    for (const name of CORE) {
      assert.equal(builtinRules[name as keyof typeof builtinRules].tests, undefined);
    }
  });
});
