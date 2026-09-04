import { useEffect, useMemo, useRef, useState } from 'react';
import { assignLanes, type LaneRow, type LaneSegment } from '../../src/view/lanes.js';
import type { Commit } from './api';
import { LIST_ROW, useListKeys } from './listkeys';

/**
 * The commit graph, drawn the way VS Code's Source Control Graph draws it:
 * one 22px row per commit, threads running down the left in a lane column,
 * the subject, the refs pointing here, and who and when in muted text.
 *
 * Where each thread goes is decided in `src/view/lanes.ts`, which is pure and
 * tested; this file only turns lane numbers into pixels. Every row draws its
 * own SVG, so a list of a thousand commits is a thousand small pictures rather
 * than one tall one that has to be re-laid-out when a row is added on top.
 *
 * Clicking a row does not select it, it navigates: the diagram becomes the
 * project as of that commit, and the row shows as selected because the view
 * now says so — the same way a box shows as focused because the URL does.
 *
 * The list this file draws is the reason `listkeys.ts` exists: 300 rows, each
 * one a button, is 300 tab stops between the Source Control panel and anything
 * below it. One stop now, and it starts on the commit the diagram is at.
 */

/** Pixels per lane. Wide enough for a 6px dot and a curve between neighbours. */
const LANE_WIDTH = 12;
/** The row is --vsc-row-h; the SVG has to say its height in numbers. */
const ROW_HEIGHT = 22;
const DOT_RADIUS = 3;
const STROKE_WIDTH = 1.5;
/** The palette is CSS: `.git-lane-c0` … `.git-lane-c5`, the accent first. */
const LANE_COLORS = 6;

/** The commit a sha names, in full or abbreviated — exact first, then by prefix. */
export function findCommit(commits: readonly Commit[], sha: string | null): Commit | null {
  if (sha === null || sha === '') return null;
  return commits.find((commit) => commit.sha === sha) ?? commits.find((commit) => commit.sha.startsWith(sha)) ?? null;
}

/** The seven characters a person reads a sha by. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "2 days ago", the way a log or a status bar says it. Coarse on purpose: a
 * commit's age is read for scale, not arithmetic, and it is shown beside a
 * subject that already carries the meaning.
 */
export function relativeTime(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return plural(Math.round(age / MINUTE), 'minute');
  if (age < DAY) return plural(Math.round(age / HOUR), 'hour');
  if (age < 2 * DAY) return 'yesterday';
  if (age < 14 * DAY) return plural(Math.round(age / DAY), 'day');
  if (age < 60 * DAY) return plural(Math.round(age / (7 * DAY)), 'week');
  if (age < 365 * DAY) return plural(Math.round(age / (30 * DAY)), 'month');
  return plural(Math.round(age / (365 * DAY)), 'year');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

/**
 * One thread across one row. A thread that stays in its lane is a vertical
 * line; one that changes lane at this commit curves between the two — it
 * leaves the top edge going straight down and arrives at the dot the same
 * way, so a stack of rows reads as one continuous line.
 */
function segmentPath(segment: LaneSegment, lane: number): string {
  const mid = ROW_HEIGHT / 2;
  if (segment.from !== null && segment.to !== null) {
    const x = laneX(segment.from);
    return `M ${x} 0 V ${ROW_HEIGHT}`;
  }
  if (segment.from !== null) {
    const from = laneX(segment.from);
    const to = laneX(lane);
    if (segment.from === lane) return `M ${to} 0 V ${mid}`;
    return `M ${from} 0 C ${from} ${mid}, ${to} 0, ${to} ${mid}`;
  }
  if (segment.to !== null) {
    const from = laneX(lane);
    const to = laneX(segment.to);
    if (segment.to === lane) return `M ${from} ${mid} V ${ROW_HEIGHT}`;
    return `M ${from} ${mid} C ${from} ${ROW_HEIGHT}, ${to} ${mid}, ${to} ${ROW_HEIGHT}`;
  }
  return '';
}

function laneClass(lane: number): string {
  return `git-lane-c${lane % LANE_COLORS}`;
}

function Lanes({ row, width }: { row: LaneRow; width: number }) {
  return (
    <svg
      className="git-lanes"
      width={width * LANE_WIDTH}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width * LANE_WIDTH} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {row.segments.map((segment, index) => (
        <path
          key={index}
          className={laneClass(segment.from ?? segment.to ?? row.lane)}
          d={segmentPath(segment, row.lane)}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
        />
      ))}
      <circle
        className={laneClass(row.lane)}
        cx={laneX(row.lane)}
        cy={ROW_HEIGHT / 2}
        r={DOT_RADIUS}
        fill="currentColor"
      />
    </svg>
  );
}

const TAG_PREFIX = 'tag: ';

