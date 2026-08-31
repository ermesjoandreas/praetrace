import type { ParsedFile } from '../parser/types.js';
import type { ParserPool } from '../parser/pool.js';
import { findSourceFiles } from './walk.js';

export interface ScanResult {
  parsed: ParsedFile[];
  /** One message per file that could not be parsed; the rest still scanned. */
  failures: string[];
}

/**
 * The initial boot scan: walk the root and parse every source file through the
 * pool. The only whole-project pass there is — every later update re-parses a
 * single file.
 */
export async function scanProject(pool: ParserPool, root: string): Promise<ScanResult> {
  const sourceFiles = await findSourceFiles(root);
  const results = await Promise.allSettled(
    sourceFiles.map((file) => pool.parse(file.filePath, file.absolutePath)),
  );

  const parsed: ParsedFile[] = [];
  const failures: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') parsed.push(result.value);
    else failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
  }

  return { parsed, failures };
}
