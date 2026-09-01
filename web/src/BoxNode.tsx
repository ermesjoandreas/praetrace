import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { MouseEvent } from 'react';
import { openInEditor, type ViewMember } from './api';
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
  /** Needed to build an absolute path for an editor link. */
  root: string;
};

export type BoxNodeType = Node<BoxData, 'box'>;

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
            <li key={`${member.name}-${index}`} className={`member member-${member.kind}`}>
              <button type="button" onClick={open(member.line)} title={`Open at line ${member.line}`}>
                {member.kind === 'function' ? `${member.name}()` : member.name}
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
