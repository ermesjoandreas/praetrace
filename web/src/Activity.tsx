import { useEffect, useState } from 'react';
import type { AgentCall } from './api';
import { Section } from './Section';
/* The wire shape, imported rather than restated: `by` rides on every entry of
   `GET /api/changes`, and a type-only import of `src/` is erased by Vite the
   way `api.ts`'s own are. `api.ts`'s `ChangeEntry` omits the field, and a
   value of that type is assignable here because `by` is optional. */
import type { ChangeEntry } from '../../src/server/session.js';
import type { Attribution } from '../../src/project/hook.js';

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
 *
 * This table describes NOW, whatever the diagram is showing. While the page
 * views a past commit the rows keep arriving and the +/- keep counting against
 * the git base, because the agent is still working in the working tree — the
 * diagram is the thing that stopped, not the project.
 */

/** Enough to answer "what happened while I was away" without a scrollback. */
const MAX_ROWS = 80;

/**
 * No seconds. A clock is only reached once a row is an hour old, and at that
 * distance the second is not information — the same reason the ages stop
 * counting in seconds after a minute. It is also 18px of a 300px panel, and
 * every one of those pixels is taken from the columns that say what happened
 * and how much of it.
 */
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

interface Row {
  at: number;
  kind: 'change' | 'agent';
  /** The file for a change; the argument for a question, when it was a path. */
  target: string | null;
  /** The tool name, for a question. */
  tool: string | null;
  /** How many of the same thing in a row this stands for. 1 for most. */
  times: number;
  /**
   * The agent's own words about what it just changed, and which files it says
   * they are about. Null on every other row, and that is what makes this one a
   * note — a note arrives as an ordinary agent call, so `tool` and `target`
   * cannot tell it apart.
   *
   * `files` is whatever the agent passed and is never checked against the
   * graph: it may name a file that is not there, or be empty. So it stays in
   * the tooltip and nothing is drawn from it — least of all a click that would
   * send the diagram to a path that does not exist.
   */
  note: { words: string; files: string[] } | null;
  /**
   * Who claimed this file, when anything did.
   *
   * Null is the word for unattributed and is drawn as one — never as a blank,
   * and never as a guess. Three things can reach this feed and they know three
   * different amounts: Claude Code's hook names itself, a tool that posts to
   * `/api/hook` names whatever it likes, and the file watcher knows *nothing*
   * — a file that changed on disk looks identical whether Cursor, a build
   * script, a `git checkout` or a person in an editor wrote it. See
   * `docs/AGENTS.md`.
   */
  by: Attribution | null;
}

