"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";

// Small label/value row used across the three cards.
function InfoRow({ label, value, mono = false }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-bg border border-border">
      <span className="text-xs sm:text-sm text-text-muted shrink-0">{label}</span>
      <span
        className={`text-xs sm:text-sm text-text-main text-right min-w-0 ${mono ? "font-mono break-all" : "font-medium"}`}
      >
        {value || "—"}
      </span>
    </div>
  );
}

function StatusLine({ status }) {
  if (!status?.message) return null;
  const cls = status.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400";
  return <p className={`text-xs sm:text-sm ${cls}`}>{status.message}</p>;
}

function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function DeploymentPage() {
  const [sync, setSync] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState(null);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        fetch("/api/state-sync").then((res) => res.json()),
        fetch("/api/runtime/status").then((res) => res.json()),
      ]);
      setSync(s?.error ? null : s);
      setRuntime(r?.error ? null : r);
    } catch {
      /* page stays usable with placeholders */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSyncNow = async () => {
    setSyncBusy(true);
    setSyncStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/state-sync/push", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) {
        setSyncStatus({ type: "success", message: "State synced to the state-data branch." });
        await loadAll();
      } else {
        setSyncStatus({ type: "error", message: data.error || data.result?.error || "State sync failed." });
      }
    } catch {
      setSyncStatus({ type: "error", message: "State sync failed (network error)." });
    } finally {
      setSyncBusy(false);
    }
  };

  const handleRuntimeCommand = async (command, busySetter, statusSetter) => {
    busySetter(true);
    statusSetter({ type: "", message: "" });
    try {
      const res = await fetch("/api/runtime/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.queued) {
        statusSetter({ type: "success", message: `Queued "${command}". Watch Runtime for progress.` });
        await loadAll();
      } else {
        statusSetter({ type: "error", message: data.error || `Failed to queue "${command}".` });
      }
    } catch {
      statusSetter({ type: "error", message: "Command failed (network error)." });
    } finally {
      busySetter(false);
    }
  };

  const bootstrap = runtime?.bootstrap;
  const updates = bootstrap?.updates;
  const syncEnabled = sync?.enabled === true;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-0">
      <div className="flex flex-col gap-6">
        {/* ── Storage ─────────────────────────────────────────────────────── */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">cloud_upload</span>
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-semibold">Storage</h3>
              <p className="text-xs sm:text-sm text-text-muted">Snapshot of the database and auth material</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-bg border border-border">
              <div className="min-w-0">
                <p className="text-sm font-medium">GitHub snapshot</p>
                <p className="text-xs text-text-muted">
                  {loading
                    ? "Loading…"
                    : syncEnabled
                      ? `Commits the database, jwt-secret and machine-id to the ${sync?.branch || "state-data"} branch.`
                      : "Disabled. Set 9ROUTER_STATE_PAT and 9ROUTER_STATE_REPO to enable."}
                </p>
              </div>
              <Badge
                variant={syncEnabled ? "success" : "default"}
                size="sm"
                dot
              >
                {syncEnabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>

            {syncEnabled && (
              <>
                <InfoRow label="Repository" value={sync?.repo} mono />
                <InfoRow label="Branch" value={sync?.branch} mono />
                <InfoRow label="Last push" value={fmtTime(sync?.lastPushAt)} />
                <InfoRow label="Last restore" value={fmtTime(sync?.lastPullAt)} />
                <InfoRow label="Remote commit" value={sync?.remoteSha} mono />
              </>
            )}

            {sync?.lastError && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <span className="material-symbols-outlined text-[16px] text-red-500">error</span>
                <span className="text-xs text-red-600 dark:text-red-400 break-all">{sync.lastError}</span>
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="secondary"
                icon="sync"
                size="sm"
                onClick={handleSyncNow}
                disabled={!syncEnabled || syncBusy}
                loading={syncBusy}
              >
                Sync now
              </Button>
              <Button variant="ghost" size="sm" icon="refresh" onClick={loadAll}>Refresh</Button>
            </div>
            <StatusLine status={syncStatus} />
          </div>
        </Card>

        {/* ── Updates ─────────────────────────────────────────────────────── */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg bg-green-500/10 text-green-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">system_update</span>
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-semibold">Updates</h3>
              <p className="text-xs sm:text-sm text-text-muted">Self-update without a redeploy</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <InfoRow label="Running version" value={bootstrap?.version || runtime?.version} />
            <InfoRow label="Latest release" value={updates?.latestVersion || (loading ? "…" : "—")} />
            <InfoRow label="Bundle path" value={bootstrap?.bundlePath} mono />
            <InfoRow label="Last check" value={fmtTime(updates?.lastCheckAt)} />
            <InfoRow
              label="Update available"
              value={
                updates?.dormant
                  ? "Dormant (no update source configured)"
                  : updates?.updateAvailable
                    ? "Yes"
                    : loading ? "…" : "No"
              }
            />

            {updates?.lastError && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <span className="material-symbols-outlined text-[16px] text-red-500">error</span>
                <span className="text-xs text-red-600 dark:text-red-400 break-all">{updates.lastError}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="secondary"
                icon="search"
                size="sm"
                disabled={!bootstrap || updateBusy}
                loading={updateBusy}
                onClick={() => handleRuntimeCommand("check", setUpdateBusy, setUpdateStatus)}
              >
                Check now
              </Button>
              <Button
                variant="primary"
                icon="download"
                size="sm"
                disabled={!bootstrap || updateBusy}
                onClick={() => handleRuntimeCommand("apply", setUpdateBusy, setUpdateStatus)}
              >
                Apply now
              </Button>
              <Button
                variant="danger"
                icon="history"
                size="sm"
                disabled={!bootstrap || !bootstrap?.previousTarget || updateBusy}
                onClick={() => handleRuntimeCommand("rollback", setUpdateBusy, setUpdateStatus)}
              >
                Rollback
              </Button>
            </div>
            <StatusLine status={updateStatus} />
          </div>
        </Card>

        {/* ── Runtime ─────────────────────────────────────────────────────── */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg bg-purple-500/10 text-purple-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">memory</span>
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-semibold">Runtime</h3>
              <p className="text-xs sm:text-sm text-text-muted">Process, database driver and data location</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <InfoRow
              label="SQLite driver"
              value={
                loading
                  ? "…"
                  : runtime?.driver
                    ? runtime.driver
                    : "Not initialized yet (opened on first request)"}
            />
            <InfoRow label="Data directory" value={runtime?.dataDir} mono />
            <InfoRow label="Database file" value={runtime?.dbFile} mono />
            <InfoRow label="Node.js" value={runtime?.nodeVersion} mono />
            <InfoRow label="Version" value={runtime?.version} mono />
            <InfoRow label="Sync state" value={
              syncEnabled
                ? sync?.pending
                  ? "Degraded — retrying"
                  : sync?.dirty
                    ? "Pending flush"
                    : "Healthy"
                : "Disabled"
            } />

            {runtime?.freeTierWarnings?.length > 0 && (
              <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="material-symbols-outlined text-[16px] text-yellow-600 dark:text-yellow-400">
                    warning
                  </span>
                  <span className="text-xs font-semibold text-yellow-600 dark:text-yellow-400">Free-plan notes</span>
                </div>
                <ul className="flex flex-col gap-1">
                  {runtime.freeTierWarnings.map((w) => (
                    <li key={w} className="text-xs text-text-muted">• {w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}