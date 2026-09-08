import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  describeUnresolved,
  type ComponentFacts,
  type GroupColor,
  type LanguageId,
  type ProvidedSymbol,
  type ViewNode,
} from './api';

export type ComponentData = {
  label: string;
  /** The name, the cohesion, and what it provides. Membership is `files`. */
  facts: ComponentFacts;
  files: string[];
  /**
   * The category's palette key, from the same rows the Categories section
   * lists, joined by stored id. Null for a category nobody has named and for
   * the no-category box: a colour is something a person chose for a name, and
   * neither of those has one.
   */
  color: GroupColor | null;
  changed: boolean;
  queried: boolean;
  /** How many of `files` differ from the git base. */
  gitChanged: number;
  /** The one language its files share; null when they differ. */
  language: LanguageId | null;
  /** False in a single-language project, where the tag would say nothing. */
  showLanguage: boolean;
  /** Every file in here is a test, fixture or story. */
  test: boolean;
  /** A file in here has a syntax error, so symbols may be missing. */
  parseError: boolean;
  /** References its files made that landed nowhere, summed. Absent is the good answer. */
  unresolved?: ViewNode['unresolved'];
  /** Nothing in this box takes part in what is being followed. */
  aside: boolean;
  /** Why a dimmed box is not proof, or null when nothing is being followed. */
  asideNote: string | null;
  /** The symbols being followed. A provided row lights when it is one. */
  following: ReadonlySet<string>;
  /** Symbol ids any of them relate to, so a row knows whether to light or fade. */
  related: ReadonlySet<string>;
  onFollow: (id: string, on: boolean) => void;
};

export type ComponentNodeType = Node<ComponentData, 'component'>;

/** The extension a developer would have typed; see BoxNode for why not the name. */
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
 * The second line of the box: how many files, and the number the clustering
 * measured — or the reason there is no number. "N files · 84%" is the same
 * line a frame draws in its label, so a category reads the same whichever
 * diagram it is on.
 */
function describe(facts: ComponentFacts, files: number): { text: string; title: string } {
  const count = `${files} ${files === 1 ? 'file' : 'files'}`;
  if (facts.uncategorised === true) {
    return {
      text: `${count} · no category`,
      title:
        'Files no category holds. Tests, fixtures and stories are always among them — they do not vote in the clustering, so no category is ever found around them — and so is any file the imports leave alone. View › Hide tests takes the tests off.',
    };
  }
  if (facts.origin === 'manual' || facts.cohesion === undefined) {
    return { text: `${count} · by hand`, title: 'Drawn by a person; the import graph was not asked' };
  }
  const share = Math.round(facts.cohesion * 100);
  return {
    text: `${count} · ${share}%`,
    title: `${share}% of these files' edges stay inside the category — a share, not a score: it rises with the category, and one holding everything reads 100%`,
  };
}

/** `App.init` for a member, `init` for anything at the top level; a call gets its parentheses. */
function spell(symbol: ProvidedSymbol): string {
  const name = symbol.owner === null ? symbol.name : `${symbol.owner}.${symbol.name}`;
  return symbol.kind === 'function' || symbol.kind === 'method' ? `${name}()` : name;
}

/**
 * A category drawn as a UML component: a box with the component icon beside
 * its name, the count and cohesion under it, and a compartment listing what
 * it PROVIDES — the symbols inside it that a file outside reaches, most
 * reached first. The same data the class diagram is drawn from, summed one
 * level up, which is what makes it honest: a line between two components is
 * the imports between their files added together, and a row in the
 * compartment is a symbol some other category's file actually calls, extends,
 * implements or holds a field of.
 *
 * The compartment is a floor, and the box says so on hover. A call through an
 * untyped receiver is not an edge, and an import names no symbol, so a type
 * used only in type positions is not listed. What is listed is real.
 *
 * `codicon-package` and not `symbol-namespace`: at 16px the braces read as
 * a namespace in an outline, and the parcel reads as a packaged unit with
 * contents, which is what a component is.
 */