function build(changes: ChangeEntry[], agentCalls: AgentCall[]): Row[] {
  const rows: Row[] = [
    // One row per file rather than per batch: the batch is how the updater
    // coalesces, which is an implementation detail, while "where" is the column
    // this table exists for and a batch has no single answer to it.
    ...changes.flatMap((entry) =>
      entry.files.map((file) => ({
        at: entry.at,
        kind: 'change' as const,
        target: file,
        tool: null,
        times: 1,
        note: null,
        // The batch's own claim, per file — a batch can hold both a file the
        // hook named and one only the watcher saw, and one name over the pair
        // would be wrong about half of it.
        by: entry.by?.[file] ?? null,
      })),
    ),
    ...agentCalls.map((call) => ({
      at: call.at,
      kind: 'agent' as const,
      target: call.target,
      tool: call.tool,
      times: 1,
      note: call.note === undefined ? null : { words: call.note, files: call.files ?? [] },
      // A question came through MCP, so the agent is the row's whole subject
      // already: the tool name is in the row and the row is blue. This column
      // answers "who wrote this file", and a question wrote nothing.
      by: null,
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
    if (last && same(last, row)) {
      last.times += 1;
      continue;
    }
    folded.push({ ...row });
  }
  return folded;
}

/**
 * Two rows that stand for the same thing happening twice.
 *
 * The words are part of that: every note arrives as `note_change` with no
 * target, so a comparison of tool and target alone would fold two things the
 * agent said into one row and throw the second sentence away.
 */
function same(a: Row, b: Row): boolean {
  return (
    a.kind === b.kind &&
    a.target === b.target &&
    a.tool === b.tool &&
    // Two agents taking turns on one file is two things happening, and folding
    // them would put one name over the other's work.
    (a.by?.agent ?? null) === (b.by?.agent ?? null) &&
    (a.note?.words ?? null) === (b.note?.words ?? null)
  );
}

/** What the source column says, and what it says when nobody said. */
const UNCLAIMED = 'unknown';

function whoOf(by: Attribution | null): string {
  return by === null ? UNCLAIMED : by.agent;
}

function whyWho(by: Attribution | null): string {
  if (by === null) {
    return 'Unattributed — nothing claimed this change. codemap saw the file change on disk, and a file that changed on disk looks the same whether an agent, a build script or a person in an editor wrote it.';
  }
  const how =
    by.how === 'declared'
      ? 'it named itself in the request'
      : "it arrived wearing Claude Code's own hook envelope";
  return `${by.agent}${by.subagent === null ? '' : ` · ${by.subagent}`}${
    by.tool === null ? '' : ` — ${by.tool}`
  }. Known because ${how}${by.session === null ? '' : `; session ${by.session.slice(0, 8)}`}.`;
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

  // The cap is a first impression, not a limit: the session holds every row
  // either way, so the reader who wants the rest can have it.
  const [showAll, setShowAll] = useState(false);

  const all = build(changes, agentCalls);
  const rows = showAll ? all : all.slice(0, MAX_ROWS);
  const live = all.length > 0 && now - (all[0]?.at ?? 0) < 6000;

  /**
   * Whether to draw the source column at all.
   *
   * In a project with no hook installed and no tool posting to `/api/hook`,
   * every row would read `unknown` — a column of one word repeated eighty
   * times, spending 44px of a 300px panel to say nothing anybody can act on.
   * It appears the moment one change is claimed, and from then on an
   * unattributed row says so in a word beside the ones that are named, which
   * is where the distinction is worth its width.
   */
  const claimed = all.some((row) => row.by !== null);

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
            {/* The columns are declared, not inferred from the widest row.
                Left to itself the table sized every column to its content and
                grew past the 300px panel — 331px of table in 285px of visible
                width — and the column it pushed over the edge was the last one,
                which is the +/- this table counts the session in. Measured on
                ripgrep: a 129-line edit read "+12", a 3-line edit showed
                nothing at all, and the numbers are right-aligned, so the
                shortest ones were the ones that disappeared entirely: the two
                largest edits of a session looked like the smallest. */}
            <colgroup>
              <col className="col-when" />
              <col className="col-mark" />
              <col className="col-what" />
              <col className="col-where" />
              {claimed && <col className="col-who" />}
              <col className="col-lines" />
            </colgroup>
            <tbody>
              {rows.map((row, index) => {
                const path = row.kind === 'change' ? row.target : null;

                // The agent saying what it did, in its own words. It takes the
                // three columns the other rows spend on a name, a directory and
                // a diff, because a sentence is what it has and 118px of the
                // "what" column would show four words of it. The row is not a
                // click target: `files` is unverified, so there is no path here
                // anything can honestly navigate to.
                if (row.note !== null) {
                  return (
                    <tr
                      key={`${row.at}-${index}`}
                      className="activity-ask"
                      title={
                        (row.times > 1 ? `${row.times} times in a row — ` : '') +
                        row.note.words +
                        (row.note.files.length === 0 ? '' : ` — ${row.note.files.join(', ')}`)
                      }
                    >
                      <td className="activity-when">{when(row.at, now)}</td>
                      <td className="activity-mark">
                        <i className="codicon codicon-comment" aria-hidden="true" />
                      </td>
                      <td className="activity-words" colSpan={claimed ? 4 : 3}>
                        {row.note.words}
                        {row.times > 1 && <span className="activity-times">×{row.times}</span>}
                      </td>
                    </tr>
                  );
                }

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
                    {/* Who wrote it, or that nobody said. Never a guess and
                        never a blank: a blank in a column of names reads as
                        "not applicable", and what is true here is stronger and
                        stranger than that — the change happened, and codemap
                        cannot know who made it. */}
                    {claimed && (
                      <td
                        className={
                          row.kind !== 'change'
                            ? 'activity-who'
                            : row.by === null
                              ? 'activity-who activity-who-unknown'
                              : 'activity-who'
                        }
                        title={row.kind === 'change' ? whyWho(row.by) : ''}
                      >
                        {row.kind === 'change' ? whoOf(row.by) : ''}
                      </td>
                    )}
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
              complete record of the session, which it is not. Saying so and
              offering nothing was worse still: the rows were already on the
              page, and a promise with no gesture reads as a limit that cannot
              be lifted. */}
          {all.length > rows.length && (
            <button type="button" className="activity-more" onClick={() => setShowAll(true)}>
              {all.length - rows.length} older {all.length - rows.length === 1 ? 'row' : 'rows'} not shown —
              show {all.length === rows.length + 1 ? 'it' : 'them'}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
