/**
 * Which edges mean one symbol reaches another.
 *
 * `contains` and `imports` are left out on purpose. They are structural: a
 * symbol belongs to its file and a file mentions another, and neither says the
 * code on one end runs, extends or holds the code on the other.
 *
 * It lives here, in `graph/`, because both sides of the question ask it and
 * neither may import the other. `view/detail.ts` answers it for the panel and
 * is pure; `project/hook.ts` answers it for the sentence the agent reads after
 * an edit and is not. A set kept in `view/` would put the event collector
 * behind the rendering layer, and one kept in `project/` would pull the
 * filesystem into a pure module — the coupling `git/types.ts` exists to
 * prevent. `graph/` is under both, and both already import its types.
 */

import type { EdgeKind } from './types.js';

/** The edge kinds in `REACHES`, as a type, so a relation can carry which one. */
export type ReachingEdgeKind = Extract<
  EdgeKind,
  'calls' | 'extends' | 'implements' | 'associates'
>;

export const REACHES: ReadonlySet<EdgeKind> = new Set<ReachingEdgeKind>([
  'calls',
  'extends',
  'implements',
  'associates',
]);
