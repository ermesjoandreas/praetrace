import { useEffect, useState } from 'react';
import { isDesktop, pickProject, recentProjects } from './api';

/**
 * What the window shows before there is anything to draw. Actions, not prose:
 * every line here does something, and the shortcuts are the ones that work.
 */
export function Welcome({
  onOpen,
  onSearch,
  hookInstalled,
  onInstallHook,
  onClose,
  unreadable,
}: {
  onOpen: (path: string) => void;
  onSearch: () => void;
  hookInstalled: boolean | null;
  onInstallHook: () => void;
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
          <button type="button" className="welcome-close" onClick={onClose} title="Close (esc)">
            ✕
          </button>
        )}
        <h1>codemap</h1>
        <p className="welcome-sub">A live map of a codebase while an agent changes it.</p>

        {unreadable !== null && (
          <p className="welcome-warn">
            codemap cannot read {unreadable.files} of the files here (
            {unreadable.kinds.join(', ')}), so nothing they declare or import is in the graph. It
            reads {unreadable.reads.join(', ')}.
          </p>
        )}

        <div className="welcome-columns">
          <section>
            <h2>Start</h2>
            {isDesktop ? (
              <button
                type="button"
                className="welcome-action"
                onClick={() => void pickProject().then((picked) => picked && onOpen(picked))}
              >
                Open folder… <kbd>⌘O</kbd>
              </button>
            ) : (
              <p className="welcome-note">
                Point the CLI at a directory: <code>npm run serve -- ~/your-project</code>
              </p>
            )}

            {recents.length > 0 && (
              <>
                <h3>Recent</h3>
                {recents.map((path) => (
                  <button type="button" key={path} className="welcome-recent" onClick={() => onOpen(path)} title={path}>
                    {path.split('/').slice(-2).join('/')}
                  </button>
                ))}
              </>
            )}
          </section>

          <section>
            <h2>Next</h2>
            {hookInstalled === false && (
              <button type="button" className="welcome-action" onClick={onInstallHook}>
                Install the Claude Code hook
              </button>
            )}
            <button type="button" className="welcome-action" onClick={onSearch}>
              Find a file or symbol <kbd>⌘K</kbd>
            </button>
            <p className="welcome-note">
              Click a box to see what depends on it. Double-click to go into it.
            </p>
          </section>

          <section>
            <h2>Keys</h2>
            <table className="welcome-keys">
              <tbody>
                {[
                  ['⌘K', 'Search'],
                  ['⌘B', 'Toggle panel'],
                  ['⌘O', 'Open project'],
                  ['⌘[  ⌘]', 'Back, forward'],
                  ['⇧⌘F', 'Fit to screen'],
                  ['⎋', 'Clear selection'],
                ].map(([key, what]) => (
                  <tr key={key}>
                    <td>
                      <kbd>{key}</kbd>
                    </td>
                    <td>{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
