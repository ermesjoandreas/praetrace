import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * VS Code's sash, and its gesture, because that is the app this one is styled
 * after and the one people already have in their hands.
 *
 * It is a 4px grab area straddling the 1px line DESIGN.md rule 2 already puts
 * between two regions — the line does not move and no handle is drawn, so a
 * window nobody is resizing looks exactly as it did. It takes the accent under
 * the cursor and while being dragged, and only then; rule 5.
 *
 * The element has no size of its own, and the hit area is a pseudo-element
 * overlapping both sides of the boundary — see the sash block in styles.css
 * for where each kind is placed and why. Either way it is positioned by the
 * boundary itself rather than against the stored size, because that would be
 * two places that have to agree about where the edge is and one of them would
 * eventually be wrong.
 *
 * This component knows nothing about panes. It reports a size in pixels; what
 * that size means, what it may not go below, and where it is kept is the
 * model's, in `panes.ts`.
 */

/**
 * How far one arrow press moves a sash, and how far one with Shift moves it.
 *
 * 4px is the one target on this page a person with a tremor cannot hit, which
 * is why the keyboard reaches it at all — so the coarse step has to cross a
 * 300px bar in a plausible number of presses, and the fine one has to be able
 * to land on an exact pixel.
 */
const STEP = 8;
const FINE_STEP = 1;

export function Sash({
  orientation,
  label,
  value,
  min,
  max,
  onStart,
  onDrag,
  onCommit,
  onReset,
  governs = 'before',
}: {
  /** `vertical` separates two columns and is dragged sideways; `horizontal` separates two rows. */
  orientation: 'vertical' | 'horizontal';
  /** What this sash resizes, for a screen reader: "Repository height", "Side bar width". */
  label: string;
  /** The current size, in pixels, of the pane this sash governs. */
  value: number;
  min: number;
  max: number;
  /**
   * A drag is beginning, before anything has moved. The parent gets one render
   * here for whatever it cannot do from a pointer move — the bars need nothing,
   * but a section's stack has to be taken over from the stylesheet first, and
   * that is a state change rather than a style. A key press has no such phase
   * and does not call it: one press is already the whole gesture.
   */
  onStart?: () => void;
  /**
   * Live, on every pointer move. The parent is expected to put this on screen
   * without going through React — see the note on `dragging` in App.tsx.
   */
  onDrag: (next: number) => void;
  /** The end of the gesture, with the size to keep. This is what gets stored. */
  onCommit: (next: number) => void;
  /** Double-click, and Home: this one pane back to its default. */
  onReset: () => void;
  /**
   * Which side of the line the reported size belongs to. The left bar is
   * *before* its sash, so dragging right grows it; the side bar is *after*
   * its own, so dragging right shrinks it.
   */
  governs?: 'before' | 'after';
}) {
  const [dragging, setDragging] = useState(false);
  /**
   * Where the pointer went down and how big the pane was then. Every move is
   * measured from that anchor rather than from the last move, so a pane held
   * at its minimum does not accumulate the pixels it refused and then jump
   * when the pointer comes back.
   */
  const anchor = useRef<{ at: number; size: number } | null>(null);

  const vertical = orientation === 'vertical';

  // While a drag is on, the pointer is over whatever it is over — the canvas,
  // a list row, a button — and every one of those has a cursor and a selection
  // of its own. The document wears the resize cursor until the gesture ends.
  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    const cursor = vertical ? 'sashing-col' : 'sashing-row';
    root.classList.add(cursor);
    return () => root.classList.remove(cursor);
  }, [dragging, vertical]);

  const sizeAt = (event: { clientX: number; clientY: number }): number => {
    const from = anchor.current;
    if (from === null) return value;
    const moved = (vertical ? event.clientX : event.clientY) - from.at;
    return from.size + (governs === 'before' ? moved : -moved);
  };

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Pointer capture, so the drag follows the pointer off the 4px strip and
    // across the canvas. Without it the resize drops the moment the cursor
    // outruns the strip, which is most of the time.
    event.currentTarget.setPointerCapture(event.pointerId);
    anchor.current = { at: vertical ? event.clientX : event.clientY, size: value };
    setDragging(true);
    onStart?.();
    event.preventDefault();
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (anchor.current === null) return;
    // A drag whose pointerup never arrived — a crashed tab, a lost capture, a
    // gesture that ended over a native menu — left the whole document in
    // resize mode and let a bare hover keep moving the border. The button
    // state is the one thing that says the gesture is over, so it is checked
    // on every move rather than trusted to arrive as an event.
    if (event.buttons === 0) {
      end(event, sizeAt(event));
      return;
    }
    onDrag(sizeAt(event));
  };

  /** The one way out of a drag, so no path can leave the page mid-gesture. */
  const end = (event: ReactPointerEvent<HTMLDivElement>, size: number) => {
    anchor.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit(size);
  };

  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (anchor.current === null) return;
    end(event, sizeAt(event));
  };

  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      event.preventDefault();
      onReset();
      return;
    }
    const back = vertical ? 'ArrowLeft' : 'ArrowUp';
    const forward = vertical ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    const step = event.shiftKey ? FINE_STEP : STEP;
    const moved = event.key === forward ? step : -step;
    // A press is one discrete change, not a stream, so it is committed at
    // once — there is no gesture to wait for the end of.
    onCommit(value + (governs === 'before' ? moved : -moved));
  };

  return (
    <div
      className={dragging ? 'sash sash-dragging' : 'sash'}
      data-orientation={orientation}
      // Which side of the sash the 1px line is on, so the accent lands on the
      // border that is already there rather than beside it.
      data-governs={governs}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onReset}
      onKeyDown={key}
    />
  );
}
