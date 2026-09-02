import { useEffect, useRef, useState, type ReactNode } from 'react';
import { searchGraph, type SearchHit } from './api';

interface SearchPaletteProps {
  /** Enter opens it in the graph; Shift+Enter opens it in the editor. */
  onPick: (hit: SearchHit, inEditor: boolean) => void;
  onClose: () => void;
}

/**
 * The Quick Pick icon for each kind. A function wears the method glyph, as it
 * does in VS Code's own outline; a type alias has no glyph of its own and
 * borrows the struct.
 */
const KIND_ICON: Record<SearchHit['kind'], string> = {
  file: 'symbol-file',
  class: 'symbol-class',
  interface: 'symbol-interface',
  function: 'symbol-function',
  method: 'symbol-method',
  field: 'symbol-field',
  type: 'symbol-structure',
};

export function SearchPalette({ onPick, onClose }: SearchPaletteProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Searching the whole graph, not the slice on screen: the point is reaching
  // something you cannot see.
  useEffect(() => {
    if (query.trim() === '') {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchGraph(query).then(
        (found) => {
          if (cancelled) return;
          setHits(found);
          setActive(0);
        },
        () => undefined,
      );
    }, 60);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, hits.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      const hit = hits[active];
      if (hit) onPick(hit, event.shiftKey);
    }
  };

  const needle = query.trim().toLowerCase();

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={input}
          value={query}
          placeholder="Find a file or a symbol…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />

        {hits.length > 0 && (
          <ul>
            {hits.map((hit, index) => {
              // A file was matched on its whole path and its name is the tail
              // of that path, so one match colours both; a symbol was matched
              // on its name alone.
              const isFile = hit.kind === 'file';
              const positions = matchedAt(isFile ? hit.path : hit.name, needle);
              const nameOffset = isFile ? hit.path.length - hit.name.length : 0;

              return (
                <li key={`${hit.path}-${hit.name}-${index}`}>
                  <button
                    type="button"
                    className={index === active ? 'hit hit-active' : 'hit'}
                    onMouseEnter={() => setActive(index)}
                    onClick={(event) => onPick(hit, event.shiftKey)}
                  >
                    <i
                      className={`codicon codicon-${KIND_ICON[hit.kind]} hit-icon kind-${hit.kind}`}
                      role="img"
                      aria-label={hit.kind}
                      title={hit.kind}
                    />
                    <span className={`hit-name kind-${hit.kind}`}>
                      {coloured(hit.name, positions, nameOffset)}
                      {hit.kind === 'function' ? '()' : ''}
                    </span>
                    <span className="hit-path">{isFile ? coloured(hit.path, positions) : hit.path}</span>
                    {index === active && (
                      <span className="hit-keys">
                        <kbd>↵</kbd> show in graph <kbd>⇧↵</kbd> open in editor
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Where the query's characters landed, mirroring the server's matcher: a
 * contiguous run if there is one, else the leftmost subsequence. Empty when
 * the query is not a subsequence, which only happens between a keystroke and
 * the results that answer it.
 */
function matchedAt(haystack: string, needle: string): number[] {
  if (needle === '') return [];
  const text = haystack.toLowerCase();
  const exact = text.indexOf(needle);
  if (exact !== -1) return Array.from({ length: needle.length }, (_, i) => exact + i);

  const positions: number[] = [];
  let at = 0;
  for (const character of needle) {
    const found = text.indexOf(character, at);
    if (found === -1) return [];
    positions.push(found);
    at = found + 1;
  }
  return positions;
}

/**
 * The text with its matched characters wrapped, the way Quick Pick colours a
 * match rather than painting behind it. Runs are grouped so a contiguous hit
 * is one span, not one per letter.
 */
function coloured(text: string, positions: number[], offset = 0): ReactNode[] {
  const marked = new Set(positions.map((position) => position - offset));
  const out: ReactNode[] = [];
  let run = '';
  let runMarked = false;

  const flush = (key: number) => {
    if (run === '') return;
    out.push(runMarked ? <span className="hit-match" key={key}>{run}</span> : run);
    run = '';
  };

  for (let i = 0; i < text.length; i++) {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush(i);
      runMarked = isMarked;
    }
    run += text[i];
  }
  flush(text.length);
  return out;
}
