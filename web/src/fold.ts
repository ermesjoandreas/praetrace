import type { ViewEdge, ViewFolder, ViewGraph, ViewNode } from './api';

/**
 * Folding a folder frame back into a folder box.
 *
 * The two ways a directory is drawn are already in the engine and are the
 * same directory used opposite ways: above `GROUP_THRESHOLD` a folder *is* a
 * box standing for files too numerous to draw, and under `?folders=1` a
 * folder is a *frame* drawn around the boxes that are. So the gesture on a
 * frame is not a third state — it is the other one. A fold puts the folder
 * back as a box carrying its count; unfolding opens it again.
 *
 * It happens on the page and not in the engine because it is a person
 * looking: which folders they have shut is not a fact about the project, it
 * is where they are in reading it, and it must answer the pointer without a
 * round trip. What the fold may never do is invent coupling — every line
 * here is a line the engine drew, re-pointed at whatever now stands for its
 * ends and summed, exactly as `selectView` sums a folder box's lines.
 *
 * Pure: a view and a set of folder ids in, boxes and lines out. Nothing here
 * knows about React Flow, and the test beside it needs no browser.
 */

/** What a view looks like with some of its folders shut. */
export interface Folded {
  /** The file boxes still drawn — the ones no shut folder swallowed. */
  nodes: ViewNode[];
  /**
   * The folders drawn as a box instead of a frame, outermost first. A folder
   * inside a shut one is not here: it went into the box with its files.
   */
  boxes: ViewFolder[];
  /**
   * The frames still drawn, with their member lists re-pointed: a frame whose
   * subfolder is shut lists that folder's id where the files used to be, or
   * it would be drawn around boxes that are no longer on the canvas.
   */
  folders: ViewFolder[];
  /** The lines, re-pointed at whatever stands for each end, and summed. */
  edges: ViewEdge[];
  /** Which box each swallowed file path is now inside. Empty when nothing is shut. */
  swallowed: ReadonlyMap<string, string>;
}

/**
 * The three things a fold reads of a view: the boxes, the lines and the
 * frames. Narrower than `ViewGraph` on purpose — this is the whole of what a
 * fold may touch, and a signature that said `ViewGraph` would invite it to
 * reach for the counts and the git status it has no business rewriting.
 */
export type FoldableView = Pick<ViewGraph, 'nodes' | 'edges' | 'folders'>;

/**
 * The view with `shut` folded away — or the view itself, untouched, when
 * nothing is shut and there is nothing to do. The identity case matters: it
 * is every flat view the page has ever drawn, and it must cost nothing and
 * change nothing.
 */
export function foldFolders(view: FoldableView, shut: ReadonlySet<string>): Folded {
  const folders = view.folders ?? [];
  const noneShut = { nodes: view.nodes, boxes: [], folders, edges: view.edges, swallowed: new Map() };
  if (folders.length === 0 || shut.size === 0) return noneShut;

  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  /**
   * The outermost shut folder above this one, or itself when it is shut and
   * nothing above it is. A fold inside a fold is not two boxes: the outer one
   * stands for everything under it, which is what its count already says.
   */
  const standingFor = new Map<string, string>();
  for (const folder of folders) {
    let outermost: string | undefined;
    // Up the parent chain rather than by path prefix: after a collapsed chain
    // a frame's ancestors are not its path's, and the two would disagree.
    for (let at: string | null = folder.id, guard = 0; at !== null && guard < 64; guard += 1) {
      if (shut.has(at)) outermost = at;
      at = byId.get(at)?.parent ?? null;
    }
    if (outermost !== undefined) standingFor.set(folder.id, outermost);
  }
  if (standingFor.size === 0) return noneShut;

  /** File path -> the folder box standing for it now. */
  const swallowed = new Map<string, string>();
  const nodes: ViewNode[] = [];
  for (const node of view.nodes) {
    const home = node.inFolder === undefined ? undefined : standingFor.get(node.inFolder);
    if (home === undefined) nodes.push(node);
    else swallowed.set(node.id, home);
  }

  const stands = (id: string): string => swallowed.get(id) ?? id;

  // Only the shut folders that actually swallowed something: a folder whose
  // boxes are all off the canvas already — the filter took them, or the diff
  // never drew them — would be a box standing for nothing.
  const drawn = new Set(swallowed.values());
  const boxes = folders.filter((folder) => drawn.has(folder.id));

  const remaining = folders.filter((folder) => !standingFor.has(folder.id));
  const reframed = remaining.map((folder) => ({
    ...folder,
    // Deduped and sorted, because several of a frame's files can now be one
    // box: a frame is drawn around whatever its members are, and the same id
    // twice would say nothing but cost a comparison.
    files: [...new Set(folder.files.map(stands))].sort(),
    // How many FILES it holds, which folding does not change. `files` above is
    // what the frame is drawn around and becomes box ids as subfolders shut;
    // reading a count off it said ProsjektMVC held 5 files instead of 11 the
    // moment Views was folded, and no file had gone anywhere.
    fileCount: folder.fileCount ?? folder.files.length,
  }));

  return { nodes, boxes, folders: reframed, edges: refold(view.edges, stands), swallowed };
}

/**
 * The lines with both ends re-pointed, and the ones that now run between the
 * same two boxes summed into one.
 *
 * A line whose ends land on the same box is dropped: the coupling is real and
 * entirely inside a box that stands for both of them, so there is nothing to
 * draw it between — the rule `selectView` applies to a bundle and to a folder
 * box, applied again over a fold.
 */
function refold(edges: readonly ViewEdge[], stands: (id: string) => string): ViewEdge[] {
  const aggregated = new Map<string, ViewEdge>();
  for (const edge of edges) {
    const from = stands(edge.from);
    const to = stands(edge.to);
    if (from === to) continue;

    // The change is part of the key, not folded away: a diff draws an added
    // line and a removed line between the same pair as two lines, because the
    // graph did change twice, and one line saying "changed" would be a third
    // state nothing else in the view has.
    const key = `${from} ${edge.kind} ${to} ${edge.change ?? ''}`;
    const existing = aggregated.get(key);
    if (existing === undefined) {
      aggregated.set(key, { ...edge, from, to });
      continue;
    }
    existing.weight += edge.weight;
    // `guessed` survives only while every reference behind the line was a
    // guess, and the diamond only while every line under it agreed — the same
    // two rules the engine applies when it folds file lines into a folder's.
    if (edge.guessed !== true) delete existing.guessed;
    if (edge.roles !== undefined) existing.roles = [...(existing.roles ?? []), ...edge.roles];
    if (existing.ownership !== edge.ownership) delete existing.ownership;
  }
  return [...aggregated.values()];
}
