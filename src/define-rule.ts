import type { Rule } from './types.ts';

/**
 * Identity helper that pins a rule's option type so `create`'s context is
 * inferred without writing the generic out by hand.
 *
 * ```ts
 * const banTempTables = defineRule({
 *   name: 'ban-temp-tables',
 *   meta: { description: '…', defaultSeverity: 'error', defaultOptions: { allow: [] } },
 *   create(context) {
 *     return {
 *       CreateStmt(node, path) {
 *         if (node.relation?.relpersistence !== 't') return;
 *         context.report({ statement: path.statement, message: 'No temp tables.' });
 *       },
 *     };
 *   },
 * });
 * ```
 */
export function defineRule<Options>(rule: Rule<Options>): Rule<Options> {
  return rule;
}
