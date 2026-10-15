// State sync — GitHub snapshot of the trio that must survive a redeploy.
//
//   $DATA_DIR/db/data.sqlite   provider connections + settings (authoritative locally)
//   $DATA_DIR/jwt-secret       dashboard session signing key
//   $DATA_DIR/machine-id       stable machine identity
//
// Design goals (see docs/superpowers/specs/2026-10-15-render-free-selfhost-design.md):
//   - Disabled entirely unless 9ROUTER_STATE_PAT is set → local Windows behaviour unchanged.
//   - pull() at boot, before the DB adapter is created; remote-newer-at-boot wins, but the
//     local file is copied into $DATA_DIR/db/backups/ first.
//   - push() debounced 5 s after writes + a 60 s periodic flush; serialised; sha-checked.
//   - Never block a user request on the network: every failure is logged and retried with
//     exponential backoff. The PAT is read from env only and never logged.
//
// Credentials come exclusively from env:
//   9ROUTER_STATE_PAT     fine-grained PAT, Contents: read/write on the repo (required)
//   9ROUTER_STATE_REPO    "owner/name" (required)
//   9ROUTER_STATE_BRANCH  optional, default "state-data"

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DATA_DIR } from "@/lib/dataDir.js";
import { DATA_FILE, BACKUPS_DIR } from "@/lib/db/paths.js";

const API_BASE = "https://api.github.com";
const MANIFEST_REMOTE_PATH = "state-manifest.json";
const DEBOUNCE_MS = Number(process.env["9ROUTER_STATE_SYNC_DEBOUNCE_MS"] || 5000);
const PERIODIC_FLUSH_MS = Number(process.env["9ROUTER_STATE_SYNC_FLUSH_MS"] || 60000);
const MAX_REMOTE_BYTES = 40 * 1024 * 1024; // GitHub Contents API is not for huge blobs
const SHA_RETRY_LIMIT = 3;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 300000;

// The files that make up "state". `remote` is the path on the state-data branch.
function stateFiles() {
  return [
    { local: DATA_FILE, remote: "db/data.sqlite", kind: "db" },
    { local: path.join(DATA_DIR, "jwt-secret"), remote: "jwt-secret", kind: "text" },
    { local: path.join(DATA_DIR, "machine-id"), remote: "machine-id", kind: "text" },
  ];
}

// ── Config (env only; never persisted) ───────────────────────────────────────

export function getConfig() {
  const pat = process.env["9ROUTER_STATE_PAT"] || "";
  const repo = (process.env["9ROUTER_STATE_REPO"] || "").trim();
  const branch = (process.env["9ROUTER_STATE_BRANCH"] || "state-data").trim() || "state-data";
  const [owner, name] = repo.split("/");
  return {
    pat,
    repo,
    owner: (owner || "").trim(),
    name: (name || "").trim(),
    branch,
    enabled: Boolean(pat && owner && name),
  };
}

export function isEnabled() {
  return getConfig().enabled;
}

// ── Transient singleton state (survives Next.js dev hot-reload) ──────────────

const g = (global.__stateSyncState ??= {
  lastPushAt: null,
  lastPullAt: null,
  lastError: null,
  remoteSha: null,
  dirty: false,
  pending: false,
  backoffMs: 0,
  fileShas: {},
  debounceTimer: null,
  retryTimer: null,
  periodicTimer: null,
  inFlight: null,
});

// ── Byte helpers (exported for tests) ────────────────────────────────────────

export function gzipToBase64(buffer) {
  return zlib.gzipSync(Buffer.from(buffer)).toString("base64");
}

export function base64ToGunzip(b64) {
  return zlib.gunzipSync(Buffer.from(String(b64).replace(/\s+/g, ""), "base64"));
}

// ── GitHub Contents API ──────────────────────────────────────────────────────

