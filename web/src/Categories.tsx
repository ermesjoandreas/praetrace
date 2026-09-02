import { useState } from 'react';
import { money } from './api';
import { Section } from './Section';
import type { GroupColor, GroupSuggestion, Suggestion } from './api';

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
 * A suggested name is the one thing here a model produced, and it is held to
 * decision 5: a guess in the page's memory until a person accepts it, and
 * accepting is the same write that typing the name would have been.
 */
export function Categories({
  groups,
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
  const [naming, setNaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The row whose palette and membership are open. One at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const live = groups.filter((group) => group.state !== 'rejected');
  const canCreate = editor.selection.boxes >= 2;

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

      <ul>
        {live.map((group) => {
          const manual = group.origin === 'manual';
          const decided = manual || group.state === 'accepted';
          const open = decided && editing === group.id;
          // Only a row with no name has a guess to show. The ids embed the
          // member count, so a guess for a cluster that has since drifted
          // finds no row and is simply not shown — never matched to the
          // wrong one.
          const suggestion = decided ? undefined : suggestions.get(group.id);

          return (
            <li key={group.id}>
              {naming === group.id ? (
                <input
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
                      // A guess is a starting point for typing as much as a
                      // thing to accept whole: the input opens on it.
                      setDraft(group.name ?? suggestion?.name ?? '');
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
                      title={manual ? 'Delete this category' : 'Not a category'}
                      aria-label={manual ? 'Delete this category' : 'Not a category'}
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

              {/* Its own row under the group, not more words on the group's:
                  the row above already ends in a close that means "not a
                  category", and a second close beside it meaning "not this
                  name" would be two identical icons with opposite reach. */}
              {suggestion !== undefined && (
                <div
                  className="group-row category-suggestion"
                  title="Suggested by Claude — not saved until you accept it"
                >
                  <i className="codicon codicon-lightbulb" aria-hidden="true" />
                  <span className="category-suggested" title={suggestion.reason}>
                    {suggestion.name}
                  </span>
                  <span className="row-actions">
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
