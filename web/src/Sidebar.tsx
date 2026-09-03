import { useEffect, useState, type ReactNode } from 'react';
import { Section } from './Section';
import { money, fetchDetail,
  openInEditor,
  type Detail,
  type ExplainFailure,
  type ExplainState,
  type StoredExplanation,
  type SymbolLinks,
  type SymbolRelation,
} from './api';

export interface Following {
  /** One entry per followed symbol the graph still knows, in pick order. */
  links: SymbolLinks[];
  /**
   * Followed symbol ids the graph answered 404 for.
   *
   * Listed rather than forgotten, and never pruned on the strength of it: a
   * file saved mid-edit will not parse for a cycle and loses every symbol in
   * it, so this is at its most common precisely while the agent is working,
   * and a list that emptied itself then would be worse than no list. Said out
   * loud instead, and taken off by hand.
   */
  gone: string[];
  /**
   * Held *files*: a reading list, not a lens.
   *
   * These never reach `relatedIds` or `relatedFiles`. Following a symbol dims
   * everything it does not touch and the chip counts what it dimmed; holding a
   * file dims nothing, deliberately. The two are joined only for what they mean
   * to the model, which is why they share this section and its one button.
   */
  files: { path: string; name: string }[];
  /**
   * The ids the run in flight actually asked about. One boolean made every row
   * in the section claim to be explaining, including ones the run had never
   * heard of — and those would have sat there saying it after it finished.
   */
  runningIds: ReadonlySet<string>;
  /** Stop the run in flight. Two minutes is a long time to have no way out. */
  onCancel: () => void;
  /** Drop a stored reading from .codemap/explain.json. It can simply be wrong. */
  onForget: (id: string) => void;
  /** True once every followed symbol has an answer, however empty. */
  settled: boolean;
  /** What has been explained, by id, for exactly the ids on show. */
  explanations: ReadonlyMap<string, StoredExplanation>;
  /** A run is in flight. It is a minute of subprocess, so it is said out loud. */
  running: boolean;
  /** The price of the last run that produced words. Null until one has. */
  lastRun: { costUsd: number; ms: number } | null;
  /**
   * Why the last press produced none, in the server's own wording. `refused`
   * is the press that asked for nothing — every id already current — which
   * is not a failed run and must not be worded as one.
   */
  failure: { reason: ExplainFailure | 'refused'; detail: string } | null;
  /** The answer as it is being written, before it is parsed into entries. */
  streamed: string;
  /**
   * `force` re-reads the ids whose reading is current as well. Off, the
   * server skips them: a press used to buy a second reading of a symbol the
   * panel already called current, at the same price as the first.
   */
  onExplain: (force: boolean) => void;
  onDrop: (id: string) => void;
}

interface SidebarProps {
  root: string;
  /** The box the user clicked, or null. Navigation is a separate gesture. */
  selected: string | null;
  /** Bumped whenever the graph changes, so the panel never shows a stale file. */
  revision: number;
  /** The commit the diagram is frozen at, so the detail describes what is drawn. */
  at: string | null;
  onSelect: (target: string) => void;
  /** The kind decides whether navigating means focus or scope. */
  onFocus: (target: string, kind: 'file' | 'folder') => void;
  following: Following;
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
  at,
  onSelect,
  onFocus,
  following,
}: SidebarProps) {
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetchDetail(selected, at).then(
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
  }, [selected, revision, root, at]);

  // The header's actions are what the panel head used to spell out as words:
  // go to it on the diagram, open it in the editor. Only a file has anywhere
  // in an editor to open.
  const actions =
    detail === null ? null : (
      <>
        <button
          type="button"
          title={detail.kind === 'file' ? 'Focus on this file' : 'Open this folder'}
          aria-label={detail.kind === 'file' ? 'Focus on this file' : 'Open this folder'}
          onClick={() => onFocus(detail.path, detail.kind)}
        >
          <i className="codicon codicon-target" aria-hidden="true" />
        </button>
        {detail.kind === 'file' && (
          <button
            type="button"
            title="Open in editor"
            aria-label="Open in editor"
            onClick={() => void openInEditor(root, detail.path, 1)}
          >
            <i className="codicon codicon-go-to-file" aria-hidden="true" />
          </button>
        )}
      </>
    );

  return (
    <aside className="sidebar">
      <Followed following={following} onSelect={onSelect} onFocus={onFocus} />

      <Section title="Detail" className="panel" actions={actions}>
        {detail === null ? (
          <p className="panel-empty">Click a box to see what it holds, and what depends on it.</p>
        ) : detail.kind === 'file' ? (
          <FileView detail={detail} root={root} onSelect={onSelect} />
        ) : (
          <FolderView detail={detail} onSelect={onSelect} />
        )}
      </Section>
    </aside>
  );
}

