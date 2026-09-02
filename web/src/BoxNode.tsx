import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { MouseEvent } from 'react';
import { openInEditor, type GitFileStatus, type LanguageId, type ViewMember } from './api';
import { MAX_MEMBERS } from './layout';

export type BoxData = {
  label: string;
  kind: 'file' | 'folder';
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
  /** The one language its files share; null on a folder holding several. */
  language: LanguageId | null;
  /** False in a single-language project, where the tag would say nothing. */
  showLanguage: boolean;
  /** Needed to build an absolute path for an editor link. */
  root: string;
  /** Showing every member rather than the first twelve. */
  expanded: boolean;
  onExpand: (id: string, expanded: boolean) => void;
  /** The symbol whose relations are being shown, if any is. */
  highlight: string | null;
  /** Symbol ids related to it, so a row knows whether to light or fade. */
  related: ReadonlySet<string>;
  onHighlight: (id: string | null) => void;
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
  untracked: '?',
  renamed: 'R',
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
};

export function BoxNode({ data }: NodeProps<BoxNodeType>) {
  const shown = data.expanded ? data.members : data.members.slice(0, MAX_MEMBERS);
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

  const classes = ['box', `box-${data.kind}`];
  if (data.external) classes.push('box-external');
  if (data.changed) classes.push('box-changed');
  if (data.queried) classes.push('box-queried');
  if (data.focused) classes.push('box-focused');

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
        <span className="box-title-text" title={data.label}>
          {data.label}
        </span>
        {data.gitStatus !== null && (
          <span
            className={`box-git box-git-${data.gitStatus}`}
            title={`${data.gitStatus} vs the git base`}
          >
            {GIT_LETTER[data.gitStatus]}
          </span>
        )}
        {/* A folder box stands for many files, so the useful fact is how many
            of them moved, not which way any single one did. */}
        {data.kind === 'folder' && data.gitChanged > 0 && (
          <span
            className="box-git box-git-count"
            title={`${data.gitChanged} of ${data.files.length} changed vs the git base`}
          >
            {data.gitChanged}
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
        {file !== undefined && (
          <button type="button" className="box-open" title="Open in editor" onClick={open(1)}>
            ↗
          </button>
        )}
      </div>

      {data.kind === 'folder' ? (
        <div className="box-meta">
          {data.files.length} {data.files.length === 1 ? 'file' : 'files'}
        </div>
      ) : (
        <ul className="box-members">
          {shown.map((member, index) => (
            <li
              key={`${member.owner ?? ''}${member.name}-${index}`}
              // Indented under the class that holds it. A flat list would put a
              // method beside the class it belongs to as though they were peers.
              className={[
                'member',
                `member-${member.kind}`,
                member.owner === null ? '' : 'member-nested',
                member.isStatic ? 'member-static' : '',
                member.isAbstract ? 'member-abstract' : '',
                data.highlight === member.id ? 'member-picked' : '',
                data.related.has(member.id) ? 'member-related' : '',
                data.highlight !== null && data.highlight !== member.id && !data.related.has(member.id)
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
                onClick={open(member.line)}
                title={`${member.owner === null ? '' : `${member.owner}.`}${member.name} — open at line ${member.line}`}
              >
                {member.kind === 'function' || member.kind === 'method'
                  ? `${member.name}()`
                  : member.name}
              </button>

              {/* On the right, where the box already puts its editor link, and
                  because the left gutter is the visibility column — a mark that
                  means something different sitting in it read as a fourth
                  visibility symbol. */}
              <button
                type="button"
                className="member-pick"
                aria-pressed={data.highlight === member.id}
                title={
                  data.highlight === member.id
                    ? 'Stop following this symbol'
                    : `Show what ${member.name} uses, and what uses it`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  data.onHighlight(data.highlight === member.id ? null : member.id);
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
