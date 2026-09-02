import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchDetail,
  openInEditor,
  type Detail,
  type GroupColor,
  type GroupSuggestion,
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
  /** One entry per followed symbol, in the order they were picked. */
  links: SymbolLinks[];
  /** True once every followed symbol has an answer, however empty. */
  settled: boolean;
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

  return (
    <aside className="sidebar">
      <Followed following={following} onSelect={onSelect} onFocus={onFocus} />

      <section className="panel">
        {detail === null ? (
          <p className="panel-empty">Click a box to see what it holds, and what depends on it.</p>
        ) : detail.kind === 'file' ? (
          <FileView detail={detail} root={root} onSelect={onSelect} onFocus={onFocus} />
        ) : (
          <FolderView detail={detail} onSelect={onSelect} onFocus={onFocus} />
        )}
      </section>

      <GroupList groups={groups} onDecide={onDecide} onSelect={onSelect} editor={groupEditor} />
    </aside>
  );
}

function FileView({
  detail,
  root,
  onSelect,
  onFocus,
}: {
  detail: Extract<Detail, { kind: 'file' }>;
  root: string;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
        <div className="panel-actions">
          <button type="button" onClick={() => onFocus(detail.path, 'file')}>
            Focus
          </button>
          <button type="button" onClick={() => void openInEditor(root, detail.path, 1)}>
            Open
          </button>
        </div>
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
  onFocus,
}: {
  detail: Extract<Detail, { kind: 'folder' }>;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
        <div className="panel-actions">
          <button type="button" onClick={() => onFocus(detail.path, 'folder')}>
            Open
          </button>
        </div>
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
    <section className="groups">
      <h2>Groups</h2>

      {canCreate &&
        (editor.creating ? (
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
        ) : (
          <button type="button" className="group-title" onClick={() => editor.onCreating(true)}>
            group the {editor.selection.boxes} selected boxes
          </button>
        ))}

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
                  <button
                    type="button"
                    className="group-drop"
                    title={manual ? 'Delete this group' : 'Not a group'}
                    onClick={() =>
                      manual ? editor.onDelete(group) : onDecide(group, group.name ?? '', 'rejected')
                    }
                  >
                    ✕
                  </button>
                </div>
              )}

              {open && (
                // Its own class, not the canvas popover's: that one is a panel
                // floating over the diagram, this one is a strip inside a list,
                // and they were sharing a name and therefore a stylesheet.
                <div className="group-palette">
                  {/* The only other way out is the swatch that opened it, and
                      the ✕ next to it deletes the group. Two ✕ that far apart
                      in meaning need the harmless one to be the near one. */}
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
                    onClick={() => setEditing(null)}
                  >
                    ✕
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
                      <button
                        type="button"
                        className="group-drop"
                        disabled={group.files.length <= 2}
                        title={
                          group.files.length <= 2
                            ? 'A group needs at least two files'
                            : `Take ${file} out of this group`
                        }
                        onClick={() =>
                          editor.onMembers(
                            group,
                            group.files.filter((member) => member !== file),
                          )
                        }
                      >
                        ✕
                      </button>
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
    </section>
  );
}

/**
 * What is being followed, listed.
 *
 * The diagram can only light a related symbol that happens to be on screen, and
 * most are not: a caller two directories away sits in a box the current scope
 * does not draw. So the highlighting answers "where does this sit" and this
 * answers "what is there", and neither is much use without the other.
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
  if (following.links.length === 0) return null;

  return (
    <section className="followed">
      {following.links.map((symbol) => (
        <div className="followed-one" key={symbol.id}>
          <div className="followed-head">
            <span className="followed-name">{symbol.name}</span>
            <span className="followed-where" title={symbol.filePath}>
              {symbol.filePath}
            </span>
            <button
              type="button"
              className="followed-drop"
              title="Stop following this one"
              onClick={() => following.onDrop(symbol.id)}
            >
              ✕
            </button>
          </div>

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
    </section>
  );
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
