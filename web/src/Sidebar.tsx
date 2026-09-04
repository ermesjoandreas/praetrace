import { useEffect, useState, type ReactNode } from 'react';
import { LIST_ROW, useListKeys } from './listkeys';
import { Section } from './Section';
import { FLOOR, money, fetchDetail,
  fetchSymbol,
  openInEditor,
  type Detail,
  type SymbolDetail,
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
  /**
   * The file explaining would create, when the server is waiting to be told it
   * may. Null when there is nothing to ask — which is every project that
   * already has a `.codemap/`, so the question is asked once and never again.
   */
  consent: string | null;
  /** Say yes, and run the press that raised the question. */
  onAcceptStore: () => void;
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
  /**
   * The box that was clicked, when it was a bundle: the files a focus view had
   * too many neighbours to draw one by one.
   *
   * Passed in rather than fetched, because a bundle is not a path — `/api/detail`
   * can only answer 404 for one — and the view is the only thing that knows
   * which files went into it. This is what makes the box openable: the diagram
   * says "258 dependents", and the panel is where those 258 have names.
   */
  bundle?: { label: string; files: string[]; of: 'dependents' | 'dependencies' | null } | null;
  /**
   * The graph id of each symbol the selected file declares, by name and start
   * line.
   *
   * `/api/detail` names a symbol and never says which id the graph filed it
   * under, and the id cannot be rebuilt from the name: a method is
   * `path#Class.method` and a second symbol of the same name in one file wears
   * a `~2`. The view already carries the id on every member, so the join is
   * made where both are in hand rather than guessed at here. Empty whenever
   * the file has no box on screen — collapsed into a folder, or reached from a
   * path row — and a row with no id shows no Explain, because a press that
   * asked about nothing would be worse than no press.
   */
  symbolIds: ReadonlyMap<string, string>;
  /** Follow one symbol and ask a model what it is for, in one press. */
  onExplainSymbol: (id: string) => void;
  /**
   * The same for the whole file, which the panel can offer where a box cannot:
   * a path row selects a file the diagram is not drawing — an importer outside
   * the current scope — and that file has no box to hover.
   */
  onExplainFile: (path: string) => void;
  following: Following;
}

