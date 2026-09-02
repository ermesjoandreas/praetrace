import { useEffect, useState, type ReactNode } from 'react';
import { Section } from './Section';
import {
  fetchDetail,
  openInEditor,
  type Detail,
  type ExplainFailure,
  type ExplainState,
  type GroupColor,
  type GroupSuggestion,
  type StoredExplanation,
  type SymbolLinks,
  type SymbolRelation,
} from './api';

/**
 * What the panel can do to a group. The frame on the canvas offers the same
 * decisions, but a frame that loses the overlap contest is never drawn — so
 * everything a group can be asked has to be reachable from here too, or naming
 * one could be the last anybody ever does to it.
 */
export interface GroupEditor {
  /** The boxes picked on the canvas, and the files those boxes stand for. */
  selection: { boxes: number; files: string[] };
  creating: boolean;
  onCreating: (open: boolean) => void;
  onCreate: (name: string) => void;
  onRename: (group: GroupSuggestion, name: string) => void;
  onColor: (group: GroupSuggestion, color: GroupColor) => void;
  /** Only a hand-drawn group may be given members; the rest come from imports. */
  onMembers: (group: GroupSuggestion, files: string[]) => void;
  onDelete: (group: GroupSuggestion) => void;
}

/**
 * The palette, spelled out here as well as in `GroupNode`: `project/groups.ts`
 * owns the union but reaches for node:fs, so nothing may import a value from it
 * into the browser. A Record keyed by GroupColor is what keeps them in step — a
 * colour added to the union fails to compile here until it is listed.
 */
const COLOR_LABELS: Record<GroupColor, string> = {
  slate: 'Slate',
  blue: 'Blue',
  teal: 'Teal',
  green: 'Green',
  amber: 'Amber',
  orange: 'Orange',
  red: 'Red',
  violet: 'Violet',
};

export interface Following {
  /** One entry per followed symbol the graph still knows, in pick order. */
  links: SymbolLinks[];
  /**
   * Followed symbol ids the graph answered 404 for.
   *
   * Listed rather than forgotten, and never pruned on the strength of it: a
   * file saved mid-edit will not parse for a cycle and loses every symbol in
   * it, so this is at its most common precisely while the agent is working,
   * and a list that emptied itself then would be worse than no list. Said out
   * loud instead, and taken off by hand.
   */
  gone: string[];
  /**
   * Held *files*: a reading list, not a lens.
   *
   * These never reach `relatedIds` or `relatedFiles`. Following a symbol dims
   * everything it does not touch and the chip counts what it dimmed; holding a
   * file dims nothing, deliberately. The two are joined only for what they mean
   * to the model, which is why they share this section and its one button.
   */
  files: { path: string; name: string }[];
  /**
   * The ids the run in flight actually asked about. One boolean made every row
   * in the section claim to be explaining, including ones the run had never
   * heard of — and those would have sat there saying it after it finished.
   */
  runningIds: ReadonlySet<string>;
  /** Stop the run in flight. Two minutes is a long time to have no way out. */
  onCancel: () => void;
  /** Drop a stored reading from .codemap/explain.json. It can simply be wrong. */
  onForget: (id: string) => void;
  /** True once every followed symbol has an answer, however empty. */
  settled: boolean;
  /** What has been explained, by id, for exactly the ids on show. */
  explanations: ReadonlyMap<string, StoredExplanation>;
  /** A run is in flight. It is a minute of subprocess, so it is said out loud. */
  running: boolean;
  /** The price of the last run that produced words. Null until one has. */
  lastRun: { costUsd: number; ms: number } | null;
  /** Why the last press produced none, in the server's own wording. */
  failure: { reason: ExplainFailure; detail: string } | null;
  /** The answer as it is being written, before it is parsed into entries. */
  streamed: string;
  onExplain: () => void;
  onDrop: (id: string) => void;
}

