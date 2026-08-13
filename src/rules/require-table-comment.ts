import { relationName, stringList, tableElements, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';
import type { Statement } from '../types.ts';

export interface RequireTableCommentOptions {
  requireOnTable: boolean;
  /** Comments on every column. Off by default — only non-obvious ones earn one. */
  requireOnColumn: boolean;
  /** Schemas the rule governs. Empty means every schema. */
  schemas: string[];
}

export const requireTableComment = defineRule<RequireTableCommentOptions>({
  name: 'require-table-comment',
  meta: {
    description: 'New tables carry a COMMENT ON TABLE.',
    rationale:
      "The comment lands in the generated schema and is the table's public docstring. Written " +
      'at creation it is cheap; retrofitted across an existing schema it never happens.',
    defaultSeverity: 'error',
    defaultOptions: { requireOnTable: true, requireOnColumn: false, schemas: [] },
  },
  create(context) {
    const { options, source } = context;

    return {
      'file:exit'() {
        if (!options.requireOnTable && !options.requireOnColumn) return;

        const commented = collectComments(source.statements);

        for (const statement of source.statements) {
          if (statement.type !== 'CreateStmt') continue;

          const relation = relationName((statement.node as AstNode)['relation']);
          const schema = relation.schema ?? 'public';
          if (options.schemas.length > 0 && !options.schemas.includes(schema)) continue;

          const qualified = `${schema}.${relation.name}`;

          if (options.requireOnTable && !hasComment(commented.tables, qualified, relation.name)) {
            context.report({
              statement,
              message: `New table ${qualified} has no COMMENT ON TABLE.`,
              help: `Add COMMENT ON TABLE ${qualified} IS '…';`,
            });
          }

          if (!options.requireOnColumn) continue;

          for (const column of tableElements(statement.node).columns) {
            const name = String(column['colname'] ?? '');
            if (name === '') continue;
            if (hasComment(commented.columns, `${qualified}.${name}`, `${relation.name}.${name}`)) {
              continue;
            }
            context.report({
              statement,
              message: `Column ${qualified}.${name} has no COMMENT ON COLUMN.`,
              help: `Add COMMENT ON COLUMN ${qualified}.${name} IS '…';`,
            });
          }
        }
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'a comment on the new table',
        sql: "CREATE TABLE public.thing (a int);\nCOMMENT ON TABLE public.thing IS 'a thing';",
      },
      {
        name: 'the comment need not repeat the schema',
        sql: "CREATE TABLE public.thing (a int);\nCOMMENT ON TABLE thing IS 'a thing';",
      },
      {
        name: 'an unqualified table matched by a qualified comment',
        sql: "CREATE TABLE thing (a int);\nCOMMENT ON TABLE public.thing IS 'a thing';",
      },
      {
        name: 'nothing created, nothing required',
        sql: 'ALTER TABLE public.thing ADD COLUMN b int;',
      },
      {
        name: 'schemas outside the governed list are ignored',
        sql: 'CREATE TABLE internal.thing (a int);',
        options: { schemas: ['public'] },
      },
      {
        name: 'column comments are not required by default',
        sql: "CREATE TABLE public.thing (a int);\nCOMMENT ON TABLE public.thing IS 'a thing';",
      },
      {
        name: 'column comments when required and present',
        sql: "CREATE TABLE public.thing (a int);\nCOMMENT ON TABLE public.thing IS 'a thing';\nCOMMENT ON COLUMN public.thing.a IS 'the a';",
        options: { requireOnColumn: true },
      },
      {
        name: 'the table requirement can be turned off',
        sql: 'CREATE TABLE public.thing (a int);',
        options: { requireOnTable: false },
      },
    ],
    invalid: [
      {
        sql: 'CREATE TABLE public.thing (a int);',
        errors: [{ line: 1, column: 1, message: 'New table public.thing has no COMMENT ON TABLE' }],
      },
      {
        name: 'a comment on a different table does not count',
        sql: "CREATE TABLE public.thing (a int);\nCOMMENT ON TABLE public.other IS 'other';",
        errors: 1,
      },
      {
        name: 'setting a null comment removes it rather than supplying one',
        sql: 'CREATE TABLE public.thing (a int);\nCOMMENT ON TABLE public.thing IS NULL;',
        errors: 1,
      },
      {
        name: 'missing column comments when required',
        sql: "CREATE TABLE public.thing (a int, b int);\nCOMMENT ON TABLE public.thing IS 'a thing';",
        options: { requireOnColumn: true },
        errors: [
          { message: 'Column public.thing.a has no COMMENT ON COLUMN' },
          { message: 'Column public.thing.b has no COMMENT ON COLUMN' },
        ],
      },
      {
        name: 'each new table is checked',
        sql: 'CREATE TABLE public.a (x int);\nCREATE TABLE public.b (y int);',
        errors: 2,
      },
    ],
  },
});

interface CollectedComments {
  tables: Set<string>;
  columns: Set<string>;
}

/**
 * Records commented objects under both their qualified and bare names, since
 * `CREATE TABLE public.thing` is routinely paired with `COMMENT ON TABLE thing`.
 */
function collectComments(statements: readonly Statement[]): CollectedComments {
  const tables = new Set<string>();
  const columns = new Set<string>();

  for (const statement of statements) {
    if (statement.type !== 'CommentStmt') continue;
    const node = statement.node as AstNode;
    // `IS NULL` removes the comment and arrives as an empty string, the same
    // shape as `IS ''`. Neither documents anything.
    const comment = node['comment'];
    if (typeof comment !== 'string' || comment.trim() === '') continue;

    const parts = stringList(node['object']?.['List']?.['items']);
    if (parts.length === 0) continue;

    if (node['objtype'] === 'OBJECT_TABLE') {
      tables.add(parts.join('.'));
      tables.add(parts[parts.length - 1]!);
    } else if (node['objtype'] === 'OBJECT_COLUMN') {
      columns.add(parts.join('.'));
      if (parts.length >= 2) columns.add(parts.slice(-2).join('.'));
    }
  }

  return { tables, columns };
}

function hasComment(seen: ReadonlySet<string>, qualified: string, bare: string): boolean {
  return seen.has(qualified) || seen.has(bare);
}
