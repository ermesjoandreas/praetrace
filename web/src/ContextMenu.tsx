import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MenuItem } from './MenuBar';

/**
 * The menu that opens where you right-clicked.
 *
 * It renders the same `MenuItem` the menu bar does, in the same chrome, so the
 * two are one vocabulary rather than two: an item that is greyed with a reason
 * up top is greyed with the same reason down here. What differs is only which
 * items are offered, and that is decided by what was under the cursor.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });

  // Flipped back inside the window when it would hang off an edge. Measured
  // after mount because the height depends on how many items this context has.
  useLayoutEffect(() => {
    const box = panel.current?.getBoundingClientRect();
    if (!box) return;
    setAt({
      x: Math.max(6, Math.min(x, window.innerWidth - box.width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - box.height - 6)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const away = (event: globalThis.MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Capture, because React Flow stops pointer events on the pane before they
    // reach the document and the menu would then never close on a click away.
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  return (
    <div
      ref={panel}
      className="menu-drop context-menu"
      style={{ left: at.x, top: at.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          type="button"
          key={`${item.label}-${index}`}
          className={item.separatorBefore ? 'menu-item menu-sep' : 'menu-item'}
          title={item.disabledBecause}
          disabled={item.disabledBecause !== undefined}
          onClick={() => {
            onClose();
            item.run?.();
          }}
        >
          <span className="menu-check">{item.checked ? '✓' : ''}</span>
          <span className="menu-label">{item.label}</span>
          {item.shortcut !== undefined && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}
