// Container entrypoint for the self-hosted (Render free) deployment.
//
// Replaces `node custom-server.js` as the container CMD. Responsibilities:
//   1. Resolve the active bundle  -> $DATA_DIR/runtime/<version>/ (or the image seed).
//   2. Seed a bundle from the image contents on first boot so we can start immediately.
//   3. Start `node custom-server.js` as a child, inherit PORT/HOSTNAME/DATA_DIR,
//      forward signals, and restart the child when it crashes.
//   4. Poll the project's GitHub Releases for a newer `server-bundle-<version>.tar.gz`
//      every 6h (and once ~60s after boot). Dormant when the update source is unset.
//   5. Download + sha256-verify + extract the bundle, flip `current`, restart the child
//      gracefully (SIGTERM -> wait <=10s -> SIGKILL).
//   6. Roll back to the previous bundle when the new child fails its health check twice.
//   7. Publish loop state to $DATA_DIR/runtime/status.json, read by GET /api/runtime/status.
//
// Env:
//   DATA_DIR               persistent-ish data root (required for anything to persist)
//   PORT / HOSTNAME        inherited by the child
//   9ROUTER_UPDATE_OWNER   GitHub owner for releases  (dormant when unset)
//   9ROUTER_UPDATE_REPO    GitHub repo name for releases (dormant when unset)
//   9ROUTER_UPDATE_PAT     PAT for the releases API; falls back to 9ROUTER_STATE_PAT

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const APP_DIR = process.env.BOOTSTRAP_APP_DIR || path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || path.join(process.env.HOME || "/root", ".9router");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
// The symlink is the documented pointer; current.path is the authoritative
// cross-platform fallback (symlink creation can fail on exotic filesystems).
const CURRENT_LINK = path.join(RUNTIME_DIR, "current");
const CURRENT_PATH_FILE = path.join(RUNTIME_DIR, "current.path");
const STATUS_FILE = path.join(RUNTIME_DIR, "status.json");
const CONTROL_FILE = path.join(RUNTIME_DIR, "control.json");

const PORT = process.env.PORT || "20128";
const HOSTNAME = process.env.HOSTNAME || "0.0.0.0";
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;

const POLL_AFTER_BOOT_MS = 60000;
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CONTROL_POLL_MS = 5000;
const HEALTH_TIMEOUT_MS = 60000;
const HEALTH_ATTEMPTS = 30;
const GRACEFUL_STOP_MS = 10000;
const MAX_HEALTH_FAILURES = 2;
const CHILD_RESTART_BASE_MS = 2000;

function nowIso() {
  return new Date().toISOString();
}

function log(scope, message) {
  console.log(`[bootstrap:${scope}] ${message}`);
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn(`[bootstrap] cannot create ${dir}: ${e.message}`);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn(`[bootstrap] cannot write ${file}: ${e.message}`);
  }
}

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  pid: process.pid,
  startedAt: nowIso(),
  updatedAt: nowIso(),
  version: readJson(path.join(APP_DIR, "package.json"), {}).version || "unknown",
  bundlePath: null,
  target: null,
  previousTarget: null,
  seeded: false,
  updates: {
    enabled: false,
    dormant: true,
    owner: process.env["9ROUTER_UPDATE_OWNER"] || null,
    repo: process.env["9ROUTER_UPDATE_REPO"] || null,
    lastCheckAt: null,
    latestVersion: null,
    updateAvailable: false,
    lastError: null,
    appliedAt: null,
    healthFailures: 0,
  },
  child: {
    pid: null,
    restarts: 0,
    lastExitCode: null,
    healthy: false,
  },
  lastCommand: null,
};

let lastCommandId = 0;
let child = null;
let childStopping = false;
let restarting = false;

function persistStatus() {
  state.updatedAt = nowIso();
  writeJson(STATUS_FILE, state);
}

// ── Bundle resolution ────────────────────────────────────────────────────────

