import { defineRule } from '../define-rule.ts';

export interface IdentifierTooLongOptions {
  /** Postgres truncates at NAMEDATALEN - 1, which is 63 in a stock build. */
  maxLength: number;
}

/** Fixture identifiers sitting exactly at, and one past, the default 63-char limit. */
const atLimit = 'a'.repeat(63);
const overLimit = 'a'.repeat(64);

export const identifierTooLong = defineRule<IdentifierTooLongOptions>({
  name: 'identifier-too-long',
  meta: {
    description: 'Keep identifiers within the Postgres length limit.',
    rationale:
      'Postgres silently truncates identifiers past NAMEDATALEN. Two names that differ only ' +
      'after the cutoff collapse into one, and the migration fails on a duplicate that looks ' +
      'nothing like a duplicate in the source.',
    defaultSeverity: 'error',
    defaultOptions: { maxLength: 63 },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      if (!Number.isInteger(options.maxLength) || options.maxLength < 1) {
        throw new TypeError(
          `pgward: rule "identifier-too-long" option maxLength must be a positive integer, ` +
            `got ${String(options.maxLength)}`,
        );
      }
      return options;
    },
  },
  create(context) {
    const { maxLength } = context.options;

    return {
      // The AST is no help here: by the time a name reaches it, Postgres has
      // already truncated it to the limit — which is precisely the damage this
      // rule reports. The scanner keeps the identifier as written.
      'file:exit'(source) {
        const reported = new Set<string>();

        for (const token of source.tokens) {
          if (token.kind !== 'IDENT') continue;

          const identifier = unquote(token.text);
          if (identifier.length <= maxLength) continue;
          if (reported.has(identifier)) continue;
          reported.add(identifier);

          const statement = source.statementAt(token.start);
          context.report({
            ...(statement ? { statement } : {}),
            offset: token.start,
            endOffset: token.end,
            message: `Identifier "${identifier}" is ${identifier.length} characters; Postgres truncates at ${maxLength}, so it silently becomes "${identifier.slice(0, maxLength)}".`,
            help: `Shorten it to ${maxLength} characters or fewer.`,
          });
        }
      },
    };
  },
  tests: {
    valid: [
      `CREATE TABLE ${atLimit} (x int);`,
      `CREATE TABLE t (${atLimit} int);`,
      'CREATE TABLE t (x int);',
      {
        name: 'a long string literal is not an identifier',
        sql: `CREATE TABLE t (x text DEFAULT '${overLimit}');`,
      },
      {
        name: 'a higher limit',
        sql: `CREATE TABLE ${overLimit} (x int);`,
        options: { maxLength: 100 },
      },
    ],
    invalid: [
      {
        name: 'a table name past the limit',
        sql: `CREATE TABLE ${overLimit} (x int);`,
        errors: [{ line: 1, column: 14, message: `Identifier "${overLimit}" is 64 characters` }],
      },
      {
        name: 'shows what it silently becomes',
        sql: `CREATE TABLE ${overLimit} (x int);`,
        errors: [{ message: `silently becomes "${atLimit}"` }],
      },
      {
        name: 'a column name',
        sql: `CREATE TABLE t (${overLimit} int);`,
        errors: 1,
      },
      {
        name: 'an index name',
        sql: `CREATE INDEX CONCURRENTLY ${overLimit} ON t (a);`,
        errors: 1,
      },
      {
        name: 'a constraint name',
        sql: `ALTER TABLE t ADD CONSTRAINT ${overLimit} CHECK (a > 0);`,
        errors: 1,
      },
      {
        name: 'a rename target',
        sql: `ALTER TABLE t RENAME TO ${overLimit};`,
        errors: 1,
      },
      {
        name: 'a schema name',
        sql: `CREATE SCHEMA ${overLimit};`,
        errors: 1,
      },
      {
        name: 'the target of an ALTER TABLE',
        sql: `ALTER TABLE ${overLimit} ADD COLUMN c int;`,
        errors: 1,
      },
      {
        name: 'a quoted identifier, measured without its delimiters',
        sql: `CREATE TABLE "${overLimit}" (x int);`,
        errors: [{ message: `is 64 characters` }],
      },
      {
        name: 'a lower limit catches shorter names',
        sql: 'CREATE TABLE abcdefghij (x int);',
        options: { maxLength: 5 },
        errors: 1,
      },
      {
        name: 'a repeated name is reported once',
        sql: `CREATE TABLE ${overLimit} (x int);\nCREATE INDEX CONCURRENTLY i ON ${overLimit} (x);`,
        errors: 1,
      },
      {
        name: 'attributed to the statement it appears in, so suppressions work',
        sql: `SELECT 1;\nCREATE TABLE ${overLimit} (x int);`,
        errors: [{ line: 2 }],
      },
    ],
  },
});

/** Strips the delimiters from a quoted identifier and unescapes doubled quotes. */
function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replaceAll('""', '"');
  }
  return text;
}
