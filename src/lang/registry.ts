import path from 'node:path';
import type { Language, LanguageId } from './types.js';

import { typescript } from './typescript.js';
import { javascript } from './javascript.js';
import { java } from './java.js';
import { go } from './go.js';
import { csharp } from './csharp.js';
import { rust } from './rust.js';
import { python } from './python.js';
import { kotlin } from './kotlin.js';
import { php } from './php.js';
import { cpp } from './cpp.js';
import { vue } from './vue.js';
import { svelte } from './svelte.js';
import { razor } from './razor.js';

/**
 * Every language the tool can read, and the one place that decides which file
 * belongs to which.
 *
 * Listed rather than discovered: a registry that scanned a directory would make
 * the set of languages a runtime question, and "why is this file not drawn"
 * would become a question about the filesystem instead of about this list.
 */
export const LANGUAGES: readonly Language[] = [
  typescript,
  javascript,
  java,
  go,
  csharp,
  rust,
  python,
  kotlin,
  php,
  cpp,
  vue,
  svelte,
  razor,
];

/**
 * `angular` is deliberately not in that list, and `.html` is deliberately not an
 * extension here.
 *
 * An `.html` file is a view only when a component's `templateUrl` names it, and
 * an extension rule cannot tell the two apart: angular/components holds 678 of
 * them, of which 19 are host pages and dgeni documentation templates that reach
 * nothing. Claiming the extension would draw all 678 and 19 would arrive as
 * boxes with no coupling — wrong in a way that reads as authoritative.
 *
 * `src/lang/angular.ts` is written and tested; what it still needs is a second
 * pass in `src/project/scan.ts` that reads the templates the first pass named.
 * Registering it before that pass exists would put a `templateUrl` in every
 * component's reference list with no file to land on, and draw not one box.
 */

const byExtension = new Map<string, Language>();
for (const language of LANGUAGES) {
  for (const extension of language.extensions) byExtension.set(extension, language);
}

const byId = new Map(LANGUAGES.map((language) => [language.id, language]));

/**
 * `.d.ts` is deliberately absent from the extension table.
 *
 * It restates what the accompanying source declares, so drawing both would
 * double every symbol in the project. But in a types-only library the `.d.ts`
 * files *are* the source — type-fest is 221 of them and resolved 0 of 487
 * imports before this — so the rule is not "skip .d.ts", it is "skip a .d.ts
 * that has a sibling implementing it". That test needs the file list, so it
 * lives in walk.ts; this only reports the language.
 */
export function languageFor(filePath: string): Language | null {
  const base = path.posix.basename(filePath).toLowerCase();
  // `.d.ts` and `.d.mts` are TypeScript, whatever walk.ts decides to do with them.
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) {
    return typescript;
  }
  const extension = base.slice(base.lastIndexOf('.'));
  return byExtension.get(extension) ?? null;
}

export function languageById(id: LanguageId): Language | null {
  return byId.get(id) ?? null;
}

/** Every extension any language claims, for the scan's file predicate. */
export function knownExtensions(): readonly string[] {
  return [...byExtension.keys()];
}