function resolveBundle() {
  try {
    if (fs.existsSync(CURRENT_PATH_FILE)) {
      const target = fs.readFileSync(CURRENT_PATH_FILE, "utf8").trim();
      if (target && fs.existsSync(target)) return target;
    }
  } catch { /* fall through */ }
  try {
    if (fs.existsSync(CURRENT_LINK)) return fs.realpathSync(CURRENT_LINK);
  } catch { /* fall through */ }
  return null;
}

function pointBundleAt(target) {
  ensureDir(RUNTIME_DIR);
  // Symlink first (documented layout), file pointer as the reliable fallback.
  try {
    const tmpLink = `${CURRENT_LINK}.tmp`;
    try { fs.unlinkSync(tmpLink); } catch { /* ignore */ }
    fs.symlinkSync(target, tmpLink, "dir");
    fs.renameSync(tmpLink, CURRENT_LINK);
  } catch {
    try { fs.unlinkSync(CURRENT_LINK); } catch { /* ignore */ }
    try { fs.symlinkSync(target, CURRENT_LINK, "dir"); } catch { /* best effort */ }
  }
  writeJson(CURRENT_PATH_FILE, target);
  state.bundlePath = target;
}

// Seed the first bundle from the image contents so the app can start immediately.
function ensureBundle() {
  const existing = resolveBundle();
  if (existing) {
    state.bundlePath = existing;
    state.target = existing;
    return existing;
  }
  pointBundleAt(APP_DIR);
  state.target = APP_DIR;
  state.seeded = true;
  log("bundle", `seeded from image contents at ${APP_DIR}`);
  return APP_DIR;
}

// ── Child process ────────────────────────────────────────────────────────────

function bundleEntry(bundleDir) {
  return path.join(bundleDir, "custom-server.js");
}

function startChild() {
  const bundleDir = resolveBundle();
  if (!bundleDir) {
    log("child", "no bundle resolved — cannot start");
    return;
  }
  state.bundlePath = bundleDir;
  const entry = bundleEntry(bundleDir);
  if (!fs.existsSync(entry)) {
    log("child", `bundle is incomplete (missing ${entry})`);
  }
  try {
    child = spawn(process.execPath, [entry], {
      cwd: bundleDir,
      env: { ...process.env, PORT, HOSTNAME, DATA_DIR },
      stdio: "inherit",
    });
    state.child.pid = child.pid;
    log("child", `started pid=${child.pid} bundle=${bundleDir}`);

    child.on("exit", (code, signal) => {
      state.child.pid = null;
      state.child.healthy = false;
      state.child.lastExitCode = code;
      const wasStopping = childStopping;
      childStopping = false;
      child = null;
      if (wasStopping) {
        log("child", `stopped (code=${code} signal=${signal})`);
        return;
      }
      log("child", `exited unexpectedly (code=${code} signal=${signal}) — restarting`);
      scheduleChildRestart();
    });
    child.on("error", (err) => {
      log("child", `spawn error: ${err.message}`);
    });
    persistStatus();
  } catch (e) {
    log("child", `failed to spawn: ${e.message}`);
  }
}

function scheduleChildRestart() {
  if (restarting) return;
  restarting = true;
  state.child.restarts += 1;
  persistStatus();
  const delay = Math.min(CHILD_RESTART_BASE_MS * state.child.restarts, 30000);
  setTimeout(() => {
    restarting = false;
    startChild();
    trackHealth();
  }, delay);
}

// SIGTERM -> wait <=10s -> SIGKILL
function stopChild() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    childStopping = true;
    const target = child;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    target.once("exit", done);
    try {
      target.kill("SIGTERM");
    } catch { /* already gone */ }
    setTimeout(() => {
      if (settled) return;
      try {
        target.kill("SIGKILL");
      } catch { /* already gone */ }
      setTimeout(done, 1000);
    }, GRACEFUL_STOP_MS);
  });
}

// ── Health ───────────────────────────────────────────────────────────────────

function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    // eslint-disable-next-line no-await-in-loop
    if (await probeHealth()) {
      state.child.healthy = true;
      state.updates.healthFailures = 0;
      persistStatus();
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2000));
  }
  state.child.healthy = false;
  persistStatus();
  log("health", `child did not become healthy within ${timeoutMs}ms (${attempt} probes)`);
  return false;
}

