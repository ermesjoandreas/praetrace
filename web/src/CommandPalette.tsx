import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flattenCommands, rankCommands, segments, type RankedCommand } from './commands';
import type { Menu } from './MenuBar';

interface CommandPaletteProps {
  /**
   * The menu bar itself. VS Code splits the two palettes in two — ⌘P finds a
   * thing, ⌘⇧P runs one — and the running half is already written down here,
   * so the palette is the bar flattened rather than a second list of what the
   * app can do. There is one place a command is declared, and this is not it.
   */
  menus: Menu[];
  onClose: () => void;
}

/**
 * ⌘⇧P. Quick Pick's shape, the same one ⌘K wears: a 26px input on top, 22px
 * rows, the matched characters coloured rather than highlighted, the key hint
 * on the active row only. The two are siblings and differ in their content
 * alone.
 *
 * A command that cannot run right now is still listed, greyed, with its
 * reason — the rule the menu bar already follows. Hiding it would answer a
 * search for something that exists with nothing at all, which teaches you the
 * feature is missing rather than why it is unavailable.
 */
export function CommandPalette({ menus, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  /**
   * The row the keyboard is on. The keyboard's alone, as in ⌘K: the mouse
   * only ever hovers, and a click is what it takes to choose.
   */
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // The bar is rebuilt on every render of the page — every `checked` and every
  // `disabledBecause` is read off the current state — so the flattening is
  // memoed against the array it came from and nothing else.
  const commands = useMemo(() => flattenCommands(menus), [menus]);
  const ranked = useMemo(() => rankCommands(commands, query), [commands, query]);

  // Ranking reorders the list under the keyboard, so the row it is on has to
  // go back to the top or Enter runs whatever happens to have landed there.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // The arrow keys can walk past the bottom of a list that scrolls; the active
  // row has to stay in sight or Enter runs something unseen.
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, ranked]);

  const choose = (entry: RankedCommand | undefined) => {
    // A greyed command is reachable, readable and not runnable. Its reason is
    // on the row; pressing it does nothing rather than closing the palette on
    // a press that achieved nothing.
    if (entry === undefined || entry.command.item.disabledBecause !== undefined) return;
    onClose();
    entry.command.item.run?.();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // A modal that Tab can leave is not modal, and `aria-modal` on the shell
    // above would be claiming otherwise. There is exactly one thing to focus
    // here — the input — so the trap is that Tab stays put, which is also what
    // Quick Pick does.
    if (event.key === 'Tab') {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, ranked.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      choose(ranked[active]);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={input}
          value={query}
          placeholder="Run a command…"
          role="combobox"
          aria-expanded
          aria-controls="palette-commands"
          aria-activedescendant={ranked.length > 0 ? `palette-command-${active}` : undefined}
          aria-label="Run a command"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />

        {ranked.length === 0 && <div className="palette-empty">No matching commands</div>}

        {ranked.length > 0 && (
          <ul ref={list} id="palette-commands" role="listbox" aria-label="Commands">
            {ranked.map((entry, index) => {
              const { command, positions } = entry;
              const { item } = command;
              const why = item.disabledBecause;
              // The menu is drawn muted and the label plain, but they were
              // matched as one string — so the label's characters are coloured
              // against the offset where it starts inside the title.
              const prefix = `${command.menu}: `;

              return (
                <li key={command.title} role="presentation">
                  <button
                    type="button"
                    id={`palette-command-${index}`}
                    role="option"
                    aria-selected={index === active}
                    // A greyed row is read out and reachable, so `disabled` —
                    // which takes it out of the accessibility tree entirely —
                    // would be the one thing that hides its reason from the
                    // reader who most needs it. `choose` refuses it instead.
                    aria-disabled={why !== undefined}
                    // The input is the only tab stop, so Tab can never strand
                    // focus on a row where Escape no longer reaches the palette.
                    tabIndex={-1}
                    className={index === active ? 'cmd cmd-active' : 'cmd'}
                    title={why}
                    onClick={() => choose(entry)}
                  >
                    <span className="cmd-check">
                      {item.checked && <i className="codicon codicon-check" aria-hidden="true" />}
                    </span>
                    <span className="cmd-title">
                      <span className="cmd-menu">{coloured(prefix, positions)}</span>
                      {coloured(item.label, positions, prefix.length)}
                    </span>
                    {/* The active row says what Enter would do, or why it
                        would do nothing. A keyboard cannot hover, so a greyed
                        command's reason has to be readable without a cursor —
                        the tooltip alone would only ever reach the mouse. */}
                    {index === active &&
                      (why === undefined ? (
                        <span className="hit-keys">
                          <kbd>↵</kbd> run
                        </span>
                      ) : (
                        <span className="cmd-why">{why}</span>
                      ))}
                    {item.shortcut !== undefined && <kbd className="cmd-shortcut">{item.shortcut}</kbd>}
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
 * The text with its matched characters wrapped, the way Quick Pick colours a
 * match rather than painting behind it. `.hit-match` is ⌘K's own class: where
 * the query landed means the same thing in both palettes and is drawn the
 * same way.
 */
function coloured(text: string, positions: readonly number[], offset = 0): ReactNode[] {
  return segments(text, positions, offset).map((segment, index) =>
    segment.matched ? (
      <span className="hit-match" key={index}>
        {segment.text}
      </span>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}
