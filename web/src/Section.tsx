import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * What the sashes know about one section, handed down from App because that is
 * where the layout lives. A section that the sashes do not govern — the two
 * inside Source Control — gets `null` and keeps the folded state it always had.
 *
 * Folding is here rather than in the section's own state because a sash dragged
 * shut and a chevron clicked shut have to land in the same place. The model
 * says a section folded to 22px *is* folded (`isFolded`), so if the chevron
 * kept its own answer the two would disagree the moment either was used: a
 * header claiming to be expanded over nothing, or a body rendered into a pane
 * with no room to show it.
 */
export interface SectionPane {
  /**
   * `null` while the stylesheet's shares still draw this bar: nobody has
   * dragged a sash in it, there are no pixels to be folded to, and the fold is
   * the section's own the way it always was.
   */
  folded: boolean | null;
  setFolded: (folded: boolean) => void;
  /** The sash on this section's top edge. Absent on the first section in a bar. */
  sash: ReactNode;
}

/** Looks a section up by the class it is placed with, which is already its id. */
export const SectionPanes = createContext<(className: string) => SectionPane | null>(() => null);

/**
 * A side bar section the way VS Code draws one: a 22px header carrying a
 * chevron, a title and, at its right edge, the section's actions —
 * kept out of sight until the header is hovered, and not rendered at all while
 * the section is folded. That last part is what stops an action from putting
 * something into a body that is not on screen.
 *
 * The chevron folds the section for real. One that only ever pointed down
 * would be decoration, and nothing in this interface is allowed to be.
 */
export function Section({
  title,
  className,
  status,
  actions,
  expandWhen,
  children,
}: {
  title: string;
  /** The class the region already had, so the rules that place it keep applying. */
  className: string;
  /** Always shown, unlike the actions: a state is not something to hunt for. */
  status?: ReactNode;
  actions?: ReactNode;
  /**
   * Something outside wants the body on screen: a menu item that puts a form
   * inside it. A folded section would swallow that silently — the form mounts
   * nowhere, its onBlur never fires, and the state that opened it never resets.
   */
  expandWhen?: boolean;
  children: ReactNode;
}) {
  const pane = useContext(SectionPanes)(className);
  /**
   * Only for a section outside the layout. For one inside it the fold is a
   * height, and a height belongs to the bar it is a share of — not to a
   * component that would forget it every time its parent stopped rendering.
   */
  const [ownOpen, setOwnOpen] = useState(true);
  const open = pane === null || pane.folded === null ? ownOpen : !pane.folded;
  // Both, always. While the shares are in charge a fold is the section's own
  // state; once a sash has been dragged it is a height, and the stack is
  // adopted at the heights on screen — so a section already folded by its
  // chevron is taken over at 22px and the two answers start out agreeing
  // rather than having to be reconciled afterwards.
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    pane?.setFolded(!next);
  };

  useEffect(() => {
    if (expandWhen) setOpen(true);
  }, [expandWhen]);

  return (
    <section className={`sidebar-section ${className}`}>
      {pane?.sash}
      <header className="section-head">
        <button
          type="button"
          className="section-title"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <i className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
          {title}
        </button>
        {status}
        {open && actions ? <div className="section-actions">{actions}</div> : null}
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}
