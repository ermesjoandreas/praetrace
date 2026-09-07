import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ChangedFile, EntryPoint, GitFileStatus, NamedCategory, OverviewReply, Root } from './api';
import { fileIconFor } from './fileicons';
import { FOLD_MANIFEST_AT, changesSummary, manifestGroups, splitPath, type EntryGroup } from './frontpage';
import { relativeTime } from './GitGraph';
import { LIST_ROW, useListKeys } from './listkeys';
import { holdOrder } from './listrows';
import { Section } from './Section';
import { DiffCount, diffTitle, type DiffRow } from './SourceControl';

/**
 * The front page: what `/` shows instead of the root diagram.
 *
 * A map of everything never works. astrupdata's root is twelve boxes and
 * fine; one level in, `lib` is 106 boxes and 427 lines laid out as a strip
 * zoomed to a smear, and the clustering's "Terminal App, 254 files, 98%" is
 * the algorithm saying everything imports everything. Sourcetrail's answer
 * after years of trying is the one taken here: never land in the big graph.
 * Land on what the project is, where it starts, what it is made of, what
 * changed and what the agent is doing — and make every line a link into the
 * one view that does work, a file and its neighbours. A number that leads
 * nowhere is furniture, and the two that lead nowhere here — a language, a
 * root past the twelfth — say so in their titles rather than pretend.
 *
 * Every list is the engine's (`src/view/overview.ts`, one fetch). This only
 * decides where a row leads: a file to `?focus=`, a category to
 * `?category=`, the changes to `?changed=1`, the unnamed to the Categories
 * section. It covers the canvas the way the welcome screen does — never the
 * window — so the bars, the breadcrumb and the status bar stay reachable,
 * and it is drawn in the side bars' own shape: 22px section headers that
 * fold, 22px rows, one Tab stop walked with the arrows.
 *
 * Mark, do not move: a refetch after a save re-sorts nothing under the
 * reader's cursor. The roots and the changed files hold the order they were
 * first read in, a row that changed is marked where it stands, and only a
 * new project — or a new commit — sorts afresh. See `holdOrder`.
 */

interface OverviewProps {
  /** The engine's answer, or null while it is being read or was refused. */
  overview: OverviewReply | null;
  /** Why there is none: the server's own words when it refused, or the failure. */
  error: string | null;
  /** The commit the page is frozen at, or null for now. */
  at: string | null;
  /**
   * Boxes the root diagram draws, from the root view the page holds anyway:
   * the count on the "Draw the whole project" row. Null until it has loaded.
   */
  rootBoxes: number | null;
  /** Which base the changes are against, as the status bar names it. */
  baseLabel: string;
  /** Files touched by the last save, and files the agent just asked about: the two pulses. */
  changed: ReadonlySet<string>;
  queried: ReadonlySet<string>;
  /** A file and its neighbours. Every file row leads here. */
  onFocus: (file: string) => void;
  /**
   * Whether the graph holds a file box for a path — the root view's files,
   * which under the front page is the whole project. The agent's row leads
   * to `?focus=` only for one it does: `describe_file` on a directory names
   * a path with a slash in it and no file to focus on, and the row used to
   * link it to a 404.
   */
  inGraph: (path: string) => boolean;
  /** A category's files, wherever they sit. */
  onCategory: (storedId: string) => void;
  /** The Categories section in the left bar, where names are given. */
  onCategories: () => void;
  /** Only what differs from the base: the root diagram under `?changed=1`. */
  onChanges: () => void;
  /**
   * The structural diff's numbers, or why there are none — the same row the
   * Source Control section draws, so the two cannot disagree about a count.
   */
  diff: DiffRow;
  /** What differs in the shape: added boxes, ghosts, changed lines — `?diff=`. */
  onDiff: () => void;
  /** The root diagram, drawn whatever its size. */
  onDrawAll: () => void;
}

