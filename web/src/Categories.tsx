import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { money } from './api';
import { fileIconFor } from './fileicons';
import { LIST_ROW, useListKeys } from './listkeys';
import { Section } from './Section';
import type { GroupColor, GroupSuggestion, OrphanGroup, Suggestion } from './api';

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
  /**
   * By the id the group is recorded under, not by the group: an orphan has no
   * cluster to hand over, only the entry in groups.json it came from.
   */
  onDelete: (storedId: string) => void;
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

/**
 * The price is in the tooltip and not on the face of the section, which is
 * where the user asked for it. Before a run it is an estimate; after one it is
 * what the last press actually cost, as the CLI measured it — the number that
 * decides whether to press again.
 */
function suggestTitle(lastRun: { costUsd: number; ms: number } | null): string {
  // $0.05 is the measured figure for this repository's three unnamed groups
  // ($0.044), not a guess; the estimate before the first run should not be
  // "corrected" down to one.
  const cost =
    lastRun === null
      ? 'about $0.05'
      : `the last run cost ${money(lastRun.costUsd)} and took ${Math.round(lastRun.ms / 1000)} s`;
  return `Ask Claude to suggest names for the unnamed categories — ${cost}, nothing is saved until you accept one`;
}

/**
 * A file under a category, as the explorer lists one: the file icon, then
 * the path with its directory ellipsised away first. Both shapes a row takes
 * — the bare leaf, and the leaf beside a ✕ while a drawn category is being
 * edited — draw the same two things.
 */
function fileLeaf(file: string) {
  const icon = fileIconFor(file);
  return (
    <>
      {icon !== null && <img className="file-icon" src={icon.url} alt="" title={icon.label} draggable={false} />}
      <span className="group-file-path">{file}</span>
    </>
  );
}

/**
 * Every group the graph found and every one somebody drew, including the ones
 * whose frames were dropped for overlapping. A group that cannot be drawn can
 * still be named, coloured and — where a person drew it — taken apart.
 *
 * "Categories" is the user's word for them; the file is still groups.json and
 * the MCP tools are still list_groups and name_group. A left-bar section on the
 * same footing as Source Control, and shown like one: it stays on screen when
 * there is nothing in it, because a section that comes and goes with its
 * contents is never where it was last seen.
 *
 * A tree, the way VS Code's side bar lists things: every category is a row
 * with a chevron, folded by default, and its files are under it only once it
 * is unfolded. It used to list every file under every category, always — on a
 * real project twenty categories and hundreds of rows, and the one row that
 * mattered, a suggested name with its accept, was somewhere in that wall.
 *
 * A suggested name is the one thing here a model produced, and it is held to
 * decision 5: a guess in the page's memory until a person accepts it, and
 * accepting is the same write that typing the name would have been. There is
 * no accept-all, and there will not be: one press per name.
 */
