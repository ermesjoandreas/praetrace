import { useState, type MouseEvent } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import type { GroupColor } from './api';

export type GroupData = {
  id: string;
  name: string | null;
  fileCount: number;
  cohesion: number;
  accepted: boolean;
  depth: number;
  /** 'manual' means a person drew this group; null means the graph found it. */
  origin: 'manual' | null;
  /** A palette key, not a CSS colour. null takes the depth default. */
  color: GroupColor | null;
  /** Frame slack around the members. null takes the layout default. */
  padding: { x: number; y: number } | null;
  /** Placed by hand and held there, rather than hugging its members. */
  locked: boolean;
  /** Members that fall outside a locked frame. Never non-zero when unlocked. */
  outside: number;
  onAccept: (name: string) => void;
  onReject: () => void;
  onRename: (name: string) => void;
  onColor: (color: GroupColor) => void;
  onDelete: () => void;
  /** A frame the user dragged or stretched. Placing one locks it by itself. */
  onGeometry: (geometry: { x: number; y: number; width: number; height: number }) => void;
  onLock: (locked: boolean) => void;
};

/** Not "group": React Flow ships built-in styling for that type name, which
 * paints a pale block over everything the frame is meant to sit behind. */
export type GroupNodeType = Node<GroupData, 'frame'>;

/**
 * The palette, spelled out again rather than imported from
 * `src/project/groups.ts`: that module reaches for node:fs and must never enter
 * the browser bundle. A Record keyed by GroupColor is what keeps the two in
 * step — a colour added to the union fails to compile here until it is listed.
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
 * The frame behind a set of boxes. It is a suggestion until someone says
 * otherwise, so an unaccepted one is dashed and dimmed, and carries the two
 * decisions rather than assuming either.
 *
 * A group someone drew by hand is marked as such wherever it is drawn. Its
 * membership did not come from the imports, and a frame that looks exactly like
 * a derived one would claim an authority the graph never gave it.
 */
/**
 * Drawn rather than an emoji. An emoji is full-colour and sized by the font, so
 * it sat in this chrome as a bright sticker that ignored the group's own colour
 * — this takes currentColor and therefore the frame's.
 */
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path
        d={locked ? 'M4 5.6V3.9a2 2 0 1 1 4 0v1.7' : 'M4 5.6V3.9a2 2 0 1 1 4 0'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <rect x="2.1" y="5.5" width="7.8" height="5.2" rx="1" fill="currentColor" />
    </svg>
  );
}

export function GroupNode({ data }: NodeProps<GroupNodeType>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.name ?? '');

  const stop = (event: MouseEvent) => event.stopPropagation();
  const manual = data.origin === 'manual';

  /**
   * Naming a suggestion is what accepts it. Naming a group that has already
   * been decided is a rename, which travels by id — the group keeps its
   * identity, where re-accepting it would go back through member overlap and
   * could land the name on a neighbour instead.
   */
  const commit = (name: string) => {
    if (data.accepted || manual) data.onRename(name);
    else data.onAccept(name);
  };

  /**
   * Stretching a frame is what locks it. A size someone dragged that the next
   * relayout threw away would be worse than not offering the handle at all, and
   * a separate "now keep it" step is a step nobody would find.
   */
  const resize = (_: unknown, box: { x: number; y: number; width: number; height: number }) => {
    data.onGeometry({ x: box.x, y: box.y, width: box.width, height: box.height });
  };


  return (
    <div
      className={[
        'group',
        `group-depth-${data.depth}`,
        data.accepted ? 'group-accepted' : '',
        manual ? 'group-manual' : '',
        data.locked ? 'group-locked' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-color={data.color ?? undefined}
    >
      {/* Handles on every edge and corner. Shown while the group is being
          edited or already held in place — always-on handles across a dozen
          overlapping frames would be a field of dots to catch by accident. */}
      <NodeResizer
        isVisible={editing || data.locked}
        minWidth={110}
        minHeight={70}
        onResizeEnd={resize}
        lineClassName="group-resize-line"
        handleClassName="group-resize-dot"
      />

      <div className="group-label" onMouseDown={stop} onClick={stop}>
        {/* The label is the handle for the whole group. It used to take two
            gestures — click the name to rename, find a separate ◍ to reach the
            colours — which meant the obvious thing to click did the least. The
            frame itself cannot be the target: it is drawn behind the boxes it
            encloses and would swallow every click meant for them. */}
        <button
          type="button"
          className={editing ? 'group-name group-name-open' : 'group-name'}
          aria-expanded={editing}
          title={editing ? 'Done' : 'Edit this group'}
          onClick={() => setEditing(!editing)}
        >
          {data.name ?? `${data.fileCount} files together`}
        </button>

        {/* A hand-drawn group carries a cohesion of 0, and printing that as 0%
            would read as a terrible group rather than as one the import graph
            was never asked to find. */}
        <span className="group-meta">
          {manual ? 'by hand' : `${Math.round(data.cohesion * 100)}%`}
        </span>

        {(data.accepted || manual) && (
          <button
            type="button"
            className="group-lock"
            aria-pressed={data.locked}
            title={
              data.locked
                ? 'Held where you put it — click to let it hug its members again'
                : 'Hugging its members — drag an edge, or click to hold it here'
            }
            onClick={() => data.onLock(!data.locked)}
          >
            <LockIcon locked={data.locked} />
          </button>
        )}

        {/* A locked frame is where someone put it, which means it can stop
            containing what it names. Saying so is the price of the lock. */}
        {data.locked && data.outside > 0 && (
          <span className="group-outside" title={`${data.outside} of this group's files sit outside the frame`}>
            ⚠ {data.outside} outside
          </span>
        )}

        {!data.accepted && !manual && (
          <button type="button" className="group-reject" title="Not a group" onClick={data.onReject}>
            ✕
          </button>
        )}

        {/* Beside the label rather than dropping below it: a frame renders
            behind the boxes it encloses, so a popover hanging into the diagram
            would be hidden by them. The strip above the members is empty by
            construction — it is the padding the frame already reserves. */}
        {editing && (
          <div className="group-editor">
            {/* Escape closes it too, but a popover with no visible way out reads
                as something that went wrong rather than something you opened. */}
            <div className="group-editor-top">
              <input
                autoFocus
                className="group-editor-name"
                value={draft}
                placeholder="Name this group"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && draft.trim() !== '') {
                    commit(draft.trim());
                    setEditing(false);
                  } else if (event.key === 'Escape') {
                    setEditing(false);
                  }
                }}
              />
              <button
                type="button"
                className="group-editor-close"
                title="Done (Esc)"
                onClick={() => setEditing(false)}
              >
                ✕
              </button>
            </div>

            {/* Only a decided group has an entry in groups.json to carry a
                colour or a size, so a suggestion is offered the one act that
                creates one. */}
            {data.accepted || manual ? (
              <>
                <div className="group-swatches">
                  {(Object.keys(COLOR_LABELS) as GroupColor[]).map((color) => (
                    <button
                      key={color}
                      type="button"
                      data-color={color}
                      className={`group-swatch${data.color === color ? ' group-swatch-active' : ''}`}
                      title={COLOR_LABELS[color]}
                      onClick={() => data.onColor(color)}
                    />
                  ))}
                </div>

                <div className="group-editor-foot">
                  <span className="group-editor-hint">
                    {data.fileCount} files · drag an edge to place it
                  </span>
                  {manual && (
                    <button
                      type="button"
                      className="group-delete"
                      title="Delete this group"
                      onClick={data.onDelete}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="group-editor-hint">Naming it is what accepts it.</div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
