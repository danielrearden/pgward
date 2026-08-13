import { defineRule } from '../define-rule.ts';

/**
 * The linter reports parse failures and malformed suppression comments under
 * these ids so their severity is configurable like any other rule. They carry
 * no visitors — the linter emits their diagnostics directly.
 */

export const parseError = defineRule<void>({
  name: 'parse-error',
  meta: {
    description: 'The file could not be parsed as Postgres SQL.',
    rationale:
      'An unparseable file is not a clean file. Every other rule silently passes on it, ' +
      'so the failure has to surface as a diagnostic of its own.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create: () => ({}),
});

export const invalidSuppression = defineRule<void>({
  name: 'invalid-suppression',
  meta: {
    description: 'A pgward-ignore comment was malformed and had no effect.',
    rationale:
      'A suppression that silently does nothing is worse than no suppression: the author ' +
      'believes a rule is waived and the reviewer sees a justification that never applied.',
    defaultSeverity: 'error',
    defaultOptions: undefined,
  },
  create: () => ({}),
});
