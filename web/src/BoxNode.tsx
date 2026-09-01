import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { MouseEvent } from 'react';
import { openInEditor, type GitFileStatus, type ViewMember } from './api';
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
  /** Needed to build an absolute path for an editor link. */
  root: string;
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

export function BoxNode({ data }: NodeProps<BoxNodeType>) {
  const shown = data.members.slice(0, MAX_MEMBERS);
  const hidden = data.members.length - shown.length;
  const file = data.kind === 'file' ? data.files[0] : undefined;

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
              className={`member member-${member.kind}${member.owner === null ? '' : ' member-nested'}`}
            >
              <button
                type="button"
                onClick={open(member.line)}
                title={`${member.owner === null ? '' : `${member.owner}.`}${member.name} — open at line ${member.line}`}
              >
                {member.kind === 'function' || member.kind === 'method'
                  ? `${member.name}()`
                  : member.name}
              </button>
            </li>
          ))}
          {hidden > 0 && <li className="member member-more">+{hidden} more</li>}
        </ul>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