/** The letters VS Code's own views use; the box and the Changes list use the same. */
const GIT_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
};

/**
 * The order a list is shown in, held across refetches of the same page.
 *
 * `scope` is what a page is — the project and the commit — and a change to
 * it starts the hold afresh; `ids` is the order the engine would give now.
 * Written from inside the memo because the held order is an input to the
 * next computation and nothing else: idempotent, which is what lets
 * StrictMode run it twice.
 */
function useHeldOrder(scope: string, ids: readonly string[]): string[] {
  const held = useRef<{ scope: string; order: string[] } | null>(null);
  return useMemo(() => {
    const order = holdOrder(held.current?.scope === scope ? held.current.order : null, ids);
    held.current = { scope, order };
    return order;
  }, [scope, ids]);
}

function plural(count: number, word: string, words = `${word}s`): string {
  return `${count} ${count === 1 ? word : words}`;
}

export function Overview({
  overview,
  error,
  at,
  rootBoxes,
  baseLabel,
  changed,
  queried,
  onFocus,
  inGraph,
  onCategory,
  onCategories,
  onChanges,
  diff,
  onDiff,
  onDrawAll,
}: OverviewProps) {
  const keys = useListKeys();
  const [now, setNow] = useState(() => Date.now());
  /** Which manifest groups have been opened, when they fold at all. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  // "4 minutes ago" has to keep moving on its own; nothing else re-renders
  // this page between one agent call and the next.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const scope = `${overview?.root ?? ''}\n${at ?? ''}`;
  const groups = useMemo(() => manifestGroups(overview?.entryPoints.manifest ?? []), [overview]);
  const rootIds = useMemo(() => (overview?.entryPoints.roots ?? []).map((root) => root.file), [overview]);
  const rootOrder = useHeldOrder(scope, rootIds);
  const changeIds = useMemo(() => (overview?.changes?.files ?? []).map((file) => file.file), [overview]);
  const changeOrder = useHeldOrder(scope, changeIds);

  const roots = useMemo(() => {
    const byFile = new Map((overview?.entryPoints.roots ?? []).map((root) => [root.file, root]));
    return rootOrder.flatMap((file) => {
      const root = byFile.get(file);
      return root === undefined ? [] : [root];
    });
  }, [overview, rootOrder]);
  const changedFiles = useMemo(() => {
    const byFile = new Map((overview?.changes?.files ?? []).map((file) => [file.file, file]));
    return changeOrder.flatMap((file) => {
      const one = byFile.get(file);
      return one === undefined ? [] : [one];
    });
  }, [overview, changeOrder]);

  const manifestCount = overview?.entryPoints.manifest.length ?? 0;
  const folded = manifestCount >= FOLD_MANIFEST_AT;
  /**
   * Whether the changes-only diagram has anything to draw: a listed file
   * with a box, or files past the ones listed, which may have one. Only the
   * first few are named, so a longer list is given the benefit of the doubt.
   */
  const drawableChanges =
    overview?.changes !== null &&
    overview !== null &&
    (overview.changes.files.some((file) => file.inGraph) || overview.changes.total > overview.changes.files.length);

  /** The marks a file row wears: the file system's amber, the agent's blue. */
  const marksOf = (file: string): string =>
    `${changed.has(file) ? ' front-row-changed' : ''}${queried.has(file) ? ' front-row-queried' : ''}`;

  const fileRow = (
    file: string,
    key: string,
    extra: { why?: string; detail?: string; count?: { value: number; title: string } },
    title: string,
    depth = 0,
  ) => {
    const { name, where } = splitPath(file);
    // The file icon, as the explorer draws one; the codicon for a file the
    // theme has no picture for.
    const icon = fileIconFor(file);
    return (
      <button
        key={key}
        type="button"
        {...LIST_ROW}
        className={`front-row front-link front-depth-${depth}${marksOf(file)}`}
        title={title}
        onClick={() => onFocus(file)}
      >
        {icon !== null ? (
          <img className="file-icon" src={icon.url} alt="" title={icon.label} draggable={false} />
        ) : (
          <i className="codicon codicon-file" aria-hidden="true" />
        )}
        <span className="front-name">{name}</span>
        <span className="front-where">{where}</span>
        {extra.detail !== undefined && <span className="front-why">{extra.detail}</span>}
        {extra.why !== undefined && <span className="front-why">{extra.why}</span>}
        {extra.count !== undefined && (
          <span className="front-count" title={extra.count.title}>
            {extra.count.value}
          </span>
        )}
      </button>
    );
  };

  const drawRow = (
    <button
      type="button"
      {...LIST_ROW}
      className="front-row front-link"
      onClick={onDrawAll}
      title={
        at === null
          ? 'The root as a class diagram: directories as boxes, the imports between them as lines. Drawn whatever its size — above 30 boxes a directory is otherwise listed.'
          : `The root as of ${at.slice(0, 7)}, as a class diagram — drawn whatever its size.`
      }
    >
      <i className="codicon codicon-type-hierarchy" aria-hidden="true" />
      <span className="front-name-ui">
        {at === null ? 'Draw the whole project' : `Draw the whole project as of ${at.slice(0, 7)}`}
      </span>
      {rootBoxes !== null && <span className="front-why">{plural(rootBoxes, 'box', 'boxes')}</span>}
    </button>
  );

  // The whole page is one list: every row wears LIST_ROW, so Tab arrives once
  // and the arrows walk from the first entry point to the agent's last call.
  return (
    <div className="front" ref={keys.ref} onKeyDown={keys.onKeyDown} onFocus={keys.onFocus}>
      <div className="front-inner">
        {overview === null ? (
          // Nothing yet, or nothing at all. The one row that is still true
          // either way is the diagram, so it is offered under the reason.
          <Section
            title={at === null ? 'Front page' : `Front page · at ${at.slice(0, 7)}`}
            className="front-section front-section-project"
          >
            {error === null ? (
              <p className="front-note">Reading the project…</p>
            ) : (
              // The tool's own gap wears the warning colour, as it does in
              // the status bar: this page is not drawn, and the row says why.
              <p className="front-note front-warn" title={error}>
                <i className="codicon codicon-warning" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
            {drawRow}
          </Section>
        ) : (
          <>
            <Section
              title={overview.name}
              className="front-section front-section-project"
              status={<span className="front-status">{plural(overview.project.files, 'file')}</span>}
            >
              <div className="front-row" title={overview.root}>
                <span className="front-label">Root</span>
                <span className="front-value">{overview.root}</span>
              </div>
              <div className="front-row" title="Source files in the graph, and how many of them are tests, fixtures or stories — decided from the path">
                <span className="front-label">Files</span>
                <span className="front-value">
                  {overview.project.files}
                  {overview.project.tests > 0 && (
                    <span className="front-why"> · {plural(overview.project.tests, 'test')}</span>
                  )}
                </span>
              </div>
              <div
                className="front-row"
                // No link, and a div like Root and Files above it: there is no
                // view by language — the list has no column for one, and the
                // icon on every file row is where a language is read — so a
                // row that led to the same twelve folders would be furniture.
                // Measured: body colour, `cursor: auto`, no hover fill, the
                // same as the two rows above it. The title says so too.
                title="What codemap parsed here, biggest first. Detected from the files, never declared. Information only: there is no view by language — the file icon on every row is where a language is read."
              >
                <span className="front-label">Languages</span>
                <span className="front-value">
                  {overview.project.languages.length === 0
                    ? 'none found'
                    : overview.project.languages.map((language) => `${language.label} ${language.files}`).join(' · ')}
                </span>
              </div>
              {overview.project.unreadable.length > 0 && (
                <div
                  className="front-row"
                  title="Source in a language codemap does not read. Nothing these files declare or import is in the graph, so a box with no lines may be coupled through them."
                >
                  <span className="front-label">Cannot read</span>
                  <span className="front-value front-warn">
                    <i className="codicon codicon-warning" aria-hidden="true" />
                    {overview.project.unreadable.map((kind) => `${kind.extension} ×${kind.files}`).join(' · ')}
                  </span>
                </div>
              )}
              {overview.project.parseErrors > 0 && (
                <div
                  className="front-row"
                  title="Files tree-sitter recovered a syntax error in; each lost symbols. The status bar lists them."
                >
                  <span className="front-label">Syntax errors</span>
                  <span className="front-value front-warn">
                    <i className="codicon codicon-warning" aria-hidden="true" />
                    {plural(overview.project.parseErrors, 'file')}
                  </span>
                </div>
              )}
              {drawRow}
            </Section>

            <Section
              title="Entry points"
              className="front-section front-section-entries"
              status={
                <span className="front-status" title="Named by the manifests, and found by the graph">
                  {manifestCount + overview.entryPoints.rootsTotal}
                </span>
              }
            >
              {manifestCount === 0 && overview.entryPoints.rootsTotal === 0 && (
                <p className="front-note">
                  None found: no manifest names a start, and every source file is imported by another.
                </p>
              )}
              {manifestCount > 0 && (
                <>
                  <h3
                    className="front-subtitle"
                    title="package.json main, bin, exports and the scripts that run a file of the project's own; a Next project's pages, routes and layouts; Cargo's [[bin]]; a Go func main; Python's __main__.py. Read once when the project was opened."
                  >
                    Named by the manifests
                  </h3>
                  {groups.map((group) => entryGroup(group, folded, open, setOpen, fileRow))}
                </>
              )}
              {overview.entryPoints.rootsTotal > 0 && (
                <>
                  <h3
                    className="front-subtitle"
                    title="Source files no other source file imports, tests and declaration files aside. A start, or dead code — the graph cannot tell which. Most-importing first, because a root that pulls in twenty files reads as a program."
                  >
                    Found by the graph
                    {/* Where a section puts its status, and not a row under
                        the list: "and 45 more" stood there as a row nothing
                        opened, and a row that leads nowhere is furniture.
                        Nothing lists the rest — past forty files the root
                        is drawn as directories, and a list of those sorted
                        by lines in is a list of directories, not of these —
                        so the number is said once, as a number. */}
                    {overview.entryPoints.rootsTotal > roots.length && (
                      <span
                        className="front-subcount"
                        title={`The ${roots.length} that import most, of ${overview.entryPoints.rootsTotal}. No view lists the rest.`}
                      >
                        {roots.length} of {overview.entryPoints.rootsTotal}
                      </span>
                    )}
                  </h3>
                  {roots.map((root) => rootRow(root, fileRow))}
                </>
              )}
            </Section>

            <Section
              title="Categories"
              className="front-section front-section-categories"
              status={
                <span className="front-status">
                  {overview.categories.named.length} named
                  {overview.categories.unnamed > 0 ? ` · ${overview.categories.unnamed} unnamed` : ''}
                </span>
              }
            >
              {overview.categories.named.length === 0 && overview.categories.unnamed === 0 && (
                <p className="front-note">None found yet: the import graph has no group of files that lean on each other more than on the rest.</p>
              )}
              {overview.categories.named.map((category) => categoryRow(category, onCategory))}
              {overview.categories.unnamed > 0 && (
                <button
                  type="button"
                  {...LIST_ROW}
                  className="front-row front-link"
                  onClick={onCategories}
                  title="Groups the import graph found that nobody has named. The Categories section is where a name is given — by you, or by asking a model with its lightbulb; the model never decides who belongs."
                >
                  <i className="codicon codicon-package" aria-hidden="true" />
                  <span className="front-name-ui">{plural(overview.categories.unnamed, 'unnamed category')}</span>
                  <span className="front-why">name them in Categories</span>
                </button>
              )}
              {overview.categories.orphans > 0 && (
                <button
                  type="button"
                  {...LIST_ROW}
                  className="front-row front-link"
                  onClick={onCategories}
                  title="Names in .codemap/groups.json that match no group the graph finds now. Listed under the Categories section, each with a delete."
                >
                  <i className="codicon codicon-package" aria-hidden="true" />
                  <span className="front-name-ui">
                    {overview.categories.orphans} stored, matching nothing
                  </span>
                </button>
              )}
            </Section>

            <Section
              title={overview.changes === null ? 'Changes' : `Changes against ${baseLabel || overview.changes.base}`}
              className="front-section front-section-changes"
              status={
                overview.changes === null || overview.changes.total === 0 ? undefined : (
                  <span className="front-status front-lines" title="Lines added and deleted against the base, over every file git can count">
                    {overview.changes.lines.added > 0 && <span className="front-added">+{overview.changes.lines.added}</span>}
                    {overview.changes.lines.deleted > 0 && <span className="front-deleted">−{overview.changes.lines.deleted}</span>}
                  </span>
                )
              }
            >
              {overview.changes === null ? (
                <p className="front-note">Not a git repository, so there is nothing to compare against.</p>
              ) : overview.changes.total === 0 ? (
                <p className="front-note">No changes against {overview.changes.base}.</p>
              ) : (
                <>
                  {/* Greyed when every changed file is listed here and none
                      has a box — a settings file, a README — because the
                      diagram it leads to would be "Nothing to show here",
                      which is a worse answer than the letter on the row. */}
                  <button
                    type="button"
                    {...LIST_ROW}
                    className={`front-row front-link${drawableChanges ? '' : ' front-row-off'}`}
                    aria-disabled={!drawableChanges}
                    onClick={drawableChanges ? onChanges : undefined}
                    title={
                      drawableChanges
                        ? `Draw only what differs from ${overview.changes.base}: the root diagram under the "changes only" filter. Deleted files have no box; a changed README is a change and not a box.`
                        : 'None of these is in the graph — nothing they declare or import is read — so there is no box to draw for them.'
                    }
                  >
                    <i className="codicon codicon-diff-multiple" aria-hidden="true" />
                    <span className="front-name-ui">{plural(overview.changes.total, 'changed file')}</span>
                    <span className="front-why">{changesSummary(overview.changes.byStatus)}</span>
                  </button>
                  {changedFiles.map((file) => changeRow(file, marksOf(file.file), onFocus))}
                  {overview.changes.total > changedFiles.length && (
                    <button
                      type="button"
                      {...LIST_ROW}
                      className="front-row front-link front-depth-1"
                      onClick={onChanges}
                      title="Every changed file, drawn: the root diagram under the changes-only filter"
                    >
                      <span className="front-name-ui front-more">and {overview.changes.total - changedFiles.length} more</span>
                    </button>
                  )}
                </>
              )}
              {/* What changed in the shape, as against the lines above: the
                  symbols and lines that came and went, drawn as added boxes
                  and ghosts. Greyed with the reason where it can run
                  nothing; aria-disabled rather than disabled, or the tooltip
                  that carries the reason would not show. */}
              <button
                type="button"
                {...LIST_ROW}
                className={`front-row front-link${diff.state === 'blocked' ? ' front-row-off' : ''}`}
                aria-disabled={diff.state === 'blocked'}
                onClick={diff.state === 'blocked' ? undefined : onDiff}
                title={diffTitle(diff, false)}
              >
                <i className="codicon codicon-git-compare" aria-hidden="true" />
                <span className="front-name-ui">Structural diff{diff.state === 'blocked' ? '' : ` · since ${diff.since}`}</span>
                {diff.state === 'ready' ? (
                  <span className="front-why">
                    <DiffCount counts={diff.counts} /> symbols
                  </span>
                ) : (
                  <span className="front-why">{diff.state === 'reading' ? 'comparing…' : diff.why}</span>
                )}
              </button>
            </Section>

            <Section
              title="Agent"
              className="front-section front-section-agent"
              status={
                overview.agent.total === 0 ? undefined : (
                  <span className="front-status">{plural(overview.agent.total, 'call')}</span>
                )
              }
            >
              {overview.agent.last === null ? (
                <p className="front-note" title="No agent has used codemap's MCP tools in this session">
                  no agent yet
                </p>
              ) : (
                <>
                  {agentRow(overview.agent.last, now, marksOf, onFocus, inGraph)}
                  {overview.agent.lastNote !== null && overview.agent.lastNote.note !== undefined && (
                    <div
                      className="front-row"
                      title={`The agent's own words, ${relativeTime(overview.agent.lastNote.at, now)}${
                        overview.agent.lastNote.files === undefined || overview.agent.lastNote.files.length === 0
                          ? ''
                          : ` · about ${overview.agent.lastNote.files.join(', ')}`
                      }`}
                    >
                      <i className="codicon codicon-comment" aria-hidden="true" />
                      <span className="front-name-ui front-quote">{overview.agent.lastNote.note}</span>
                    </div>
                  )}
                </>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

type FileRow = (
  file: string,
  key: string,
  extra: { why?: string; detail?: string; count?: { value: number; title: string } },
  title: string,
  depth?: number,
) => ReactElement;

/**
 * One reason's worth of manifest entries: a row with the count and, folded
 * or not, the files under it one indent in. A group of one file is still a
 * group — the row says why the file is a start, which the file row alone
 * would repeat on every line.
 */
function entryGroup(
  group: EntryGroup,
  folded: boolean,
  open: ReadonlySet<string>,
  setOpen: (next: (was: ReadonlySet<string>) => ReadonlySet<string>) => void,
  fileRow: FileRow,
) {
  const shown = !folded || open.has(group.why);
  return (
    <div key={group.why} className="front-group">
      <button
        type="button"
        {...LIST_ROW}
        className="front-row front-link"
        aria-expanded={shown}
        onClick={() =>
          setOpen((was) => {
            const next = new Set(was);
            if (next.has(group.why)) next.delete(group.why);
            else next.add(group.why);
            return next;
          })
        }
        title={`${group.files.length} ${group.files.length === 1 ? 'file' : 'files'} known this way. Click to ${shown ? 'fold' : 'unfold'} them.`}
      >
        <i className={`codicon codicon-chevron-${shown ? 'down' : 'right'} front-twistie`} aria-hidden="true" />
        <span className="front-name-ui">{group.why}</span>
        <span className="front-count">{group.files.length}</span>
      </button>
      {shown &&
        group.files.map((entry: EntryPoint) =>
          fileRow(
            entry.file,
            entry.file,
            entry.detail === undefined ? {} : { detail: entry.detail },
            `${entry.file} — ${entry.why}${entry.detail === undefined ? '' : ` "${entry.detail}"`}. Click to focus on it: the file and what it imports.`,
            1,
          ),
        )}
    </div>
  );
}

/**
 * A root the graph found: the file, why it is one in the engine's words, and
 * how many files it imports. The title carries the floor the number stands
 * on — "nothing imports it" is as far as the graph could see.
 */
function rootRow(root: Root, fileRow: FileRow) {
  return fileRow(
    root.file,
    root.file,
    {
      why: root.why,
      count: {
        value: root.imports,
        title: `Imports ${root.imports === 1 ? '1 file' : `${root.imports} files`} — distinct files, edges out`,
      },
    },
    `${root.file} — ${root.why}, as far as the graph can see: a file reached only through an untyped receiver, a dynamic import() or a Worker URL counts as unreached. Imports ${root.imports} ${
      root.imports === 1 ? 'file' : 'files'
    }. Click to focus on it.`,
  );
}

function categoryRow(category: NamedCategory, onCategory: (storedId: string) => void) {
  const measure = category.cohesion === null ? 'by hand' : `${Math.round(category.cohesion * 100)}%`;
  return (
    <button
      key={category.storedId}
      type="button"
      {...LIST_ROW}
      className={`front-row front-link front-depth-${category.depth}`}
      onClick={() => onCategory(category.storedId)}
      title={
        category.cohesion === null
          ? `${category.name} — drawn by hand, ${category.files} files; the import graph was never asked to find it. Click to show its files, wherever they sit.`
          : `${category.name} — ${category.files} files, ${measure} of their edges stay inside the category (a share, not a score). Click to show its files, wherever they sit.`
      }
    >
      <i className="codicon codicon-package" aria-hidden="true" />
      <span className="front-name-ui">{category.name}</span>
      <span className="front-why">
        {category.files} files · {measure}
      </span>
    </button>
  );
}

/**
 * A changed file, in the Changes list's shape. One the graph holds no box
 * for — a README, a deleted file — is greyed rather than linked: a focus
 * view of it would be a 404, and its letter is the fact the row is there for.
 */
function changeRow(file: ChangedFile, marks: string, onFocus: (file: string) => void) {
  const { name, where } = splitPath(file.file);
  const off = !file.inGraph;
  return (
    <button
      key={file.file}
      type="button"
      {...LIST_ROW}
      className={`front-row front-link front-depth-1${off ? ' front-row-off' : ''}${marks}`}
      aria-disabled={off}
      onClick={off ? undefined : () => onFocus(file.file)}
      title={
        off
          ? `${file.file} — ${file.status}, and not in the graph: ${file.status === 'deleted' ? 'a deleted file has no box' : 'nothing it declares or imports is read'}`
          : `${file.file} — ${file.status} against the base. Click to focus on it.`
      }
    >
      <span className="front-name">{name}</span>
      <span className="front-where">{where}</span>
      <span className={`front-letter front-letter-${file.status}`} aria-label={file.status}>
        {GIT_LETTER[file.status]}
      </span>
    </button>
  );
}

/**
 * What the agent last asked, and where. A target the graph holds a file box
 * for is a path and the row leads to it; a search term is not, and neither
 * is a directory — `describe_file` takes one, and a slash in it is not a
 * file to focus on — so the row only says so.
 */
function agentRow(
  last: NonNullable<OverviewReply['agent']['last']>,
  now: number,
  marksOf: (file: string) => string,
  onFocus: (file: string) => void,
  inGraph: (path: string) => boolean,
) {
  const path = last.target !== null && inGraph(last.target) ? last.target : null;
  const age = relativeTime(last.at, now);
  if (path === null) {
    // A path-shaped target that is not a file box says why the row leads
    // nowhere: a directory, or a file the graph does not hold.
    const why =
      last.target !== null && last.target.includes('/') ? ' — not a file the graph holds, so nothing to focus on' : '';
    return (
      <div className="front-row" title={`${last.tool}${last.target === null ? '' : ` "${last.target}"`}, ${age}${why}`}>
        <i className="codicon codicon-hubot" aria-hidden="true" />
        <span className="front-name-ui">{last.tool}</span>
        {last.target !== null && <span className="front-where">{last.target}</span>}
        <span className="front-why">{age}</span>
      </div>
    );
  }
  const { name, where } = splitPath(path);
  return (
    <button
      type="button"
      {...LIST_ROW}
      className={`front-row front-link${marksOf(path)}`}
      onClick={() => onFocus(path)}
      title={`${last.tool} about ${path}, ${age}. Click to focus on it.`}
    >
      <i className="codicon codicon-hubot" aria-hidden="true" />
      <span className="front-name-ui">{last.tool}</span>
      <span className="front-name">{name}</span>
      <span className="front-where">{where}</span>
      <span className="front-why">{age}</span>
    </button>
  );
}
