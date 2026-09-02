import type { ProjectFacts } from '../lang/types.js';
import type { ParsedFile } from '../parser/types.js';
import type { ParserPool } from '../parser/pool.js';
import { gatherFacts } from './facts.js';
import { findSourceFiles } from './walk.js';

export interface ScanResult {
  parsed: ParsedFile[];
  /** One message per file that could not be parsed; the rest still scanned. */
  failures: string[];
  /**
   * What no single file could know: tsconfig aliases, the packages of a
   * monorepo, the Go module path. Read once here because it comes from files
   * the graph never parses, and handed to the store, which owns resolution.
   */
  facts: ProjectFacts;
}

/**
 * The initial boot scan: walk the root and parse every source file through the
 * pool. The only whole-project pass there is — every later update re-parses a
 * single file.
 */
export async function scanProject(pool: ParserPool, root: string): Promise<ScanResult> {
  const sourceFiles = await findSourceFiles(root);

  // The facts are read on this thread while the workers parse, so the
  // configuration files cost nothing the parse was not already waiting for.
  const [facts, results] = await Promise.all([
    gatherFacts(root, sourceFiles.map((file) => file.filePath)),
    Promise.allSettled(sourceFiles.map((file) => pool.parse(file.filePath, file.absolutePath))),
  ]);

  const parsed: ParsedFile[] = [];
  const failures: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') parsed.push(result.value);
    else failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
  }

  return { parsed, failures, facts };
}
