import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchChanges,
  fetchDetail,
  openInEditor,
  type ChangeEntry,
  type Detail,
} from './api';

interface SidebarProps {
  root: string;
  /** The box the user clicked, or null. Navigation is a separate gesture. */
  selected: string | null;
  /** Bumped whenever the graph changes, so the panel never shows a stale file. */
  revision: number;
  onSelect: (target: string) => void;
  /** The kind decides whether navigating means focus or scope. */
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function Sidebar({ root, selected, revision, onSelect, onFocus }: SidebarProps) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [changes, setChanges] = useState<ChangeEntry[]>([]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetchDetail(selected).then(
      (result) => {
        if (!cancelled) setDetail(result);
      },
      () => {
        if (!cancelled) setDetail(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selected, revision, root]);

  useEffect(() => {
    let cancelled = false;
    fetchChanges().then(
      (result) => {
        if (!cancelled) setChanges(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [revision, root]);

  return (
    <aside className="sidebar">
      <section className="panel">
        {detail === null ? (
          <p className="panel-empty">Click a box to see what it holds, and what depends on it.</p>
        ) : detail.kind === 'file' ? (
          <FileView detail={detail} root={root} onSelect={onSelect} onFocus={onFocus} />
        ) : (
          <FolderView detail={detail} onSelect={onSelect} onFocus={onFocus} />
        )}
      </section>

      <section className="feed">
        <h2>Changes</h2>
        {changes.length === 0 ? (
          <p className="panel-empty">Nothing has changed since this project was opened.</p>
        ) : (
          <ol>
            {changes.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <time>{clock.format(new Date(entry.at))}</time>
                <span className="feed-files">
                  {entry.files.map((file) => (
                    <button type="button" key={file} onClick={() => onSelect(file)} title={file}>
                      {file}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

function FileView({
  detail,
  root,
  onSelect,
  onFocus,
}: {
  detail: Extract<Detail, { kind: 'file' }>;
  root: string;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
        <div className="panel-actions">
          <button type="button" onClick={() => onFocus(detail.path, 'file')}>
            Focus
          </button>
          <button type="button" onClick={() => void openInEditor(root, detail.path, 1)}>
            Open
          </button>
        </div>
        <p className="panel-meta">
          {detail.symbols.length} symbols · {detail.lineCount} lines
        </p>
      </header>

      {/* The whole list, not the eight the box has room for. */}
      <PanelList title="Declares">
        {detail.symbols.map((symbol, index) => (
          <li key={`${symbol.name}-${index}`}>
            <button
              type="button"
              className={`sym sym-${symbol.kind}`}
              onClick={() => void openInEditor(root, detail.path, symbol.line)}
              title={`Open at line ${symbol.line}`}
            >
              {symbol.kind === 'function' ? `${symbol.name}()` : symbol.name}
              <span className="sym-line">{symbol.line}</span>
            </button>
          </li>
        ))}
      </PanelList>

      {/* The answer the diagram could never give. */}
      <PathList title="Used by" paths={detail.importedBy} onSelect={onSelect} />
      <PathList title="Uses" paths={detail.imports} onSelect={onSelect} />
    </>
  );
}

function FolderView({
  detail,
  onSelect,
  onFocus,
}: {
  detail: Extract<Detail, { kind: 'folder' }>;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
        <div className="panel-actions">
          <button type="button" onClick={() => onFocus(detail.path, 'folder')}>
            Open
          </button>
        </div>
        <p className="panel-meta">{detail.files.length} files</p>
      </header>

      <PathList title="Files" paths={detail.files} onSelect={onSelect} />
      <PathList title="Used by" paths={detail.importedBy} onSelect={onSelect} />
      <PathList title="Uses" paths={detail.imports} onSelect={onSelect} />
    </>
  );
}

function PanelList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="panel-list">
      <h3>{title}</h3>
      <ul>{children}</ul>
    </div>
  );
}

function PathList({
  title,
  paths,
  onSelect,
}: {
  title: string;
  paths: string[];
  onSelect: (target: string) => void;
}) {
  if (paths.length === 0) return null;

  return (
    <PanelList title={`${title} (${paths.length})`}>
      {paths.map((path) => (
        <li key={path}>
          <button type="button" className="path" onClick={() => onSelect(path)} title={path}>
            {path}
          </button>
        </li>
      ))}
    </PanelList>
  );
}
