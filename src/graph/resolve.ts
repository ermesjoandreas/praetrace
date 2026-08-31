import path from 'node:path';

/**
 * Map a module specifier onto a file in the scanned set. Pure: it is given every
 * known file rather than touching the filesystem, which keeps the graph layer
 * testable and free of I/O.
 *
 * Bare specifiers (`react`, `node:fs`) and anything outside the root resolve to
 * null, and the edge is dropped — the MVP graphs the project, not its
 * dependencies.
 */
export function resolveImport(
  fromFilePath: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFilePath), specifier));

  for (const candidate of candidatesFor(base)) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function candidatesFor(base: string): string[] {
  if (base.endsWith('.ts') || base.endsWith('.tsx')) return [base];

  // NodeNext ESM writes `./foo.js` for what is `./foo.ts` on disk.
  const jsExtension = /\.(js|jsx|mjs|cjs)$/.exec(base);
  if (jsExtension) {
    const stem = base.slice(0, -jsExtension[0].length);
    return [`${stem}.ts`, `${stem}.tsx`];
  }

  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
}
