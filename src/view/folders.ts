/**
 * Folders as frames — the second arrangement of the same boxes.
 *
 * The class diagram draws one box per file and lays them out by their lines.
 * That answers what talks to what, and says nothing about the structure a
 * person actually made. An IDE shows the folder tree and cannot show the
 * coupling; this draws both at once, and an edge that crosses a folder wall
 * is visible as exactly that. On the project this was argued from — a first
 * year ASP.NET solution — the root is 18 boxes and 8 lines, and all eight
 * cross a folder: Controllers to Models, Controllers to Views/Home twice,
 * Views/Shared to Models. The folders separate exactly the things that talk,
 * which is MVC, and which is the picture a tree alone cannot draw.
 *
 * Pure: paths in, a tree of frames out. No dagre, no React, no I/O — the
 * geometry is `web/src/layout.ts`'s and the arrangement is decided here, so
 * the rules below can be checked without a browser.
 */

/**
 * One folder, drawn as a frame around the boxes inside it.
 *
 * Not a `ViewNode`, and that is why `ViewGraph` is a separate type from
 * `Graph`: a folder frame is not a box, stands at no end of a line, and has
 * no symbols. It carries what `web/src/layout.ts` already takes for a
 * category frame — id, files, depth, parent — so the page hands these to
 * `layoutNodes` and `frameClusters` rather than growing a second frame
 * system beside the one that exists.
 */
export interface ViewFolder {
  /**
   * The folder's own path, project-relative — `ProsjektMVC/Views/Home`.
   *
   * Stable because it is the path and nothing else: a file joining or leaving
   * a folder does not rename it, so the frame keeps its identity across a
   * save and the page animates rather than redrawing. That is the opposite of
   * a cluster id, which embeds the member count (`src/cli/index.ts~8`) and
   * changes the moment a file joins — see *Graph model* in CLAUDE.md.
   *
   * Two things do move it, and both are honest. Renaming or moving the folder
   * is a different folder. And a collapsed chain is named by its innermost
   * folder (`ProsjektMVC/wwwroot/js`, not `wwwroot`), so the id follows the
   * chain inward when the last file directly in the inner folder goes — while
   * a file *added* to the outer one keeps the inner frame's id and simply
   * gives it an ancestor, which is the case that happens.
   */
  id: string;
  /**
   * What the frame is called: the path below the scope, with any folder
   * collapsed into this one joined on — `wwwroot/js` for a `wwwroot` holding
   * nothing but `js`. A collapsed folder must not lose its name, or the fold
   * silently deletes the thing the view is about.
   */
  label: string;
  /** 0 is an outermost frame; 1 sits inside one. `ClusterInput.depth`'s meaning. */
  depth: number;
  /** The id of the frame this one sits in, or null at the top. */
  parent: string | null;
  /**
   * Every box inside, nested ones included, sorted.
   *
   * Including the nested ones because a frame is drawn around where its
   * members landed, and an outer folder whose own files all sit in inner
   * folders would otherwise be a frame around nothing. It costs the nesting
   * nothing: `layoutNodes` registers frames outermost-first, so each box ends
   * up parented to the innermost frame that claimed it — and a frame the
   * layout declines to draw leaves its boxes to the nearest one above, which
   * is the right answer rather than a lost one.
   */
  files: string[];
  /**
   * How many files it holds, which folding does not change.
   *
   * `files` is what the frame is drawn around, and the page rewrites it as
   * subfolders shut — a swallowed file becomes the box standing for it. A
   * count read off that shrank: folding Views made ProsjektMVC say it held 5
   * files instead of 11, and no file had gone anywhere.
   */
  fileCount: number;
}

/** The frames for a set of boxes, and which frame holds each box. */
export interface FolderNesting {
  /** Outermost first, then by id — the order a consumer can register in. */
  folders: ViewFolder[];
  /**
   * Box path to the id of the innermost frame holding it. A box with no entry
   * sits in no frame: it is directly in the scope, or every folder above it
   * was collapsed or capped away.
   */
  holder: ReadonlyMap<string, string>;
}

/**
 * How many frames may nest before the folders stop being drawn. A guard, not
 * the design.
 *
 * Measured across four real projects, over every directory taken as a scope
 * and counting only the 109 that draw as a diagram at all (30 boxes or
 * fewer): 107 are 0, 1 or 2 frames deep. The two that are not are
 * webapp-h26's root at 3 — the case this feature exists for — and this
 * repository's `src/lang/fixtures` at 5, which `?tests=0` hides. So four
 * never binds on anything measured, and a depth *cap* as the primary rule was
 * refused on evidence: capping webapp-h26's root at 2 drew 6 of its 8
 * crossing edges and at 1 drew 3 of 8, which is the picture the feature was
 * asked for. What actually bounds this is `LIST_ABOVE` — a scope big enough
 * to nest deeply is a list before it is a diagram — and the cost of depth is
 * nothing next to the cost of size: on 366 boxes the first frame level costs
 * 3.5 s of dagre and the next three cost nothing measurable.
 *
 * Past it nothing below is framed, and the boxes there are not stranded: a
 * box is labelled relative to the frame that holds it, so a folder that lost
 * its frame reappears in its files' own labels (`hero/hero.component.ts`).
 */
