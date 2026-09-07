import { useMemo } from 'react';
import type { DiffCounts, GitFileStatus, GitStatus, LogResponse } from './api';
import { GitGraph, shortSha } from './GitGraph';
import { LIST_ROW, useListKeys } from './listkeys';
import { Section } from './Section';
import { GIT_BASES } from './StatusBar';

/**
 * The Source Control section: what the working tree has changed, and the
 * history it sits on top of. Named and arranged the way VS Code names and
 * arranges the same two things, because that is the vocabulary the user
 * already reads every day — "Changes" with a count, and "Graph".
 *
 * Read-only from end to end. Nothing here commits, checks out or resets: an
 * agent may be editing the working tree at this moment, and a tool that
 * moved the tree under it would be worse than no tool. Clicking a commit
 * changes what the diagram shows, never what is on disk.
 *
 * The log is the page's, not this section's: the page re-reads it when the
 * server says the status moved (a commit) and after a fetch (commits that
 * touch no working tree), and the frozen chip in the breadcrumb row reads
 * the same list to name the commit it is viewing.
 */

/**
 * The letters VS Code's own view uses. 'U' for untracked rather than the '?'
 * git prints, because the column is read as an editor's, not as porcelain.
 */
const GIT_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
};

const GIT_WORD: Record<GitFileStatus, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  untracked: 'Untracked',
  renamed: 'Renamed',
};

/**
 * What the Structural diff row has to say, and the front page's copy of it.
 * `since` is what the diff is against in the status bar's words — `HEAD`,
 * `merge base`, a short sha. `blocked` carries the reason the row runs
 * nothing: no git, a root commit, a commit the log does not hold. Reading is
 * a state and not a null, because the first answer builds a whole commit's
 * graph and a row that showed nothing meanwhile would read as "no diff".
 */
export type DiffRow =
  | { state: 'reading'; since: string }
  | { state: 'ready'; since: string; counts: DiffCounts }
  | { state: 'blocked'; why: string };

/** "+12 −3", the diff's own two numbers: symbols added and removed since the base. */
export function DiffCount({ counts }: { counts: DiffCounts }) {
  return (
    <span className="scm-diff-counts">
      <span className="scm-added">+{counts.symbols.added}</span>
      <span className="scm-deleted">−{counts.symbols.removed}</span>
    </span>
  );
}

/**
 * The sentence under the numbers, shared by the two rows that print them so
 * they cannot say different things about the same count.
 */