// Health is tracked in the background so a child that dies right after boot is
// noticed even when no update is in flight.
function trackHealth() {
  setTimeout(async () => {
    const ok = await probeHealth();
    if (!ok && child) {
      state.child.healthy = false;
      persistStatus();
    }
  }, 5000);
}

// ── Releases (update loop) ───────────────────────────────────────────────────

function updateConfig() {
  const owner = process.env["9ROUTER_UPDATE_OWNER"] || "";
  const repo = process.env["9ROUTER_UPDATE_REPO"] || "";
  const pat = process.env["9ROUTER_UPDATE_PAT"] || process.env["9ROUTER_STATE_PAT"] || "";
  return { owner, repo, pat, enabled: Boolean(owner && repo && pat) };
}

function httpsJson(url, pat) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "9router-bootstrap",
    };
    if (pat) headers.Authorization = `Bearer ${pat}`;
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`bad JSON: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function httpsDownload(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsDownload(res.headers.location, headers).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function checkForUpdate({ apply = false } = {}) {
  const cfg = updateConfig();
  state.updates.owner = cfg.owner || null;
  state.updates.repo = cfg.repo || null;
  if (!cfg.enabled) {
    state.updates.dormant = true;
    state.updates.enabled = false;
    persistStatus();
    return { dormant: true };
  }
  state.updates.dormant = false;
  state.updates.enabled = true;

  try {
    const release = await httpsJson(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`,
      cfg.pat
    );
    const latest = String(release.tag_name || "").replace(/^v/, "");
    state.updates.lastCheckAt = nowIso();
    state.updates.latestVersion = latest || null;
    state.updates.lastError = null;
    const running = readJson(path.join(resolveBundle() || APP_DIR, "package.json"), {}).version || state.version;
    const newer = latest && compareVersions(latest, running) > 0;
    state.updates.updateAvailable = Boolean(newer);
    persistStatus();

    if (!newer || !apply) {
      log("update", newer ? `newer version available: ${latest}` : `up to date (${running})`);
      return { latest, running, newer };
    }
    await applyBundle(cfg, latest, release);
    return { latest, running, newer, applied: true };
  } catch (err) {
    state.updates.lastError = `update check failed: ${err.message}`;
    log("update", state.updates.lastError);
    persistStatus();
    return { error: state.updates.lastError };
  }
}

