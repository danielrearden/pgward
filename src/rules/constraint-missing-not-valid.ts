import { createdTableMatcher } from '../analysis/new-tables.ts';
import { alterTableCommands, relationName, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface ConstraintMissingNotValidOptions {
  /** Which constraint kinds must be added `NOT VALID` first. */
  constraintTypes: Array<'check' | 'foreign key'>;
  /** Skip tables created by this same migration. */
  allowOnNewTables: boolean;
}

const CONTYPE_LABELS: Record<string, 'check' | 'foreign key'> = {
  CONSTR_CHECK: 'check',
  CONSTR_FOREIGN: 'foreign key',
};

export const constraintMissingNotValid = defineRule<ConstraintMissingNotValidOptions>({
  name: 'constraint-missing-not-valid',
  meta: {
    description: 'Add constraints NOT VALID, then validate them separately.',
    rationale:
      'Adding a constraint scans the whole table under ACCESS EXCLUSIVE. Splitting it into ' +
      'ADD CONSTRAINT … NOT VALID followed by VALIDATE CONSTRAINT keeps the scan online.',
    help: 'Add it NOT VALID, then VALIDATE CONSTRAINT in a separate statement.',
    defaultSeverity: 'error',
    defaultOptions: {
      constraintTypes: ['check', 'foreign key'],
      allowOnNewTables: true,
    },
  },
  create(context) {
    const isNewTable = createdTableMatcher(context.source);

    return {
      AlterTableStmt(node, path) {
        const relation = relationName(node.relation);
        if (context.options.allowOnNewTables && isNewTable(relation)) return;

        for (const command of alterTableCommands(node)) {
          if (command['subtype'] !== 'AT_AddConstraint') continue;

          const constraint = (command['def'] as AstNode)?.['Constraint'];
          if (!constraint) continue;

          const label = CONTYPE_LABELS[String(constraint['contype'] ?? '')];
          if (!label || !context.options.constraintTypes.includes(label)) continue;
          // `skip_validation` is how libpg_query records NOT VALID.
          if (constraint['skip_validation']) continue;

          const name = constraint['conname'] ? ` ${constraint['conname']}` : '';
          context.report({
            statement: path.statement,
            message: `Adding ${label} constraint${name} scans all of ${relation.qualified} under ACCESS EXCLUSIVE.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0) NOT VALID;',
      'ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o (b) NOT VALID;',
      'ALTER TABLE t VALIDATE CONSTRAINT c;',
      {
        name: 'a UNIQUE constraint is a different rule’s business',
        sql: 'ALTER TABLE t ADD CONSTRAINT u UNIQUE (a);',
      },
      {
        name: 'constraints in CREATE TABLE scan nothing',
        sql: 'CREATE TABLE t (a int, CONSTRAINT c CHECK (a > 0));',
      },
      {
        name: 'a table created in the same migration is empty',
        sql: 'CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);',
      },
      {
        name: 'the checked kinds are configurable',
        sql: 'ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0);',
        options: { constraintTypes: ['foreign key'] },
      },
    ],
    invalid: [
      {
        name: 'a CHECK that scans the whole table',
        sql: 'ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0);',
        errors: [{ line: 1, column: 1, message: 'Adding check constraint c scans all of t' }],
      },
      {
        name: 'names the table it scans',
        sql: 'ALTER TABLE public.thing ADD CONSTRAINT c CHECK (x > 0);',
        errors: [{ message: 'scans all of public.thing under ACCESS EXCLUSIVE' }],
      },
      {
        name: 'a foreign key without NOT VALID',
        sql: 'ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o (b);',
        errors: [{ message: 'Adding foreign key constraint f scans all of t' }],
      },
      {
        name: 'an unnamed constraint still reports',
        sql: 'ALTER TABLE t ADD CHECK (x > 0);',
        errors: 1,
      },
      {
        name: 'the new-table exemption can be turned off',
        sql: 'CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);',
        options: { allowOnNewTables: false },
        errors: 1,
      },
      {
        name: 'each constraint in a list is reported',
        sql: 'ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0), ADD CONSTRAINT d CHECK (y > 0);',
        errors: 2,
      },
    ],
  },
});
