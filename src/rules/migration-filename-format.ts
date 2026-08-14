import { defineRule } from '../define-rule.ts';

export interface MigrationFilenameFormatOptions {
  /**
   * A regular expression the filename must match, tested against the name
   * exactly as it was handed to the linter. Pass paths relative to your
   * migrations directory and the pattern can pin the directory too, which is
   * how a project with more than one convention keeps them apart:
   * `'^(migrations/V\\d+__\\w+|repeatable/R__\\w+)\\.sql$'`.
   *
   * Null — the default — turns the rule off, since there is no naming
   * convention every runner agrees on.
   */
  pattern: string | null;
}

export const migrationFilenameFormat = defineRule<MigrationFilenameFormatOptions>({
  name: 'migration-filename-format',
  meta: {
    description: 'Require migration filenames to match a pattern.',
    rationale:
      'Migration runners read version, ordering and description out of the filename, so a name ' +
      'that does not parse is applied in the wrong order or skipped outright. The kinder ' +
      'runners refuse the whole deploy instead, which is still a deploy that fails on something ' +
      'a rename would have caught.',
    defaultSeverity: 'error',
    defaultOptions: { pattern: null },
    normalizeOptions(raw, defaults) {
      const options = { ...defaults, ...(raw as object) };
      if (options.pattern !== null) {
        // Compile here so a bad pattern fails at construction rather than on
        // the first file that trips it.
        try {
          new RegExp(options.pattern, 'u');
        } catch (cause) {
          throw new TypeError(
            `pgward: rule "migration-filename-format" option pattern is not a valid regular ` +
              `expression: ${(cause as Error).message}`,
          );
        }
      }
      return options;
    },
  },
  create(context) {
    const { options, source } = context;

    return {
      file() {
        // A caller that supplies no filename has nothing for this to check.
        if (options.pattern === null || source.filename === null) return;

        if (new RegExp(options.pattern, 'u').test(source.filename)) return;

        context.report({
          // The filename is what is wrong, and it has no position in the SQL.
          offset: 0,
          message: 'This filename does not match the required migration naming format.',
          help: `Rename it to match ${options.pattern}.`,
        });
      },
    };
  },
  tests: {
    valid: [
      {
        name: 'inert until a pattern is configured',
        sql: 'SELECT 1;',
        filename: 'whatever-you-like.sql',
      },
      {
        name: 'a matching filename',
        sql: 'SELECT 1;',
        filename: 'V20260812.143012__add_index.sql',
        options: { pattern: '^V\\d{8}\\.\\d{6}__[a-z0-9_]+\\.sql$' },
      },
      {
        name: 'the pattern can pin the directory',
        sql: 'SELECT 1;',
        filename: 'migrations/V20260812.143012__add_index.sql',
        options: { pattern: '^migrations/V\\d{8}\\.\\d{6}__[a-z0-9_]+\\.sql$' },
      },
      {
        name: 'alternation covers more than one convention',
        sql: 'SELECT 1;',
        filename: 'procedures/R__0000_is_valid_email.sql',
        options: { pattern: '^(migrations/V\\d+__\\w+|procedures/R__\\w+)\\.sql$' },
      },
      {
        name: 'no filename to check',
        sql: 'SELECT 1;',
        options: { pattern: '^V\\d+__\\w+\\.sql$' },
      },
    ],
    invalid: [
      {
        name: 'a filename that does not match',
        sql: 'SELECT 1;',
        filename: 'add_index.sql',
        options: { pattern: '^V\\d{8}\\.\\d{6}__[a-z0-9_]+\\.sql$' },
        errors: [{ line: 1, column: 1, message: 'does not match the required migration naming' }],
      },
      {
        name: 'the right shape in the wrong directory',
        sql: 'SELECT 1;',
        filename: 'scratch/V20260812.143012__add_index.sql',
        options: { pattern: '^migrations/V\\d{8}\\.\\d{6}__[a-z0-9_]+\\.sql$' },
        errors: 1,
      },
      {
        name: 'an uppercase description',
        sql: 'SELECT 1;',
        filename: 'V20260812.143012__addIndex.sql',
        options: { pattern: '^V\\d{8}\\.\\d{6}__[a-z0-9_]+\\.sql$' },
        errors: 1,
      },
    ],
  },
});
