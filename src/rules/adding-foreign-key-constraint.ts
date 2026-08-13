import { createdTableMatcher } from '../analysis/new-tables.ts';
import { alterTableCommands, relationName, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface AddingForeignKeyConstraintOptions {
  /** Skip tables created by this same migration. */
  allowOnNewTables: boolean;
}

export const addingForeignKeyConstraint = defineRule<AddingForeignKeyConstraintOptions>({
  name: 'adding-foreign-key-constraint',
  meta: {
    description: 'Add foreign keys NOT VALID, then validate them separately.',
    rationale:
      'A new foreign key locks both tables and scans the child to validate existing rows. ' +
      'Overlaps with constraint-missing-not-valid, which covers CHECK constraints too — turn ' +
      'one off if the duplicate diagnostics are noisy.',
    help: 'Add the constraint NOT VALID, then VALIDATE CONSTRAINT in a separate statement.',
    defaultSeverity: 'error',
    defaultOptions: { allowOnNewTables: true },
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
          if (!constraint || constraint['contype'] !== 'CONSTR_FOREIGN') continue;
          if (constraint['skip_validation']) continue;

          const target = constraint['pktable'] ? relationName(constraint['pktable']).qualified : '';
          context.report({
            statement: path.statement,
            message: `Adding this foreign key${target ? ` to ${target}` : ''} locks both tables and scans ${relation.qualified}.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      'ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o (b) NOT VALID;',
      'ALTER TABLE t VALIDATE CONSTRAINT f;',
      {
        name: 'a CHECK is not a foreign key',
        sql: 'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);',
      },
      {
        name: 'references declared in CREATE TABLE',
        sql: 'CREATE TABLE t (a int REFERENCES o (b));',
      },
      {
        name: 'a table created in the same migration',
        sql: 'CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o (b);',
      },
    ],
    invalid: [
      {
        sql: 'ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o (b);',
        errors: [{ line: 1, column: 1, message: 'Adding this foreign key to o locks both tables' }],
      },
      {
        name: 'explains that both tables are locked',
        sql: 'ALTER TABLE public.child ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o (b);',
        errors: [{ message: 'locks both tables and scans public.child' }],
      },
      {
        name: 'the new-table exemption can be turned off',
        sql: 'CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES o (b);',
        options: { allowOnNewTables: false },
        errors: 1,
      },
    ],
  },
});
