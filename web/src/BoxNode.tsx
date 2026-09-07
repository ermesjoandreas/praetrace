import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { MouseEvent } from 'react';
import {
  describeUnresolved,
  openInEditor,
  type Change,
  type GitFileStatus,
  type LanguageId,
  type ViewMember,
  type ViewNode,
} from './api';
import { MAX_MEMBERS } from './layout';

export type BoxData = {
  label: string;
  /**
   * A `bundle` stands for neighbours a focus view had too many of to draw one
   * by one. It is drawn as a folder is — a count, not a member list — because
   * both stand for a pile of files rather than for one; what makes it its own
   * kind is that it is not a place in the project, so nothing may navigate to
   * it.
   */
  kind: 'file' | 'folder' | 'bundle';
  /**
   * Which way a bundle's arrow runs, or null on every other box.
   *
   * What the count under the label is a count *of*. "260 dependents" is a
   * count of files that import the focused one, and it was read as the fan-in
   * of a symbol inside it — four files import that symbol and three use it. A
   * number wearing the wrong subject is worse than no number, so the box says
   * the subject out loud.
   */
  bundleOf: 'dependents' | 'dependencies' | null;
  members: ViewMember[];
  files: string[];
  external: boolean;
  focused: boolean;
  changed: boolean;
  queried: boolean;
  /** Its own git status. null for folder boxes and for unchanged files. */
  gitStatus: GitFileStatus | null;
  /** How many of `files` differ from the base. 0 or 1 for a file box. */
  gitChanged: number;
  /**
   * Under a structural diff: what happened to this file between the two
   * graphs, or undefined on a context box and on every other view. `removed`
   * is the ghost — drawn from the before graph, dashed and dimmed, and not
   * on disk, so nothing on it may open an editor or spend money on a file
   * that is not there. The letter it wears replaces the git badge: the diff
   * is the comparison, and two letters for one fact would read as two facts.
   */
  change?: Change;
  /**
   * What the diff is against, in the status bar's words — `HEAD`, `merge
   * base`, a short sha — for the letter's title. Null outside a diff.
   */
  since: string | null;
  /** The one language its files share; null on a folder holding several. */
  language: LanguageId | null;
  /** False in a single-language project, where the tag would say nothing. */
  showLanguage: boolean;
  /** A test, fixture or story; a folder is one only when every file in it is. */
  test: boolean;
  /**
   * The parser hit a syntax error here, or in one of a folder's files. Said on
   * the box because "0 symbols" from a file that would not parse looks exactly
   * like an empty file, and an M badge beside it read as a finished edit.
   */
  parseError: boolean;
  /**
   * What the test report measured here, on a file box and when there is any.
   *
   * It never reaches the face of the box. A percentage on every box is a number
   * nobody asked for on the one surface the diagram uses for what is happening
   * now, and it would be absent from most of them anyway — 391 of zod's 510
   * boxes have no entry, so the diagram would read as broken rather than as
   * unmeasured. In the title, it is there when you go looking for it.
   */
  coverage: ViewNode['coverage'];
  /**
   * References this box's files made that landed nowhere, summed over the pile
   * a folder or a bundle stands for. Absent is the good answer.
   *
   * Said on the face of the box because it is the only thing that separates
   * the two ways a box can have no arrows: code that leans on nothing, and
   * coupling this tool could not follow. The second is the common one — 374 of
   * zod's 510 files have some — and it used to be drawn as the first.
   */
  unresolved?: ViewNode['unresolved'];
  /** Needed to build an absolute path for an editor link. */
  root: string;
  /** Nothing in this box takes part in what is being followed. */
  aside: boolean;
  /**
   * The graph's sentence about how much of that it can vouch for, or null when
   * nothing is being followed.
   *
   * A dimmed box is the diagram drawing "this has no part in it", and the list
   * it is drawn from is a floor — a class handed to a function as a value, or
   * a method reached through an untyped receiver, is a use nothing here can
   * see. The panel prints the same sentence beside its count; the box, which
   * is where the claim is loudest, used to make it in silence.
   */
  asideNote: string | null;
  /** Showing every member rather than the first twelve. */
  expanded: boolean;
  onExpand: (id: string, expanded: boolean) => void;
  /** The symbols being followed. More than one is a union, not a comparison. */
  following: ReadonlySet<string>;
  /** Symbol ids any of them relate to, so a row knows whether to light or fade. */
  related: ReadonlySet<string>;
  onFollow: (id: string, on: boolean) => void;
  /**
   * This whole file is being held on to, to be explained later. It is fed from
   * a different set than `following`, and must stay that way: a followed symbol
   * is a lens — it drives `related` and `aside` — while a held file is only a
   * list entry. Routing it into the same set would make one gesture mean two
   * things and make the chip's "N in, N out" count a lie.
   */
  followed: boolean;
  onFollowFile: (path: string, on: boolean) => void;
  /**
   * Hold this file and ask a model what it is for, in one press.
   *
   * The reading itself has always been here; the way in had not. It rendered
   * only inside a panel section that is null until something is already being
   * followed, so three of seven readers walked every menu, the panel and ⌘K
   * and never found the word Explain at all. A file box is the surface those
   * three were looking at, so the gesture goes on it.
   */
  onExplain: (path: string) => void;
};

