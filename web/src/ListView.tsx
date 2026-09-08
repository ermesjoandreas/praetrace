import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { describeUnresolved, type GitFileStatus, type LanguageId, type ViewGraph, type ViewNode } from './api';
import { fileIconFor } from './fileicons';
import { LIST_ROW, useListKeys } from './listkeys';
import type { Band, Shown } from './marks';
import { holdOrder, letterStatus, nextSort, rowsOf, sortRows, type ListRow, type Sort, type SortKey } from './listrows';

/**
 * The slice as rows, where the engine said it is a list.
 *
 * A map of everything never works: astrupdata's `lib` is 106 boxes and 427
 * lines, and drawn it is one strip zoomed to a smear that answers no question
 * a person has. Past `LIST_ABOVE` boxes the canvas shows this instead — the
 * explorer's shape, one 22px row per box, with the numbers that matter on the
 * row: what it is, what it holds, how many lines come in and go out, its git
 * letter, whether it is a test. Every column sorts. The diagram is still one
 * click away, in the chip above and in View › Show as list.
 *
 * The same slice, not a different one. `view.nodes` and `view.edges` are what
 * the diagram would have drawn — the outside directories included, dimmed
 * here as they are there — and a row's `in` and `out` are the lines the
 * diagram would have drawn to it, summed. Nothing is derived from the files;
 * the engine decided what is here and this only decides how it stands.
 *
 * Mark, do not move: a save re-sorts nothing under the reader's cursor. The
 * order is held across live updates and a changed row is marked where it is;
 * only a click on a header, or a new view, sorts afresh. See `holdOrder`.
 */

interface ListViewProps {
  view: ViewGraph;
  /**
   * Which view this is, as App keys everything else on it. A new key is a new
   * list and sorts afresh; the same key across an update holds the order.
   */
  viewKey: string;
  /** The row the panel describes, and the rows picked for a category. */
  selected: string | null;
  picked: ReadonlySet<string>;
  /**
   * The two live signals, as the boxes wear them: written lately, and asked
   * about lately. Marks, not pulses — they stand for minutes, and `pulsing` /
   * `pulsingAsk` are the short announcement inside them. See `marks.ts`.
   */
  marks: ReadonlyMap<string, Shown>;
  asked: ReadonlyMap<string, Band>;
  pulsing: ReadonlySet<string>;
  pulsingAsk: ReadonlySet<string>;
  /**
   * Rows nothing being followed touches, or that ⌘F did not match. Dimmed, as
   * the boxes are; `asideNote` is the graph's own sentence about why a dimmed
   * row is not proof, and null while ⌘F owns the dimming.
   */
  aside: ReadonlySet<string>;
  asideNote: string | null;
  /** False in a project of one language, where the tag would say nothing. */
  showLanguage: boolean;
  /** ⌘F's Enter: the row to bring into view. */
  reveal: string | null;
  /** How much of the project these rows are, for the header. */
  slice: { drawn: number; total: number } | null;
  /** Click. `additive` is shift, ⌘ or ctrl: add to the picked rows rather than replace them. */
  onSelect: (id: string, additive: boolean) => void;
  /** Double-click: a file focuses, a folder scopes. A bundle and a component go nowhere. */
  onOpen: (id: string, kind: ViewNode['kind']) => void;
  /** Right-click: on a row, or on the list's empty ground. */
  onContextMenu: (event: MouseEvent, id: string | null) => void;
}

/** The letters VS Code's own views use; the box and the Changes list use the same. */
const GIT_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
};

/** The tag a box wears, so a row and a box say the language the same way. */
const LANGUAGE_TAG: Record<LanguageId, string> = {
  typescript: 'ts',
  javascript: 'js',
  java: 'java',
  go: 'go',
  csharp: 'c#',
  rust: 'rs',
  python: 'py',
  kotlin: 'kt',
  php: 'php',
  cpp: 'c/c++',
  vue: 'vue',
  svelte: 'svelte',
  razor: 'cshtml',
  angular: 'html',
};

/**
 * The diff's letter, said the way the box says it: the same three words,
 * because the row and the box describe the same pair of graphs.
 */
const CHANGE_SAID: Record<NonNullable<ListRow['change']>, string> = {
  added: 'Added since the base — not in the graph this diff is against',
  removed: 'Removed since the base — a ghost: not on disk, drawn from the graph this diff is against',
  touched: 'Changed since the base — a symbol came, went or moved, or a line from here did',
};

const KIND_ICON: Record<ViewNode['kind'], string> = {
  file: 'file',
  folder: 'folder',
  bundle: 'files',
  component: 'package',
};

