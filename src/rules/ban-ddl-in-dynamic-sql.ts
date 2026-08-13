import { stringList, stringValue, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';
import { assertKnownStatementKinds, statementKindPattern } from '../statement-kinds.ts';

export interface BanDdlInDynamicSqlOptions {
  /** Statement kinds that must never appear inside a dynamic body. */
  watchedStatements: string[];
  /**
   * Also reject `EXECUTE` inside a body. SQL assembled at run time can't be
   * analysed at all, so the safe answer is to refuse it rather than pass it.
   */
  banDynamicExecute: boolean;
}

const EXECUTE_PATTERN = /\bEXECUTE\b/i;

export const banDdlInDynamicSql = defineRule<BanDdlInDynamicSqlOptions>({
  name: 'ban-ddl-in-dynamic-sql',
  meta: {
    description: 'Keep governed DDL out of dollar-quoted bodies and dynamic EXECUTE.',
    rationale:
      "This rule is what makes a parser sufficient: it removes the only case a parser can't " +
      'see. Without it, an ALTER TABLE hidden in a DO block passes every other rule silently.',
    defaultSeverity: 'error',
    defaultOptions: {
      watchedStatements: ['ALTER TABLE', 'DROP TABLE', 'TRUNCATE'],
      banDynamicExecute: true,
    },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      assertKnownStatementKinds(
        'ban-ddl-in-dynamic-sql',
        'watchedStatements',
        options.watchedStatements,
      );
      return options;
    },
  },
  create(context) {
    const { options } = context;

    const inspect = (body: string, construct: string, statement: any): void => {
      for (const kind of options.watchedStatements) {
        const pattern = statementKindPattern(kind);
        if (pattern?.test(body)) {
          context.report({
            statement,
            message: `This ${construct} contains ${kind}. DDL inside a dynamic body is invisible to every other rule here.`,
            help: `Move it out into a plain statement.`,
          });
          return;
        }
      }

      if (options.banDynamicExecute && EXECUTE_PATTERN.test(body)) {
        context.report({
          statement,
          message: `This ${construct} uses EXECUTE. SQL assembled at run time cannot be checked, so it is refused rather than passed silently.`,
          help: `Write the statement out in full instead of assembling it at run time.`,
        });
      }
    };

    return {
      DoStmt(node, path) {
        for (const body of definitionBodies(node.args)) {
          inspect(body, 'DO block', path.statement);
        }
      },

      CreateFunctionStmt(node, path) {
        for (const body of definitionBodies(node.options)) {
          inspect(body, node.is_procedure ? 'procedure body' : 'function body', path.statement);
        }
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'plain DDL is visible to every other rule',
        sql: 'ALTER TABLE t ADD COLUMN c int;',
      },
      {
        name: 'a DO block doing nothing governed',
        sql: 'DO $$ BEGIN PERFORM 1; END $$;',
      },
      {
        name: 'a function body doing nothing governed',
        sql: 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;',
      },
      {
        name: 'EXECUTE may be permitted explicitly',
        sql: "DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;",
        options: { banDynamicExecute: false },
      },
      {
        name: 'a statement kind outside the watched set',
        sql: 'DO $$ BEGIN CREATE TABLE t (a int); END $$;',
        options: { banDynamicExecute: false },
      },
    ],
    invalid: [
      {
        name: 'ALTER TABLE hidden in a DO block',
        sql: 'DO $$ BEGIN ALTER TABLE t ADD COLUMN c int; END $$;',
        errors: [{ line: 1, column: 1, message: 'This DO block contains ALTER TABLE' }],
      },
      {
        name: 'says why a parser cannot help here',
        sql: 'DO $$ BEGIN DROP TABLE t; END $$;',
        errors: [{ message: 'invisible to every other rule here' }],
      },
      {
        name: 'TRUNCATE in a function body',
        sql: 'CREATE FUNCTION f() RETURNS void AS $$ BEGIN TRUNCATE t; END $$ LANGUAGE plpgsql;',
        errors: [{ message: 'function body contains TRUNCATE' }],
      },
      {
        name: 'dynamic EXECUTE is refused outright',
        sql: "DO $$ BEGIN EXECUTE format('REFRESH MATERIALIZED VIEW %I', v); END $$;",
        errors: [{ message: 'assembled at run time cannot be checked' }],
      },
      {
        name: 'the watched set is configurable',
        sql: 'DO $$ BEGIN CREATE INDEX idx ON t (a); END $$;',
        options: { watchedStatements: ['CREATE INDEX'], banDynamicExecute: false },
        errors: 1,
      },
    ],
  },
});

/** Pulls the `AS $$ … $$` payload out of a `DefElem` list. */
function definitionBodies(elements: unknown): string[] {
  if (!Array.isArray(elements)) return [];
  const bodies: string[] = [];

  for (const element of elements) {
    const defElem = (element as AstNode)?.['DefElem'];
    if (!defElem || String(defElem['defname'] ?? '').toLowerCase() !== 'as') continue;

    const arg = defElem['arg'];
    const single = stringValue(arg);
    if (single !== null) {
      bodies.push(single);
      continue;
    }
    if (arg && typeof arg === 'object' && (arg as AstNode)['List']) {
      bodies.push(...stringList((arg as AstNode)['List']['items']));
    } else if (Array.isArray(arg)) {
      bodies.push(...stringList(arg));
    }
  }

  return bodies;
}