export const MAX_FOLDER_DEPTH = 4;

/**
 * The folder frames for a set of drawn boxes, and which one holds each.
 *
 * `scope` is the directory the view is looking inside, `''` for the project
 * root. It is never a frame itself — it is the canvas — and a path that is
 * not under it is skipped rather than dragged in, so a caller may hand over
 * every box it drew and the external ones, whose directories are outside the
 * scope, fall away on their own.
 *
 * Three rules decide which folders are drawn, and each is here because
 * something measured argued for it:
 *
 * - **A folder holding one file is still a frame.** webapp-h26's
 *   `Controllers` and `Models` hold one file each and are exactly the wall
 *   the picture is about. `layoutNodes` and `frameClusters` refuse a category
 *   frame with fewer than two members on screen — right for a cluster, which
 *   is an artefact of an algorithm, and wrong for a folder, which is a
 *   statement a developer made. That rule is 5 of webapp-h26's 13 frames.
 * - **A folder holding nothing but one subfolder is collapsed into it**, its
 *   name joined onto the label — the same walk `descend` does at the scope.
 *   Honest but nearly free: it fires 3 times in 613 folders across four
 *   projects, and 0 times on the largest of them, so nothing may lean on it.
 * - **A folder holding every drawn box is not framed.** It separates nothing
 *   from nothing; it is the canvas with a border. This is what keeps a single
 *   box, or a scope whose files all sit one directory down, from drawing a
 *   rectangle that says nothing.
 */
export function nestByFolder(paths: readonly string[], scope: string): FolderNesting {
  const prefix = scope === '' ? '' : `${scope}/`;

  // The scope is the key for the root of all three, and is never emitted: it
  // is the canvas, so a frame around it would be a border around the picture.
  const direct = new Map<string, string[]>();
  const children = new Map<string, Set<string>>();
  /** Boxes under a folder, nested ones included. Only the canvas rule reads it. */
  const held = new Map<string, number>();
  let total = 0;

  for (const filePath of paths) {
    if (!filePath.startsWith(prefix)) continue;
    const segments = filePath.slice(prefix.length).split('/');
    // What is left after dropping the file's own name is the folders above it.
    segments.pop();
    total += 1;

    let folder = scope;
    for (const segment of segments) {
      const child = folder === '' ? segment : `${folder}/${segment}`;
      addTo(children, folder, child);
      held.set(child, (held.get(child) ?? 0) + 1);
      folder = child;
    }
    pushTo(direct, folder, filePath);
  }

  const framed = new Set<string>();
  for (const [folder, boxes] of held) {
    if (boxes === total) continue;
    if ((direct.get(folder)?.length ?? 0) === 0 && (children.get(folder)?.size ?? 0) < 2) continue;
    framed.add(folder);
  }

  const folders: ViewFolder[] = [];
  const holder = new Map<string, string>();

  /**
   * Depth-first from the scope. `parent` and `depth` describe the innermost
   * frame drawn so far, so an unframed folder passes both through unchanged —
   * which is what puts a collapsed chain's files in the frame below it, and a
   * capped subtree's files in the last frame above it. `carried` is the
   * segments of the folders collapsed on the way down, waiting to be joined
   * onto the next label.
   */
  const walk = (folder: string, parent: string | null, depth: number, carried: readonly string[]): void => {
    if (parent !== null) {
      for (const box of direct.get(folder) ?? []) holder.set(box, parent);
    }

    for (const child of [...(children.get(folder) ?? [])].sort()) {
      const segment = child.slice(folder === '' ? 0 : folder.length + 1);
      if (!framed.has(child) || depth >= MAX_FOLDER_DEPTH) {
        walk(child, parent, depth, [...carried, segment]);
        continue;
      }
      folders.push({
        id: child,
        label: [...carried, segment].join('/'),
        depth,
        parent,
        files: [],
        fileCount: 0,
      });
      walk(child, child, depth + 1, []);
    }
  };
  walk(scope, null, 0, []);

  // Up the parent chain rather than by prefix: after a collapse the frame's
  // ancestors are not the path's, and the two would disagree.
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const [box, innermost] of holder) {
    let at: string | null = innermost;
    while (at !== null) {
      const frame = byId.get(at);
      if (frame === undefined) break;
      frame.files.push(box);
      at = frame.parent;
    }
  }
  // The true count, taken before anything downstream rewrites `files`.
  for (const folder of folders) {
    folder.files.sort();
    folder.fileCount = folder.files.length;
  }

  folders.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  return { folders, holder };
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([value]));
  else existing.add(value);
}
