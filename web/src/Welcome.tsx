import { useEffect, useState } from 'react';
import { isDesktop, pickProject, recentProjects } from './api';

/**
 * What the window shows before there is anything to draw. Actions, not prose:
 * every line here does something, and the shortcuts are the ones that work.
 * The shape is VS Code's empty editor — a centred list of commands with their
 * keys on the right — so a row that runs on click is a button and a row that
 * only names a key is not.
 */
export function Welcome({
  onOpen,
  onSearch,
  onClose,
  unreadable,
}: {
  onOpen: (path: string) => void;
  onSearch: () => void;
  /** Null when there is no project to go back to, so there is nothing to close. */
  onClose: (() => void) | null;
  /**
   * Source this tool cannot read, or null when there is none. It is repeated
   * here because this screen is what a project of nothing but unreadable files
   * shows, and it covers the header where the same fact is reported — so
   * without it, the one project that most needs telling would be told nothing.
   */
  unreadable: { files: number; kinds: string[]; reads: string[] } | null;
}) {
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    if (!isDesktop) return;
    void recentProjects().then(setRecents, () => setRecents([]));
  }, []);

  return (
    <div className="welcome">
      <div className="welcome-inner">
        {onClose !== null && (
          <button
            type="button"
            className="welcome-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        )}

        {/* One line, because Help → "What this is" opens this screen. */}
        <p className="welcome-sub">codemap — a live map of a codebase while an agent changes it.</p>

        {unreadable !== null && (
          <p className="welcome-warn">
            <i className="codicon codicon-warning" aria-hidden="true" />
            <span>
              codemap cannot read {unreadable.files} of the files here (
              {unreadable.kinds.join(', ')}), so nothing they declare or import is in the graph.
              It reads {unreadable.reads.join(', ')}.
            </span>
          </p>
        )}

        <ul className="welcome-list">
          <li>
            {isDesktop ? (
              <button
                type="button"
                className="welcome-action"
                onClick={() => void pickProject().then((picked) => picked && onOpen(picked))}
              >
                <span className="welcome-label">Open folder…</span>
                <kbd>⌘O</kbd>
              </button>
            ) : (
              <span className="welcome-row">
                <span className="welcome-label">Open a project</span>
                <code>npm run serve -- ~/your-project</code>
              </span>
            )}
          </li>
          <li>
            <button type="button" className="welcome-action" onClick={onSearch}>
              <span className="welcome-label">Find a file or symbol</span>
              <kbd>⌘K</kbd>
            </button>
          </li>
          {[
            ['Toggle panel', '⌘B'],
            ['Back, forward', '⌘[ ⌘]'],
            ['Fit to screen', '⇧⌘F'],
            ['Clear selection', 'Esc'],
            ['Inspect a box', 'Click'],
            ['Go into a box', 'Double-click'],
          ].map(([what, key]) => (
            <li key={what}>
              <span className="welcome-row">
                <span className="welcome-label">{what}</span>
                <kbd>{key}</kbd>
              </span>
            </li>
          ))}
        </ul>

        {recents.length > 0 && (
          <>
            <h2>Recent</h2>
            <ul className="welcome-list">
              {recents.map((path) => {
                const parts = path.split('/');
                return (
                  <li key={path}>
                    <button type="button" className="welcome-recent" onClick={() => onOpen(path)} title={path}>
                      <span className="welcome-label">{parts[parts.length - 1]}</span>
                      <span className="welcome-path">{parts.slice(0, -1).join('/')}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
