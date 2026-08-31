import { readdir } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** Shared with the watcher, so both see the same project. */
export function isIgnoredDirectoryName(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name);
}

export interface SourceFile {
  /** POSIX path relative to the root; becomes the graph node id. */
  filePath: string;
  absolutePath: string;
}

/** The initial boot scan. Every later update re-parses one file, never this. */
export async function findSourceFiles(root: string): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  await visit(root, root, found);
  found.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return found;
}

async function visit(root: string, directory: string, found: SourceFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (isIgnoredDirectoryName(entry.name)) continue;
      await visit(root, absolutePath, found);
      continue;
    }

    if (entry.isFile() && isSourceFileName(entry.name)) {
      found.push({
        absolutePath,
        filePath: path.relative(root, absolutePath).split(path.sep).join('/'),
      });
    }
  }
}

export function isSourceFileName(name: string): boolean {
  // .d.ts files only restate types that the accompanying source already declares.
  if (name.endsWith('.d.ts')) return false;
  return name.endsWith('.ts') || name.endsWith('.tsx');
}