/**
 * What a ref is, from how git spelled it. The checked-out branch gets the
 * accent and HEAD itself is not shown twice; `HEAD` with no branch is a
 * detached HEAD. Which branch that is comes from git, not from the refs: the
 * log spells a detached HEAD sitting on main as `HEAD, main`, exactly what
 * `HEAD -> main` becomes once the arrow is split, so the refs alone cannot
 * tell the two apart. A remote branch is one with a slash in it, which is
 * git's convention rather than a rule, but it is the convention every
 * developer reads.
 */
function RefBadges({ refs, branch }: { refs: string[]; branch: string | null }) {
  const current = refs.includes('HEAD') ? branch : null;

  return (
    <span className="git-refs">
      {refs.map((ref) => {
        if (ref === 'HEAD') {
          if (current !== null) return null;
          return (
            <span key={ref} className="git-ref git-ref-head" title="HEAD, detached">
              <i className="codicon codicon-target" aria-hidden="true" />
              HEAD
            </span>
          );
        }
        if (ref.startsWith(TAG_PREFIX)) {
          const name = ref.slice(TAG_PREFIX.length);
          return (
            <span key={ref} className="git-ref git-ref-tag" title={`Tag ${name}`}>
              <i className="codicon codicon-tag" aria-hidden="true" />
              {name}
            </span>
          );
        }
        const isCurrent = ref === current;
        const isRemote = ref.includes('/');
        return (
          <span
            key={ref}
            className={`git-ref ${isCurrent ? 'git-ref-head' : isRemote ? 'git-ref-remote' : 'git-ref-branch'}`}
            title={isCurrent ? `${ref}, checked out` : isRemote ? `Remote branch ${ref}` : `Branch ${ref}`}
          >
            <i
              className={`codicon codicon-${isCurrent ? 'target' : isRemote ? 'cloud' : 'git-branch'}`}
              aria-hidden="true"
            />
            {ref}
          </span>
        );
      })}
    </span>
  );
}

export function GitGraph({
  commits,
  head,
  branch,
  viewing,
  onView,
}: {
  /** Newest first, as the log answers. */
  commits: Commit[];
  /** The sha HEAD is at, or '' when it is not among `commits`. */
  head: string;
  /** The branch checked out, or null when HEAD is detached. */
  branch: string | null;
  /** The commit the diagram is frozen at, or null when it shows now. */
  viewing: string | null;
  /** Navigate: draw the project as of this commit. */
  onView: (sha: string) => void;
}) {
  const rows = useMemo(() => assignLanes(commits), [commits]);
  // As wide as the busiest row. Capping it looked tidy and drew a commit on the
  // ninth lane with no dot and no thread — a row saying the commit has no place
  // in the history. A wide log scrolls sideways instead.
  const width = useMemo(() => rows.reduce((widest, row) => Math.max(widest, row.width), 1), [rows]);

  // Ages are coarse — minutes at the finest — so once a minute keeps them true.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
    return () => window.clearInterval(timer);
  }, []);

  // The selected row is the one the view is at; with nothing frozen it is
  // HEAD, and '' selects none rather than the first row, which would claim a
  // commit that may not even be checked out. Matched the way git reads a sha:
  // a hand-typed `?at=7fe7f88` is the same commit as the whole thing.
  const selectedSha = useMemo(
    () => findCommit(commits, viewing ?? (head === '' ? null : head))?.sha ?? null,
    [commits, viewing, head],
  );
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedSha]);

  // Tab arrives on the commit on screen rather than on the newest one, which
  // in a 300-commit log can be a long way from what the diagram is showing.
  // -1 when nothing is selected, which the hook reads as the first row.
  const keys = useListKeys(commits.findIndex((commit) => commit.sha === selectedSha));

  return (
    <div className="git-graph" {...keys}>
      {commits.map((commit, index) => {
        const row = rows[index];
        if (row === undefined) return null;
        const selected = commit.sha === selectedSha;
        const when = relativeTime(commit.at, now);
        return (
          <button
            key={commit.sha}
            type="button"
            {...LIST_ROW}
            ref={selected ? selectedRef : undefined}
            className={selected ? 'git-row git-row-selected' : 'git-row'}
            aria-current={selected ? 'true' : undefined}
            onClick={() => onView(commit.sha)}
            title={`${shortSha(commit.sha)} · ${commit.author} · ${dateFormat.format(new Date(commit.at))}\n${
              commit.subject
            }\n\nClick to draw the project as of this commit`}
          >
            <Lanes row={row} width={width} />
            <span className="git-subject">{commit.subject}</span>
            {commit.refs.length > 0 && <RefBadges refs={commit.refs} branch={branch} />}
            <span className="git-meta">
              {commit.author} · {when}
            </span>
          </button>
        );
      })}
    </div>
  );
}
