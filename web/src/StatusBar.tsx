import { useEffect, useRef, useState } from 'react';
import {
  describeUnresolved,
  type AgentCall,
  type RemoteStatus,
  type Unresolved,
  type ViewGraph,
} from './api';
import { AgentStatus } from './AgentStatus';

/**
 * The three bases the server accepts, and the words each one gets. One list
 * because three things read it — the picker, the chip and the View menu — and
 * they must never disagree about what a base is called or which is in force.
 *
 * The words are git's own. A developer reads "HEAD~1" in their terminal every
 * day, and a friendlier paraphrase would be one more vocabulary to learn.
 */
export const GIT_BASES = [
  { value: 'HEAD', label: 'HEAD', hint: 'uncommitted changes', menu: 'Diff against HEAD' },
  { value: 'HEAD~1', label: 'HEAD~1', hint: 'and the last commit', menu: 'Diff against HEAD~1' },
  { value: 'branch', label: 'merge base', hint: 'the whole branch', menu: 'Diff against the merge base' },
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
  /** What the bar calls the base — 'HEAD', 'HEAD~1' or 'merge base'. */
  baseLabel: string;
  /** null when there is no git, or no remote to be ahead of or behind. */
  remote: RemoteStatus | null;
  onlyChanged: boolean;
  onToggleChanged: () => void;
  onChangeBase: (base: string) => void;
  /**
   * The diagram is a past commit's. The bar still describes now — the branch
   * and the changes are the working tree's, whatever is drawn — but a filter
   * that keeps only what differs from the base has nothing to keep in a graph
   * that has no working tree, so the toggle is greyed rather than emptying it.
   */
  frozen: boolean;
  /** Whether the websocket is up, so updates arrive without a reload. */
  live: boolean;
  /** "12 boxes · 40 files", or '' until the first view has loaded. */
  counts: string;
  /** "TypeScript 479 · JavaScript 31", or '' when nothing was parsed. */
  languages: string;
  unreadable: Unreadable | null;
  /**
   * Test files the `tests=0` filter took off the diagram, project-wide. 0 when
   * the filter is off. Said beside the file count because that count just
   * shrank, and a diagram that lost its suite without a word would read as a
   * project that has none.
   */
  hiddenTests: number;
  /** Turn the filter off again. */
  onShowTests: () => void;
  /** Files the parser could not fully read. Their boxes carry the badge; this is the total. */
  parseErrors: number;
  /**
   * Every reference the drawn boxes could not follow — `totalUnresolved`. null
   * when they followed all of them, which is what a healthy project says.
   *
   * Beside "not read" and the syntax errors because it is the same kind of
   * fact: source the graph holds less of than the box count suggests. It is
   * the largest of the three by far — zod 2 966, TanStack/query 4 728 — and
   * until it was counted it was the only one that was invisible.
   */
  unresolved?: Unresolved | null;
  agentLast: AgentCall | null;
  agentTotal: number;
}

/**
 * The bottom row: the project's state in one line, the way an editor's status
 * bar reads. Left is what the working tree is — connected or not, which branch,
 * how far from the remote, how much differs, what could not be read. Right is
 * what is on screen and who else is looking at it. Every item is information
 * or runs something; nothing here is decoration.
 */
