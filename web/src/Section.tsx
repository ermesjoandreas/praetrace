import { useEffect, useState, type ReactNode } from 'react';

/**
 * A side bar section the way VS Code draws one: a 22px header carrying a
 * chevron, a title and, at its right edge, the section's actions —
 * kept out of sight until the header is hovered, and not rendered at all while
 * the section is folded. That last part is what stops an action from putting
 * something into a body that is not on screen.
 *
 * The chevron folds the section for real. One that only ever pointed down
 * would be decoration, and nothing in this interface is allowed to be. The
 * folded state is the section's own: nothing outside needs it, and it is not
 * worth remembering across a reload.
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
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (expandWhen) setOpen(true);
  }, [expandWhen]);

  return (
    <section className={`sidebar-section ${className}`}>
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
