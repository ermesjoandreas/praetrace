/**
 * Lay a commit graph out in lanes, the way an editor's source control graph
 * draws it: newest commit on top, one row per commit, a dot in the lane the
 * commit occupies and a thread running down from each commit to its parents.
 *
 * Pure, and it knows nothing about git beyond a sha and its parents — the log
 * that feeds it comes from `project/git.ts`, but so could anything else with
 * the same shape. Nothing here is a coordinate: a row says which lane a thread
 * enters and leaves in, and the page turns lane numbers into pixels.
 */

/** What the layout needs of a commit. `Commit` from the log satisfies it. */
export interface LaneInput {
  sha: string;
  /** First parent first — the one that keeps this commit's lane. */
  parents: string[];
}

/**
 * One thread crossing one row. Both ends are lane numbers at the row's top and
 * bottom edge; null at either end means the thread starts or ends at this
 * row's commit instead. `from === to` is a thread passing straight through.
 */
export interface LaneSegment {
  from: number | null;
  to: number | null;
}

export interface LaneRow {
  /** The lane this commit's dot sits in. */
  lane: number;
  segments: LaneSegment[];
  /** Lanes in use across this row — how wide the column has to be here. */
  width: number;
}

/**
 * Assign every commit a lane and every parent link a path, top down.
 *
 * `commits` must be newest first with no parent ahead of its child, which is
 * what `git log --date-order` promises. The algorithm keeps a list of open
 * lanes, each waiting for the sha it will next contain. A commit takes the
 * first lane waiting for it, or opens one when none is; every other lane
 * waiting for the same sha closes into it — that is a branch point, seen from
 * above. Its first parent inherits the lane, and each further parent joins the
 * lane already waiting for it or opens another. A parent that never arrives —
 * cut off by the log's limit — keeps its lane open to the bottom, so the
 * thread visibly runs off the end rather than stopping at a commit that has
 * none.
 *
 * Closed lanes are reused rather than compacted: a thread never changes lane
 * except at a commit, which is what keeps every row drawable on its own.
 */
export function assignLanes(commits: readonly LaneInput[]): LaneRow[] {
  const lanes: (string | null)[] = [];
  const rows: LaneRow[] = [];

  for (const commit of commits) {
    const segments: LaneSegment[] = [];
    let lane = -1;

    // Threads coming in from above. The first one waiting for this commit is
    // its lane; the rest fold into it. Everything else passes through, unless
    // it is decided below.
    for (let index = 0; index < lanes.length; index++) {
      if (lanes[index] !== commit.sha) continue;
      if (lane === -1) {
        lane = index;
        segments.push({ from: index, to: null });
      } else {
        segments.push({ from: index, to: null });
        lanes[index] = null;
      }
    }
    if (lane === -1) lane = open(lanes);

    // Parents leaving below. The first keeps this lane; a root commit closes it.
    const [first, ...rest] = commit.parents;
    if (first === undefined) {
      lanes[lane] = null;
    } else {
      lanes[lane] = first;
      segments.push({ from: null, to: lane });
    }
    for (const parent of rest) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = open(lanes);
        lanes[target] = parent;
      } else if (target !== lane) {
        // Joining a lane that is already waiting for this parent: the thread
        // above it is still alive and must be drawn through this row, or it
        // would stop dead at the top edge and resume below the dot.
        segments.push({ from: target, to: target });
      }
      segments.push({ from: null, to: target });
    }

    // Every lane still open and not touched by this commit runs straight through.
    for (let index = 0; index < lanes.length; index++) {
      if (index === lane || lanes[index] === null) continue;
      if (segments.some((segment) => segment.to === index || segment.from === index)) continue;
      segments.push({ from: index, to: index });
    }

    // Trailing closed lanes are dropped so the width says what is in use, and
    // a lane opened later lands where the eye expects — at the right edge.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    let width = lane + 1;
    for (const segment of segments) {
      width = Math.max(width, (segment.from ?? 0) + 1, (segment.to ?? 0) + 1);
    }
    rows.push({ lane, segments, width });
  }

  return rows;
}

/** The first free lane, or a new one at the end. */
function open(lanes: (string | null)[]): number {
  const free = lanes.indexOf(null);
  if (free !== -1) return free;
  lanes.push(null);
  return lanes.length - 1;
}