function ghHeaders(cfg) {
  // The PAT is only ever placed in this header object; callers must not log it.
  return {
    Authorization: `Bearer ${cfg.pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "9router-state-sync",
    "Content-Type": "application/json",
  };
}

async function ghFetch(cfg, url, init = {}) {
  return globalThis.fetch(url, { ...init, headers: { ...ghHeaders(cfg), ...(init.headers || {}) } });
}

function contentsUrl(cfg, remotePath, suffix = "") {
  return `${API_BASE}/repos/${cfg.owner}/${cfg.name}/contents/${remotePath}${suffix}`;
}

function safeError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  // Defensive: never surface anything that could contain the token.
  return msg.replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted]").slice(0, 500);
}

function log(msg) {
  console.log(`[StateSync] ${msg}`);
}

// Read a file's metadata (sha) + body from the branch. Returns null when absent.
async function readRemoteFile(cfg, remotePath) {
  const res = await ghFetch(cfg, contentsUrl(cfg, remotePath, `?ref=${encodeURIComponent(cfg.branch)}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${remotePath} → ${res.status}`);
  const meta = await res.json();
  if (!meta || typeof meta !== "object") return null;

  let bytes;
  if (meta.encoding === "base64" && meta.content) {
    bytes = Buffer.from(String(meta.content).replace(/\s+/g, ""), "base64");
  } else if (meta.download_url) {
    const raw = await ghFetch(cfg, meta.download_url, { headers: {} });
    if (!raw.ok) throw new Error(`GET raw ${remotePath} → ${raw.status}`);
    bytes = Buffer.from(await raw.arrayBuffer());
  } else {
    bytes = Buffer.alloc(0);
  }
  return { sha: meta.sha, bytes };
}

// PUT a file, handling the sha-conflict (409) retry loop.
async function putRemoteFile(cfg, remotePath, bytes, message) {
  const content = Buffer.from(bytes).toString("base64");
  let sha = g.fileShas[remotePath];
  let lastErr;
  for (let attempt = 1; attempt <= SHA_RETRY_LIMIT; attempt++) {
    if (!sha) {
      const existing = await readRemoteFile(cfg, remotePath);
      sha = existing ? existing.sha : undefined;
    }
    const body = { message, content, branch: cfg.branch, ...(sha ? { sha } : {}) };
    const res = await ghFetch(cfg, contentsUrl(cfg, remotePath), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) {
      // Sha conflict (concurrent writer) or stale sha → re-read and retry.
      sha = undefined;
      lastErr = new Error(`PUT ${remotePath} → ${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`PUT ${remotePath} → ${res.status} ${await res.text().catch(() => "")}`);
    const data = await res.json().catch(() => ({}));
    g.fileShas[remotePath] = data?.content?.sha;
    g.remoteSha = data?.commit?.sha || data?.content?.sha || g.remoteSha;
    return data;
  }
  throw lastErr || new Error(`PUT ${remotePath} failed`);
}

async function readManifest(cfg) {
  const file = await readRemoteFile(cfg, MANIFEST_REMOTE_PATH);
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.bytes.toString("utf8"));
    return { ...parsed, _sha: file.sha };
  } catch {
    return null;
  }
}

// ── Local mtime ──────────────────────────────────────────────────────────────

function newestLocalMtime() {
  let newest = 0;
  for (const f of stateFiles()) {
    try {
      const st = fs.statSync(f.local);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      /* missing → ignore */
    }
  }
  return newest;
}

// ── pull() — boot restore (before the DB adapter is created) ─────────────────

export async function pull() {
  if (!isEnabled()) return { skipped: true, reason: "disabled" };
  const cfg = getConfig();
  try {
    const manifest = await readManifest(cfg);
    if (!manifest) return { skipped: true, reason: "no-remote-state" };

    const remoteTime = Date.parse(manifest.updatedAt || 0) || 0;
    const localTime = newestLocalMtime();
    g.remoteSha = manifest._sha || g.remoteSha;
    if (remoteTime === 0 || remoteTime <= localTime) {
      log("local state is at least as new as remote — keeping local");
      return { skipped: true, reason: "local-newer" };
    }

    const backupDir = path.join(BACKUPS_DIR, `remote-${Date.now()}`);
    fs.mkdirSync(backupDir, { recursive: true });

    const restored = [];
    for (const f of stateFiles()) {
      const remote = await readRemoteFile(cfg, f.remote);
      if (!remote) continue;
      // Backup the local file before overwriting (matches the existing backup convention).
      try {
        if (fs.existsSync(f.local)) {
          fs.copyFileSync(f.local, path.join(backupDir, path.basename(f.local)));
        }
      } catch (e) {
        log(`backup of ${f.remote} failed: ${safeError(e)}`);
      }
      fs.mkdirSync(path.dirname(f.local), { recursive: true });
      // Remote payload is gzipped bytes; gunzip back to the raw state file.
      const bytes = zlib.gunzipSync(remote.bytes);
      fs.writeFileSync(f.local, bytes);
      g.fileShas[f.remote] = remote.sha;
      restored.push(f.remote);
    }
    g.lastPullAt = new Date().toISOString();
    g.lastError = null;
    g.remoteSha = manifest._sha || g.remoteSha;
    log(`restored from remote: ${restored.join(", ")} (backup → ${backupDir})`);
    startPeriodicFlush();
    return { pulled: true, files: restored, backupDir, remoteSha: g.remoteSha };
  } catch (err) {
    g.lastError = safeError(err);
    log(`pull failed: ${g.lastError}`);
    scheduleRetry();
    return { error: g.lastError };
  }
}

// ── push() — debounced snapshot of the trio ──────────────────────────────────

