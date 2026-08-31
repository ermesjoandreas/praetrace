import { useEffect, useRef, useState } from 'react';
import { isDesktop, pickProject, recentProjects } from './api';

/** Two trailing segments identify a project without filling the header. */
function shorten(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.slice(-2).join('/') || path;
}

export function ProjectMenu({ root, onSwitch }: { root: string; onSwitch: (path: string) => void }) {
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
      <button type="button" className="project-button" onClick={() => setOpen((was) => !was)} title={root}>
        {shorten(root)}
        <span className="chevron">▾</span>
      </button>

      {open && (
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
