import { useEffect, useRef, useState } from 'react';
import { searchGraph, type SearchHit } from './api';

interface SearchPaletteProps {
  /** Enter opens it in the graph; Shift+Enter opens it in the editor. */
  onPick: (hit: SearchHit, inEditor: boolean) => void;
  onClose: () => void;
}

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
            {hits.map((hit, index) => (
              <li key={`${hit.path}-${hit.name}-${index}`}>
                <button
                  type="button"
                  className={index === active ? 'hit hit-active' : 'hit'}
                  onMouseEnter={() => setActive(index)}
                  onClick={(event) => onPick(hit, event.shiftKey)}
                >
                  <span className={`hit-name kind-${hit.kind}`}>
                    {hit.kind === 'function' ? `${hit.name}()` : hit.name}
                  </span>
                  <span className="hit-path">{hit.path}</span>
                  <span className="hit-kind">{hit.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer>
          <span>↑↓ move</span>
          <span>↵ show in graph</span>
          <span>⇧↵ open in editor</span>
          <span>esc close</span>
        </footer>
      </div>
    </div>
  );
}