// Debounced trigger after connection/settings writes. Cheap when disabled.
export function push(reason = "write") {
  if (!isEnabled()) return;
  g.dirty = true;
  if (g.debounceTimer) clearTimeout(g.debounceTimer);
  g.debounceTimer = setTimeout(() => {
    g.debounceTimer = null;
    flush(reason).catch(() => {});
  }, DEBOUNCE_MS);
  if (g.debounceTimer.unref) g.debounceTimer.unref();
}

export const notifyWrite = push;

// Immediate, serialised flush. Returns the push result (or coalesces onto the
// in-flight promise so concurrent callers never double-commit).
export function flush(reason = "manual") {
  if (!isEnabled()) return Promise.resolve({ skipped: true, reason: "disabled" });
  if (g.inFlight) return g.inFlight;
  g.inFlight = doPush(reason).finally(() => {
    g.inFlight = null;
  });
  return g.inFlight;
}

async function doPush(reason) {
  const cfg = getConfig();
  try {
    const files = {};
    const payloads = [];
    for (const f of stateFiles()) {
      let bytes;
      try {
        bytes = fs.readFileSync(f.local);
      } catch {
        continue; // state file not present yet
      }
      const gz = zlib.gzipSync(bytes);
      if (gz.length > MAX_REMOTE_BYTES) {
        throw new Error(`${f.remote} too large (${gz.length} bytes)`);
      }
      payloads.push({ remote: f.remote, gz });
    }
    if (payloads.length === 0) {
      g.dirty = false;
      return { skipped: true, reason: "no-local-state" };
    }

    for (const p of payloads) {
      await putRemoteFile(cfg, p.remote, p.gz, `state: sync ${reason} (${p.remote})`);
      files[p.remote] = g.fileShas[p.remote] || null;
    }

    const manifest = { updatedAt: new Date().toISOString(), version: 1, files };
    await putRemoteFile(
      cfg,
      MANIFEST_REMOTE_PATH,
      Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      `state: sync ${reason} (manifest)`
    );

    g.dirty = false;
    g.pending = false;
    g.backoffMs = 0;
    g.lastPushAt = manifest.updatedAt;
    g.lastError = null;
    log(`pushed ${Object.keys(files).length} file(s) (${reason})`);
    return { pushed: true, files: Object.keys(files), at: g.lastPushAt };
  } catch (err) {
    g.lastError = safeError(err);
    g.pending = true;
    log(`push failed: ${g.lastError}`);
    scheduleRetry();
    return { error: g.lastError };
  }
}

// ── Retry with exponential backoff ───────────────────────────────────────────

function scheduleRetry() {
  if (g.retryTimer) return;
  g.backoffMs = g.backoffMs ? Math.min(g.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_BASE_MS;
  g.retryTimer = setTimeout(() => {
    g.retryTimer = null;
    flush("retry").catch(() => {});
  }, g.backoffMs);
  if (g.retryTimer.unref) g.retryTimer.unref();
}

// ── Periodic flush (60 s) ────────────────────────────────────────────────────

export function startPeriodicFlush() {
  if (g.periodicTimer || !isEnabled()) return;
  g.periodicTimer = setInterval(() => {
    if (g.dirty) flush("periodic").catch(() => {});
  }, PERIODIC_FLUSH_MS);
  if (g.periodicTimer.unref) g.periodicTimer.unref();
}

export function stopPeriodicFlush() {
  if (g.periodicTimer) clearInterval(g.periodicTimer);
  g.periodicTimer = null;
}

// ── Status (safe, non-secret) ────────────────────────────────────────────────

export function status() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    repo: cfg.enabled ? cfg.repo : null,
    owner: cfg.enabled ? cfg.owner : null,
    name: cfg.enabled ? cfg.name : null,
    branch: cfg.branch,
    lastPushAt: g.lastPushAt,
    lastPullAt: g.lastPullAt,
    lastError: g.lastError,
    remoteSha: g.remoteSha,
    dirty: g.dirty,
    pending: g.pending,
    backoffMs: g.backoffMs,
  };
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function __resetForTests() {
  if (g.debounceTimer) clearTimeout(g.debounceTimer);
  if (g.retryTimer) clearTimeout(g.retryTimer);
  if (g.periodicTimer) clearInterval(g.periodicTimer);
  g.lastPushAt = null;
  g.lastPullAt = null;
  g.lastError = null;
  g.remoteSha = null;
  g.dirty = false;
  g.pending = false;
  g.backoffMs = 0;
  g.fileShas = {};
  g.debounceTimer = null;
  g.retryTimer = null;
  g.periodicTimer = null;
  g.inFlight = null;
}

export const __testInternals = {
  MANIFEST_REMOTE_PATH,
  DEBOUNCE_MS,
  PERIODIC_FLUSH_MS,
  stateFiles,
};