export type BoxNodeType = Node<BoxData, 'box'>;

/**
 * Git gets a badge, never a tint. The box surface already carries two signals —
 * amber for just written, blue for the agent just asked — and both are about
 * this minute. Standing against a commit is a slower fact about the same box,
 * so it sits beside the name rather than competing for the same surface.
 */
const GIT_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
};

/**
 * The diff's letters, VS Code's own: a file the base graph has not got is
 * added, a ghost is deleted, a file whose shape moved is modified. The same
 * three colours the git badge wears, because they say the same thing about a
 * different pair — the graphs rather than the trees.
 */
const CHANGE_LETTER: Record<Change, { letter: string; status: GitFileStatus; said: string }> = {
  added: { letter: 'A', status: 'added', said: 'Added' },
  removed: { letter: 'D', status: 'deleted', said: 'Removed' },
  touched: { letter: 'M', status: 'modified', said: 'Changed' },
};

/**
 * UML's three markers. A member whose source said nothing is public, which is
 * what TypeScript means by silence, so it gets the + a UML reader expects
 * rather than a blank that would read as "unknown".
 */
const VISIBILITY = { private: '−', protected: '#', public: '+' } as const;

/**
 * The extension a developer would have typed, not the language's full name: the
 * tag shares a 240px title row with a filename, and "TypeScript" would be the
 * widest thing on it. The header spells the names out; this only has to be
 * recognisable once you have read them.
 */
const LANGUAGE_TAG: Record<LanguageId, string> = {
  typescript: 'ts',
  javascript: 'js',
  java: 'java',
  go: 'go',
  csharp: 'c#',
  rust: 'rs',
  python: 'py',
};

/**
 * Which rows a box shows when it declares more than it has room for.
 *
 * Document order shows whichever the parser saw first, which answers no
 * question the reader asked. `linked` marks the rows an edge on this diagram
 * actually runs through, so those come first and the rest fill what is left —
 * a stable sort, so inside each half document order survives and with it the
 * UML reading, attributes before operations.
 *
 * Past MAX_MEMBERS linked rows the unlinked ones are dropped rather than
 * ranked behind them: every row on show is then part of the answer, which is
 * the point. Under the default edge kinds nothing is marked — an `imports`
 * edge runs file to file, so no one symbol writes it — and this falls back to
 * document order, unchanged.
 */
function rowsToShow(members: ViewMember[]): ViewMember[] {
  // Under a diff a row that came or went is what the box is on the canvas
  // for, and it is ranked the way a linked row is: first, and before the
  // rows that did nothing.
  const marked = (member: ViewMember): boolean => member.linked === true || member.change !== undefined;
  const linked = members.filter(marked);
  if (linked.length >= MAX_MEMBERS) return linked.slice(0, MAX_MEMBERS);
  return [...members].sort((a, b) => Number(marked(b)) - Number(marked(a))).slice(0, MAX_MEMBERS);
}

