import { useEffect, useRef, useState } from 'react';
import type { AgentCall, ViewGraph } from './api';
import { AgentStatus } from './AgentStatus';

/**
 * The three bases the server accepts, and the words each one gets. One list
 * because three things read it — the picker, the chip and the View menu — and
 * they must never disagree about what a base is called or which is in force.
 */
export const GIT_BASES = [
  { value: 'HEAD', option: 'uncommitted', chip: 'HEAD', menu: 'Compare against uncommitted changes' },
  { value: 'HEAD~1', option: '+ last commit', chip: 'HEAD~1', menu: 'Compare against the last commit too' },
  { value: 'branch', option: 'whole branch', chip: 'the branch', menu: 'Compare against the whole branch' },
] as const;

/**
 * Files in a language nothing here reads. Said out loud rather than left to be
 * inferred from a thin diagram, because that inference never happens: a graph
 * missing a fifth of its source does not look broken, it looks like code with
 * no coupling — exactly the picture this all exists to stop drawing.
 */
export interface Unreadable {
  files: number;
  /** "12 .py", biggest first. */
  kinds: string[];
  /** Every language the tool understands, for saying what is missing against. */
  reads: string[];
}

interface StatusBarProps {
  /** null when the project is not a git work tree, which is normal, not a fault. */
  git: ViewGraph['git'];
  /** What the bar calls the base — 'HEAD', 'HEAD~1' or 'the branch'. */
  baseLabel: string;
  onlyChanged: boolean;
  onToggleChanged: () => void;
  onChangeBase: (base: string) => void;
  /** Whether the websocket is up, so updates arrive without a reload. */
  live: boolean;
  /** "12 boxes · 40 files", or '' until the first view has loaded. */
  counts: string;
  /** "TypeScript 479 · JavaScript 31", or '' when nothing was parsed. */
  languages: string;
  unreadable: Unreadable | null;
  agentLast: AgentCall | null;
  agentTotal: number;
}

/**
 * The bottom row: the project's state in one line, the way an editor's status
 * bar reads. Left is what the working tree is — connected or not, which branch,
 * how much differs, what could not be read. Right is what is on screen and who
 * else is looking at it. Every item is information or runs something; nothing
 * here is decoration.
 */
export function StatusBar({
  git,
  baseLabel,
  onlyChanged,
  onToggleChanged,
  onChangeBase,
  live,
  counts,
  languages,
  unreadable,
  agentLast,
  agentTotal,
}: StatusBarProps) {
  const [baseOpen, setBaseOpen] = useState(false);
  const baseMenu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!baseOpen) return;
    const away = (event: globalThis.MouseEvent) => {
      if (!baseMenu.current?.contains(event.target as Node)) setBaseOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setBaseOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [baseOpen]);

  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <span
          className={live ? 'status-item live live-on' : 'status-item live'}
          title={
            live
              ? 'Connected — the diagram updates as files change'
              : 'Disconnected from the server — reconnecting'
          }
        >
          <i
            className={live ? 'codicon codicon-radio-tower' : 'codicon codicon-debug-disconnect'}
            aria-hidden="true"
          />
          {live ? 'live' : 'disconnected'}
        </span>

        {git !== null && (
          // One control, two segments: what the tree is compared against, and
          // how much differs. The shape is VS Code's status bar and GitHub's
          // branch button, because a developer can already read it — and the
          // dropdown is this app's own menu, so one gesture does not get two
          // visual languages.
          <div className="git" ref={baseMenu}>
            <button
              type="button"
              className={baseOpen ? 'status-item git-base git-base-open' : 'status-item git-base'}
              aria-expanded={baseOpen}
              onClick={() => setBaseOpen((was) => !was)}
              title={`Comparing against ${git.base}${git.branch === null ? '' : ` on ${git.branch}`}`}
            >
              <i className="codicon codicon-git-branch git-icon" aria-hidden="true" />
              <span className="git-base-name">{git.branch ?? baseLabel}</span>
              <i className="codicon codicon-chevron-down git-caret" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="status-item git-count"
              aria-pressed={onlyChanged}
              onClick={onToggleChanged}
              // The count is git's, not the diagram's: it includes deleted files
              // that have no box and untracked files the graph never parses.
              title={
                onlyChanged
                  ? `Showing only what differs from ${git.base} — click to show every file`
                  : `${git.changed === 1 ? '1 path differs' : `${git.changed} paths differ`} from ${
                      git.base
                    } — click to show only those`
              }
            >
              <span className="git-count-n">{git.changed}</span>
              <span className="git-count-word">changed vs {baseLabel}</span>
            </button>

            {/* The base is a session setting, not a view. One server watches one
                project and runs git against one base, so a base carried in the
                URL would promise a per-tab comparison nothing can honour — the
                same reason the project root is not in the URL either. */}
            {baseOpen && (
              <div className="menu-drop menu-drop-up git-drop">
                <div className="git-drop-head">Compare against</div>
                {GIT_BASES.map((base) => (
                  <button
                    key={base.value}
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setBaseOpen(false);
                      onChangeBase(base.value);
                    }}
                  >
                    <span className="menu-check">
                      {git.requested === base.value && (
                        <i className="codicon codicon-check" aria-hidden="true" />
                      )}
                    </span>
                    <span className="menu-label">{base.option}</span>
                    <kbd>{base.chip}</kbd>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {unreadable !== null && (
          <span
            className="status-item unread"
            title={`codemap cannot read ${unreadable.files} ${
              unreadable.files === 1 ? 'file' : 'files'
            } here (${unreadable.kinds.join(
              ', ',
            )}), so nothing they declare or import is in this graph. It reads ${unreadable.reads.join(
              ', ',
            )}.`}
          >
            <i className="codicon codicon-warning" aria-hidden="true" />
            {/* What it means first, then what it was: the row is scanned left
                to right, and three kinds are what fits. The rest are in the
                tooltip, with a count so a fourth cannot hide behind the
                truncation. */}
            not read: {unreadable.kinds.slice(0, 3).join(' · ')}
            {unreadable.kinds.length > 3 ? ` +${unreadable.kinds.length - 3}` : ''}
          </span>
        )}
      </div>

      <div className="statusbar-right">
        {counts !== '' && <span className="status-item counts">{counts}</span>}
        {languages !== '' && (
          <span className="status-item langs" title="What codemap parsed here, biggest first">
            {languages}
          </span>
        )}
        <AgentStatus last={agentLast} total={agentTotal} />
      </div>
    </footer>
  );
}