export function ComponentNode({ data }: NodeProps<ComponentNodeType>) {
  const { facts } = data;
  const { symbols, total } = facts.provides;
  const more = total - symbols.length;
  const meta = describe(facts, data.files.length);
  const tag = !data.showLanguage ? null : data.language === null ? 'mixed' : LANGUAGE_TAG[data.language];

  // The first few members, so the box says what it stands for before it is
  // clicked; the whole list is in the panel.
  const members = [
    `${data.label} — ${data.files.length} ${data.files.length === 1 ? 'file' : 'files'}. Click the box to list them.`,
    ...data.files.slice(0, 8),
    ...(data.files.length > 8 ? [`…and ${data.files.length - 8} more`] : []),
  ].join('\n');
  const title =
    data.aside && data.asideNote !== null
      ? `${members}\n\nDimmed because nothing in it took part in what is being followed. ${data.asideNote}`
      : members;

  const classes = ['box', 'box-component'];
  if (facts.uncategorised === true) classes.push('box-uncategorised');
  if (data.changed) classes.push('box-changed');
  if (data.queried) classes.push('box-queried');
  if (data.aside) classes.push('box-aside');

  return (
    <div className={classes.join(' ')} data-color={data.color ?? undefined}>
      <Handle type="target" position={Position.Left} />

      <div className="box-title">
        <i className="codicon codicon-package box-kind" aria-hidden="true" />
        <span className="box-title-text" title={title}>
          {data.label}
        </span>
        {/* A box standing for many files says how many of them moved, not
            which way any single one did. */}
        {data.gitChanged > 0 && (
          <span
            className="box-git box-git-count"
            title={`${data.gitChanged} of ${data.files.length} changed vs the git base`}
          >
            {data.gitChanged}
          </span>
        )}
        {data.parseError && (
          <span className="box-warning" title="A file in here has a syntax error; symbols may be missing">
            <i className="codicon codicon-warning" aria-hidden="true" />
          </span>
        )}
        {data.unresolved !== undefined && (
          <span
            className="box-unresolved"
            title={`${describeUnresolved(data.unresolved)} across the ${data.files.length} files in here named something codemap could not find, so some of their coupling is not drawn`}
          >
            <i className="codicon codicon-question" aria-hidden="true" />
            {data.unresolved.imports + data.unresolved.calls}
          </span>
        )}
        {tag !== null && (
          <span
            className="box-lang"
            title={data.language === null ? `${data.files.length} files, in more than one language` : `language: ${data.language}`}
          >
            {tag}
          </span>
        )}
        {data.test && (
          <span className="box-test" title="Every file in here is a test, fixture or story">
            test
          </span>
        )}
      </div>

      <div className="box-meta" title={meta.title}>
        {meta.text}
      </div>

      {/* The interface. Member rows, because that is what a UML compartment
          is, and every control on one is sized to the 17px line. A row's name
          and its mark do one thing between them — follow the symbol — the way
          a label and its checkbox do: the mark shows the state, the name is
          the bigger target. */}
      <ul
        className="box-members box-provides"
        title={
          symbols.length === 0
            ? 'Nothing here is reached by name from outside — a floor: a call through an untyped receiver is not tracked, and an import names no symbol'
            : `What files outside this category reach, most reached first — a floor: a call through an untyped receiver is not tracked, and an import names no symbol`
        }
      >
        {symbols.map((symbol) => {
          const picked = data.following.has(symbol.id);
          const related = data.related.has(symbol.id);
          const aside = data.following.size > 0 && !picked && !related;
          return (
            <li
              key={symbol.id}
              className={[
                'member',
                `member-${symbol.kind}`,
                symbol.owner === null ? '' : 'member-nested',
                picked ? 'member-picked' : '',
                related ? 'member-related' : '',
                aside ? 'member-aside' : '',
                symbol.guessed === true ? 'member-guessed' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className="member-name"
                title={`${spell(symbol)} — reached from ${symbol.reachedFrom} ${
                  symbol.reachedFrom === 1 ? 'file' : 'files'
                } outside this category${
                  symbol.guessed === true
                    ? ', every one of them resolved by a name match nothing in the referring file asked for'
                    : ''
                }. ${picked ? 'Stop following it' : 'Follow it: what reaches it, and what it uses'}`}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onFollow(symbol.id, !picked);
                }}
              >
                {spell(symbol)}
              </button>
              <span className="member-reach" aria-label={`reached from ${symbol.reachedFrom} files`}>
                {symbol.reachedFrom}
              </span>
              <button
                type="button"
                className="member-pick"
                aria-pressed={picked}
                title={picked ? 'Stop following this symbol' : `Show what reaches ${symbol.name}, and what it uses`}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onFollow(symbol.id, !picked);
                }}
              />
            </li>
          );
        })}
        {symbols.length === 0 && <li className="member member-more">nothing reached by name</li>}
        {/* A count, not a way in: the server cut the list at a box's worth and
            the page never holds the rest, so there is nothing to unfold. The
            twelve drawn are the ones reached from the most places. */}
        {more > 0 && (
          <li
            className="member member-more"
            title={`${total} symbols in here are reached from outside; these ${symbols.length} are the ones reached from the most files`}
          >
            +{more} more
          </li>
        )}
      </ul>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}