export function StatusBar({
  git,
  baseLabel,
  remote,
  onlyChanged,
  onToggleChanged,
  onChangeBase,
  frozen,
  live,
  counts,
  languages,
  unreadable,
  hiddenTests,
  onShowTests,
  parseErrors,
  unresolved = null,
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
      if (event.key !== 'Escape') return;
      // Taken: the page's own Escape must not also leave a frozen view.
      event.preventDefault();
      setBaseOpen(false);
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
          // The shape is VS Code's status bar, because a developer can already
          // read it: the branch, then how far it is from its upstream, then the
          // changes as a badge — and the dropdown is this app's own menu, so
          // one gesture does not get two visual languages.
          <div className="git" ref={baseMenu}>
            <button
              type="button"
              className={baseOpen ? 'status-item git-base git-base-open' : 'status-item git-base'}
              aria-expanded={baseOpen}
              onClick={() => setBaseOpen((was) => !was)}
              title={`${git.branch ?? 'detached HEAD'} · diff against ${git.base} — click to change the base`}
            >
              <i className="codicon codicon-git-branch git-icon" aria-hidden="true" />
              <span className="git-base-name">{git.branch ?? baseLabel}</span>
              <i className="codicon codicon-chevron-down git-caret" aria-hidden="true" />
            </button>

            {/* Only with an upstream: 0 ahead of nothing is not a fact.
                Information, not a control — the Fetch button is in the
                Repository panel, and one fetch path is enough. */}
            {remote !== null && remote.upstream !== null && (
              <span
                className="status-item git-sync"
                title={`${remote.ahead} ahead, ${remote.behind} behind ${remote.upstream}${
                  remote.fetchedAt === null ? ' — never fetched' : ''
                }`}
              >
                <i className="codicon codicon-arrow-small-up" aria-hidden="true" />
                <span className="git-sync-n">{remote.ahead}</span>
                <i className="codicon codicon-arrow-small-down" aria-hidden="true" />
                <span className="git-sync-n">{remote.behind}</span>
              </span>
            )}

            <button
              type="button"
              className={frozen ? 'status-item git-count git-count-frozen' : 'status-item git-count'}
              aria-pressed={onlyChanged}
              // aria-disabled rather than disabled: a disabled button gives no
              // tooltip, and the tooltip is where the reason lives.
              aria-disabled={frozen}
              onClick={frozen ? undefined : onToggleChanged}
              // The count is git's, not the diagram's: it includes deleted files
              // that have no box and untracked files the graph never parses.
              title={
                frozen
                  ? `${git.changed === 1 ? '1 change' : `${git.changed} changes`} in the working tree now · diff against ${
                      git.base
                    } — a past commit has none, so this cannot filter the diagram`
                  : onlyChanged
                    ? `Showing only the ${git.changed === 1 ? 'change' : `${git.changed} changes`} · diff against ${
                        git.base
                      } — click to show every file`
                    : `${git.changed === 1 ? '1 change' : `${git.changed} changes`} · diff against ${
                        git.base
                      } — click to show only those`
              }
            >
              <span className="git-count-word">Changes</span>
              <span className="git-count-badge">{git.changed}</span>
            </button>

            {/* The base is a session setting, not a view. One server watches one
                project and runs git against one base, so a base carried in the
                URL would promise a per-tab comparison nothing can honour — the
                same reason the project root is not in the URL either. */}
            {baseOpen && (
              <div className="menu-drop menu-drop-up git-drop">
                <div className="git-drop-head">Diff against</div>
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
                    <span className="menu-label">{base.label}</span>
                    <span className="git-drop-hint">{base.hint}</span>
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

        {/* Beside "not read", because it is the same kind of fact: source the
            graph holds less of than the box count suggests. A file with a
            syntax error keeps its box and loses its symbols, silently, until
            this said so. */}
        {parseErrors > 0 && (
          <span
            className="status-item parse-errors"
            title={`${
              parseErrors === 1 ? '1 file' : `${parseErrors} files`
            } in this project would not fully parse, so symbols may be missing — each box carries a warning badge`}
          >
            <i className="codicon codicon-warning" aria-hidden="true" />
            {parseErrors === 1 ? '1 file with a syntax error' : `${parseErrors} files with syntax errors`}
          </span>
        )}

        {/* Muted, not the warning colour: this is the tool reaching its limit
            on code that is perfectly fine, and it is the ordinary state of
            every project measured so far. Said out loud all the same — it is
            the difference between a diagram of a project with little coupling
            and a diagram missing most of it, and nothing else on the page
            tells the two apart. */}
        {unresolved !== null && (
          <span
            className="status-item unresolved"
            title={`${describeUnresolved(
              unresolved,
            )} in the boxes drawn here named something codemap could not find, so some coupling is missing from the diagram. The boxes it came from carry the same mark; a box with no arrows and no mark really does stand alone.`}
          >
            <i className="codicon codicon-question" aria-hidden="true" />
            {unresolved.imports + unresolved.calls} unresolved
          </span>
        )}
      </div>

      <div className="statusbar-right">
        {counts !== '' && <span className="status-item counts">{counts}</span>}
        {/* Runs something: a click is the way the filter comes off from here,
            the same as the Changes badge toggles its own. */}
        {hiddenTests > 0 && (
          <button
            type="button"
            className="status-item tests-hidden"
            onClick={onShowTests}
            title="Test files, fixtures and stories are left out of the diagram — click to show them"
          >
            <i className="codicon codicon-eye-closed" aria-hidden="true" />
            {hiddenTests === 1 ? '1 test hidden' : `${hiddenTests} tests hidden`}
          </button>
        )}
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