async function applyBundle(cfg, version, release) {
  const assetName = `server-bundle-${version}.tar.gz`;
  const checksumName = `${assetName}.sha256`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const tarAsset = assets.find((a) => a.name === assetName);
  const shaAsset = assets.find((a) => a.name === checksumName);
  if (!tarAsset || !shaAsset) {
    throw new Error(`release assets missing (${assetName}${shaAsset ? "" : ", " + checksumName})`);
  }

  log("update", `downloading ${assetName}`);
  const tarball = await httpsDownload(tarAsset.browser_download_url, {
    Authorization: `Bearer ${cfg.pat}`,
    Accept: "application/octet-stream",
    "User-Agent": "9router-bootstrap",
  });

  const checksumText = (await httpsDownload(shaAsset.browser_download_url, {
    Authorization: `Bearer ${cfg.pat}`,
    Accept: "application/octet-stream",
    "User-Agent": "9router-bootstrap",
  })).toString("utf8");
  const expected = (checksumText.match(/[0-9a-f]{64}/i) || [])[0];
  const actual = crypto.createHash("sha256").update(tarball).digest("hex");
  if (!expected || expected.toLowerCase() !== actual) {
    throw new Error(`sha256 mismatch for ${assetName}`);
  }
  log("update", `sha256 verified for ${assetName}`);

  const target = path.join(RUNTIME_DIR, version);
  const staging = path.join(RUNTIME_DIR, `.staging-${version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  ensureDir(staging);
  const tarPath = path.join(RUNTIME_DIR, `${assetName}`);
  fs.writeFileSync(tarPath, tarball);
  try {
    execFileSync("tar", ["-xzf", tarPath, "-C", staging], { stdio: "inherit" });
  } finally {
    fs.rmSync(tarPath, { force: true });
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  if (!fs.existsSync(path.join(target, "custom-server.js"))) {
    throw new Error(`extracted bundle for ${version} is missing custom-server.js`);
  }

  await activateBundle(target, version);
}

async function activateBundle(target, version) {
  const previousTarget = state.bundlePath || state.target;
  pointBundleAt(target);
  state.previousTarget = previousTarget;
  state.target = target;
  state.updates.healthFailures = 0;
  persistStatus();

  for (let attempt = 1; attempt <= MAX_HEALTH_FAILURES; attempt += 1) {
    log("update", `activating ${version} (attempt ${attempt}/${MAX_HEALTH_FAILURES})`);
    // eslint-disable-next-line no-await-in-loop
    await stopChild();
    startChild();
    // eslint-disable-next-line no-await-in-loop
    const healthy = await waitForHealth();
    if (healthy) {
      state.updates.appliedAt = nowIso();
      state.updates.lastError = null;
      persistStatus();
      log("update", `bundle ${version} is live and healthy`);
      return true;
    }
    state.updates.healthFailures = attempt;
    persistStatus();
  }

  log("update", `bundle ${version} failed health check ${MAX_HEALTH_FAILURES}x — rolling back`);
  await rollback();
  throw new Error(`bundle ${version} failed health check — rolled back to ${state.bundlePath}`);
}

async function rollback() {
  const previous = state.previousTarget;
  if (!previous) {
    log("update", "rollback requested but no previous bundle is recorded");
    return false;
  }
  log("update", `rolling back to ${previous}`);
  pointBundleAt(previous);
  state.target = previous;
  state.previousTarget = null;
  state.updates.healthFailures = 0;
  state.updates.lastError = `rolled back to ${previous}`;
  persistStatus();
  await stopChild();
  startChild();
  await waitForHealth();
  return true;
}

// ── Control channel (dashboard commands, cross-process) ───────────────────────

async function handleCommand(command) {
  const id = command.id;
  let result = { ok: true };
  try {
    if (command.command === "check") {
      result = { ok: true, ...(await checkForUpdate()) };
    } else if (command.command === "apply") {
      result = { ok: true, ...(await checkForUpdate({ apply: true })) };
    } else if (command.command === "rollback") {
      result = { ok: await rollback() };
    } else {
      result = { ok: false, error: `unknown command: ${command.command}` };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  state.lastCommand = { id, command: command.command, at: nowIso(), result };
  persistStatus();
  return result;
}

function pollControl() {
  const cmd = readJson(CONTROL_FILE, null);
  if (!cmd || typeof cmd.id !== "number" || cmd.id <= lastCommandId) return;
  lastCommandId = cmd.id;
  log("control", `running command "${cmd.command}" (#${cmd.id})`);
  handleCommand(cmd).catch((e) => log("control", `command failed: ${e.message}`));
}

// ── Boot ─────────────────────────────────────────────────────────────────────

function forwardSignal(signal) {
  log("signal", `received ${signal} — forwarding to child`);
  if (child) {
    try { child.kill(signal); } catch { /* ignore */ }
  }
}

async function main() {
  ensureDir(RUNTIME_DIR);
  // Heartbeat within ~2s so the platform health check passes while Next boots.
  log("boot", `starting 9router ${state.version} (port=${PORT})`);

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      forwardSignal(sig);
      stopChild().finally(() => process.exit(0));
    });
  }

  ensureBundle();
  persistStatus();
  startChild();
  trackHealth();

  if (updateConfig().enabled) {
    setTimeout(() => { checkForUpdate().catch(() => {}); }, POLL_AFTER_BOOT_MS);
    setInterval(() => { checkForUpdate().catch(() => {}); }, POLL_INTERVAL_MS);
  } else {
    state.updates.dormant = true;
    persistStatus();
    log("update", "dormant — set 9ROUTER_UPDATE_OWNER + 9ROUTER_UPDATE_REPO (+ PAT) to enable");
  }

  setInterval(pollControl, CONTROL_POLL_MS);
  // Never resolves — the interval keeps this (non-Next) process alive.
}

main().catch((e) => console.error(`[bootstrap] fatal: ${e.stack || e.message}`));