export function Categories({
  groups,
  orphans,
  onDecide,
  onSelect,
  groupEditor: editor,
  suggestBlocked,
  suggestions,
  suggesting,
  suggestError,
  lastRun,
  onSuggest,
  onDismissSuggestion,
}: {
  groups: GroupSuggestion[];
  /** Stored names no group the graph finds now answers to. See OrphanGroup. */
  orphans: OrphanGroup[];
  onDecide: (group: GroupSuggestion, name: string, state: 'accepted' | 'rejected') => void;
  onSelect: (target: string) => void;
  groupEditor: GroupEditor;
  /**
   * Why a press would do nothing, in words, or null when it would run. App's
   * one answer, shared with the menu item, so the two can never disagree about
   * whether the user may spend the money.
   */
  suggestBlocked: string | null;
  /** By cluster id. App owns the map; a row only reads the entry for its own id. */
  suggestions: ReadonlyMap<string, Suggestion>;
  suggesting: boolean;
  /** Why the last press produced no names, in words, or null. */
  suggestError: string | null;
  /** What the last run that produced names cost, or null before one has. */
  lastRun: { costUsd: number; ms: number } | null;
  onSuggest: () => void;
  onDismissSuggestion: (id: string) => void;
}) {
  // One walk over the whole list, in the order it is drawn: a group, the name
  // being typed in place of it, then the files under it — when it is
  // unfolded. listkeys reads the rows out of the DOM, so a folded group's
  // files are not rows and the walk skips them without being told. The
  // chevron, the swatch, the palette and the row actions are not rows — they
  // act on the row they sit in, and Tab still reaches all but the chevron.
  const keys = useListKeys();
  const [naming, setNaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The row whose palette and membership are open. One at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  /**
   * The rows whose files are on screen, by cluster id. Everything starts
   * folded, and nothing is persisted: a new session starts tidy. The id embeds
   * the member count, so a group that drifts arrives under a new id and
   * therefore folded — which is right, since as far as the page knows it is a
   * new row.
   */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());

  const live = groups.filter((group) => group.state !== 'rejected');
  const canCreate = editor.selection.boxes >= 2;
  const unfoldedCount = live.filter((group) => unfolded.has(group.id)).length;

  const setFold = (id: string, open: boolean) => {
    setUnfolded((was) => {
      if (was.has(id) === open) return was;
      const next = new Set(was);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    // The palette and the member editor live in the unfolded body, so folding
    // the row ends the edit rather than leaving a swatch pressed over nothing.
    if (!open && editing === id) setEditing(null);
  };

  /** What a nested row says it sits inside: the outer group's name, or its size. */
  const parentLabel = (id: string): string => {
    const parent = groups.find((group) => group.id === id);
    return parent === undefined ? id : (parent.name ?? `${parent.files.length} files`);
  };

  // ← folds the row the keyboard is on and → unfolds it: VS Code's tree keys.
  // Only a category's own row answers them — a file is a leaf, and the rename
  // field owns its arrows for the caret. Everything else is listkeys'.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target;
    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      target instanceof HTMLElement &&
      target.dataset.group !== undefined
    ) {
      event.preventDefault();
      setFold(target.dataset.group, event.key === 'ArrowRight');
      return;
    }
    keys.onKeyDown(event);
  };

  // Greyed with the reason rather than absent, for the same reason the add
  // button is: an action that comes and goes is never found.

  return (
    <Section
      title="Categories"
      className="categories"
      // "Group selection" from a menu puts a form in this body; a folded body
      // would swallow it.
      expandWhen={editor.creating}
      status={suggesting ? <span className="categories-status">Suggesting…</span> : undefined}
      actions={
        <>
          <button
            type="button"
            disabled={suggestBlocked !== null}
            aria-busy={suggesting}
            title={suggestBlocked ?? suggestTitle(lastRun)}
            aria-label="Suggest names"
            onClick={onSuggest}
          >
            <i className="codicon codicon-lightbulb" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={!canCreate}
            title={
              canCreate
                ? `Group the ${editor.selection.boxes} selected boxes`
                : 'Select two or more boxes on the diagram to draw a category'
            }
            aria-label="Group the selected boxes"
            onClick={() => editor.onCreating(true)}
          >
            <i className="codicon codicon-add" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={unfoldedCount === live.length}
            title={
              live.length === 0
                ? 'Nothing to unfold'
                : unfoldedCount === live.length
                  ? 'Every category is already unfolded'
                  : 'Expand all'
            }
            aria-label="Expand all"
            onClick={() => setUnfolded(new Set(live.map((group) => group.id)))}
          >
            <i className="codicon codicon-expand-all" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={unfoldedCount === 0}
            title={
              live.length === 0
                ? 'Nothing to fold'
                : unfoldedCount === 0
                  ? 'Every category is already folded'
                  : 'Collapse all'
            }
            aria-label="Collapse all"
            onClick={() => {
              setUnfolded(new Set());
              setEditing(null);
            }}
          >
            <i className="codicon codicon-collapse-all" aria-hidden="true" />
          </button>
        </>
      }
    >
      {/* The reason, verbatim: `missing` carries the list of places that were
          searched, which is the fixable part. It stands until the next press. */}
      {suggestError !== null && <p className="categories-error">{suggestError}</p>}

      {canCreate && editor.creating && (
        <input
          autoFocus
          value={newName}
          placeholder={`Name a category of ${editor.selection.files.length} files`}
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

      {live.length === 0 && !editor.creating && (
        <p className="panel-empty">
          Nothing to categorise yet. Select two or more boxes on the diagram to draw one.
        </p>
      )}

      <ul {...keys} onKeyDown={onKeyDown}>
        {live.map((group) => {
          const manual = group.origin === 'manual';
          const decided = manual || group.state === 'accepted';
          const shown = unfolded.has(group.id);
          // Editing unfolds the row and folding it ends the edit, so this is
          // never true of a folded row; the `shown` is there so that a palette
          // can never be drawn under a chevron that says there is nothing.
          const open = shown && decided && editing === group.id;
          // Only a row with no name has a guess to show. The ids embed the
          // member count, so a guess for a cluster that has since drifted
          // finds no row and is simply not shown — never matched to the
          // wrong one.
          const suggestion = decided ? undefined : suggestions.get(group.id);
          // A drawn group carries a cohesion of 0 — the import graph was never
          // asked to find it — and 0% would read as a terrible group rather
          // than as somebody's decision.
          const cohesion = manual ? 'by hand' : `${Math.round(group.cohesion * 100)}%`;

          return (
            // One indent in under the group it was found inside. The list is
            // in walk order — an outer group, then what nests in it — so the
            // indent alone says which; the title says it in words.
            //
            // Its own row, and its own fold: folding the outer group hides
            // that group's files and never the categories nested in it. A
            // category is a thing, and hiding it under another would hide a
            // name the person may be looking for — which is the whole reason
            // the list folds at all.
            <li
              key={group.id}
              className={group.parent === null ? undefined : 'group-nested'}
              title={group.parent === null ? undefined : `Inside "${parentLabel(group.parent)}"`}
            >
              {naming === group.id ? (
                // A row while it is being renamed, so the walk does not lose
                // its place; the arrows inside it belong to the caret. The
                // fold is untouched: a name is typed on the row, not under it.
                <input
                  {...LIST_ROW}
                  autoFocus
                  value={draft}
                  placeholder="Name this category"
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
                  {/* The chevron is VS Code's twistie and is not a tab stop:
                      ← and → on the row do the same, and twenty chevrons
                      between Tab and the next section would be the 300 stops
                      listkeys exists to prevent. */}
                  <button
                    type="button"
                    className="group-twistie"
                    tabIndex={-1}
                    aria-expanded={shown}
                    title={shown ? 'Fold' : 'Unfold'}
                    aria-label={shown ? 'Fold' : 'Unfold'}
                    onClick={() => setFold(group.id, !shown)}
                  >
                    <i
                      className={`codicon codicon-chevron-${shown ? 'down' : 'right'}`}
                      aria-hidden="true"
                    />
                  </button>
                  {/* The swatch is the way in: it shows the colour the frame is
                      drawn in and opens the palette that changes it. A group
                      with no colour of its own is drawn in the default grey,
                      which is what slate is. The palette lives under the row,
                      so opening it unfolds the row; typing a name does not.

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
                      onClick={() => {
                        setEditing(open ? null : group.id);
                        if (!open) setFold(group.id, true);
                      }}
                    />
                  )}
                  {/* A model's guess at a name sits on the group's own row —
                      the lightbulb where a decided group's swatch would be, and
                      the name muted, because nothing has been decided — so the
                      accept is on the one row a folded list shows. It turns
                      into the title's text the moment a person accepts it, by
                      the same write typing it would have made. The reason
                      stays on hover, in the title. */}
                  {suggestion !== undefined && (
                    <i className="codicon codicon-lightbulb" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    {...LIST_ROW}
                    data-group={group.id}
                    className={group.state === 'accepted' ? 'group-title named' : 'group-title'}
                    title={suggestion?.reason}
                    onClick={() => {
                      // A guess is a starting point for typing as much as a
                      // thing to accept whole: the input opens on it.
                      setDraft(group.name ?? suggestion?.name ?? '');
                      setNaming(group.id);
                    }}
                  >
                    {group.name ?? suggestion?.name ?? `${group.files.length} files`}
                  </button>
                  {/* The count and the cohesion, since a folded row is all
                      there is to read. An unnamed group with no guess is
                      titled by its count already and is not told it twice. */}
                  <span
                    className="group-cohesion"
                    title={
                      manual
                        ? 'Drawn by a person; the import graph was not asked'
                        : // A share, not a score. It rises with the group —
                          // 100% for one holding the whole project — so the
                          // size it is measured over belongs in the same
                          // breath. express: this reads 91% over 38 of the 51
                          // files clustering looked at, while lib/ + index.js,
                          // the actual core, reads 18%.
                          `${Math.round(group.cohesion * 100)}% of these ${group.files.length} files' edges stay inside the category — a share, not a score: it rises with the group, and a group holding everything reads 100%`
                    }
                  >
                    {group.name === null && suggestion === undefined
                      ? cohesion
                      : `${group.files.length} · ${cohesion}`}
                  </span>
                  <span className="row-actions">
                    {suggestion === undefined ? (
                      // Rejecting is remembering that this is not a group, so
                      // the next scan stops proposing it. Nothing proposed a
                      // drawn group, so there is nothing to remember: it is
                      // deleted.
                      <button
                        type="button"
                        className="group-drop"
                        title={manual ? 'Delete this category' : 'Not a category'}
                        aria-label={manual ? 'Delete this category' : 'Not a category'}
                        onClick={() =>
                          manual
                            ? // A drawn group is always stored, so it always has the id it
                              // is stored under; the cluster id is the fallback App uses.
                              editor.onDelete(group.storedId ?? group.id)
                            : onDecide(group, group.name ?? '', 'rejected')
                        }
                      >
                        <i
                          className={`codicon codicon-${manual ? 'trash' : 'close'}`}
                          aria-hidden="true"
                        />
                      </button>
                    ) : (
                      // While a guess stands the row's two actions are about
                      // the guess, and "not a category" waits until it is
                      // dismissed: a second close beside this one, meaning
                      // the group and not the name, would be two identical
                      // icons with opposite reach.
                      <>
                        <button
                          type="button"
                          className="group-drop"
                          title={`Name it "${suggestion.name}"`}
                          aria-label="Accept"
                          onClick={() => editor.onRename(group, suggestion.name)}
                        >
                          <i className="codicon codicon-check" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="group-drop"
                          title="Dismiss this suggestion"
                          aria-label="Dismiss"
                          onClick={() => onDismissSuggestion(group.id)}
                        >
                          <i className="codicon codicon-close" aria-hidden="true" />
                        </button>
                      </>
                    )}
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

              {shown && (
                <div className="group-files">
                  {group.files.map((file) =>
                    open && manual ? (
                      <span className="group-row" key={file}>
                        <button type="button" {...LIST_ROW} title={file} onClick={() => onSelect(file)}>
                          {fileLeaf(file)}
                        </button>
                        <span className="row-actions">
                          <button
                            type="button"
                            className="group-drop"
                            disabled={group.files.length <= 2}
                            title={
                              group.files.length <= 2
                                ? 'A category needs at least two files'
                                : `Take ${file} out of this category`
                            }
                            aria-label={`Take ${file} out of this category`}
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
                      <button type="button" {...LIST_ROW} key={file} title={file} onClick={() => onSelect(file)}>
                        {fileLeaf(file)}
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
              )}
            </li>
          );
        })}
      </ul>

      {/* Names that are in .codemap/groups.json and match nothing the graph
          finds now. They used to be dropped on read, so a committed name could
          vanish from the panel with no way to learn why, let alone delete it.
          Kept and listed: the code a name described may come back, and until
          then the one thing to do with it is take it out on purpose.

          No arrow keys: a row here is a name and a count, and the one thing
          that can be done to it is the trash in its actions. A walk whose
          Enter does nothing would be a list that looks reachable and is not. */}
      {orphans.length > 0 && (
        <div className="categories-orphans">
          <h3
            className="categories-orphans-title"
            title="Stored in .codemap/groups.json, and no category the graph finds now holds most of these files"
          >
            Stored, matches nothing
          </h3>
          <ul>
            {orphans.map((orphan) => (
              <li key={orphan.storedId}>
                <div className="group-row group-orphan">
                  <span className="group-title" title={orphan.files.join('\n')}>
                    {orphan.name}
                  </span>
                  <span className="group-cohesion">
                    {orphan.files.length} {orphan.files.length === 1 ? 'file' : 'files'}
                  </span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="group-drop"
                      title="Delete this category — it is removed from .codemap/groups.json"
                      aria-label={`Delete ${orphan.name}`}
                      onClick={() => editor.onDelete(orphan.storedId)}
                    >
                      <i className="codicon codicon-trash" aria-hidden="true" />
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