function FileView({
  detail,
  root,
  onSelect,
}: {
  detail: Extract<Detail, { kind: 'file' }>;
  root: string;
  onSelect: (target: string) => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
        <p className="panel-meta">
          {detail.symbols.length === 1 ? '1 symbol' : `${detail.symbols.length} symbols`} ·{' '}
          {detail.lineCount === 1 ? '1 line' : `${detail.lineCount} lines`}
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
      {/* Its own heading, never folded into Uses. An import says this file
          mentions that one; a call says it runs something in it, and the same
          path under both headings is the ordinary case — a file nearly always
          imports what it calls. Merged, the stronger claim would be read off
          the weaker evidence. Most files have none, and PathList hides an
          empty list. */}
      <PathList title="Calls" paths={detail.calls} onSelect={onSelect} />
    </>
  );
}

function FolderView({
  detail,
  onSelect,
}: {
  detail: Extract<Detail, { kind: 'folder' }>;
  onSelect: (target: string) => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
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
 * Every state a stored reading can be in, said in words.
 *
 * A Record keyed by the union for the same reason Categories' COLOR_LABELS is one: a state
 * the server learns to send fails to compile here until this file has something
 * to say about it, and an unnamed state is exactly the silence that makes a
 * reading get believed after it stopped being true.
 */
const STATE_WORDS: Record<ExplainState, string> = {
  none: 'Nothing has been asked about this one yet.',
  current: 'The source has not changed since this was written.',
  drifted:
    'The source is unchanged, but something it relates to has been written since. Still true, no longer complete.',
  stale: 'The source changed after this was written, so it may now be false.',
  orphaned: 'What this describes has left the graph.',
  unknown: 'Fingerprinted by a build this one cannot check against.',
};

/** The kinds a caller would be expected for. The rest are named, not called. */
const CALLABLE: ReadonlySet<string> = new Set(['function', 'method', 'class']);

/** Why a run produced nothing, in words that say what to do about it. */
const FAILURE_WORDS: Record<ExplainFailure | 'refused', string> = {
  refused: 'Nothing to explain:',
  missing: 'claude was not found.',
  auth: 'claude is installed but not logged in.',
  timeout: 'claude did not answer in time and was stopped.',
  failed: 'claude exited with an error.',
  unreadable: 'claude answered, but not in a shape that could be read.',
  unsaved: 'The answers arrived but could not be written to .codemap/explain.json — they are held for now and will be gone at the next restart.',
};

/**
 * What is being followed, listed, and what a model made of it.
 *
 * The diagram can only light a related symbol that happens to be on screen, and
 * most are not: a caller two directories away sits in a box the current scope
 * does not draw. So the highlighting answers "where does this sit" and this
 * answers "what is there", and neither is much use without the other.
 *
 * The explanations live here rather than in a panel of their own, because a
 * reading parted from the thing it reads is how a rotted one gets believed.
 */
function Followed({
  following,
  onSelect,
  onFocus,
}: {
  following: Following;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  const { links, gone, files, explanations, running, runningIds, lastRun, failure, streamed } = following;
  if (links.length === 0 && gone.length === 0 && files.length === 0) return null;

  // What a press can come back with words for. A gone symbol keeps its row and
  // its close button, but the graph cannot resolve it and the server drops it, so counting
  // it here would promise an answer that is not coming.
  const answerable = links.length + files.length;

  // Six identical "not explained yet" lines under a button that already says
  // "Explain · 6 new" is noise. The line earns its place the moment the list
  // is mixed — some rows read, some not — or a run has been and gone leaving
  // this row with nothing to show for it.
  const sayNothingYet = explanations.size > 0 || running || lastRun !== null || failure !== null;

  // What a press would actually spend on: the rows without a current reading.
  // The server skips the current ones either way, but a button that says 6
  // and reads 2 has a count nobody can trust. With nothing new to read the
  // button says what it will do instead — read them all again — and ⌥ does
  // the same while there still is.
  const fresh = [...links.map((symbol) => symbol.id), ...files.map((file) => file.path)].filter(
    (id) => explanations.get(id)?.state !== 'current',
  ).length;
  const rereadAll = answerable > 0 && fresh === 0;
  const lastRunNote =
    lastRun === null
      ? ''
      : ` Last run ${money(lastRun.costUsd)}${lastRun.ms === 0 ? '' : `, ${Math.round(lastRun.ms / 1000)}s`}.`;

  return (
    <Section title="Following" className="followed">
      <div className="followed-one">
        {/* Not a followed-head: that is a row, and this is the section's one
            button, which wants the whole width. */}
        <div className="explain-bar">
          <button
            type="button"
            className="explain-run"
            aria-busy={running}
            disabled={running || answerable === 0}
            title={
              running
                ? 'A run is in flight. It takes a minute or so.'
                : answerable === 0
                  ? 'Nothing here that the graph can still resolve.'
                  : rereadAll
                    ? `Every one of these has a current reading. Press to read all ${answerable} again — it spends your Claude quota.${lastRunNote}`
                    : `Ask Claude what the ${fresh} without a current reading are for. It spends your Claude quota.${
                        fresh === answerable ? '' : ` ⌥-click to read all ${answerable} again.`
                      }${lastRunNote}`
            }
            onClick={(event) => following.onExplain(rereadAll || event.altKey)}
          >
            {running ? 'Explaining' : rereadAll ? 'Re-explain all' : 'Explain'}
            <span>·</span>
            {running || rereadAll ? answerable : `${fresh} new`}
          </button>

          {running && (
            <button type="button" className="explain-stop" onClick={following.onCancel}>
              stop
            </button>
          )}
        </div>

        {/* The answer as it lands. Twelve seconds pass before the first
            character, and a wait with nothing moving in it is indistinguishable
            from a hung subprocess — which is what this was, until it streamed.
            Shown raw: it is not parsed into entries until the run ends. */}
        {running && streamed !== '' && (
          <p className="explain-stream">{streamed.replace(/^@@ .*$/gm, '').trim()}</p>
        )}
        {/* The label is never the useful half on its own: `missing` carries the
            list of places that were searched, which is the fixable part, so the
            detail is printed exactly as it came back. */}
        {failure !== null && (
          <p className="explain-failed">
            {FAILURE_WORDS[failure.reason]}
            {failure.detail === '' ? '' : ` ${failure.detail}`}
          </p>
        )}
      </div>

      {links.map((symbol) => (
        <div className="followed-one" key={symbol.id}>
          <div className="followed-head">
            <span className="followed-name">{symbol.name}</span>
            <span className="followed-where" title={symbol.filePath}>
              {symbol.filePath}
            </span>
            <StateChip state={explanations.get(symbol.id)?.state} />
            <span className="row-actions">
              {explanations.has(symbol.id) && (
                <button
                  type="button"
                  className="followed-drop"
                  title="Forget this reading — it is removed from .codemap/explain.json"
                  aria-label="Forget this reading"
                  onClick={() => following.onForget(symbol.id)}
                >
                  <i className="codicon codicon-trash" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="followed-drop"
                title="Stop following this one"
                aria-label="Stop following this one"
                onClick={() => following.onDrop(symbol.id)}
              >
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            </span>
          </div>

          <Reading
            entry={explanations.get(symbol.id)}
            running={runningIds.has(symbol.id)}
            sayNothingYet={sayNothingYet}
          />

          {/* The graph's own word on how much of the lists below it can vouch
              for. A method's callers are the typed ones only, so for one an
              empty list is a silence, not a count — cobra's Command.Execute
              read "0 in" with sixteen callers in grep — and this sentence is
              what keeps the silence from being read as none. */}
          {symbol.coverage === 'partial' && (
            <p className="followed-coverage">{symbol.coverageNote}</p>
          )}

          {symbol.usedBy.length === 0 && symbol.uses.length === 0 ? (
            // A type or an interface is never *called*, so an empty relation
            // list is the normal case for it and saying so on every one taught
            // the reader to stop reading the line. It is only worth a sentence
            // where callers were expected and the graph looked everywhere it
            // can — a method's sentence is the coverage note above.
            symbol.coverage === 'full' &&
            CALLABLE.has(symbol.kind) && (
              <p className="followed-none">
                Nothing in the graph references this by name, and it references nothing that
                resolved.
              </p>
            )
          ) : (
            <>
              <Relations
                title={symbol.coverage === 'partial' ? 'known used by' : 'used by'}
                rows={symbol.usedBy}
                onSelect={onSelect}
                onFocus={onFocus}
              />
              <Relations title="uses" rows={symbol.uses} onSelect={onSelect} onFocus={onFocus} />
            </>
          )}
        </div>
      ))}

      {gone.map((id) => (
        <Lost
          key={id}
          id={id}
          entry={explanations.get(id)}
          sayNothingYet={sayNothingYet}
          onDrop={() => following.onDrop(id)}
        />
      ))}

      {files.map((file) => (
        <div className="followed-one" key={file.path}>
          <div className="followed-head">
            <span className="followed-name">{file.name}</span>
            <span className="followed-where" title={file.path}>
              {file.path}
            </span>
            {/* Why this row has no callers under it: it is a whole file, held to
                be read rather than to be traced through. */}
            <span className="followed-edge">file</span>
            <StateChip state={explanations.get(file.path)?.state} />
            <span className="row-actions">
              {explanations.has(file.path) && (
                <button
                  type="button"
                  className="followed-drop"
                  title="Forget this reading — it is removed from .codemap/explain.json"
                  aria-label="Forget this reading"
                  onClick={() => following.onForget(file.path)}
                >
                  <i className="codicon codicon-trash" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="followed-drop"
                title="Stop holding this file"
                aria-label="Stop holding this file"
                onClick={() => following.onDrop(file.path)}
              >
                <i className="codicon codicon-close" aria-hidden="true" />
              </button>
            </span>
          </div>

          <Reading
            entry={explanations.get(file.path)}
            running={runningIds.has(file.path)}
            sayNothingYet={sayNothingYet}
          />
        </div>
      ))}
    </Section>
  );
}

/**
 * A followed symbol the graph no longer has.
 *
 * Kept, not pruned, and its reading kept with it: an explanation of something
 * that has gone is the most interesting thing this tool can say. All that is
 * left of it is the id — a re-parse clears every answer the page held — so the
 * name is read back out of the id rather than remembered.
 */
function Lost({
  id,
  entry,
  sayNothingYet,
  onDrop,
}: {
  id: string;
  entry: StoredExplanation | undefined;
  sayNothingYet: boolean;
  onDrop: () => void;
}) {
  // Split at the first '#': the path comes first, and a `#private` member's
  // name holds a '#' of its own — `path#Observer.#tick` cut at the last one
  // would call the symbol "tick" of the file "path#Observer.". A path holding
  // one is ambiguous under either rule; the id scheme does not guard it.
  const cut = id.indexOf('#');
  const name = cut === -1 ? id : id.slice(cut + 1);
  const filePath = cut === -1 ? '' : id.slice(0, cut);

  return (
    <div className="followed-one">
      <div className="followed-head">
        <span className="followed-name">{name}</span>
        <span className="followed-where" title={id}>
          {filePath}
        </span>
        <span className="explain-state" data-state="orphaned" title={STATE_WORDS.orphaned}>
          gone
        </span>
        <span className="row-actions">
          <button
            type="button"
            className="followed-drop"
            title="Stop following this one"
            aria-label="Stop following this one"
            onClick={onDrop}
          >
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        </span>
      </div>

      <p className="followed-none">
        Not in the graph. A file that will not parse loses its symbols until the next save,
        so this is kept until you take it off.
      </p>

      <Reading entry={entry} running={false} sayNothingYet={sayNothingYet} />
    </div>
  );
}

/**
 * How a reading stands to the code it describes, in one word.
 *
 * Nothing is drawn for `current`: a chip on every healthy row is noise. The two
 * grades that are left mean opposite things — drifted is still true and merely
 * incomplete, stale may now be false — and only one of them should stop anyone
 * trusting the words, so only one of them is loud.
 */
function StateChip({ state }: { state: ExplainState | undefined }) {
  if (state === undefined || state === 'current' || state === 'none') return null;
  return (
    <span className="explain-state" data-state={state} title={STATE_WORDS[state]}>
      {state}
    </span>
  );
}

/**
 * The reading itself, short first, and every state it can be in said out loud.
 *
 * A spinner that never resolves, or a row that is simply blank, is the failure
 * this section is arranged against: it costs the user money to fill, and an
 * answer nobody can tell apart from a silence is not worth what it cost.
 */
function Reading({
  entry,
  running,
  sayNothingYet,
}: {
  entry: StoredExplanation | undefined;
  running: boolean;
  sayNothingYet: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (entry === undefined) {
    // The two silences nobody can tell apart otherwise: a row nothing has been
    // spent on, and a row being paid for right now.
    if (running) return <p className="followed-none">Explaining this one…</p>;
    return sayNothingYet ? <p className="followed-none">Not explained yet.</p> : null;
  }

  // Dimmed, never deleted. The source moved under these words, or the thing
  // they describe is gone — and in both cases the old reading is usually still
  // most of the answer. The chip beside it stays bright: it is the part that
  // says why the rest is faded.
  const doubted = entry.state === 'stale' || entry.state === 'orphaned';

  return (
    <div className={doubted ? 'explain-stale' : undefined}>
      <p className="explain-short">
        {entry.short}
        {entry.long !== '' && (
          <button
            type="button"
            className="explain-more"
            title={open ? 'Fold it away' : 'The fuller reading'}
            onClick={() => setOpen(!open)}
          >
            {open ? 'less' : 'more'}
          </button>
        )}
      </p>
      {open && entry.long !== '' && <p className="explain-long">{entry.long}</p>}
      {/* A run is on and this row already has words: they are the old ones until
          it ends. Blanking them for a minute to prove something is happening
          would take away the thing the panel is for. */}
      {running && <p className="followed-none">Reading it again…</p>}
    </div>
  );
}

/** Cents are the unit here: a run is two or three of them, not two dollars. */
function Relations({
  title,
  rows,
  onSelect,
  onFocus,
}: {
  title: string;
  rows: SymbolRelation[];
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="followed-kind">
        {title} <span>{rows.length}</span>
      </h3>
      <ul className="followed-rows">
        {rows.map((row) => (
          <li key={row.id + row.edge}>
            <button
              type="button"
              title={
                // A file caller has no line to open at: the call was written
                // outside every symbol, so the row names a whole box and says
                // so rather than pointing at line 1 as though it were a
                // declaration.
                row.kind === 'file'
                  ? `${row.filePath} — ${row.edge} this from a statement outside every symbol in it`
                  : `${row.filePath}:${row.line} — ${row.edge}`
              }
              onClick={() => onSelect(row.filePath)}
              onDoubleClick={() => onFocus(row.filePath, 'file')}
            >
              {/* The name is a basename here, which without a mark would read
                  as a symbol someone had called store.ts. Beside the name and
                  not inside it, so the name keeps its own ellipsis. */}
              {row.kind === 'file' && (
                <i className="codicon codicon-symbol-file followed-icon" aria-hidden="true" />
              )}
              <span className="followed-symbol">{row.name}</span>
              <span className="followed-edge">{row.edge}</span>
              <span className="followed-file">{row.filePath}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