/** The key both halves of that join agree on. A file has one symbol per line and name. */
export function symbolKey(name: string, line: number): string {
  return `${line}\n${name}`;
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
  bundle = null,
  symbolIds,
  onExplainSymbol,
  onExplainFile,
  following,
}: SidebarProps) {
  const [detail, setDetail] = useState<Detail | null>(null);
  /**
   * The row of the Declares list that is open, with everything the header can
   * draw before the graph has answered: a fetch takes a moment, and a panel
   * that goes blank in it reads as the click having done nothing — which is
   * what this whole view exists to stop.
   */
  const [openSymbol, setOpenSymbol] = useState<(SymbolDetail & { id: string }) | null>(null);
  /** What that symbol reaches and what reaches it. 'gone' is the graph's 404. */
  const [symbolLinks, setSymbolLinks] = useState<SymbolLinks | 'gone' | null>(null);

  // A different box, or a different commit, is a different question. Not
  // `bundle`: App builds that object inline, so it is a new one every render
  // and would close the symbol the moment it was opened.
  useEffect(() => {
    setOpenSymbol(null);
  }, [selected, at]);

  useEffect(() => {
    if (openSymbol === null) {
      setSymbolLinks(null);
      return;
    }
    let cancelled = false;
    setSymbolLinks(null);
    fetchSymbol(openSymbol.id, at).then(
      (found) => {
        if (!cancelled) setSymbolLinks(found ?? 'gone');
      },
      () => {
        if (!cancelled) setSymbolLinks(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [openSymbol, revision, at]);

  useEffect(() => {
    // A bundle id names no file, so asking about it can only be answered 404.
    if (selected === null || bundle !== null) {
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
  }, [selected, revision, root, at, bundle]);

  // The header's actions are what the panel head used to spell out as words:
  // go to it on the diagram, ask what it is for, open it in the editor. Only a
  // file has anywhere in an editor to open, or a reading to be had of it.
  //
  // A symbol takes the header over while it is open: both of these mean
  // something different one level down — the reading is of this symbol, and the
  // editor opens on its own line. The way back is not here, because a section
  // action is hidden until the section is hovered and the way out of a view
  // must not be; it is in the view's own header, where it is always drawn.
  const actions =
    openSymbol !== null && detail?.kind === 'file' ? (
      <>
        <button
          type="button"
          title={`Ask Claude what ${openSymbol.name} is for — it spends your Claude quota`}
          aria-label="Explain this symbol"
          onClick={() => onExplainSymbol(openSymbol.id)}
        >
          <i className="codicon codicon-sparkle" aria-hidden="true" />
        </button>
        <button
          type="button"
          title={`Open ${detail.path} at line ${openSymbol.line}`}
          aria-label="Open in editor"
          onClick={() => void openInEditor(root, detail.path, openSymbol.line)}
        >
          <i className="codicon codicon-go-to-file" aria-hidden="true" />
        </button>
      </>
    ) : detail === null ? null : (
      <>
        <button
          type="button"
          title={detail.kind === 'file' ? 'Focus on this file' : 'Open this folder'}
          aria-label={detail.kind === 'file' ? 'Focus on this file' : 'Open this folder'}
          onClick={() => onFocus(detail.path, detail.kind)}
        >
          <i className="codicon codicon-target" aria-hidden="true" />
        </button>
        {/* The panel's own way in, for the file a box cannot offer one for:
            a path row selects an importer the current scope does not draw, and
            the reader looking at it is exactly the one asking what it is for.
            The sparkle is VS Code's mark for "a model did this", and the title
            says what a press costs before it is pressed. */}
        {detail.kind === 'file' && (
          <button
            type="button"
            title="Ask Claude what this file is for — it spends your Claude quota"
            aria-label="Explain this file"
            onClick={() => onExplainFile(detail.path)}
          >
            <i className="codicon codicon-sparkle" aria-hidden="true" />
          </button>
        )}
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
        {bundle !== null ? (
          <BundleView bundle={bundle} onSelect={onSelect} />
        ) : detail === null ? (
          <p className="panel-empty">Click a box to see what it holds, and what depends on it.</p>
        ) : openSymbol !== null && detail.kind === 'file' ? (
          <SymbolView
            symbol={openSymbol}
            filePath={detail.path}
            links={symbolLinks}
            onBack={() => setOpenSymbol(null)}
            onSelect={onSelect}
            onFocus={onFocus}
          />
        ) : detail.kind === 'file' ? (
          <FileView
            detail={detail}
            root={root}
            onSelect={onSelect}
            symbolIds={symbolIds}
            onExplainSymbol={onExplainSymbol}
            onOpenSymbol={setOpenSymbol}
          />
        ) : (
          <FolderView detail={detail} onSelect={onSelect} />
        )}
      </Section>
    </aside>
  );
}

/**
 * Why the header says fewer symbols than the list has rows, when it does.
 *
 * Only when there is an alias — an unconditional sentence about counting would
 * be noise on the great majority of files, which have none.
 */
function aliasTitle(symbols: readonly SymbolDetail[]): string | undefined {
  const aliases = symbols.filter((symbol) => symbol.aliasOf !== undefined).length;
  if (aliases === 0) return undefined;
  return `${symbols.length} rows below, ${aliases === 1 ? 'one of which is' : `${aliases} of which are`} another name for a body already counted`;
}

function FileView({
  detail,
  root,
  onSelect,
  symbolIds,
  onExplainSymbol,
  onOpenSymbol,
}: {
  detail: Extract<Detail, { kind: 'file' }>;
  root: string;
  onSelect: (target: string) => void;
  symbolIds: ReadonlyMap<string, string>;
  onExplainSymbol: (id: string) => void;
  /** Open one row: what calls it, and what it calls. The graph already knows. */
  onOpenSymbol: (symbol: SymbolDetail & { id: string }) => void;
}) {
  const bodies = detail.symbols.filter((symbol) => symbol.aliasOf === undefined).length;
  return (
    <>
      <header className="panel-head">
        <h2 title={detail.path}>{detail.path}</h2>
        {/* Bodies, not names. One function bound to two names is two rows
            below — a reader looking for `res.type` must find it — but counting
            both said express's response.js holds 24 where it holds 22, and a
            count wrong in the safe-looking direction is the failure this
            project cares most about. See `SymbolDetail.aliasOf`. */}
        <p className="panel-meta" title={aliasTitle(detail.symbols)}>
          {bodies === 1 ? '1 symbol' : `${bodies} symbols`} ·{' '}
          {detail.lineCount === 1 ? '1 line' : `${detail.lineCount} lines`}
        </p>
      </header>

      {/* The whole list, not the eight the box has room for. */}
      <PanelList title="Declares">
        {detail.symbols.map((symbol, index) => {
          // The ids come from the view and the rows from `/api/detail`, and the
          // second arrives a moment after the first — so for one frame after a
          // click the two describe different files. The id names its own file,
          // so it can say whether it belongs to this one; explaining the wrong
          // symbol would spend money on it.
          const found = symbolIds.get(symbolKey(symbol.name, symbol.line));
          const id = found?.startsWith(`${detail.path}#`) === true ? found : undefined;
          return (
            <li key={`${symbol.name}-${index}`}>
              {/* The click opens the symbol: what calls it, what it calls, and
                  how much of that the graph can vouch for. `/api/symbol` has
                  answered that all along and nothing on the page reached it,
                  so a reader who clicked one of these fifty-one rows watched
                  the editor fail to open and read it as nothing happening.

                  A row the view gave no id for falls back to the editor, which
                  is the one thing always possible: the id cannot be rebuilt
                  from a name — a method is `path#Class.method` — so a file
                  with no box on the diagram has nothing to ask about. */}
              <button
                type="button"
                {...LIST_ROW}
                className={`sym sym-${symbol.kind}`}
                onClick={() =>
                  id === undefined
                    ? void openInEditor(root, detail.path, symbol.line)
                    : onOpenSymbol({ ...symbol, id })
                }
                title={
                  id === undefined
                    ? `Open at line ${symbol.line} — this file has no box on the diagram, so the graph's id for this row is not in hand`
                    : symbol.aliasOf === undefined
                      ? `What calls ${symbol.name}, and what it calls`
                      : `${symbol.name} is another name for ${symbol.aliasOf} — one body, two names, so it is listed but counted once`
                }
              >
                {symbol.kind === 'function' ? `${symbol.name}()` : symbol.name}
                {/* Said on the row and not only in the title: two rows at one
                    line with nothing between them read as two functions. */}
                {symbol.aliasOf !== undefined && <span className="sym-alias">= {symbol.aliasOf}</span>}
                <span className="sym-line">{symbol.line}</span>
              </button>
              {/* Hidden until the row is hovered, like every other row action.
                  This is the surface a reader is already on when they want to
                  know what a symbol is for — the panel that lists it — and
                  before this the only Explain on the page lived in a section
                  that does not exist until something is already followed. */}
              <span className="row-actions">
                {id !== undefined && (
                  <button
                    type="button"
                    title={`Follow ${symbol.name} and ask Claude what it is for — it spends your Claude quota`}
                    aria-label={`Explain ${symbol.name}`}
                    onClick={() => onExplainSymbol(id)}
                  >
                    <i className="codicon codicon-sparkle" aria-hidden="true" />
                  </button>
                )}
                {/* The editor kept, now that the row's own click is the graph's
                    answer rather than the editor's. */}
                <button
                  type="button"
                  title={`Open ${detail.path} at line ${symbol.line}`}
                  aria-label={`Open ${symbol.name} in the editor`}
                  onClick={() => void openInEditor(root, detail.path, symbol.line)}
                >
                  <i className="codicon codicon-go-to-file" aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </PanelList>

      {/* The answer the diagram could never give — and a floor, not a census.
          A file reached through a barrel, or named by a specifier the resolver
          could not follow, is missing from this list, and the reader who is
          about to change a signature is the one who cannot afford to read the
          number as a total. The graph says what it missed, in its own words. */}
      <PathList
        title="Used by"
        paths={detail.importedBy}
        floor
        note={detail.importedByNote}
        onSelect={onSelect}
      />
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

/**
 * One symbol: what calls it, what it calls, and how much of that the graph can
 * vouch for.
 *
 * The answer has been on `/api/symbol` since the day it was written and the
 * page had no way to it — a symbol's relations could be read only by *paying*
 * for one, because the Following section is the only place they were drawn and
 * the only gesture that filled it was the one that spends money. This is the
 * same answer for nothing, one level down from the file that declares it.
 */
function SymbolView({
  symbol,
  filePath,
  links,
  onBack,
  onSelect,
  onFocus,
}: {
  symbol: SymbolDetail;
  filePath: string;
  /** null while the graph is being asked; 'gone' when it answered 404. */
  links: SymbolLinks | 'gone' | null;
  onBack: () => void;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={`${symbol.name} — ${symbol.kind}`}>{symbol.name}</h2>
        <p className="panel-meta">
          {/* The way out, drawn rather than hidden behind a hover: this view
              replaced the file's, so the file has to stay one press away and
              visibly so. It also says where the symbol lives, which is the
              other thing the header would otherwise have to spend a line on. */}
          <button type="button" className="symbol-back" onClick={onBack} title={`Back to ${filePath}`}>
            <i className="codicon codicon-arrow-left" aria-hidden="true" />
            {filePath}
          </button>
          <span className="symbol-where">
            {symbol.kind} · line {symbol.line}
          </span>
        </p>
      </header>

      {links === null ? (
        <p className="panel-empty">Looking up what reaches it…</p>
      ) : links === 'gone' ? (
        // The same silence the Following section names, for the same cause: a
        // file saved mid-edit does not parse for a cycle and loses every symbol
        // in it, so this is at its most likely exactly while the agent works.
        <p className="panel-empty">
          Not in the graph. A file that will not parse loses its symbols until the next save.
        </p>
      ) : (
        <SymbolRelations links={links} onSelect={onSelect} onFocus={onFocus} />
      )}
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
      {/* A directory's dependents are a floor for the same reason a file's are,
          and the graph qualifies the pile in the same words. */}
      <PathList
        title="Used by"
        paths={detail.importedBy}
        floor
        note={detail.importedByNote}
        onSelect={onSelect}
      />
      <PathList title="Uses" paths={detail.imports} onSelect={onSelect} />
    </>
  );
}

/**
 * What one bundle box stands for.
 *
 * The diagram's honest answer to 278 neighbours is one box saying how many;
 * this is the other half of that bargain, because a count nobody can open is
 * just a number. Every file is a row, and picking one shows that file's own
 * detail — from where the header's target button focuses it, which is how a
 * file inside a bundle gets a box of its own.
 *
 * No "Uses" and "Used by": every file here is a neighbour of the focus by
 * definition, and the pile as a whole leans on nothing — that would be a claim
 * about a box, and this box is not a thing in the project.
 */
function BundleView({
  bundle,
  onSelect,
}: {
  bundle: { label: string; files: string[]; of: 'dependents' | 'dependencies' | null };
  onSelect: (target: string) => void;
}) {
  return (
    <>
      <header className="panel-head">
        <h2 title={bundle.label}>{bundle.label}</h2>
        {/* Which number this is, in the same words the box uses. "260
            dependents" is a count of files that import the file in focus, and
            read beside a followed symbol it gets taken for that symbol's — the
            symbol had four importers and three users. */}
        <p className="panel-meta">
          {bundle.files.length}{' '}
          {bundle.of === 'dependencies'
            ? 'files the file in focus imports'
            : 'files that import the file in focus'}{' '}
          — too many to draw one by one
        </p>
      </header>

      <PathList title="Files" paths={bundle.files} onSelect={onSelect} />
    </>
  );
}

/**
 * Every list the Detail panel draws: Declares, Used by, Uses, Calls, Files.
 *
 * The arrow keys are wired here rather than five times over, which is the whole
 * reason this component takes children instead of rows — the rows come from
 * five callers with five shapes, and each of them marks its own with LIST_ROW.
 * A caller that forgets the mark gets a list the keyboard walks past, not a
 * broken one.
 */
function PanelList({
  title,
  note = '',
  children,
}: {
  title: string;
  /** What the count above it leaves out. The same prose the Following section uses. */
  note?: string;
  children: ReactNode;
}) {
  const keys = useListKeys();
  return (
    <div className="panel-list">
      <h3>{title}</h3>
      {note !== '' && <p className="followed-coverage">{note}</p>}
      <ul {...keys}>{children}</ul>
    </div>
  );
}

function PathList({
  title,
  paths,
  floor = false,
  note = '',
  onSelect,
}: {
  title: string;
  paths: string[];
  /** The list is what was found, not what there is; the count says so. */
  floor?: boolean;
  note?: string;
  onSelect: (target: string) => void;
}) {
  if (paths.length === 0) return null;

  return (
    <PanelList title={`${title} (${floor ? FLOOR : ''}${paths.length})`} note={note}>
      {paths.map((path) => (
        <li key={path}>
          <button type="button" {...LIST_ROW} className="path" onClick={() => onSelect(path)} title={path}>
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
 *
 * The arrow keys reach the rows inside it — what a followed symbol is used by
 * and what it uses — and not the heads above them. A head is not a row: it is
 * a name, where the file is, how the reading stands, and two actions on hover.
 * There is nothing for Enter to do to one, and a walk that stopped on a row
 * whose Enter did nothing would teach the keyboard that this list is broken.
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
  const { consent, onAcceptStore } = following;
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
        {/* A question, not an error. The press did nothing and spent nothing;
            what it wants is permission to leave a file in a project that may
            have been opened only to be read. Asked here rather than written
            into the panel as a standing warning, because a sentence saying
            "this will create a file" is read by whoever was already going to
            be careful. Before this the refusal was swallowed and the button
            was simply dead. */}
        {consent !== null && (
          <p className="explain-consent">
            Explaining writes <code>{consent}</code>, and this project has none yet.
            <button type="button" className="explain-consent-yes" onClick={onAcceptStore}>
              Create it and explain
            </button>
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

          <SymbolRelations links={symbol} onSelect={onSelect} onFocus={onFocus} />
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

/**
 * Both halves of one symbol's relations, with the graph's hedge over them.
 *
 * One component for the two surfaces that draw this — the Detail panel's
 * symbol view and the Following section — because the hedging *is* the
 * substance: these counts are floors in both places for the same reasons, and
 * two copies of that reasoning is two chances for one of them to quietly stop
 * saying it.
 */
function SymbolRelations({
  links,
  onSelect,
  onFocus,
}: {
  links: SymbolLinks;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  return (
    <>
      {/* The graph's own word on how much of the lists below it can vouch
          for, and it is said whatever the state. A method's callers are
          the typed ones only, so for one an empty list is a silence rather
          than a count — cobra's Command.Execute read "0 in" with sixteen
          callers in grep. But `tracked` is not the opposite of that: a
          class handed to a function as a value is not a call either, which
          is how QueryObserver read sixteen against 26 real sites. Drawn
          only for the weaker state, this line was absent from exactly the
          counts that looked trustworthy. */}
      <p className="followed-coverage">{links.coverageNote}</p>
      {/* The parser knows the names a symbol calls and not the lines they are
          written on, so this list has no order the source would recognise. A
          lifecycle question was answered wrong from it once. */}
      {links.uses.length > 1 && <p className="followed-coverage">{links.usesNote}</p>}

      {links.usedBy.length === 0 && links.uses.length === 0 ? (
        // A type or an interface is never *called*, so an empty relation
        // list is the normal case for it and saying so on every one taught
        // the reader to stop reading the line. It is only worth a sentence
        // where callers were expected and the graph looked everywhere it
        // can — a method's sentence is the coverage note above.
        links.coverage !== 'partial' &&
        CALLABLE.has(links.kind) && (
          <p className="followed-none">
            Nothing in the graph references this by name, and it references nothing that resolved.
          </p>
        )
      ) : (
        <>
          {/* The count wears a ≥ rather than the heading wearing the word
              "known": the number is what gets read and quoted, so the
              number is what has to say it is a floor. Only on the incoming
              half — what a symbol reaches is written down in its own body,
              and it is the callers that arrive through receivers and
              barrels nobody typed. */}
          <Relations title="used by" floor rows={links.usedBy} onSelect={onSelect} onFocus={onFocus} />
          <Relations title="uses" rows={links.uses} onSelect={onSelect} onFocus={onFocus} />
        </>
      )}
    </>
  );
}

/** Cents are the unit here: a run is two or three of them, not two dollars. */
function Relations({
  title,
  rows,
  floor = false,
  onSelect,
  onFocus,
}: {
  title: string;
  rows: SymbolRelation[];
  /** The list is what was found, not what there is. See the note above it. */
  floor?: boolean;
  onSelect: (target: string) => void;
  onFocus: (target: string, kind: 'file' | 'folder') => void;
}) {
  const keys = useListKeys();
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="followed-kind">
        {title}{' '}
        <span>
          {floor ? FLOOR : ''}
          {rows.length}
        </span>
      </h3>
      <ul className="followed-rows" {...keys}>
        {rows.map((row) => (
          <li key={row.id + row.edge}>
            <button
              type="button"
              {...LIST_ROW}
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
