import { useEffect, useState, type ReactNode } from 'react';
import {
  fetchMcpStatus,
  installHook,
  installMcp,
  isDesktop,
  pickProject,
  requestFetch,
  type FetchResponse,
  type HookStatus,
  type McpStatus,
  type RepoInfo,
} from './api';
import { relativeTime } from './GitGraph';
import { Section } from './Section';

/**
 * What the repository is, and the few things that can be done to it from here.
 *
 * Three blocks — Project, Remote, Claude Code — each a list of label · value
 * rows with a button under it. Every value is a fact read from the server and
 * every button runs something that exists; a button that cannot run right now
 * is greyed with the reason in its title rather than hidden, so the reason is
 * one hover away. The one exception is a hook that is already installed: the
 * row says so, and a button that could never do anything would be decoration.
 *
 * The panel owns nothing but its own pending states. `repo` is fetched by App,
 * and when an action here changes what the server would answer — a fetch moves
 * ahead/behind, an install flips the hook — the result is handed back up rather
 * than kept, because the log and the menu bar read the same facts.
 *
 * `.mcp.json` is the one exception, and it is kept here: nothing else on the
 * page reads it, so putting it in `RepoInfo` would make every consumer of that
 * answer re-render for a file only these two rows describe.
 *
 * No arrow keys, unlike every other list in the left bar. These rows are a `dl`
 * of facts: a label and a value, nothing to select and nothing for Enter to
 * run. What can be run here is the button under each block, and Tab reaches
 * three buttons in the whole panel. `listkeys.ts` is for a list you walk; this
 * is a list you read.
 */
