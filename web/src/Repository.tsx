import { useEffect, useState, type ReactNode } from 'react';
import {
  installHook,
  isDesktop,
  pickProject,
  requestFetch,
  type FetchResponse,
  type HookStatus,
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

  const { remote, hook, languages, agent } = repo;
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
          <Row
            label="MCP"
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
      </div>
    </Section>
  );
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
