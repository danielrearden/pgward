import { stringList } from '../ast.ts';
import { defineRule } from '../define-rule.ts';

export interface RequireEnumValueOrderingOptions {
  /**
   * Also require `ALTER TYPE … ADD VALUE` to say BEFORE or AFTER, so the new
   * value lands in sorted position instead of at the end.
   */
  requireNeighborOnAdd: boolean;
}

export const requireEnumValueOrdering = defineRule<RequireEnumValueOrderingOptions>({
  name: 'require-enum-value-ordering',
  meta: {
    description: 'Declare enum values in sorted order.',
    rationale:
      'Enum comparison and ORDER BY follow declaration order, not alphabetical order. Once ' +
      'values are out of order there is no way to reorder them without recreating the type.',
    defaultSeverity: 'error',
    defaultOptions: { requireNeighborOnAdd: true },
  },
  create(context) {
    return {
      CreateEnumStmt(node, path) {
        const values = stringList(node.vals);
        if (values.length < 2) return;

        const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const firstOutOfPlace = values.findIndex((value, index) => value !== sorted[index]);
        if (firstOutOfPlace === -1) return;

        const name = stringList(node.typeName).join('.');
        context.report({
          statement: path.statement,
          message: `Enum ${name} declares "${values[firstOutOfPlace]}" out of order. Comparison and ORDER BY follow declaration order, and it cannot be changed later without recreating the type.`,
          help: `Declare the values in this order: ${sorted.join(', ')}.`,
        });
      },

      AlterEnumStmt(node, path) {
        if (!context.options.requireNeighborOnAdd) return;
        // An oldVal means this renames an existing value rather than adding one.
        if (node.oldVal) return;
        if (node.newValNeighbor) return;

        const name = stringList(node.typeName).join('.');
        context.report({
          statement: path.statement,
          message: `ADD VALUE '${node.newVal}' to ${name} appends to the end of the enum.`,
          help: `Say BEFORE or AFTER an existing value so the ordering stays meaningful.`,
        });
      },
    };
  },
  tests: {
    valid: [
      "CREATE TYPE status AS ENUM ('active', 'inactive', 'pending');",
      "CREATE TYPE single AS ENUM ('only');",
      'CREATE TYPE empty AS ENUM ();',
      {
        name: 'adding a value in sorted position',
        sql: "ALTER TYPE status ADD VALUE 'blocked' BEFORE 'pending';",
      },
      {
        name: 'renaming an existing value is not an insertion',
        sql: "ALTER TYPE status RENAME VALUE 'old' TO 'new';",
      },
      {
        name: 'the neighbour requirement can be relaxed',
        sql: "ALTER TYPE status ADD VALUE 'zzz';",
        options: { requireNeighborOnAdd: false },
      },
    ],
    invalid: [
      {
        name: 'values declared out of order',
        sql: "CREATE TYPE status AS ENUM ('pending', 'active');",
        errors: [{ line: 1, column: 1, message: 'declares "pending" out of order' }],
      },
      {
        name: 'shows the expected order',
        sql: "CREATE TYPE status AS ENUM ('b', 'a', 'c');",
        errors: [{ help: 'Declare the values in this order: a, b, c' }],
      },
      {
        name: 'explains that declaration order is comparison order',
        sql: "CREATE TYPE status AS ENUM ('b', 'a');",
        errors: [{ message: 'Comparison and ORDER BY follow declaration order' }],
      },
      {
        name: 'appending a value without a neighbour',
        sql: "ALTER TYPE status ADD VALUE 'blocked';",
        errors: [{ message: "appends to the end of the enum" }],
      },
    ],
  },
});