export function diffTitle(row: DiffRow, on: boolean): string {
  if (row.state === 'blocked') return row.why;
  if (row.state === 'reading') return `Comparing the graph against ${row.since} — the first comparison builds that commit's graph`;
  const { files, symbols, edges } = row.counts;
  return `${symbols.added} symbols added and ${symbols.removed} removed since ${row.since}; ${files.added} files added, ${files.removed} removed, ${files.touched} changed in shape; ${edges.added} lines added, ${edges.removed} removed. What the graph holds, not what git holds: an edit that moves no declaration and changes no resolved reference is invisible here. ${
    on ? 'Click to leave the diff' : 'Click to draw it: added boxes, ghosts for what was removed'
  }`;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The directory a path sits in; empty at the root, so nothing is drawn. */
function whereOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Which commit the working tree is compared against, in git's own words. A
 * session setting rather than a view — it is not in the URL — but it belongs
 * beside the list it decides the contents of, or "Changes (4)" would be a
 * number with nothing on screen saying four *since what*.
 */
function DiffAgainst({ base, onChangeBase }: { base: string | null; onChangeBase: (base: string) => void }) {
  return (
    <div className="scm-base" role="group" aria-label="Diff against">
      <span className="scm-base-label">Diff against</span>
      {GIT_BASES.map((candidate) => (
        <button
          key={candidate.value}
          type="button"
          className={base === candidate.value ? 'scm-base-pick scm-base-pick-on' : 'scm-base-pick'}
          aria-pressed={base === candidate.value}
          title={`${candidate.menu} — ${candidate.hint}`}
          onClick={() => base !== candidate.value && onChangeBase(candidate.value)}
        >
          {candidate.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The working tree against the base, one row per file, the way an editor's
 * source control view lists them: name, then the directory in muted text,
 * then how far it moved, then the git letter at the right edge.
 *
 * A deleted file has no box on the diagram, so its row cannot inspect or
 * navigate anything. It is still listed — the diff is git's, and a list that
 * quietly dropped deletions would disagree with the count in its own header
 * — but it is greyed, with the reason where the cursor will find it. It stays
 * in the keyboard's walk for the same reason it stays in the list: skipping it
 * would make the arrows disagree with what is drawn.
 */
function Changes({
  git,
  onSelect,
  onFocus,
}: {
  git: GitStatus;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  const paths = useMemo(() => Object.keys(git.files).sort(), [git.files]);
  const keys = useListKeys();

  if (paths.length === 0) {
    return <p className="scm-empty">No changes against {git.base}.</p>;
  }

  return (
    <ul className="scm-changes" {...keys}>
      {paths.map((path) => {
        const status = git.files[path];
        if (status === undefined) return null;
        const lines = git.lines[path];
        const gone = status === 'deleted';
        return (
          <li key={path}>
            <button
              type="button"
              {...LIST_ROW}
              className={gone ? 'scm-change scm-change-gone' : 'scm-change'}
              aria-disabled={gone}
              onClick={gone ? undefined : () => onSelect(path)}
              onDoubleClick={gone ? undefined : () => onFocus(path, 'file')}
              title={
                gone
                  ? `${path} — deleted, so the diagram has no box for it`
                  : `${path} — ${GIT_WORD[status].toLowerCase()} against ${git.base}. Click to inspect, double-click to go there`
              }
            >
              <span className="scm-change-name">{nameOf(path)}</span>
              <span className="scm-change-where">{whereOf(path)}</span>
              {lines !== undefined && (
                <span className="scm-change-lines">
                  {lines.added > 0 && <span className="scm-added">+{lines.added}</span>}
                  {lines.deleted > 0 && <span className="scm-deleted">−{lines.deleted}</span>}
                </span>
              )}
              <span className={`scm-letter scm-letter-${status}`} aria-label={GIT_WORD[status]}>
                {GIT_LETTER[status]}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The structural diff, one row under the base picker: what changed in the
 * shape since the base — or, while the diagram is frozen, since the commit's
 * parent — and the way onto the diagram of it. Pressed, it is a mode and
 * holds the selection fill; greyed with the reason where it can run nothing.
 */
function StructuralDiff({ row, on, onToggle }: { row: DiffRow; on: boolean; onToggle: () => void }) {
  const blocked = row.state === 'blocked';
  return (
    <button
      type="button"
      {...LIST_ROW}
      className="scm-diff"
      aria-pressed={on}
      aria-disabled={blocked}
      onClick={blocked ? undefined : onToggle}
      title={diffTitle(row, on)}
    >
      <i className="codicon codicon-git-compare" aria-hidden="true" />
      <span className="scm-diff-name">Structural diff{row.state === 'blocked' ? '' : ` · since ${row.since}`}</span>
      {row.state === 'ready' ? (
        <DiffCount counts={row.counts} />
      ) : (
        <span className="scm-diff-counts">{row.state === 'reading' ? 'comparing…' : ''}</span>
      )}
    </button>
  );
}

export function SourceControl({
  git,
  base,
  onChangeBase,
  onlyChanged,
  onToggleChanged,
  diff,
  diffOn,
  onToggleDiff,
  log,
  at,
  onViewCommit,
  onBackToNow,
  onSelect,
  onFocus,
}: {
  /**
   * The whole status, not the summary on the view: this is the one place the
   * per-file half is drawn. null when the project is not a git work tree,
   * which is ordinary and says so rather than hiding the section.
   */
  git: GitStatus | null;
  /** What was asked for — 'HEAD', 'HEAD~1' or 'branch' — not what resolved. */
  base: string | null;
  onChangeBase: (base: string) => void;
  /** Whether the diagram is keeping only what differs from the base. */
  onlyChanged: boolean;
  onToggleChanged: () => void;
  /** The structural diff's numbers, or why there are none. See `DiffRow`. */
  diff: DiffRow;
  /** Whether the diagram is the diff — `?diff=` — and the row is the way out. */
  diffOn: boolean;
  onToggleDiff: () => void;
  /** null until the first read; empty commits when there are none. */
  log: LogResponse | null;
  /** The commit the diagram is frozen at — `?at=` — or null for now. */
  at: string | null;
  /** Navigate to a commit. The row shows as selected once the view says so. */
  onViewCommit: (sha: string) => void;
  onBackToNow: () => void;
  /** A click on a changed file inspects it, the same gesture a box gets. */
  onSelect: (target: string) => void;
  /** A double click navigates, also the same as a box. */
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  const changed = git === null ? 0 : Object.keys(git.files).length;
  const frozen = at !== null;

  return (
    <Section title="Source Control" className="source-control">
      {git === null ? (
        <p className="scm-empty">Not a git repository, so there is nothing to compare against.</p>
      ) : (
        <>
          <Section
            title="Changes"
            className="scm-section scm-section-changes"
            status={
              <span
                className="scm-count"
                title={`${changed === 1 ? '1 file differs' : `${changed} files differ`} from ${git.base}`}
              >
                {changed}
              </span>
            }
            actions={
              // Greyed while frozen rather than absent: a past commit has no
              // working tree, so there is nothing for the filter to keep.
              <button
                type="button"
                aria-pressed={onlyChanged}
                aria-disabled={frozen}
                className={onlyChanged ? 'scm-filter scm-filter-on' : 'scm-filter'}
                title={
                  frozen
                    ? 'The diagram shows a past commit, which has no working tree to filter by'
                    : onlyChanged
                      ? 'Showing only changed files — click to show every file'
                      : 'Show only changed files in the diagram'
                }
                aria-label="Show only changed files in the diagram"
                onClick={frozen ? undefined : onToggleChanged}
              >
                <i className={`codicon codicon-${onlyChanged ? 'filter-filled' : 'filter'}`} aria-hidden="true" />
              </button>
            }
          >
            <DiffAgainst base={base} onChangeBase={onChangeBase} />
            <StructuralDiff row={diff} on={diffOn} onToggle={onToggleDiff} />
            <Changes git={git} onSelect={onSelect} onFocus={onFocus} />
          </Section>

          <Section
            title="Graph"
            className="scm-section scm-section-graph"
            status={
              at !== null ? (
                <span className="scm-viewing" title={`The diagram shows the project as of ${at}`}>
                  {shortSha(at)}
                </span>
              ) : undefined
            }
            actions={
              at !== null ? (
                <button
                  type="button"
                  title={`Back to now — stop viewing ${shortSha(at)}`}
                  aria-label="Back to now"
                  onClick={onBackToNow}
                >
                  <i className="codicon codicon-close" aria-hidden="true" />
                </button>
              ) : undefined
            }
          >
            {log === null ? (
              <p className="scm-empty">Reading the log…</p>
            ) : log.commits.length === 0 ? (
              <p className="scm-empty">No commits yet.</p>
            ) : (
              <GitGraph
                commits={log.commits}
                head={log.head}
                branch={log.branch}
                viewing={at}
                onView={onViewCommit}
              />
            )}
          </Section>
        </>
      )}
    </Section>
  );
}
