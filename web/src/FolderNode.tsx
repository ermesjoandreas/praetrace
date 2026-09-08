import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

export type FolderData = {
  /** The folder's path, which is its id — `ProsjektMVC/Views/Home`. */
  id: string;
  /** What it is called here: the path below the scope, collapsed folders joined on. */
  label: string;
  /** How many boxes are inside, nested ones included. */
  fileCount: number;
  /** 0 is an outermost frame; 1 sits inside one. */
  depth: number;
  /** Shut: drawn as one box standing for its files, rather than as a frame. */
  folded: boolean;
  /**
   * Every box in it is a file the diff's before graph holds and the tree does
   * not — so the folder itself is gone. Derived from the boxes rather than
   * carried by the engine: a ghost frame is exactly "every box in it is a
   * ghost", and a second place deciding that is a second place to be wrong.
   */
  ghost: boolean;
  /** A file inside changed while the fold was hiding it. Folded frames only. */
  marked: boolean;
  onFold: (folded: boolean) => void;
};

/**
 * A folder, drawn around the boxes in it — or, shut, as one box standing for
 * them.
 *
 * **It must not read as a category, and the difference is not a hue.** A
 * category is a piece of architecture a person named and coloured; a folder is
 * neither named nor coloured by anybody — it is what the tree already says. So
 * a category frame keeps the eight colours and its 6% fill, and this is the
 * page's own structural hairline: `--vsc-border`, the same 1px line that
 * separates every region of the window, with no fill and no colour of its own.
 * Nothing here can be renamed, coloured, deleted or dragged, because none of
 * those is a thing you can do to a directory from a diagram.
 *
 * The one gesture is the fold, and it is the other half of something the
 * engine already does: above `GROUP_THRESHOLD` a folder *is* a box with a
 * count on it, and under `?folders=1` it is a frame around the boxes. Shutting
 * a frame puts the folder back as that box; opening it draws its files again.
 */
export type FolderNodeType = Node<FolderData, 'folder'>;

export function FolderNode({ data }: NodeProps<FolderNodeType>) {
  const files = `${data.fileCount} ${data.fileCount === 1 ? 'file' : 'files'}`;

  /**
   * The chevron, and the whole of what a folder frame can be asked to do.
   * Down is open, right is shut — the direction the left bar's sections use,
   * so one gesture means one thing on this page.
   */
  const fold = (
    <button
      type="button"
      className="folder-fold nodrag"
      aria-expanded={!data.folded}
      title={data.folded ? `Draw the ${files} in ${data.label}` : `Fold ${data.label} into one box`}
      onClick={(event) => {
        event.stopPropagation();
        data.onFold(!data.folded);
      }}
    >
      <i
        className={`codicon ${data.folded ? 'codicon-chevron-right' : 'codicon-chevron-down'}`}
        aria-hidden="true"
      />
    </button>
  );

  // Shut: an ordinary box, in the box's own chrome, so it reads as one of the
  // things on the canvas rather than as a shrunken frame. `.box-title` is the
  // drag handle every box on this page is moved by.
  if (data.folded) {
    return (
      <div className={data.marked ? 'box box-folder-shut box-changed' : 'box box-folder-shut'}>
        <Handle type="target" position={Position.Left} />
        <div className="box-title">
          {fold}
          <span
            className="box-title-text"
            // A box standing for a pile says how many moved, never which way:
            // the direction is a fact about one file and there is no one file
            // here — the rule a folder box and a bundle already follow.
            title={data.marked ? `${data.id}\n\nSomething in here has just changed` : data.id}
          >
            {data.label}
          </span>
        </div>
        <div className="box-meta">{files}</div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  return (
    <div
      className={[
        'folder-frame',
        `folder-depth-${Math.min(data.depth, 3)}`,
        data.ghost ? 'folder-ghost' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* The frame lets every click through to the boxes it is drawn behind;
          only this line catches one. LABEL_HEIGHT in layout.ts is 18, and
          everything on it is 18 or less with no vertical padding. */}
      <div className="folder-label">
        {fold}
        <span className="folder-name" title={data.id}>
          {data.label}
        </span>
        <span className="folder-count">{files}</span>
        {data.ghost && (
          <span className="folder-gone" title="Every file in this folder is a ghost: the folder is not on disk">
            gone
          </span>
        )}
      </div>
    </div>
  );
}
