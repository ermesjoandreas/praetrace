import { useEffect, useState } from 'react';
import type { AgentCall } from './api';

/**
 * What the agent last asked codemap, and how long ago.
 *
 * Deliberately not a lit dot: "something is connected" is not worth a widget.
 * Naming the tool tells you what the agent is actually doing — looking around,
 * or writing a decision down — which is the thing worth glancing at.
 */
export function AgentStatus({ last, total }: { last: AgentCall | null; total: number }) {
  const [, tick] = useState(0);

  // Re-renders so the age keeps counting while nothing else changes.
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (last === null) {
    return (
      <div className="agent-status" title="No agent has used codemap's MCP tools in this session">
        <span className="agent-status-key">MCP</span>
        <span className="agent-status-idle">no agent yet</span>
      </div>
    );
  }

  const seconds = Math.max(0, Math.round((Date.now() - last.at) / 1000));
  const active = seconds < 6;

  return (
    <div
      className={active ? 'agent-status agent-status-active' : 'agent-status'}
      title={`${total} agent ${total === 1 ? 'call' : 'calls'} this session${
        last.target === null ? '' : ` · last about ${last.target}`
      }`}
    >
      <span className="agent-status-key">MCP</span>
      <span className="agent-status-tool">{last.tool}</span>
      <span className="agent-status-age">{formatAge(seconds)}</span>
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 6) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