/**
 * The columns, in the order they read. Every one is a sort, so the header is
 * the control and the table has no other. The title on `in` and `out` is
 * where the floor is said: the number on the row is what the view holds,
 * and the view holds only what the graph could follow and what `?edges=`
 * switched on.
 */
const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'name', label: 'Name', title: 'The box: a file, or a directory standing for the files in it. Click to sort by name.' },
  { key: 'kind', label: 'Kind', title: 'file, folder, bundle or component. Click to sort by kind.' },
  {
    key: 'members',
    label: 'Members',
    title: 'Symbols a file declares; files a folder, bundle or component stands for. Click to sort by count.',
  },
  {
    key: 'in',
    label: 'In',
    title:
      'Lines into this box on this view, summed — the dimmed outside directories included. A floor, never a total: a reference the graph could not follow is not a line, and an edge kind not switched on under View is not on the view. Click to sort, most imported first.',
  },
  {
    key: 'out',
    label: 'Out',
    title:
      'Lines out of this box on this view, summed. A floor for the same reasons as In. Click to sort, most importing first.',
  },
  { key: 'git', label: 'Git', title: 'Against the git base: the file’s letter, or how many of a folder’s files moved. Click to sort, changed first.' },
  { key: 'test', label: 'Test', title: 'A test, fixture or story — it does not decide categories. Click to sort, tests first.' },
];

function memberWord(row: ListRow): string {
  if (row.kind === 'file') return `${row.members} ${row.members === 1 ? 'symbol' : 'symbols'}`;
  return `${row.files} ${row.files === 1 ? 'file' : 'files'}`;
}

/** What one row says when hovered: where it is, and what its numbers count. */
function rowTitle(row: ListRow, asideNote: string | null, dimmed: boolean): string {
  const where = row.external ? ' — outside this scope, drawn because a line reaches it' : '';
  const go =
    row.kind === 'file'
      ? 'double-click to focus on it'
      : row.kind === 'folder'
        ? 'double-click to look inside'
        : row.kind === 'bundle'
          ? 'a bundle is not a place to go'
          : 'a component is a category, not a place';
  const lines = `${row.in} in, ${row.out} out — lines on this view, and a floor`;
  const note = dimmed && asideNote !== null ? `\n\nDimmed because nothing in it took part in what is being followed. ${asideNote}` : '';
  return `${row.id}${where}\n${memberWord(row)} · ${lines}\nClick to inspect, ${go}${note}`;
}

