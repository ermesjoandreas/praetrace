import { isTestFile } from '../../src/view/tests.ts';

/**
 * Which file icon a path wears, and where the picture is.
 *
 * The one exception to "every icon is a Codicon" — DESIGN.md says why, and
 * it is VS Code's own exception: the editor draws its files with a separate,
 * coloured icon theme because the colour is what a reader recognises before
 * the name has been read. The pictures are the Material Icon Theme's, copied
 * into `icons/` with their licence line, and the mapping is the theme's own
 * `fileExtensions` table cut down to the languages this tool reads: the
 * extensions in `src/lang/*.ts`, and the theme's three test variants for
 * what `view/tests.ts` calls a test. It has test icons for the TypeScript
 * and JavaScript families only, so a Go or Java test wears its language's
 * icon, as it does in the editor.
 *
 * Pure, and apart from the components so `node --test` can run it: a module
 * that imported the SVGs as modules would be one Node cannot load, so the
 * URLs are bound with `new URL(…, import.meta.url)`, which Vite rewrites at
 * build time — to a data URI, under its inline limit, so twelve icons cost
 * no requests — and Node reads as a `file:` URL, which is what the test
 * checks the twelve files against.
 */

export type FileIconId =
  | 'typescript'
  | 'react_ts'
  | 'javascript'
  | 'react'
  | 'java'
  | 'go'
  | 'csharp'
  | 'rust'
  | 'python'
  | 'test-ts'
  | 'test-js'
  | 'test-jsx';

export interface FileIcon {
  id: FileIconId;
  /** The picture, for an `<img>`. */
  url: string;
  /** What the picture says, for the title — the language, and "test" when the icon is the test variant. */
  label: string;
}

/**
 * Twelve literals rather than one template: Vite rewrites only a `new URL`
 * whose path it can read at build time, and a template with a variable in
 * it would ship the whole directory as loose files instead.
 */
const URL_OF: Record<FileIconId, string> = {
  typescript: new URL('./icons/typescript.svg', import.meta.url).href,
  react_ts: new URL('./icons/react_ts.svg', import.meta.url).href,
  javascript: new URL('./icons/javascript.svg', import.meta.url).href,
  react: new URL('./icons/react.svg', import.meta.url).href,
  java: new URL('./icons/java.svg', import.meta.url).href,
  go: new URL('./icons/go.svg', import.meta.url).href,
  csharp: new URL('./icons/csharp.svg', import.meta.url).href,
  rust: new URL('./icons/rust.svg', import.meta.url).href,
  python: new URL('./icons/python.svg', import.meta.url).href,
  'test-ts': new URL('./icons/test-ts.svg', import.meta.url).href,
  'test-js': new URL('./icons/test-js.svg', import.meta.url).href,
  'test-jsx': new URL('./icons/test-jsx.svg', import.meta.url).href,
};

const LABEL_OF: Record<FileIconId, string> = {
  typescript: 'TypeScript',
  react_ts: 'TypeScript, JSX',
  javascript: 'JavaScript',
  react: 'JavaScript, JSX',
  java: 'Java',
  go: 'Go',
  csharp: 'C#',
  rust: 'Rust',
  python: 'Python',
  'test-ts': 'TypeScript test',
  'test-js': 'JavaScript test',
  'test-jsx': 'JSX test',
};

/** The extensions `src/lang/*.ts` claim, each to the theme's icon for it. */
const BY_EXTENSION: Readonly<Record<string, FileIconId>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'react_ts',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'react',
  '.java': 'java',
  '.go': 'go',
  '.cs': 'csharp',
  '.rs': 'rust',
  '.py': 'python',
};

/** The theme's test variant, where it has one. The rest keep the language's icon. */
const TEST_VARIANT: Partial<Record<FileIconId, FileIconId>> = {
  typescript: 'test-ts',
  javascript: 'test-js',
  react_ts: 'test-jsx',
  react: 'test-jsx',
};

/**
 * The icon for a path, or null when the theme has none for it — a directory,
 * a `.vue`, a README. The caller keeps whatever codicon it had for those.
 * Decided from the path alone, as the language and the test tag are, and by
 * the same test predicate, so an icon never says "test" of a file the tag
 * would not.
 */
export function fileIconFor(path: string): FileIcon | null {
  const id = fileIconIdFor(path);
  return id === null ? null : { id, url: URL_OF[id], label: LABEL_OF[id] };
}

export function fileIconIdFor(path: string): FileIconId | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const language = BY_EXTENSION[name.slice(dot)];
  if (language === undefined) return null;
  return (isTestFile(path) ? TEST_VARIANT[language] : undefined) ?? language;
}

/** Every icon, for a test that checks the twelve files are there. */
export const FILE_ICON_URLS: Readonly<Record<FileIconId, string>> = URL_OF;
