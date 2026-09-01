import { useState, type MouseEvent } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

export type GroupData = {
  name: string | null;
  fileCount: number;
  cohesion: number;
  accepted: boolean;
  depth: number;
  onAccept: (name: string) => void;
  onReject: () => void;
};

/** Not "group": React Flow ships built-in styling for that type name, which
 * paints a pale block over everything the frame is meant to sit behind. */
export type GroupNodeType = Node<GroupData, 'frame'>;

/**
 * The frame behind a set of boxes. It is a suggestion until someone says
 * otherwise, so an unaccepted one is dashed and dimmed, and carries the two
 * decisions rather than assuming either.
 */
export function GroupNode({ data }: NodeProps<GroupNodeType>) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState(data.name ?? '');

  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <div
      className={[
        'group',
        `group-depth-${data.depth}`,
        data.accepted ? 'group-accepted' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="group-label" onMouseDown={stop} onClick={stop}>
        {naming ? (
          <input
            autoFocus
            value={draft}
            placeholder="Name this group"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim() !== '') {
                data.onAccept(draft.trim());
                setNaming(false);
              } else if (event.key === 'Escape') {
                setNaming(false);
              }
            }}
            onBlur={() => setNaming(false)}
          />
        ) : (
          <>
            <button type="button" className="group-name" onClick={() => setNaming(true)}>
              {data.name ?? `${data.fileCount} files together`}
            </button>
            <span className="group-meta">{Math.round(data.cohesion * 100)}%</span>
            {!data.accepted && (
              <button type="button" className="group-reject" title="Not a group" onClick={data.onReject}>
                ✕
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
