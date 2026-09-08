import { useEffect, useRef, useState } from 'react';
import { isDesktop, pickProject, recentProjects } from './api';

/** Two trailing segments identify a project without filling the header. */
function shorten(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.slice(-2).join('/') || path;
}

export function ProjectMenu({
  root,
  opening,
  onSwitch,
}: {
  root: string;
  /**
   * The project a switch is on its way to, or null. Opening one is a whole boot
   * scan, and on a large tree that is minutes; this is the only place on screen
   * that says a click was heard, so it names the folder rather than spinning.
   */
  opening: string | null;
  onSwitch: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const container = useRef<HTMLDivElement>(null);

  // A browser tab has no folder picker, and the CLI already chose the project.
  useEffect(() => {
    if (!open) return;
    void recentProjects().then(setRecents, () => setRecents([]));
  }, [open, root]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: globalThis.MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!isDesktop) return <span className="root">{root}</span>;

  const others = recents.filter((path) => path !== root);

  return (
    <div className="project" ref={container}>
      {opening !== null ? (
        // Not the same button greyed out: a disabled control still reads as the
        // thing you just pressed, and what has to be said here is that the
        // press landed and the scan is running. The menu is not offered while
        // it is — a second switch queues behind this one on the server.
        <span className="project-button project-opening" title={opening}>
          <i className="codicon codicon-sync spin" aria-hidden="true" />
          Opening {shorten(opening)}…
        </span>
      ) : (
        <button type="button" className="project-button" onClick={() => setOpen((was) => !was)} title={root}>
          {shorten(root)}
          <i className="codicon codicon-chevron-down chevron" aria-hidden="true" />
        </button>
      )}

      {open && opening === null && (
        <div className="project-menu">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void pickProject().then((picked) => {
                if (picked !== null) onSwitch(picked);
              });
            }}
          >
            Open folder…
          </button>

          {others.length > 0 && <div className="project-sep">Recent</div>}
          {others.map((path) => (
            <button
              type="button"
              key={path}
              title={path}
              onClick={() => {
                setOpen(false);
                onSwitch(path);
              }}
            >
              {shorten(path)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
