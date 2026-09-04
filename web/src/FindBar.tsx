import { useEffect, useRef } from 'react';
import { countLabel } from './find';

interface FindBarProps {
  /** What is typed. Held by the page, so the bar and the highlight cannot disagree. */
  query: string;
  onQuery: (query: string) => void;
  /** How many boxes the query matched in what is drawn. */
  matches: number;
  /** Which match the camera is on, as an index into them. */
  current: number;
  /** +1 for Enter and the down button, −1 for ⇧Enter and up. Wrapping is the page's. */
  onStep: (delta: number) => void;
  onClose: () => void;
  /**
   * Bumped by the page when ⌘F is pressed with the bar already open. An editor
   * takes the second press to mean "search for something else", so it selects
   * what is there rather than leaving the caret where the mouse put it.
   */
  focusToken?: number;
}

/**
 * ⌘F. VS Code has this and ⌘K both, and they do different jobs: ⌘K asks the
 * whole graph a question and takes you somewhere, this one marks what is
 * already drawn and takes you nowhere until you ask it to.
 *
 * So it owns no view. It does not filter, it does not move the camera on its
 * own, and it rides no URL — a highlight is not a view, and a link that
 * restored one would be describing the reader rather than the diagram.
 *
 * It reports and it steps; the highlight itself belongs to the page, which is
 * the only thing that knows which boxes are on screen.
 */
export function FindBar({
  query,
  onQuery,
  matches,
  current,
  onStep,
  onClose,
  focusToken,
}: FindBarProps) {
  const input = useRef<HTMLInputElement>(null);

  // select(), not focus(): it does both, and the second ⌘F is meant to replace
  // what is in the box.
  useEffect(() => {
    input.current?.select();
  }, [focusToken]);

  // On the bar rather than the input: Escape and Enter mean the same thing
  // with the caret in the box and with the focus ring on a step button.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      // Taken, so the page's own Escape does not also leave a frozen view or
      // drop the selection on the way out.
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
    }
  };

  const stuck = matches === 0;

  return (
    <div className="findbar" onKeyDown={onKeyDown}>
      <input
        ref={input}
        className="findbar-input"
        value={query}
        placeholder="Find in view"
        onChange={(event) => onQuery(event.target.value)}
      />
      <span className="findbar-count">{countLabel(query, matches, current)}</span>
      <button
        type="button"
        title="Previous match (⇧↵)"
        aria-label="Previous match"
        disabled={stuck}
        onClick={() => onStep(-1)}
      >
        <i className="codicon codicon-arrow-up" aria-hidden="true" />
      </button>
      <button
        type="button"
        title="Next match (↵)"
        aria-label="Next match"
        disabled={stuck}
        onClick={() => onStep(1)}
      >
        <i className="codicon codicon-arrow-down" aria-hidden="true" />
      </button>
      <button type="button" title="Close (⎋)" aria-label="Close find" onClick={onClose}>
        <i className="codicon codicon-close" aria-hidden="true" />
      </button>
    </div>
  );
}