export function Repository({
  repo,
  boxes,
  frozen,
  onSwitchProject,
  onFetched,
  onHookInstalled,
}: {
  repo: RepoInfo;
  /** Boxes in the view on screen: the page's own count, which the server has no view of. */
  boxes: number;
  /**
   * The commit the diagram is frozen at, and how many files it held. `/api/repo`
   * counts the working tree and cannot know what last week held, so while a
   * commit is on screen the Files row reads the view's count instead — "Files
   * 1128" beside "712 files" in the status bar was the live number under a
   * commit. Null while the diagram is the working tree's.
   */
  frozen: { at: string; files: number } | null;
  onSwitchProject: (root: string) => void;
  /** A fetch finished. `remote` in it is fresh; the log may have new commits. */
  onFetched: (result: FetchResponse) => void;
  /** The hook was written; this is what the server now says about it. */
  onHookInstalled: (status: HookStatus) => void;
}) {
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpInstalling, setMcpInstalling] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  /**
   * Whether this page is the one that wrote the file. The restart sentence is
   * only true at the moment of writing — on the next reload the config is
   * simply installed, and a permanent "restart" would be noise.
   */
  const [mcpJustWritten, setMcpJustWritten] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // "4 min ago" has to keep moving on its own; nothing else re-renders this
  // panel between a fetch and the next one.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // An error belongs to the project it happened in.
  useEffect(() => {
    setFetchError(null);
    setInstallError(null);
    setMcpError(null);
    setMcpJustWritten(false);
  }, [repo.root]);

  // `.mcp.json` is a file in the project, so it is read per project — and the
  // answer to a root we have already left is dropped rather than shown under
  // the new one's name.
  useEffect(() => {
    let current = true;
    setMcp(null);
    fetchMcpStatus().then(
      (status) => {
        if (current) setMcp(status);
      },
      (cause: unknown) => {
        if (current) setMcpError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [repo.root]);

  const runFetch = () => {
    setFetching(true);
    setFetchError(null);
    requestFetch().then(
      (result) => {
        setFetching(false);
        if (!result.ok) setFetchError(result.detail);
        onFetched(result);
      },
      (cause: unknown) => {
        setFetching(false);
        setFetchError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const runInstall = () => {
    setInstalling(true);
    setInstallError(null);
    installHook().then(
      (status) => {
        setInstalling(false);
        onHookInstalled(status);
      },
      (cause: unknown) => {
        setInstalling(false);
        setInstallError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const runMcpInstall = () => {
    setMcpInstalling(true);
    setMcpError(null);
    installMcp().then(
      (status) => {
        setMcpInstalling(false);
        setMcp(status);
        setMcpJustWritten(true);
      },
      (cause: unknown) => {
        setMcpInstalling(false);
        setMcpError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const { remote, hook, languages, agent, coverage } = repo;
  const fetchBlocked =
    remote === null
      ? 'Not a git repository'
      : remote.url === null
        ? 'No remote named origin'
        : null;

  return (
    <Section title={repo.name} className="repository">
      <div className="repo-block">
        <h3 className="repo-block-title">Project</h3>
        <dl className="repo-rows">
          <Row label="Root" title={repo.root}>
            {repo.root}
          </Row>
          <Row
            label="Files"
            title={
              frozen === null
                ? 'Source files in the graph'
                : `at ${frozen.at.slice(0, 7)} — the commit on screen; the working tree has ${repo.files}`
            }
          >
            {frozen === null ? repo.files : frozen.files}
          </Row>
          <Row label="On screen" title="Boxes in the view on screen — a commit's, while one is frozen">
            {boxes}
          </Row>
          <Row label="Languages" title="What the project is written in, biggest first">
            {languages.found.length === 0
              ? 'none found'
              : languages.found.map((language) => `${language.label} ${language.files}`).join(' · ')}
          </Row>
          {languages.unreadable.length > 0 && (
            <Row
              label="Cannot read"
              title="Source in a language codemap does not read. Nothing these files declare or import is in the graph."
            >
              {languages.unreadable.map((kind) => `${kind.extension} ×${kind.files}`).join(' · ')}
            </Row>
          )}
          {/* Beside Files and Languages, because that is what it is: something
              read off the project, from a file CI already wrote. It sits here
              rather than under Claude Code — nothing about it comes from an
              agent, and a reader who found it in that block would reasonably
              conclude one had produced it. The age is the artefact's, so a
              report from last month says so instead of looking current. */}
          <Row
            label="Coverage"
            title={
              coverage === null
                ? 'No coverage/lcov.info, lcov.info or coverage/coverage-final.json at the project root. Only there, so a monorepo writing one per package finds nothing.'
                : `${coverage.source}, written ${clock.format(new Date(coverage.at))}`
            }
          >
            {coverage === null
              ? 'none found'
              : `${coverage.source} · ${relativeTime(coverage.at, now)}`}
          </Row>
        </dl>
        <div className="repo-actions">
          {isDesktop ? (
            <button
              type="button"
              className="repo-button"
              onClick={() => void pickProject().then((picked) => picked !== null && onSwitchProject(picked))}
              title="Open another project (⌘O)"
            >
              <i className="codicon codicon-folder-opened" aria-hidden="true" />
              Open folder…
            </button>
          ) : (
            // A browser tab has no folder picker; the way to another project is
            // the command line that started this one.
            <code className="repo-cli" title="Start the server on another project to open it here">
              npm run serve -- ~/your-project
            </code>
          )}
        </div>
      </div>

      <div className="repo-block">
        <h3 className="repo-block-title">Remote</h3>
        <dl className="repo-rows">
          {remote === null ? (
            <Row label="Origin" title="This folder is not inside a git repository">
              not a git repository
            </Row>
          ) : (
            <>
              <Row label="Origin" title={remote.url ?? 'No remote named origin'}>
                {remote.url === null ? 'none' : remoteName(remote.url)}
              </Row>
              <Row label="Upstream" title="What the current branch tracks">
                {remote.upstream ?? 'none'}
              </Row>
              {remote.upstream !== null && (
                <Row
                  label="Sync"
                  title={`${remote.ahead} ${plural(remote.ahead, 'commit')} ahead of ${remote.upstream}, ${remote.behind} behind`}
                >
                  <span className="repo-sync">
                    <i className="codicon codicon-arrow-up" aria-hidden="true" />
                    {remote.ahead}
                    <i className="codicon codicon-arrow-down" aria-hidden="true" />
                    {remote.behind}
                  </span>
                </Row>
              )}
              <Row
                label="Last fetch"
                title={remote.fetchedAt === null ? 'No fetch has been run here' : clock.format(new Date(remote.fetchedAt))}
              >
                {remote.fetchedAt === null ? 'never' : relativeTime(remote.fetchedAt, now)}
              </Row>
            </>
          )}
        </dl>
        {fetchError !== null && <p className="repo-error">{fetchError}</p>}
        <div className="repo-actions">
          <button
            type="button"
            className="repo-button"
            onClick={runFetch}
            disabled={fetching || fetchBlocked !== null}
            title={
              fetchBlocked ??
              (fetching ? 'Fetching from origin…' : 'git fetch — reads from origin, touches nothing in the working tree')
            }
          >
            <i className="codicon codicon-cloud-download" aria-hidden="true" />
            {fetching ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
      </div>

      <div className="repo-block">
        <h3 className="repo-block-title">Claude Code</h3>
        <dl className="repo-rows">
          <Row label="Hook" title={hook.settingsPath}>
            {hook.unreadable ? (
              <span className="repo-missing">
                <i className="codicon codicon-error" aria-hidden="true" />
                settings.json is not valid JSON
              </span>
            ) : hook.installed ? (
              <span className="repo-ok">
                <i className="codicon codicon-check" aria-hidden="true" />
                installed
              </span>
            ) : (
              <span className="repo-missing">
                <i className="codicon codicon-close" aria-hidden="true" />
                not installed
              </span>
            )}
          </Row>
          {/* A page built after this field and pointed at a server built
              before it gets undefined here, and `npm run dev:web` proxies to a
              separately running serve — so the row is skipped rather than
              taking the whole app down with it. */}
          <Row label="Hook calls" title={hookCallsTitle(repo.hookCalls)}>
            <HookCalls calls={repo.hookCalls} />
          </Row>
          {/* Above the calls row, in the order the two facts are needed: the
              config is what decides whether an agent can ask at all, and "never
              asked" under a project with no .mcp.json was reporting silence
              from tools that were never offered. */}
          <McpRow status={mcp} justWritten={mcpJustWritten} />
          <Row
            label="MCP calls"
            title={
              agent.lastAt === null
                ? 'No agent has used codemap through MCP in this session'
                : `${agent.total} ${plural(agent.total, 'call')} this session`
            }
          >
            {agent.lastAt === null ? 'never asked' : `last asked ${relativeTime(agent.lastAt, now)}`}
          </Row>
          <Row label="Port file" title={repo.portFile}>
            {under(repo.portFile, repo.root)}
          </Row>
        </dl>
        {installError !== null && <p className="repo-error">{installError}</p>}
        {mcpError !== null && <p className="repo-error">{mcpError}</p>}
        {!hook.installed && (
          <div className="repo-actions">
            <button
              type="button"
              className="repo-button repo-primary"
              onClick={runInstall}
              disabled={installing || hook.unreadable}
              title={
                hook.unreadable
                  ? `${hook.settingsPath} is not valid JSON, so the hook cannot be merged into it`
                  : `Writes the PostToolUse hook into ${hook.settingsPath}`
              }
            >
              {installing ? 'Writing…' : 'Install hook'}
            </button>
          </div>
        )}
        {/* Under the hook's button and in its shape, in the order the rows
            above name them. A config that is already current has no button, for
            the reason the hook's has none: it could never do anything. */}
        {mcp !== null && !mcp.installed && (
          <div className="repo-actions">
            <button
              type="button"
              className="repo-button repo-primary"
              onClick={runMcpInstall}
              disabled={mcpInstalling || mcp.unreadable || mcp.script === null}
              title={mcpInstallTitle(mcp)}
            >
              {/* The restart is in the button's own words, before it is pressed.
                  Claude Code reads .mcp.json when a session starts, so a write
                  mid-session changes nothing until the agent is restarted —
                  the one part of this that no button can do, and the part a
                  person is most likely to read as the install having failed. */}
              {mcpInstalling ? 'Writing…' : 'Install MCP · restart Claude Code'}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * What has actually arrived at the hook endpoint, beside the row above it that
 * says a hook is installed.
 *
 * The two rows answer different questions on purpose. "Hook ✓ installed" reads
 * a settings file; this reads the requests. A whole review ran with the first
 * one green over five calls that every one answered `{"accepted":false}`,
 * because the server had been started on `/tmp` and Claude Code was reporting
 * `/private/tmp` — and nothing on screen could disagree with the tick.
 *
 * A refusal on its own is ordinary: the hook fires on every edit the agent
 * makes, and one to a file outside the project or of a kind codemap cannot read
 * is refused exactly as it should be. So the numbers are stated plainly and the
 * reader judges — except for the one shape that cannot be innocent, calls
 * arriving and none of them landing, which is marked.
 */
function HookCalls({ calls }: { calls: { accepted: number; refused: number } | undefined }) {
  if (calls === undefined) return <>unknown</>;
  // Plain, like the MCP row's "never asked" beside it: nothing has gone wrong,
  // nothing has happened yet.
  if (calls.accepted + calls.refused === 0) return <>none yet</>;
  if (calls.accepted === 0) {
    return (
      <span className="repo-partial">
        <i className="codicon codicon-question" aria-hidden="true" />
        {calls.refused} refused, none answered
      </span>
    );
  }
  return (
    <span className="repo-ok">
      <i className="codicon codicon-check" aria-hidden="true" />
      {calls.accepted} answered
      {calls.refused > 0 && ` · ${calls.refused} refused`}
    </span>
  );
}

/**
 * Whether an agent starting in this project would be handed codemap's tools.
 *
 * The row exists because the answer was invisible and the failure silent. A
 * project's hook can be installed and answering while `.mcp.json` is simply
 * absent, and then the agent has no tools at all — with nothing on screen
 * saying which of the two channels was missing. "Not configured" is the whole
 * fix, one press away.
 *
 * "Names a script that is not there" is the same finding for a config that
 * looks right: a `.mcp.json` copied between projects keeps `scripts/mcp.mjs`,
 * which resolves against the project Claude Code starts the server in, so in
 * any repository but codemap's own it names nothing and the server never
 * starts.
 */
function McpRow({ status, justWritten }: { status: McpStatus | null; justWritten: boolean }) {
  if (status === null) {
    return (
      <Row label="MCP" title="Reading .mcp.json">
        …
      </Row>
    );
  }

  if (status.unreadable) {
    return (
      <Row
        label="MCP"
        title={`${status.configPath} is not valid JSON, so codemap cannot be merged into it without writing over servers it cannot see`}
      >
        <span className="repo-missing">
          <i className="codicon codicon-error" aria-hidden="true" />
          .mcp.json is not valid JSON
        </span>
      </Row>
    );
  }

  if (status.installed) {
    return (
      <Row
        label="MCP"
        title={`${status.configPath} names ${status.script ?? 'a script'}${beside(status.others)}. Claude Code reads it when a session starts.`}
      >
        <span className="repo-ok">
          <i className="codicon codicon-check" aria-hidden="true" />
          {/* Twenty-six characters, because the value column is 155px and
              ellipsis is what the row does to anything longer — a restart
              instruction cut off mid-word is worse than no restart
              instruction. The title carries the sentence. */}
          {justWritten ? 'installed · restart Claude' : 'installed'}
        </span>
      </Row>
    );
  }

  // Nothing to point at: the packaged app ships dist/ without scripts/mcp.mjs.
  // The reason names the directory searched, which is the fixable half.
  if (status.script === null) {
    return (
      <Row label="MCP" title={status.reason ?? 'No MCP script to point .mcp.json at'}>
        <span className="repo-missing">
          <i className="codicon codicon-warning" aria-hidden="true" />
          no script to point at
        </span>
      </Row>
    );
  }

  return (
    <Row
      label="MCP"
      title={`${status.configPath} has no codemap server${beside(status.others)}, so an agent here is offered no codemap tools`}
    >
      <span className="repo-missing">
        <i className="codicon codicon-close" aria-hidden="true" />
        not configured
      </span>
    </Row>
  );
}

/** What else is in the file, said in a title, so a merge is visibly a merge. */
function beside(others: readonly string[]): string {
  if (others.length === 0) return '';
  return `, beside ${others.join(', ')}`;
}

function mcpInstallTitle(status: McpStatus): string {
  if (status.unreadable) {
    return `${status.configPath} is not valid JSON, so codemap cannot be merged into it`;
  }
  if (status.script === null) return status.reason ?? 'No MCP script to point .mcp.json at';
  return (
    `Writes ${status.script} into ${status.configPath}, keeping every server already there${beside(status.others)}. ` +
    'Claude Code reads .mcp.json when a session starts, so the agent must be restarted once before the tools appear.'
  );
}

function hookCallsTitle(calls: { accepted: number; refused: number } | undefined): string {
  if (calls === undefined) return 'This server is older than the counter.';
  const { accepted, refused } = calls;
  const arrived = `${accepted + refused} ${plural(accepted + refused, 'call')} this session`;
  if (accepted + refused === 0) {
    return 'No PostToolUse payload has reached this server yet. It is written on the agent’s next edit.';
  }
  if (accepted === 0) {
    return `${arrived}, and not one named a source file inside this project. That is what a hook pointed at the wrong root looks like — and also what a session that has only edited markdown, JSON or a file in another language looks like, so check the paths before believing the first reading.`;
  }
  return refused === 0
    ? `${arrived}, every one of them a source file inside this project.`
    : `${arrived}. A refused one named nothing this project holds — an edit outside the root, or a file codemap cannot read.`;
}

/** One label · value row. The title carries what the value had to shorten. */
function Row({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <div className="repo-row">
      <dt className="repo-label">{label}</dt>
      <dd className="repo-value" title={title}>
        {children}
      </dd>
    </div>
  );
}

const clock = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/**
 * `github.com/user/repo` out of whatever git stores: an scp-style
 * `git@github.com:user/repo.git`, an https URL, or a local path that is neither
 * and is shown as it is. The full value is in the row's title.
 */
function remoteName(url: string): string {
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
  let host: string;
  let pathname: string;
  if (scp !== null) {
    host = scp[1] ?? '';
    pathname = scp[2] ?? '';
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.host;
      pathname = parsed.pathname;
    } catch {
      return url;
    }
  }
  return `${host}/${pathname.replace(/^\/+/, '').replace(/\.git$/, '')}`;
}

/** A path inside the project, said relative to it; anything else as it is. */
function under(file: string, root: string): string {
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}
