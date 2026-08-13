import { PgParser, unwrapParseResult, unwrapScanResult } from '@supabase/pg-parser';

import { buildSourceFile } from '../../src/source.ts';
import type { SourceFile } from '../../src/types.ts';

const parser = new PgParser({ version: 17 });

export interface MakeSourceOptions {
  filename?: string | null;
  implicitTransaction?: boolean;
  implicitTransactionDefault?: boolean;
}

/** Parses SQL and builds a `SourceFile`, the way the linter does internally. */
export async function makeSource(
  sql: string,
  options: MakeSourceOptions = {},
): Promise<SourceFile> {
  const tree = await unwrapParseResult(parser.parse(sql));
  const tokens = await unwrapScanResult(parser.scan(sql));

  return buildSourceFile({
    sql,
    filename: options.filename ?? null,
    stmts: tree.stmts ?? [],
    tokens,
    implicitTransactionDefault: options.implicitTransactionDefault ?? true,
    implicitTransaction: options.implicitTransaction,
  });
}
