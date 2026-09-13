import { useEffect, useState } from "react";
import type { RpcClient } from "../rpcClient";
import type { ActivityEntry } from "../types";

const MAX_ENTRIES = 100;

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour12: false });

/**
 * Live list of recent button executions: seeded from pad.getLog, then kept
 * current via pad.activity notifications. Every entry is also in the server
 * log (journalctl --user -u macro-pad).
 */
export function ActivitySection({ client }: { client: RpcClient }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .call<{ entries: ActivityEntry[] }>("pad.getLog")
      .then((r) => {
        if (alive) setEntries(r.entries);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    const off = client.on<ActivityEntry>("pad.activity", (entry) => {
      setEntries((prev) => [entry, ...prev].slice(0, MAX_ENTRIES));
    });
    return () => {
      alive = false;
      off();
    };
  }, [client]);

  const summary = error
    ? "unavailable"
    : entries.length === 0
      ? "no presses yet"
      : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;

  return (
    <details className="section">
      <summary>
        <h2>Recent activity</h2>
        <span className="section-summary">{summary}</span>
        <span className="chevron" aria-hidden="true">
          ▸
        </span>
      </summary>
      {error ? (
        <p className="field-note">Could not load the activity log: {error}</p>
      ) : entries.length === 0 ? (
        <p className="field-note">
          No button presses yet this session. Presses also appear in the server log (
          <code>journalctl --user -u macro-pad -f</code>).
        </p>
      ) : (
        <ul className="activity-list">
          {entries.map((e, i) => (
            <li key={`${e.ts}-${i}`} className={e.ok ? "activity-ok" : "activity-fail"}>
              <div className="activity-row">
                <span className="activity-time">{fmtTime(e.ts)}</span>
                <span className="activity-what">
                  {e.label?.trim() || `#${e.button}`}
                  <span className="activity-meta">
                    {e.action} · {e.profile}
                  </span>
                </span>
                <span className="activity-status">{e.ok ? "✓" : "✗"}</span>
              </div>
              {!e.ok && e.error && <div className="activity-error">{e.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
