import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchChanges,
  fetchDetail,
  openInEditor,
  type ChangeEntry,
  type AgentCall,
  type Detail,
  type GroupSuggestion,
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
  groups: GroupSuggestion[];
  /** What the agent asked, newest first. Interleaved with the changes below. */
  agentCalls: AgentCall[];
  onDecide: (group: GroupSuggestion, name: string, state: 'accepted' | 'rejected') => void;
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function Sidebar({
  root,
  selected,
  revision,
  onSelect,
  onFocus,
  groups,
  onDecide,
  agentCalls,
}: SidebarProps) {
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

      <GroupList groups={groups} onDecide={onDecide} onSelect={onSelect} />

      <Timeline changes={changes} agentCalls={agentCalls} onSelect={onSelect} />
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

/**
 * Every group the graph found, including the ones whose frames were dropped for
 * overlapping. A group that cannot be drawn can still be named.
 */
function GroupList({
  groups,
  onDecide,
  onSelect,
}: {
  groups: GroupSuggestion[];
  onDecide: (group: GroupSuggestion, name: string, state: 'accepted' | 'rejected') => void;
  onSelect: (target: string) => void;
}) {
  const [naming, setNaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const live = groups.filter((group) => group.state !== 'rejected');
  if (live.length === 0) return null;

  return (
    <section className="groups">
      <h2>Groups</h2>
      <ul>
        {live.map((group) => (
          <li key={group.id}>
            {naming === group.id ? (
              <input
                autoFocus
                value={draft}
                placeholder="Name this group"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && draft.trim() !== '') {
                    onDecide(group, draft.trim(), 'accepted');
                    setNaming(null);
                  } else if (event.key === 'Escape') setNaming(null);
                }}
                onBlur={() => setNaming(null)}
              />
            ) : (
              <div className="group-row">
                <button
                  type="button"
                  className={group.state === 'accepted' ? 'group-title named' : 'group-title'}
                  onClick={() => {
                    setDraft(group.name ?? '');
                    setNaming(group.id);
                  }}
                >
                  {group.name ?? `${group.files.length} files`}
                </button>
                <span className="group-cohesion">{Math.round(group.cohesion * 100)}%</span>
                <button
                  type="button"
                  className="group-drop"
                  title="Not a group"
                  onClick={() => onDecide(group, group.name ?? '', 'rejected')}
                >
                  ✕
                </button>
              </div>
            )}
            <div className="group-files">
              {group.files.map((file) => (
                <button type="button" key={file} title={file} onClick={() => onSelect(file)}>
                  {file}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The agent's questions and its edits in one column, newest first.
 *
 * Two separate lists would hide the thing worth seeing: an agent looks a file
 * up and then rewrites it, and the lookup is what explains the edit.
 */
function Timeline({
  changes,
  agentCalls,
  onSelect,
}: {
  changes: ChangeEntry[];
  agentCalls: AgentCall[];
  onSelect: (target: string) => void;
}) {
  const rows = [
    ...changes.map((entry) => ({ at: entry.at, kind: 'change' as const, entry })),
    ...agentCalls.map((call) => ({ at: call.at, kind: 'agent' as const, call })),
  ].sort((a, b) => b.at - a.at);

  return (
    <section className="feed">
      <h2>Agent &amp; changes</h2>
      {rows.length === 0 ? (
        <p className="panel-empty">
          Nothing yet. Edits show here, and so does anything an agent asks codemap through MCP.
        </p>
      ) : (
        <ol>
          {rows.map((row, index) => (
            <li key={`${row.at}-${index}`} className={row.kind === 'agent' ? 'feed-agent' : undefined}>
              <time>{clock.format(new Date(row.at))}</time>
              {row.kind === 'change' ? (
                <span className="feed-files">
                  <span className="feed-mark" title="changed on disk">
                    ✎
                  </span>
                  {row.entry.files.map((file) => (
                    <button type="button" key={file} onClick={() => onSelect(file)} title={file}>
                      {file}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="feed-files">
                  <span className="feed-mark" title="the agent asked codemap">
                    ?
                  </span>
                  <span className="feed-tool">
                    {row.call.tool}
                    {row.call.target !== null && (
                      <button
                        type="button"
                        className="feed-target"
                        onClick={() => row.call.target && onSelect(row.call.target)}
                        title={row.call.target}
                      >
                        {row.call.target}
                      </button>
                    )}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
