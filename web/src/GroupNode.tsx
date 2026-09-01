import { useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { useStore, type Node, type NodeProps } from '@xyflow/react';
import type { GroupColor } from './api';
import { MAX_PADDING, MIN_PADDING, defaultPadding } from './layout';

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
  onAccept: (name: string) => void;
  onReject: () => void;
  onRename: (name: string) => void;
  onColor: (color: GroupColor) => void;
  onPadding: (padding: { x: number; y: number }) => void;
  onDelete: () => void;
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

const clamp = (value: number): number =>
  Math.round(Math.min(MAX_PADDING, Math.max(MIN_PADDING, value)));

/**
 * The frame behind a set of boxes. It is a suggestion until someone says
 * otherwise, so an unaccepted one is dashed and dimmed, and carries the two
 * decisions rather than assuming either.
 *
 * A group someone drew by hand is marked as such wherever it is drawn. Its
 * membership did not come from the imports, and a frame that looks exactly like
 * a derived one would claim an authority the graph never gave it.
 */
export function GroupNode({ data }: NodeProps<GroupNodeType>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.name ?? '');

  const stop = (event: MouseEvent) => event.stopPropagation();
  const manual = data.origin === 'manual';
  const padding = data.padding ?? defaultPadding(data.depth);

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

  // The drag is in screen pixels, the frame in graph units: at half zoom the
  // corner would otherwise run away from the cursor at twice its speed.
  const zoom = useStore((state) => state.transform[2]);

  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const from = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null);

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    // React Flow pans the canvas on a pointerdown that reaches the pane.
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    from.current = { pointerX: event.clientX, pointerY: event.clientY, ...padding };
    setDrag(padding);
  };

  const moveResize = (event: PointerEvent<HTMLButtonElement>) => {
    const origin = from.current;
    if (origin === null) return;
    event.stopPropagation();
    setDrag({
      x: clamp(origin.x + (event.clientX - origin.pointerX) / zoom),
      y: clamp(origin.y + (event.clientY - origin.pointerY) / zoom),
    });
  };

  /** One write per gesture: every change costs a re-layout and a file in the
   * project, and a drag would otherwise spend a hundred of both. */
  const endResize = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    from.current = null;
    setDrag(null);
    if (drag !== null && (drag.x !== padding.x || drag.y !== padding.y)) data.onPadding(drag);
  };

  // The committed size arrives a round trip later, so the frame grows under the
  // cursor on its own until then. Nothing else is laid out from this.
  const preview: CSSProperties | undefined =
    drag === null
      ? undefined
      : {
          marginLeft: padding.x - drag.x,
          marginTop: padding.y - drag.y,
          width: `calc(100% + ${(drag.x - padding.x) * 2}px)`,
          height: `calc(100% + ${(drag.y - padding.y) * 2}px)`,
        };

  return (
    <div
      className={[
        'group',
        `group-depth-${data.depth}`,
        data.accepted ? 'group-accepted' : '',
        manual ? 'group-manual' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-color={data.color ?? undefined}
      style={preview}
    >
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
                    {data.fileCount} files · drag the corner to resize
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

      {/* The frame hugs its members, so the corner drags the slack around them
          rather than an absolute size — the boxes decide where it goes, a
          person decides how much room it gets. */}
      {editing && (
        <button
          type="button"
          className="group-resize"
          title={`Padding ${(drag ?? padding).x} × ${(drag ?? padding).y}`}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          // The canvas pans from a mousedown, which is a separate event from
          // the pointerdown the drag itself runs on.
          onMouseDown={stop}
          onClick={stop}
        />
      )}
    </div>
  );
}
