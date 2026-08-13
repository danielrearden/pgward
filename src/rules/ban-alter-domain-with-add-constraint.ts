import { stringList } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

/** libpg_query records the ALTER DOMAIN variant as a single character. */
const ADD_CONSTRAINT = 'C';

export const banAlterDomainWithAddConstraint = defineRule<void>({
  name: 'ban-alter-domain-with-add-constraint',
  meta: {
    description: 'Do not add constraints to an existing domain.',
    rationale:
      'ADD CONSTRAINT on a domain takes ACCESS EXCLUSIVE on every table with a column of that ' +
      'domain and rescans all of them, with no NOT VALID escape hatch.',
    help: 'Add the CHECK to the columns instead.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      AlterDomainStmt(node, path) {
        if (node.subtype !== ADD_CONSTRAINT) return;

        const name = stringList(node.typeName).join('.');
        context.report({
          statement: path.statement,
          message: `Adding a constraint to domain ${name} locks and rescans every table using it, with no NOT VALID form available.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'ALTER DOMAIN positive DROP CONSTRAINT c;',
      'ALTER DOMAIN positive SET NOT NULL;',
      'ALTER DOMAIN positive DROP NOT NULL;',
      { name: 'table constraints are a different rule’s business', sql: 'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID;' },
    ],
    invalid: [
      {
        sql: 'ALTER DOMAIN positive ADD CONSTRAINT c CHECK (VALUE > 0);',
        errors: [
          { line: 1, column: 1, message: 'Adding a constraint to domain positive locks and rescans' },
        ],
      },
      {
        name: 'says there is no NOT VALID escape hatch',
        sql: 'ALTER DOMAIN positive ADD CHECK (VALUE > 0);',
        errors: [{ message: 'no NOT VALID form available' }],
      },
    ],
  },
});