export function ListView({
  view,
  viewKey,
  selected,
  picked,
  marks,
  asked,
  pulsing,
  pulsingAsk,
  aside,
  asideNote,
  showLanguage,
  reveal,
  slice,
  onSelect,
  onOpen,
  onContextMenu,
}: ListViewProps) {
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' });
  const keys = useListKeys();
  const body = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => rowsOf(view), [view]);

  /**
   * The order on screen. Held under one key — the view and the sort — so an
   * update to the same view keeps every row where it stands; a new view or a
   * click on a header starts the hold afresh. Written from inside the memo
   * because the held order is an input to the next computation and nothing
   * else: it is idempotent, which is what lets StrictMode run it twice.
   */
  const held = useRef<{ key: string; order: string[] } | null>(null);
  const ordered = useMemo(() => {
    const sorted = sortRows(rows, sort).map((row) => row.id);
    const key = `${viewKey}\n${sort.key}\n${sort.dir}`;
    const order = holdOrder(held.current?.key === key ? held.current.order : null, sorted);
    held.current = { key, order };
    const byId = new Map(rows.map((row) => [row.id, row]));
    return order.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
  }, [rows, sort, viewKey]);

  // ⌘F's Enter walks the matches; on a list that is a scroll, not a camera.
  useEffect(() => {
    if (reveal === null || body.current === null) return;
    const row = body.current.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(reveal)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [reveal]);

  const listRef = (node: HTMLDivElement | null) => {
    body.current = node;
    keys.ref(node);
  };

  return (
    <div className="listview" onContextMenu={(event) => onContextMenu(event, null)}>
      <div className="list-head" role="row">
        {COLUMNS.map((column) => {
          const on = sort.key === column.key;
          return (
            <button
              key={column.key}
              type="button"
              className={`list-cell list-col list-col-${column.key}${on ? ' list-col-on' : ''}`}
              title={column.title}
              aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() => setSort((current) => nextSort(current, column.key))}
            >
              <span className="list-col-label">{column.label}</span>
              {on && (
                <i
                  className={`codicon codicon-triangle-${sort.dir === 'asc' ? 'up' : 'down'}`}
                  aria-hidden="true"
                />
              )}
              {/* The caption the canvas carries in its corner, here beside the
                  first header: information, never a control. */}
              {column.key === 'name' && slice !== null && (
                <span
                  className="list-status"
                  title={`The list holds the ${slice.drawn} files in this part of the project. It has ${slice.total}; the rest are not on it.`}
                >
                  {slice.drawn} of {slice.total} files
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="list-body" ref={listRef} onKeyDown={keys.onKeyDown} onFocus={keys.onFocus}>
        {ordered.map((row) => {
          const dimmed = aside.has(row.id);
          const classes = ['list-row', `list-row-${row.kind}`];
          if (row.external) classes.push('list-row-external');
          if (selected === row.id || picked.has(row.id)) classes.push('list-row-selected');
          const mark = marks.get(row.id);
          const askedAt = asked.get(row.id);
          if (mark !== undefined) classes.push('list-row-changed', `list-row-changed-${mark.band}`);
          if (mark?.born === true) classes.push('list-row-born');
          if (askedAt !== undefined) classes.push('list-row-queried', `list-row-queried-${askedAt}`);
          if (pulsing.has(row.id)) classes.push('list-row-pulse-write');
          if (pulsingAsk.has(row.id)) classes.push('list-row-pulse-ask');
          if (dimmed) classes.push('list-row-aside');
          // A file row's id is its path, which is what the icon is read off.
          // The tag stays only where there is no icon — a folder's pile, or a
          // file the theme has no picture for — as on the box.
          const icon = row.kind === 'file' ? fileIconFor(row.id) : null;
          const tag = !showLanguage || icon !== null ? null : row.language === null ? 'mixed' : LANGUAGE_TAG[row.language];
          const letter = letterStatus(row);
          return (
            <button
              key={row.id}
              type="button"
              {...LIST_ROW}
              data-row-id={row.id}
              className={classes.join(' ')}
              aria-selected={selected === row.id || picked.has(row.id)}
              title={
                (mark === undefined ? '' : `${mark.title}. `) + rowTitle(row, asideNote, dimmed)
              }
              onClick={(event) => onSelect(row.id, event.shiftKey || event.metaKey || event.ctrlKey)}
              onDoubleClick={() => onOpen(row.id, row.kind)}
              onContextMenu={(event) => {
                // The row's menu, not the ground's.
                event.stopPropagation();
                onContextMenu(event, row.id);
              }}
            >
              <span className="list-cell list-name">
                {icon !== null ? (
                  <img className="file-icon" src={icon.url} alt="" title={icon.label} draggable={false} />
                ) : (
                  <i className={`codicon codicon-${KIND_ICON[row.kind]}`} aria-hidden="true" />
                )}
                <span className="list-label">{row.label}</span>
                {/* A box that was not here a moment ago. The one thing on this
                    page that says a file arrived rather than moved, and it is
                    a word rather than a hue because the amber already means
                    "written" and this is a kind of written, not a rival to
                    it. */}
                {mark?.born === true && <span className="list-new">new</span>}
                {row.external && <span className="list-tag">outside</span>}
                {/* The same marks the box's title carries, for the same
                    reasons: a warning is the tool's own gap, and the count of
                    references that went nowhere is what tells a row with no
                    lines from one whose lines could not be followed. */}
                {row.parseError && (
                  <i
                    className="codicon codicon-warning list-warning"
                    role="img"
                    aria-label="syntax error"
                    title={
                      row.kind === 'file'
                        ? 'This file has a syntax error; symbols may be missing'
                        : 'A file in here has a syntax error; symbols may be missing'
                    }
                  />
                )}
                {row.unresolved !== undefined && (
                  <span
                    className="list-unresolved"
                    title={`${describeUnresolved(row.unresolved)} named something codemap could not find, so some of the coupling is not counted`}
                  >
                    <i className="codicon codicon-question" aria-hidden="true" />
                    {row.unresolved.imports + row.unresolved.calls}
                  </span>
                )}
                {tag !== null && <span className="list-tag">{tag}</span>}
              </span>
              <span className="list-cell list-kind">{row.kind}</span>
              <span className="list-cell list-num" title={memberWord(row)}>
                {row.kind === 'file' ? row.members : `${row.files} files`}
              </span>
              <span className="list-cell list-num">{row.in}</span>
              <span className="list-cell list-num">{row.out}</span>
              <span className="list-cell list-git">
                {letter !== null ? (
                  <span
                    className={`list-letter list-letter-${letter}`}
                    title={row.change === undefined ? `${letter} vs the git base` : CHANGE_SAID[row.change]}
                  >
                    {GIT_LETTER[letter]}
                  </span>
                ) : row.gitChanged > 0 ? (
                  <span className="list-letter list-letter-count" title={`${row.gitChanged} of ${row.files} changed vs the git base`}>
                    {row.gitChanged}
                  </span>
                ) : null}
              </span>
              <span className="list-cell list-test">{row.test && <span className="list-tag">test</span>}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
