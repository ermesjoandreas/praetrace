import { useEffect, useState } from 'react';
import type { AgentCall, ChangeEntry } from './api';
import { Section } from './Section';

/**
 * What the agent is doing, right now, and where.
 *
 * This is the premise of the whole tool in one column: you step away, the agent
 * works, and the question on returning is not "what does the code look like" but
 * "what has it been touching". The diagram answers the first. This answers the
 * second, and the two are meant to be read together — a row names a file, and
 * clicking it moves the diagram there.
 *
 * The agent's questions and the file changes share one list on purpose. Two
 * lists would hide the thing worth seeing: an agent looks a file up and then
 * rewrites it, and the lookup is what explains the edit.
 */

/** Enough to answer "what happened while I was away" without a scrollback. */
const MAX_ROWS = 80;

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface Row {
  at: number;
  kind: 'change' | 'agent';
  /** The file for a change; the argument for a question, when it was a path. */
  target: string | null;
  /** The tool name, for a question. */
  tool: string | null;
  /** How many of the same thing in a row this stands for. 1 for most. */
  times: number;
}

function build(changes: ChangeEntry[], agentCalls: AgentCall[]): Row[] {
  const rows: Row[] = [
    // One row per file rather than per batch: the batch is how the updater
    // coalesces, which is an implementation detail, while "where" is the column
    // this table exists for and a batch has no single answer to it.
    ...changes.flatMap((entry) =>
      entry.files.map((file) => ({ at: entry.at, kind: 'change' as const, target: file, tool: null, times: 1 })),
    ),
    ...agentCalls.map((call) => ({
      at: call.at,
      kind: 'agent' as const,
      target: call.target,
      tool: call.tool,
      times: 1,
    })),
  ];
  return collapse(rows.sort((a, b) => b.at - a.at));
}

/**
 * Fold a run of the same thing into one row.
 *
 * A row is an event and the +/- beside it is a state — the file's whole distance
 * from the git base — so four saves a minute apart drew four rows carrying the
 * same unchanged number, and the feed read as though it were repeating itself.
 * It was not; the number simply does not move at the pace the rows do.
 *
 * Only a CONSECUTIVE run folds. A, B, A is three things that happened and must
 * stay three rows: collapsing across the gap would say the two A's were one edit
 * and quietly reorder what the column exists to show.
 */
function collapse(rows: readonly Row[]): Row[] {
  const folded: Row[] = [];
  for (const row of rows) {
    const last = folded[folded.length - 1];
    if (last && last.kind === row.kind && last.target === row.target && last.tool === row.tool) {
      last.times += 1;
      continue;
    }
    folded.push({ ...row });
  }
  return folded;
}

/** The directory a path sits in — the "where" column, and empty at the root. */
function whereOf(path: string | null): string {
  if (path === null) return '';
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

function nameOf(path: string | null): string {
  if (path === null) return '';
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Recent times count up, older ones get a clock. A row that says "4s" is the
 * one you are actually watching; a row from twenty minutes ago is a record, and
 * "1247s" would be arithmetic rather than information.
 */
function when(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 3) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return clock.format(new Date(at));
}

export function Activity({
  changes,
  agentCalls,
  lines,
  onSelect,
  onFocus,
}: {
  changes: ChangeEntry[];
  agentCalls: AgentCall[];
  /**
   * How far each file has moved from the git base, the way an editor's source
   * control view counts it. Absent for a file git cannot measure — an untracked
   * one, or a binary — and shown as nothing rather than as zero, because "+0 -0"
   * and "not counted" look alike and mean the opposite.
   */
  lines: Record<string, { added: number; deleted: number }> | null;
  /** A click inspects, the same gesture a box gets. */
  onSelect: (target: string) => void;
  /** A double click navigates, also the same as a box. */
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  // The ages count on their own; nothing else re-renders this panel between
  // events, and a table of stale "2s" labels would be worse than no ages.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const all = build(changes, agentCalls);
  const rows = all.slice(0, MAX_ROWS);
  const live = all.length > 0 && now - (all[0]?.at ?? 0) < 6000;

  return (
    <Section
      title="Activity"
      className="activity"
      status={
        <span className={live ? 'activity-live activity-live-on' : 'activity-live'}>
          {live && <i className="codicon codicon-circle-filled" aria-hidden="true" />}
          {live ? 'live' : 'idle'}
        </span>
      }
    >
      {rows.length === 0 ? (
        <p className="activity-empty">
          Nothing yet. Every edit lands here, and so does anything an agent asks codemap
          through MCP.
        </p>
      ) : (
        <div className="activity-scroll">
          <table className="activity-table">
            <tbody>
              {rows.map((row, index) => {
                const path = row.kind === 'change' ? row.target : null;
                return (
                  <tr
                    key={`${row.at}-${index}`}
                    className={row.kind === 'agent' ? 'activity-ask' : 'activity-write'}
                    onClick={() => path !== null && onSelect(path)}
                    onDoubleClick={() => path !== null && onFocus(path, 'file')}
                    title={
                      (row.times > 1 ? `${row.times} times in a row — ` : '') +
                      (row.kind === 'change'
                        ? `${row.target} — click to inspect, double-click to go there`
                        : `The agent called ${row.tool}${row.target === null ? '' : ` on ${row.target}`}`)
                    }
                  >
                    <td className="activity-when">{when(row.at, now)}</td>
                    <td className="activity-mark">
                      <i
                        className={`codicon codicon-${row.kind === 'change' ? 'edit' : 'search'}`}
                        aria-hidden="true"
                      />
                    </td>
                    <td className="activity-what">
                      {row.kind === 'change' ? nameOf(row.target) : row.tool}
                      {row.times > 1 && <span className="activity-times">×{row.times}</span>}
                    </td>
                    <td className="activity-where">
                      {row.kind === 'change' ? whereOf(row.target) : (row.target ?? '')}
                    </td>
                    <td className="activity-lines">
                      {path !== null && lines?.[path] !== undefined && (
                        <>
                          {lines[path].added > 0 && (
                            <span className="activity-added">+{lines[path].added}</span>
                          )}
                          {lines[path].deleted > 0 && (
                            <span className="activity-deleted">−{lines[path].deleted}</span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* A table that quietly stopped at eighty rows would read as a
              complete record of the session, which it is not. */}
          {all.length > rows.length && (
            <p className="activity-more">
              {all.length - rows.length} older {all.length - rows.length === 1 ? 'row' : 'rows'} not shown
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
