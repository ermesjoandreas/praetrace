import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  shortcut?: string;
  run?: () => void;
  /** Shown ticked; still runnable. */
  checked?: boolean;
  /** Greyed out, with the reason in a tooltip. */
  disabledBecause?: string;
  separatorBefore?: boolean;
}

export interface Menu {
  title: string;
  items: MenuItem[];
}

/**
 * The menu bar is not decoration: every item runs something the app can already
 * do, and nothing is listed that it cannot. An entry that needs a selection is
 * greyed with the reason rather than silently doing nothing.
 */
export function MenuBar({ menus, trailing }: { menus: Menu[]; trailing?: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const close = (event: globalThis.MouseEvent) => {
      if (!bar.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="menubar" ref={bar}>
      <span className="menubar-brand">codemap</span>

      {menus.map((menu) => (
        <div className="menu" key={menu.title}>
          <button
            type="button"
            className={open === menu.title ? 'menu-title menu-title-open' : 'menu-title'}
            onClick={() => setOpen((current) => (current === menu.title ? null : menu.title))}
            // Once one menu is open, moving across the bar opens the others,
            // which is how every menu bar behaves.
            onMouseEnter={() => setOpen((current) => (current === null ? null : menu.title))}
          >
            {menu.title}
          </button>

          {open === menu.title && (
            <div className="menu-drop">
              {menu.items.map((item, index) => (
                <button
                  type="button"
                  key={`${item.label}-${index}`}
                  className={item.separatorBefore ? 'menu-item menu-sep' : 'menu-item'}
                  title={item.disabledBecause}
                  disabled={item.disabledBecause !== undefined}
                  onClick={() => {
                    setOpen(null);
                    item.run?.();
                  }}
                >
                  <span className="menu-check">{item.checked ? '✓' : ''}</span>
                  <span className="menu-label">{item.label}</span>
                  {item.shortcut !== undefined && <kbd>{item.shortcut}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="menubar-trailing">{trailing}</div>
    </div>
  );
}
