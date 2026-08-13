import { createdTableMatcher } from '../analysis/new-tables.ts';
import { alterTableCommands, relationName, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface DisallowedUniqueConstraintOptions {
  /**
   * Also flag `ADD CONSTRAINT … PRIMARY KEY` without `USING INDEX`. It builds
   * its index under the same exclusive lock, so it is the identical hazard —
   * Squawk's own rule covers only UNIQUE.
   */
  includePrimaryKey: boolean;
  /** Skip tables created by this same migration. */
  allowOnNewTables: boolean;
}

const LABELS: Record<string, string> = {
  CONSTR_UNIQUE: 'UNIQUE',
  CONSTR_PRIMARY: 'PRIMARY KEY',
};

export const disallowedUniqueConstraint = defineRule<DisallowedUniqueConstraintOptions>({
  name: 'disallowed-unique-constraint',
  meta: {
    description: 'Adopt a concurrently-built index instead of adding UNIQUE directly.',
    rationale:
      'ADD CONSTRAINT … UNIQUE builds its backing index non-concurrently under an exclusive ' +
      'lock. Build the index with CREATE UNIQUE INDEX CONCURRENTLY, then adopt it with ' +
      'ADD CONSTRAINT … USING INDEX.',
    help: 'Build the index with CREATE UNIQUE INDEX CONCURRENTLY, then adopt it with ADD CONSTRAINT … USING INDEX.',
    defaultSeverity: 'error',
    defaultOptions: { includePrimaryKey: true, allowOnNewTables: true },
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

          const contype = String(constraint['contype'] ?? '');
          if (contype === 'CONSTR_PRIMARY' && !context.options.includePrimaryKey) continue;

          const label = LABELS[contype];
          if (!label) continue;
          // `USING INDEX` adopts an already-built index, which is the safe form.
          if (constraint['indexname']) continue;

          context.report({
            statement: path.statement,
            message: `This ${label} constraint builds its index under an exclusive lock on ${relation.qualified}.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'adopting an index built concurrently',
        sql: 'ALTER TABLE t ADD CONSTRAINT u UNIQUE USING INDEX u_idx;',
      },
      {
        name: 'a primary key adopting an index',
        sql: 'ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY USING INDEX pk_idx;',
      },
      {
        name: 'UNIQUE in CREATE TABLE builds against nothing',
        sql: 'CREATE TABLE t (a int UNIQUE);',
      },
      {
        name: 'a CHECK is a different rule’s business',
        sql: 'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID;',
      },
      {
        name: 'a table created in the same migration',
        sql: 'CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT u UNIQUE (a);',
      },
      {
        name: 'primary keys can be exempted to match Squawk',
        sql: 'ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (a);',
        options: { includePrimaryKey: false },
      },
    ],
    invalid: [
      {
        name: 'UNIQUE builds its index under an exclusive lock',
        sql: 'ALTER TABLE t ADD CONSTRAINT u UNIQUE (a);',
        errors: [
          { line: 1, column: 1, message: 'This UNIQUE constraint builds its index under an exclusive lock' },
        ],
      },
      {
        name: 'points at the two-step replacement',
        sql: 'ALTER TABLE t ADD CONSTRAINT u UNIQUE (a);',
        errors: [{ help: 'ADD CONSTRAINT … USING INDEX' }],
      },
      {
        name: 'PRIMARY KEY is the same hazard by default',
        sql: 'ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (a);',
        errors: [{ message: 'PRIMARY KEY constraint' }],
      },
      {
        name: 'the new-table exemption can be turned off',
        sql: 'CREATE TABLE t (a int);\nALTER TABLE t ADD CONSTRAINT u UNIQUE (a);',
        options: { allowOnNewTables: false },
        errors: 1,
      },
    ],
  },
});