interface SidebarProps {
  root: string;
  /** The box the user clicked, or null. Navigation is a separate gesture. */
  selected: string | null;
  /** Bumped whenever the graph changes, so the panel never shows a stale file. */
  revision: number;
  onSelect: (target: string) => void;
  /** The kind decides whether navigating means focus or scope. */
  onFocus: (target: string, kind: 'file' | 'folder') => void;
  groups: GroupSuggestion[];
  onDecide: (group: GroupSuggestion, name: string, state: 'accepted' | 'rejected') => void;
  groupEditor: GroupEditor;
  following: Following;
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function Sidebar({
  root,
  selected,
  revision,
  onSelect,
  onFocus,
  groups,
  onDecide,
  groupEditor,
  following,
}: SidebarProps) {
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetchDetail(selected).then(
      (result) => {
        if (!cancelled) setDetail(result);
      },
      () => {
        if (!cancelled) setDetail(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selected, revision, root]);

  // The header's actions are what the panel head used to spell out as words:
  // go to it on the diagram, open it in the editor. Only a file has anywhere
  // in an editor to open.
  const actions =
    detail === null ? null : (
      <>
        <button
          type="button"
          title={detail.kind === 'file' ? 'Focus on this file' : 'Open this folder'}
          aria-label={detail.kind === 'file' ? 'Focus on this file' : 'Open this folder'}
          onClick={() => onFocus(detail.path, detail.kind)}
        >
          <i className="codicon codicon-target" aria-hidden="true" />
        </button>
        {detail.kind === 'file' && (
          <button
            type="button"
            title="Open in editor"
            aria-label="Open in editor"
            onClick={() => void openInEditor(root, detail.path, 1)}
          >
            <i className="codicon codicon-go-to-file" aria-hidden="true" />
          </button>
        )}
      </>
    );

  return (
    <aside className="sidebar">
      <Followed following={following} onSelect={onSelect} onFocus={onFocus} />

      <Section title="Detail" className="panel" actions={actions}>
        {detail === null ? (
          <p className="panel-empty">Click a box to see what it holds, and what depends on it.</p>
        ) : detail.kind === 'file' ? (
          <FileView detail={detail} root={root} onSelect={onSelect} />
        ) : (
          <FolderView detail={detail} onSelect={onSelect} />
        )}
      </Section>

      <GroupList groups={groups} onDecide={onDecide} onSelect={onSelect} editor={groupEditor} />
    </aside>
  );
}

function FileView({
  detail,
  root,
  onSelect,
}: {
  detail: Extract<Detail, { kind: 'file' }>;
  root: string;
  onSelect: (target: string) => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
        <p className="panel-meta">
          {detail.symbols.length} symbols · {detail.lineCount} lines
        </p>
      </header>

      {/* The whole list, not the eight the box has room for. */}
      <PanelList title="Declares">
        {detail.symbols.map((symbol, index) => (
          <li key={`${symbol.name}-${index}`}>
            <button
              type="button"
              className={`sym sym-${symbol.kind}`}
              onClick={() => void openInEditor(root, detail.path, symbol.line)}
              title={`Open at line ${symbol.line}`}
            >
              {symbol.kind === 'function' ? `${symbol.name}()` : symbol.name}
              <span className="sym-line">{symbol.line}</span>
            </button>
          </li>
        ))}
      </PanelList>

      {/* The answer the diagram could never give. */}
      <PathList title="Used by" paths={detail.importedBy} onSelect={onSelect} />
      <PathList title="Uses" paths={detail.imports} onSelect={onSelect} />
    </>
  );
}

function FolderView({
  detail,
  onSelect,
}: {
  detail: Extract<Detail, { kind: 'folder' }>;
  onSelect: (target: string) => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
        <p className="panel-meta">{detail.files.length} files</p>
      </header>

      <PathList title="Files" paths={detail.files} onSelect={onSelect} />
      <PathList title="Used by" paths={detail.importedBy} onSelect={onSelect} />
      <PathList title="Uses" paths={detail.imports} onSelect={onSelect} />
    </>
  );
}

function PanelList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel-list">
      <h3>{title}</h3>
      <ul>{children}</ul>
    </div>
  );
}

