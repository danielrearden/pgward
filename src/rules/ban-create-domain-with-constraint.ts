import { stringList, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export const banCreateDomainWithConstraint = defineRule<void>({
  name: 'ban-create-domain-with-constraint',
  meta: {
    description: 'Do not create domains with constraints.',
    rationale:
      'A domain constraint can never be changed online: altering it takes ACCESS EXCLUSIVE on ' +
      'every table using the domain and rescans them all. Put the CHECK on the column instead, ' +
      'where it can be added NOT VALID and validated separately.',
    help: 'Put the CHECK on the column instead.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create(context) {
    return {
      CreateDomainStmt(node, path) {
        const constraints = (node.constraints ?? []).filter((entry) =>
          Boolean((entry as AstNode)?.['Constraint']),
        );
        if (constraints.length === 0) return;

        const name = stringList(node.domainname).join('.');
        context.report({
          statement: path.statement,
          message: `Domain ${name} carries a constraint. Changing it later locks and rescans every table using the domain.`,
        });
      },
    };
  },
  tests: {
    valid: [
      'CREATE DOMAIN positive AS int;',
      'CREATE TABLE t (a int CHECK (a > 0));',
      'CREATE TYPE e AS ENUM (\'a\');',
    ],
    invalid: [
      {
        sql: 'CREATE DOMAIN positive AS int CHECK (VALUE > 0);',
        errors: [{ line: 1, column: 1, message: 'Domain positive carries a constraint' }],
      },
      {
        name: 'explains the cost of changing it later',
        sql: 'CREATE DOMAIN positive AS int CHECK (VALUE > 0);',
        errors: [{ message: 'locks and rescans every table using the domain' }],
      },
      {
        name: 'NOT NULL is a constraint too',
        sql: 'CREATE DOMAIN required AS text NOT NULL;',
        errors: 1,
      },
    ],
  },
});