export function BoxNode({ data }: NodeProps<BoxNodeType>) {
  const shown = data.expanded ? data.members : rowsToShow(data.members);
  const hidden = data.members.length - shown.length;
  const file = data.kind === 'file' ? data.files[0] : undefined;
  // Muted text and nothing else. The box surface already carries amber for just
  // written, blue for the agent just asked, a git badge and the selection ring;
  // what a file is written in is the slowest fact of the five and gets the
  // quietest treatment. Only a folder can be mixed — every file has one.
  const tag = !data.showLanguage
    ? null
    : data.language === null
      ? 'mixed'
      : LANGUAGE_TAG[data.language];

  // `lines` is what the report had a count for, not what the file holds, so the
  // sentence says "measured" rather than leaving the reader to assume the file
  // is 122 lines long. A report entry with nothing in it says nothing.
  const measured = data.coverage === undefined || data.coverage.lines === 0 ? null : data.coverage;
  const measure =
    measured === null
      ? data.label
      : `${data.label} — ${measured.covered} of ${measured.lines} measured lines ran (${Math.round(
          (measured.covered / measured.lines) * 100,
        )}%)`;
  // Only on a box the following actually dimmed: on a lit one the sentence
  // would be qualifying a claim the box is not making.
  const title =
    data.aside && data.asideNote !== null
      ? `${measure}\n\nDimmed because nothing in it took part in what is being followed. ${data.asideNote}`
      : measure;

  // Names, not a count: a bundle exists because 258 boxes answer nothing, and
  // the first few paths are what say whether the pile is worth opening. Eight
  // is what a tooltip holds without becoming a list of its own; the rest are a
  // click away, in the panel.
  const bundled =
    data.kind !== 'bundle'
      ? undefined
      : [
          `${data.files.length} files ${
            data.bundleOf === 'dependencies' ? 'the file in focus imports' : 'import the file in focus'
          } — a count of files, not of uses of anything inside it. Click the box to list them.`,
          ...data.files.slice(0, 8),
          ...(data.files.length > 8 ? [`…and ${data.files.length - 8} more`] : []),
        ].join('\n');

  /**
   * A ghost is not on disk: the file's box is drawn from the graph the diff
   * compares against, and an editor link, a reading or a hold would be about
   * a path that answers nothing. What can be read of it is in the panel,
   * which asks the before graph.
   */
  const onDisk = data.change !== 'removed';

  const classes = ['box', `box-${data.kind}`];
  if (data.external) classes.push('box-external');
  if (data.change !== undefined) classes.push(`box-${data.change === 'removed' ? 'ghost' : data.change}`);
  if (data.changed) classes.push('box-changed');
  if (data.queried) classes.push('box-queried');
  if (data.focused) classes.push('box-focused');
  if (data.aside) classes.push('box-aside');

  /** Clicking a box navigates, so opening an editor must not also do that. */
  const open = (line: number) => (event: MouseEvent) => {
    event.stopPropagation();
    if (file === undefined) return;
    void openInEditor(data.root, file, line);
  };

  return (
    <div className={classes.join(' ')}>
      <Handle type="target" position={Position.Left} />

      <div className="box-title">
        <span className="box-title-text" title={title}>
          {data.label}
        </span>
        {/* Under a diff the letter is the diff's, in the same place and the
            same colours the git badge sits in: the diff is the comparison
            here, and the git status is still in the title for the reader who
            wants both. A context box wears the git letter as ever. */}
        {data.change !== undefined ? (
          <span
            className={`box-git box-git-${CHANGE_LETTER[data.change].status}`}
            title={`${CHANGE_LETTER[data.change].said} since ${data.since ?? 'the base'}${
              data.change === 'removed'
                ? ' — a ghost: this file is not on disk, and the box is drawn from the graph it is compared against'
                : data.change === 'added'
                  ? ' — no box for it in the graph it is compared against'
                  : ' — a symbol came, went or moved, or a line it wrote did'
            }${data.gitStatus === null ? '' : `. git: ${data.gitStatus} vs the git base`}`}
          >
            {CHANGE_LETTER[data.change].letter}
          </span>
        ) : (
          data.gitStatus !== null && (
            <span
              className={`box-git box-git-${data.gitStatus}`}
              title={`${data.gitStatus} vs the git base`}
            >
              {GIT_LETTER[data.gitStatus]}
            </span>
          )
        )}
        {/* A box standing for many files says how many of them moved, not
            which way any single one did — the direction is a fact about one
            file, and there is no one file here. */}
        {data.kind !== 'file' && data.gitChanged > 0 && (
          <span
            className="box-git box-git-count"
            title={`${data.gitChanged} of ${data.files.length} changed vs the git base`}
          >
            {data.gitChanged}
          </span>
        )}
        {/* A warning, not a tint: the surface already carries amber and blue
            for this minute's edits, and a broken file is a fact about the
            parse, not about who touched it. */}
        {data.parseError && (
          <span
            className="box-warning"
            title={
              data.kind === 'file'
                ? 'This file has a syntax error; symbols may be missing'
                : 'A file in here has a syntax error; symbols may be missing'
            }
          >
            <i className="codicon codicon-warning" aria-hidden="true" />
          </span>
        )}
        {/* Muted, and deliberately not the warning colour: a reference that
            landed nowhere is the tool reaching its limit, not the file being
            broken, and 374 of zod's 510 files have one. A count and never a
            line — an edge to a node we could not name would be the lie this
            exists to prevent — so the number is the whole mark. */}
        {data.unresolved !== undefined && (
          <span
            className="box-unresolved"
            title={
              data.kind === 'file'
                ? `${describeUnresolved(data.unresolved)} in this file named something codemap could not find, so some of its coupling is not drawn`
                : `${describeUnresolved(data.unresolved)} across the ${data.files.length} files in here named something codemap could not find, so some of their coupling is not drawn`
            }
          >
            <i className="codicon codicon-question" aria-hidden="true" />
            {data.unresolved.imports + data.unresolved.calls}
          </span>
        )}
        {tag !== null && (
          <span
            className="box-lang"
            title={
              data.language === null
                ? `${data.files.length} files, in more than one language`
                : `language: ${data.language}`
            }
          >
            {tag}
          </span>
        )}
        {/* As quiet as the language tag, and beside it: what a file is for is
            the same order of fact as what it is written in. It is here so a
            box drawn from a suite reads as one, not because it is drawn any
            differently — tests are in the graph; they just do not vote. */}
        {data.test && (
          <span
            className="box-test"
            title={
              data.kind === 'file'
                ? 'A test, fixture or story — it does not decide categories'
                : 'Every file in here is a test, fixture or story'
            }
          >
            test
          </span>
        )}
        {/* Wears the same mark a member row uses, because it is the same act on a
            bigger thing. It deliberately does not light the file's symbols: a
            click on a box already means "inspect this", and a second meaning
            for one gesture is worse than a control you have to press. Only on a
            file box — a folder stands for many paths, and quietly holding all
            of them would be a different act than the one you asked for. */}
        {file !== undefined && onDisk && (
          <>
            <button
              type="button"
              className="box-follow"
              aria-pressed={data.followed}
              title={
                data.followed
                  ? 'Stop holding on to this file'
                  : 'Hold on to this file, to explain later — nothing in the diagram dims'
              }
              onClick={(event) => {
                event.stopPropagation();
                data.onFollowFile(file, !data.followed);
              }}
            />
            {/* The sparkle is VS Code's own mark for "a model did this", and
                the tooltip says what it costs before it is pressed — the one
                thing on this box that spends money must not be the one thing
                that is coy about it. */}
            <button
              type="button"
              className="box-explain"
              title="Ask Claude what this file is for — it spends your Claude quota"
              aria-label="Explain this file"
              onClick={(event) => {
                event.stopPropagation();
                data.onExplain(file);
              }}
            >
              <i className="codicon codicon-sparkle" aria-hidden="true" />
            </button>
            {/* A codicon rather than a glyph: it is monochrome and takes
                currentColor, so it dims and lights with the button instead of
                sitting on it as a sticker. The label lives in aria-label now
                that the button has no text. */}
            <button
              type="button"
              className="box-open"
              title="Open in editor"
              aria-label="Open in editor"
              onClick={open(1)}
            >
              <i className="codicon codicon-link-external" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {/* A file gets its compartment of members; everything else stands for a
          pile of files and gets a count. Written as "is it a file" rather than
          "is it a folder" so a bundle takes the same branch a folder does — it
          carries no members either, and an empty list would draw a box with
          nothing in it.

          The bundle's title is the paths themselves: its label already says how
          many and which way ("258 dependents"), and which files it stands for is
          the one thing left that a reader wants from it. */}
      {data.kind !== 'file' ? (
        <div className="box-meta" title={bundled}>
          {/* A bundle's label is "260 dependents", and the reader who arrived
              here by following a symbol read those 260 as the symbol's. They
              are files, and they import the file in focus — which is a much
              weaker claim than using anything in it. One line, because the box
              is measured for one: the rest of the sentence is in the title. */}
          {data.kind === 'bundle'
            ? data.bundleOf === 'dependencies'
              ? 'files it imports'
              : 'files that import it'
            : `${data.files.length} ${data.files.length === 1 ? 'file' : 'files'}`}
        </div>
      ) : (
        <ul className="box-members">
          {shown.map((member, index) => (
            <li
              key={`${member.owner ?? ''}${member.name}-${index}`}
              // Which row a right-click landed on: React Flow hands App the box, and App reads this off the row.
              data-member-id={member.id}
              // Indented under the class that holds it. A flat list would put a
              // method beside the class it belongs to as though they were peers.
              className={[
                'member',
                `member-${member.kind}`,
                member.owner === null ? '' : 'member-nested',
                member.isStatic ? 'member-static' : '',
                member.isAbstract ? 'member-abstract' : '',
                data.following.has(member.id) ? 'member-picked' : '',
                data.related.has(member.id) ? 'member-related' : '',
                member.change === undefined ? '' : `member-${member.change}`,
                data.following.size > 0 &&
                !data.following.has(member.id) &&
                !data.related.has(member.id)
                  ? 'member-aside'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="member-vis" aria-hidden="true">
                {member.owner === null ? '' : VISIBILITY[member.visibility ?? 'public']}
              </span>

              <button
                type="button"
                className="member-name"
                // A removed row's line is the before graph's, and the file
                // may not even be there: nothing to open, and the title says.
                onClick={member.change === 'removed' ? undefined : open(member.line)}
                title={
                  member.change === 'removed'
                    ? `${member.owner === null ? '' : `${member.owner}.`}${member.name} — removed since ${data.since ?? 'the base'}; it was at line ${member.line} then`
                    : // An alias says so here rather than taking a column: the box
                      // is measured for a dozen names, and two rows at one line
                      // otherwise read as two functions. See `ViewMember.aliasOf`.
                      member.aliasOf === undefined
                      ? `${member.owner === null ? '' : `${member.owner}.`}${member.name}${
                          member.change === 'added' ? ` — added since ${data.since ?? 'the base'};` : ' —'
                        } open at line ${member.line}`
                      : `${member.name} is another name for ${member.aliasOf}, one body — open at line ${member.line}`
                }
              >
                {member.kind === 'function' || member.kind === 'method'
                  ? `${member.name}()`
                  : member.name}
              </button>

              {/* Only `never`, and never `covered`. The muted dot is worth its
                  pixel because it is rare — 99 of zod's 4201 symbols — and
                  because it is the one answer worth acting on; a mark on
                  everything the suite did run would fill the diagram with dots
                  that say "measured". Absent is the common answer and means
                  unknown, so it is drawn as nothing rather than as 0%. Muted
                  and not the warning colour: code the tests never reach is a
                  fact about the suite, not a fault in the file. */}
              {member.coverage === 'never' && (
                <span
                  className="member-never"
                  role="img"
                  title="never executed by the test suite"
                  aria-label="never executed by the test suite"
                />
              )}

              {/* The diff's letter on a row, the way the box wears one in its
                  title: text, in the git colour, at the right — the left
                  gutter is the visibility column and a mark there read as a
                  fourth visibility symbol. */}
              {member.change !== undefined && (
                <span
                  className={`member-change box-git-${CHANGE_LETTER[member.change].status}`}
                  aria-label={CHANGE_LETTER[member.change].said}
                >
                  {CHANGE_LETTER[member.change].letter}
                </span>
              )}

              {/* On the right, where the box already puts its editor link, and
                  because the left gutter is the visibility column — a mark that
                  means something different sitting in it read as a fourth
                  visibility symbol. */}
              <button
                type="button"
                className="member-pick"
                aria-pressed={data.following.has(member.id)}
                title={
                  data.following.has(member.id)
                    ? 'Stop following this symbol'
                    : `Show what ${member.name} uses, and what uses it — hold on to several at once`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  data.onFollow(member.id, !data.following.has(member.id));
                }}
              />
            </li>
          ))}
          {/* The count was a label, which meant the twelfth symbol was the last
              one the diagram would ever admit to. It is the way in now. */}
          {(hidden > 0 || data.expanded) && (
            <li className="member member-more">
              <button
                type="button"
                className="member-expand"
                title={
                  data.expanded
                    ? 'Show the first ' + MAX_MEMBERS + ' again'
                    : 'Show all ' + data.members.length + ' — the box grows and the diagram re-lays out'
                }
                onClick={(event) => {
                  event.stopPropagation();
                  data.onExpand(data.files[0] ?? data.label, !data.expanded);
                }}
              >
                {data.expanded ? 'show fewer' : '+' + hidden + ' more'}
              </button>
            </li>
          )}
        </ul>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