function PathList({
  title,
  paths,
  onSelect,
}: {
  title: string;
  paths: string[];
  onSelect: (target: string) => void;
}) {
  if (paths.length === 0) return null;

  return (
    <PanelList title={`${title} (${paths.length})`}>
      {paths.map((path) => (
        <li key={path}>
          <button type="button" className="path" onClick={() => onSelect(path)} title={path}>
            {path}
          </button>
        </li>
      ))}
    </PanelList>
  );
}

/**
 * Every group the graph found and every one somebody drew, including the ones
 * whose frames were dropped for overlapping. A group that cannot be drawn can
 * still be named, coloured and — where a person drew it — taken apart.
 */
function GroupList({
  groups,
  onDecide,
  onSelect,
  editor,
}: {
  groups: GroupSuggestion[];
  onDecide: (group: GroupSuggestion, name: string, state: 'accepted' | 'rejected') => void;
  onSelect: (target: string) => void;
  editor: GroupEditor;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The row whose palette and membership are open. One at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const live = groups.filter((group) => group.state !== 'rejected');
  // Drawing the first group has to be possible before there is a list to add
  // it to, so the section outlives an empty one.
  const canCreate = editor.selection.boxes >= 2;
  if (live.length === 0 && !canCreate) return null;

  return (
    <Section
      title="Groups"
      className="groups"
      // "Group selection" from a menu puts a form in this body; a folded body
      // would swallow it.
      expandWhen={editor.creating}
      actions={
        // Greyed with the reason rather than absent: a header action that comes
        // and goes with the selection would never be found.
        <button
          type="button"
          disabled={!canCreate}
          title={
            canCreate
              ? `Group the ${editor.selection.boxes} selected boxes`
              : 'Select two or more boxes on the diagram to draw a group'
          }
          aria-label="Group the selected boxes"
          onClick={() => editor.onCreating(true)}
        >
          <i className="codicon codicon-add" aria-hidden="true" />
        </button>
      }
    >
      {canCreate && editor.creating && (
        <input
          autoFocus
          value={newName}
          placeholder={`Name a group of ${editor.selection.files.length} files`}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && newName.trim() !== '') {
              editor.onCreate(newName.trim());
              setNewName('');
            } else if (event.key === 'Escape') editor.onCreating(false);
          }}
          onBlur={() => editor.onCreating(false)}
        />
      )}

      <ul>
        {live.map((group) => {
          const manual = group.origin === 'manual';
          const decided = manual || group.state === 'accepted';
          const open = decided && editing === group.id;

          return (
            <li key={group.id}>
              {naming === group.id ? (
                <input
                  autoFocus
                  value={draft}
                  placeholder="Name this group"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && draft.trim() !== '') {
                      editor.onRename(group, draft.trim());
                      setNaming(null);
                    } else if (event.key === 'Escape') setNaming(null);
                  }}
                  onBlur={() => setNaming(null)}
                />
              ) : (
                <div className="group-row">
                  {/* The swatch is the way in: it shows the colour the frame is
                      drawn in and opens the palette that changes it. A group
                      with no colour of its own is drawn in the default grey,
                      which is what slate is.

                      Only a group that has been decided has an entry in
                      groups.json to hang a colour on, so a suggestion is not
                      offered a palette that would have nowhere to land. Naming
                      it accepts it, and it can be dressed after that. */}
                  {decided && (
                    <button
                      type="button"
                      className="group-swatch"
                      data-color={group.color ?? 'slate'}
                      aria-pressed={open}
                      title={open ? 'Close' : manual ? 'Colour and members' : 'Colour'}
                      onClick={() => setEditing(open ? null : group.id)}
                    />
                  )}
                  <button
                    type="button"
                    className={group.state === 'accepted' ? 'group-title named' : 'group-title'}
                    onClick={() => {
                      setDraft(group.name ?? '');
                      setNaming(group.id);
                    }}
                  >
                    {group.name ?? `${group.files.length} files`}
                  </button>
                  {/* A drawn group carries a cohesion of 0 — the import graph
                      was never asked to find it — and 0% would read as a
                      terrible group rather than as somebody's decision. */}
                  <span className="group-cohesion">
                    {manual ? 'by hand' : `${Math.round(group.cohesion * 100)}%`}
                  </span>
                  {/* Rejecting is remembering that this is not a group, so the
                      next scan stops proposing it. Nothing proposed a drawn
                      group, so there is nothing to remember: it is deleted. */}
                  <span className="row-actions">
                    <button
                      type="button"
                      className="group-drop"
                      title={manual ? 'Delete this group' : 'Not a group'}
                      aria-label={manual ? 'Delete this group' : 'Not a group'}
                      onClick={() =>
                        manual ? editor.onDelete(group) : onDecide(group, group.name ?? '', 'rejected')
                      }
                    >
                      <i
                        className={`codicon codicon-${manual ? 'trash' : 'close'}`}
                        aria-hidden="true"
                      />
                    </button>
                  </span>
                </div>
              )}

              {open && (
                // Its own class, not the canvas popover's: that one is a panel
                // floating over the diagram, this one is a strip inside a list,
                // and they were sharing a name and therefore a stylesheet.
                <div className="group-palette">
                  {/* The only other way out is the swatch that opened it, and
                      the drop button next to it rejects or deletes the group.
                      Two ways out that far apart in meaning need the harmless
                      one to be the near one. */}
                  <span className="group-palette-label">Colour</span>
                  <div className="group-swatches">
                    {(Object.keys(COLOR_LABELS) as GroupColor[]).map((color) => (
                      <button
                        key={color}
                        type="button"
                        data-color={color}
                        className={`group-swatch${group.color === color ? ' group-swatch-active' : ''}`}
                        title={COLOR_LABELS[color]}
                        onClick={() => editor.onColor(group, color)}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="group-palette-close"
                    title="Done"
                    aria-label="Done"
                    onClick={() => setEditing(null)}
                  >
                    <i className="codicon codicon-close" aria-hidden="true" />
                  </button>
                </div>
              )}

              <div className="group-files">
                {group.files.map((file) =>
                  open && manual ? (
                    <span className="group-row" key={file}>
                      <button type="button" title={file} onClick={() => onSelect(file)}>
                        {file}
                      </button>
                      <span className="row-actions">
                        <button
                          type="button"
                          className="group-drop"
                          disabled={group.files.length <= 2}
                          title={
                            group.files.length <= 2
                              ? 'A group needs at least two files'
                              : `Take ${file} out of this group`
                          }
                          aria-label={`Take ${file} out of this group`}
                          onClick={() =>
                            editor.onMembers(
                              group,
                              group.files.filter((member) => member !== file),
                            )
                          }
                        >
                          <i className="codicon codicon-close" aria-hidden="true" />
                        </button>
                      </span>
                    </span>
                  ) : (
                    <button type="button" key={file} title={file} onClick={() => onSelect(file)}>
                      {file}
                    </button>
                  ),
                )}
                {open && manual && editor.selection.files.length > 0 && (
                  <button
                    type="button"
                    title="Add what is selected on the diagram"
                    onClick={() =>
                      editor.onMembers(group, [
                        ...new Set([...group.files, ...editor.selection.files]),
                      ])
                    }
                  >
                    add {editor.selection.files.length} selected
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * Every state a stored reading can be in, said in words.
 *
 * A Record keyed by the union for the same reason COLOR_LABELS is one: a state
 * the server learns to send fails to compile here until this file has something
 * to say about it, and an unnamed state is exactly the silence that makes a
 * reading get believed after it stopped being true.
 */
const STATE_WORDS: Record<ExplainState, string> = {
  none: 'Nothing has been asked about this one yet.',
  current: 'The source has not changed since this was written.',
  drifted:
    'The source is unchanged, but something it relates to has been written since. Still true, no longer complete.',
  stale: 'The source changed after this was written, so it may now be false.',
  orphaned: 'What this describes has left the graph.',
  unknown: 'Fingerprinted by a build this one cannot check against.',
};

/** Why a run produced nothing, in words that say what to do about it. */
const FAILURE_WORDS: Record<ExplainFailure, string> = {
  missing: 'claude was not found.',
  auth: 'claude is installed but not logged in.',
  timeout: 'claude did not answer in time and was stopped.',
  failed: 'claude exited with an error.',
  unreadable: 'claude answered, but not in a shape that could be read.',
  unsaved: 'The answers arrived but could not be written to .codemap/explain.json — they are held for now and will be gone at the next restart.',
};

/**
 * What is being followed, listed, and what a model made of it.
 *
 * The diagram can only light a related symbol that happens to be on screen, and
 * most are not: a caller two directories away sits in a box the current scope
 * does not draw. So the highlighting answers "where does this sit" and this
 * answers "what is there", and neither is much use without the other.
 *
 * The explanations live here rather than in a panel of their own, because a
 * reading parted from the thing it reads is how a rotted one gets believed.
 */
function Followed({
  following,
  onSelect,
  onFocus,
}: {
  following: Following;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  const { links, gone, files, explanations, running, runningIds, lastRun, failure, streamed } = following;
  if (links.length === 0 && gone.length === 0 && files.length === 0) return null;

  // What a press can come back with words for. A gone symbol keeps its row and
  // its close button, but the graph cannot resolve it and the server drops it, so counting
  // it here would promise an answer that is not coming.
  const answerable = links.length + files.length;

  // Six identical "not explained yet" lines under a button that already says
  // "Explain these · 6" is noise. The line earns its place the moment the list
  // is mixed — some rows read, some not — or a run has been and gone leaving
  // this row with nothing to show for it.
  const sayNothingYet = explanations.size > 0 || running || lastRun !== null || failure !== null;

  return (
    <Section title="Following" className="followed">
      <div className="followed-one">
        {/* Not a followed-head: that is a row, and this is the section's one
            button, which wants the whole width. */}
        <div className="explain-bar">
          <button
            type="button"
            className="explain-run"
            aria-busy={running}
            disabled={running || answerable === 0}
            title={
              running
                ? 'A run is in flight. It takes a minute or so.'
                : answerable === 0
                  ? 'Nothing here that the graph can still resolve.'
                  : `Ask Claude what these are for. It spends your Claude quota.${
                      lastRun === null
                        ? ''
                        : ` Last run ${money(lastRun.costUsd)}${
                            lastRun.ms === 0 ? '' : `, ${Math.round(lastRun.ms / 1000)}s`
                          }.`
                    }`
            }
            onClick={following.onExplain}
          >
            {running ? 'Explaining' : 'Explain these'}
            <span>·</span>
            {answerable}
          </button>

          {running && (
            <button type="button" className="explain-stop" onClick={following.onCancel}>
              stop
            </button>
          )}
        </div>

        {/* The answer as it lands. Twelve seconds pass before the first
            character, and a wait with nothing moving in it is indistinguishable
            from a hung subprocess — which is what this was, until it streamed.
            Shown raw: it is not parsed into entries until the run ends. */}
        {running && streamed !== '' && (
          <p className="explain-stream">{streamed.replace(/^@@ .*$/gm, '').trim()}</p>
        )}
        {/* The label is never the useful half on its own: `missing` carries the
            list of places that were searched, which is the fixable part, so the
            detail is printed exactly as it came back. */}
        {failure !== null && (
          <p className="explain-failed">
            {FAILURE_WORDS[failure.reason]}
            {failure.detail === '' ? '' : ` ${failure.detail}`}
          </p>
        )}
      </div>

      {links.map((symbol) => (
        <div className="followed-one" key={symbol.id}>
          <div className="followed-head">
            <span className="followed-name">{symbol.name}</span>
            <span className="followed-where" title={symbol.filePath}>
              {symbol.filePath}
            </span>
            <StateChip state={explanations.get(symbol.id)?.state} />
            <span className="row-actions">
              {explanations.has(symbol.id) && (
                <button
                  type="button"
                  className="followed-drop"
                  title="Forget this reading — it is removed from .codemap/explain.json"
                  aria-label="Forget this reading"
                  onClick={() => following.onForget(symbol.id)}
                >
                  <i className="codicon codicon-trash" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="followed-drop"
                title="Stop following this one"
                aria-label="Stop following this one"
                onClick={() => following.onDrop(symbol.id)}
              >
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            </span>
          </div>

          <Reading
            entry={explanations.get(symbol.id)}
            running={runningIds.has(symbol.id)}
            sayNothingYet={sayNothingYet}
          />

          {symbol.usedBy.length === 0 && symbol.uses.length === 0 ? (
            <p className="followed-none">
              Nothing here references it, and nothing it references resolved. Method calls
              are under-reported on purpose.
            </p>
          ) : (
            <>
              <Relations title="used by" rows={symbol.usedBy} onSelect={onSelect} onFocus={onFocus} />
              <Relations title="uses" rows={symbol.uses} onSelect={onSelect} onFocus={onFocus} />
            </>
          )}
        </div>
      ))}

      {gone.map((id) => (
        <Lost
          key={id}
          id={id}
          entry={explanations.get(id)}
          sayNothingYet={sayNothingYet}
          onDrop={() => following.onDrop(id)}
        />
      ))}

      {files.map((file) => (
        <div className="followed-one" key={file.path}>
          <div className="followed-head">
            <span className="followed-name">{file.name}</span>
            <span className="followed-where" title={file.path}>
              {file.path}
            </span>
            {/* Why this row has no callers under it: it is a whole file, held to
                be read rather than to be traced through. */}
            <span className="followed-edge">file</span>
            <StateChip state={explanations.get(file.path)?.state} />
            <span className="row-actions">
              {explanations.has(file.path) && (
                <button
                  type="button"
                  className="followed-drop"
                  title="Forget this reading — it is removed from .codemap/explain.json"
                  aria-label="Forget this reading"
                  onClick={() => following.onForget(file.path)}
                >
                  <i className="codicon codicon-trash" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="followed-drop"
                title="Stop holding this file"
                aria-label="Stop holding this file"
                onClick={() => following.onDrop(file.path)}
              >
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            </span>
          </div>

          <Reading
            entry={explanations.get(file.path)}
            running={runningIds.has(file.path)}
            sayNothingYet={sayNothingYet}
          />
        </div>
      ))}
    </Section>
  );
}

/**
 * A followed symbol the graph no longer has.
 *
 * Kept, not pruned, and its reading kept with it: an explanation of something
 * that has gone is the most interesting thing this tool can say. All that is
 * left of it is the id — a re-parse clears every answer the page held — so the
 * name is read back out of the id rather than remembered.
 */
function Lost({
  id,
  entry,
  sayNothingYet,
  onDrop,
}: {
  id: string;
  entry: StoredExplanation | undefined;
  sayNothingYet: boolean;
  onDrop: () => void;
}) {
  // Split at the last '#': a path may legally hold one, a symbol name may not.
  const cut = id.lastIndexOf('#');
  const name = cut === -1 ? id : id.slice(cut + 1);
  const filePath = cut === -1 ? '' : id.slice(0, cut);

  return (
    <div className="followed-one">
      <div className="followed-head">
        <span className="followed-name">{name}</span>
        <span className="followed-where" title={id}>
          {filePath}
        </span>
        <span className="explain-state" data-state="orphaned" title={STATE_WORDS.orphaned}>
          gone
        </span>
        <span className="row-actions">
          <button
            type="button"
            className="followed-drop"
            title="Stop following this one"
            aria-label="Stop following this one"
            onClick={onDrop}
          >
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        </span>
      </div>

      <p className="followed-none">
        Not in the graph. A file that will not parse loses its symbols until the next save,
        so this is kept until you take it off.
      </p>

      <Reading entry={entry} running={false} sayNothingYet={sayNothingYet} />
    </div>
  );
}

/**
 * How a reading stands to the code it describes, in one word.
 *
 * Nothing is drawn for `current`: a chip on every healthy row is noise. The two
 * grades that are left mean opposite things — drifted is still true and merely
 * incomplete, stale may now be false — and only one of them should stop anyone
 * trusting the words, so only one of them is loud.
 */
function StateChip({ state }: { state: ExplainState | undefined }) {
  if (state === undefined || state === 'current' || state === 'none') return null;
  return (
    <span className="explain-state" data-state={state} title={STATE_WORDS[state]}>
      {state}
    </span>
  );
}

/**
 * The reading itself, short first, and every state it can be in said out loud.
 *
 * A spinner that never resolves, or a row that is simply blank, is the failure
 * this section is arranged against: it costs the user money to fill, and an
 * answer nobody can tell apart from a silence is not worth what it cost.
 */
function Reading({
  entry,
  running,
  sayNothingYet,
}: {
  entry: StoredExplanation | undefined;
  running: boolean;
  sayNothingYet: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (entry === undefined) {
    // The two silences nobody can tell apart otherwise: a row nothing has been
    // spent on, and a row being paid for right now.
    if (running) return <p className="followed-none">Explaining this one…</p>;
    return sayNothingYet ? <p className="followed-none">Not explained yet.</p> : null;
  }

  // Dimmed, never deleted. The source moved under these words, or the thing
  // they describe is gone — and in both cases the old reading is usually still
  // most of the answer. The chip beside it stays bright: it is the part that
  // says why the rest is faded.
  const doubted = entry.state === 'stale' || entry.state === 'orphaned';

  return (
    <div className={doubted ? 'explain-stale' : undefined}>
      <p className="explain-short">
        {entry.short}
        {entry.long !== '' && (
          <button
            type="button"
            className="explain-more"
            title={open ? 'Fold it away' : 'The fuller reading'}
            onClick={() => setOpen(!open)}
          >
            {open ? 'less' : 'more'}
          </button>
        )}
      </p>
      {open && entry.long !== '' && <p className="explain-long">{entry.long}</p>}
      {/* A run is on and this row already has words: they are the old ones until
          it ends. Blanking them for a minute to prove something is happening
          would take away the thing the panel is for. */}
      {running && <p className="followed-none">Reading it again…</p>}
    </div>
  );
}

/** Cents are the unit here: a run is two or three of them, not two dollars. */
function money(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

function Relations({
  title,
  rows,
  onSelect,
  onFocus,
}: {
  title: string;
  rows: SymbolRelation[];
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="followed-kind">
        {title} <span>{rows.length}</span>
      </h3>
      <ul className="followed-rows">
        {rows.map((row) => (
          <li key={row.id + row.edge}>
            <button
              type="button"
              title={`${row.filePath}:${row.line} — ${row.edge}`}
              onClick={() => onSelect(row.filePath)}
              onDoubleClick={() => onFocus(row.filePath, 'file')}
            >
              <span className="followed-symbol">{row.name}</span>
              <span className="followed-edge">{row.edge}</span>
              <span className="followed-file">{row.filePath}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
