import { useEffect, useState } from 'react';
import { fetchHookStatus, installHook, type HookStatus } from './api';

/**
 * Offers to write the Claude Code hook, and shows exactly what it would write
 * first. Without the hook the graph still updates — the file watcher sees the
 * same edits — but a beat later and without knowing the agent made them.
 */
export function HookBanner({ root }: { root: string }) {
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
    setReviewing(false);
    setError(null);
    fetchHookStatus().then(setStatus, () => setStatus(null));
  }, [root]);

  if (!status || status.installed || dismissed) return null;

  const install = () => {
    setBusy(true);
    installHook().then(
      (next) => {
        setStatus(next);
        setBusy(false);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      },
    );
  };

  return (
    <div className="hook-banner">
      <div className="hook-row">
        <i
          className={`codicon ${status.unreadable ? 'codicon-error' : 'codicon-warning'} hook-icon`}
          aria-hidden="true"
        />
        <span>
          {status.unreadable
            ? 'This project has a settings.json that is not valid JSON, so the hook cannot be merged in.'
            : 'Claude Code hook not installed — updates come from the file watcher only.'}
        </span>

        {!status.unreadable && (
          <button type="button" onClick={() => setReviewing((was) => !was)}>
            {reviewing ? 'Hide' : 'Review…'}
          </button>
        )}
        <button
          type="button"
          className="hook-dismiss"
          onClick={() => setDismissed(true)}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <i className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>

      {reviewing && (
        <div className="hook-review">
          <div className="hook-path">{status.settingsPath}</div>
          <pre>{status.preview}</pre>
          {error !== null && <div className="hook-error">{error}</div>}
          <div className="hook-actions">
            <button type="button" className="hook-install" onClick={install} disabled={busy}>
              {busy ? 'Writing…' : 'Write this file'}
            </button>
            <button type="button" onClick={() => setReviewing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
