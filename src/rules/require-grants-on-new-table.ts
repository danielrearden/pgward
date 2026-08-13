import { relationName, stringValue, type AstNode } from '../ast.ts';
import { defineRule } from '../define-rule.ts';
import type { Statement } from '../types.ts';

export interface RequireGrantsOnNewTableOptions {
  /** Schemas the rule governs. Empty means every schema. */
  schemas: string[];
  /**
   * Role to the privileges it must be granted on every new table, e.g.
   * `{ api: ['SELECT', 'INSERT'], reporting: ['SELECT'] }`. Empty — the
   * default — leaves the rule inert.
   */
  requiredGrants: Record<string, string[]>;
}

const grants = { requiredGrants: { api: ['SELECT', 'INSERT'], reporting: ['SELECT'] } };

export const requireGrantsOnNewTable = defineRule<RequireGrantsOnNewTableOptions>({
  name: 'require-grants-on-new-table',
  meta: {
    description: 'New tables carry the project’s standard GRANT block.',
    rationale:
      'A table with no grants is invisible to the application role. Nothing fails at migration ' +
      'time — the breakage shows up later, as a permission error in production.',
    help: 'Add the missing GRANT statements to this migration.',
    defaultSeverity: 'error',
    defaultOptions: { schemas: [], requiredGrants: {} },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      const normalized: Record<string, string[]> = {};
      for (const [role, privileges] of Object.entries(options.requiredGrants)) {
        if (!Array.isArray(privileges)) {
          throw new TypeError(
            `pgward: rule "require-grants-on-new-table" option requiredGrants.${role} must be ` +
              `an array of privilege names, got ${String(privileges)}`,
          );
        }
        normalized[role.toLowerCase()] = privileges.map((privilege) =>
          String(privilege).toUpperCase(),
        );
      }
      return { ...options, requiredGrants: normalized };
    },
  },
  create(context) {
    const { options, source } = context;

    return {
      'file:exit'() {
        const required = Object.entries(options.requiredGrants);
        if (required.length === 0) return;

        const grants = collectGrants(source.statements);

        for (const statement of source.statements) {
          if (statement.type !== 'CreateStmt') continue;

          const relation = relationName((statement.node as AstNode)['relation']);
          const schema = relation.schema ?? 'public';
          if (options.schemas.length > 0 && !options.schemas.includes(schema)) continue;

          const key = `${schema}.${relation.name}`;
          const missing: string[] = [];

          for (const [role, privileges] of required) {
            const held = new Set([
              ...(grants.byTable.get(key)?.get(role) ?? []),
              ...(grants.bySchema.get(schema)?.get(role) ?? []),
            ]);
            if (held.has('ALL')) continue;

            const absent = privileges.filter((privilege) => !held.has(privilege));
            if (absent.length > 0) missing.push(`${role} (${absent.join(', ')})`);
          }

          if (missing.length === 0) continue;

          context.report({
            statement,
            message: `New table ${key} is missing required grants: ${missing.join('; ')}. Without them the table is invisible to those roles.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'inert until requiredGrants is configured',
        sql: 'CREATE TABLE public.thing (a int);',
      },
      {
        name: 'every required grant present',
        sql: 'CREATE TABLE public.thing (a int);\nGRANT SELECT, INSERT ON public.thing TO api;\nGRANT SELECT ON public.thing TO reporting;',
        options: grants,
      },
      {
        name: 'GRANT ALL satisfies every privilege',
        sql: 'CREATE TABLE public.thing (a int);\nGRANT ALL ON public.thing TO api;\nGRANT ALL ON public.thing TO reporting;',
        options: grants,
      },
      {
        name: 'a schema-wide grant covers the new table',
        sql: 'CREATE TABLE public.thing (a int);\nGRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO api;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO reporting;',
        options: grants,
      },
      {
        name: 'unqualified tables default to the public schema',
        sql: 'CREATE TABLE thing (a int);\nGRANT SELECT, INSERT ON public.thing TO api;\nGRANT SELECT ON public.thing TO reporting;',
        options: grants,
      },
      {
        name: 'schemas outside the governed list are ignored',
        sql: 'CREATE TABLE internal.thing (a int);',
        options: { ...grants, schemas: ['public'] },
      },
      {
        name: 'grants are matched case-insensitively',
        sql: 'CREATE TABLE public.thing (a int);\nGRANT select, insert ON public.thing TO API;\nGRANT select ON public.thing TO Reporting;',
        options: grants,
      },
    ],
    invalid: [
      {
        name: 'no grants at all',
        sql: 'CREATE TABLE public.thing (a int);',
        options: grants,
        errors: [
          {
            line: 1,
            column: 1,
            message: 'public.thing is missing required grants: api (SELECT, INSERT); reporting (SELECT)',
          },
        ],
      },
      {
        name: 'names only the missing privileges',
        sql: 'CREATE TABLE public.thing (a int);\nGRANT SELECT ON public.thing TO api;\nGRANT SELECT ON public.thing TO reporting;',
        options: grants,
        errors: [{ message: 'api (INSERT)' }],
      },
      {
        name: 'explains the consequence',
        sql: 'CREATE TABLE public.thing (a int);',
        options: { requiredGrants: { api: ['SELECT'] } },
        errors: [{ message: 'invisible to those roles' }],
      },
      {
        name: 'a grant to a different role does not count',
        sql: 'CREATE TABLE public.thing (a int);\nGRANT SELECT ON public.thing TO someone_else;',
        options: { requiredGrants: { api: ['SELECT'] } },
        errors: 1,
      },
      {
        name: 'each new table is checked',
        sql: 'CREATE TABLE public.a (x int);\nCREATE TABLE public.b (y int);',
        options: { requiredGrants: { api: ['SELECT'] } },
        errors: 2,
      },
    ],
  },
});

interface CollectedGrants {
  /** `schema.table` to role to privileges. */
  byTable: Map<string, Map<string, Set<string>>>;
  /** schema to role to privileges, from `GRANT … ON ALL TABLES IN SCHEMA`. */
  bySchema: Map<string, Map<string, Set<string>>>;
}

function collectGrants(statements: readonly Statement[]): CollectedGrants {
  const byTable = new Map<string, Map<string, Set<string>>>();
  const bySchema = new Map<string, Map<string, Set<string>>>();

  const record = (
    target: Map<string, Map<string, Set<string>>>,
    key: string,
    roles: string[],
    privileges: string[],
  ): void => {
    let roleMap = target.get(key);
    if (!roleMap) {
      roleMap = new Map();
      target.set(key, roleMap);
    }
    for (const role of roles) {
      let held = roleMap.get(role);
      if (!held) {
        held = new Set();
        roleMap.set(role, held);
      }
      for (const privilege of privileges) held.add(privilege);
    }
  };

  for (const statement of statements) {
    if (statement.type !== 'GrantStmt') continue;
    const node = statement.node as AstNode;
    if (!node['is_grant'] || node['objtype'] !== 'OBJECT_TABLE') continue;

    const roles = (node['grantees'] ?? [])
      .map((grantee: AstNode) => {
        const spec = grantee?.['RoleSpec'];
        if (!spec) return null;
        if (spec['roletype'] === 'ROLESPEC_PUBLIC') return 'public';
        return String(spec['rolename'] ?? '').toLowerCase();
      })
      .filter((role: string | null): role is string => Boolean(role));

    // An empty privilege list means GRANT ALL.
    const privileges =
      Array.isArray(node['privileges']) && node['privileges'].length > 0
        ? node['privileges']
            .map((entry: AstNode) => entry?.['AccessPriv']?.['priv_name'])
            .filter((name: unknown): name is string => typeof name === 'string')
            .map((name: string) => name.toUpperCase())
        : ['ALL'];

    if (node['targtype'] === 'ACL_TARGET_ALL_IN_SCHEMA') {
      for (const object of node['objects'] ?? []) {
        const schema = stringValue(object);
        if (schema) record(bySchema, schema, roles, privileges);
      }
      continue;
    }

    for (const object of node['objects'] ?? []) {
      const rangeVar = (object as AstNode)?.['RangeVar'];
      if (!rangeVar) continue;
      const relation = relationName(rangeVar);
      record(byTable, `${relation.schema ?? 'public'}.${relation.name}`, roles, privileges);
    }
  }

  return { byTable, bySchema };
}
