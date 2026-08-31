import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ViewMember } from './api';
import { MAX_MEMBERS } from './layout';

export type BoxData = {
  label: string;
  kind: 'file' | 'folder';
  members: ViewMember[];
  fileCount: number;
  external: boolean;
  focused: boolean;
};

export type BoxNodeType = Node<BoxData, 'box'>;

export function BoxNode({ data }: NodeProps<BoxNodeType>) {
  const shown = data.members.slice(0, MAX_MEMBERS);
  const hidden = data.members.length - shown.length;

  const classes = ['box', `box-${data.kind}`];
  if (data.external) classes.push('box-external');
  if (data.focused) classes.push('box-focused');

  return (
    <div className={classes.join(' ')}>
      <Handle type="target" position={Position.Left} />
      <div className="box-title" title={data.label}>{data.label}</div>

      {data.kind === 'folder' ? (
        <div className="box-meta">{data.fileCount} {data.fileCount === 1 ? 'file' : 'files'}</div>
      ) : (
        <ul className="box-members">
          {shown.map((member, index) => (
            <li key={`${member.name}-${index}`} className={`member member-${member.kind}`}>
              {member.kind === 'function' ? `${member.name}()` : member.name}
            </li>
          ))}
          {hidden > 0 && <li className="member member-more">+{hidden} more</li>}
        </ul>
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
