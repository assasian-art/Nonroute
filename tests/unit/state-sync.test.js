import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The module reads DATA_DIR at import time (via src/lib/db/paths.js), so point it
// at a scratch dir before importing.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "state-sync-"));
process.env.DATA_DIR = TMP;
process.env["9ROUTER_STATE_SYNC_DEBOUNCE_MS"] = "200";
process.env["9ROUTER_STATE_SYNC_FLUSH_MS"] = "60000";
// Stand in for the database so a push never opens the real one.
globalThis.__stateSyncDbExport = () =>
  JSON.stringify({ settings: {}, providerConnections: [{ id: "c1", provider: "arena" }] });

let mod;

function makeResponse({ status = 200, body = {}, ok = status >= 200 && status < 300 } = {}) {
  return {
    status,
    ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

beforeAll(async () => {
  fs.mkdirSync(path.join(TMP, "db"), { recursive: true });
  mod = await import("../../src/lib/stateSync/githubState.js");
});

beforeEach(() => {
  mod.__resetForTests();
  delete process.env["9ROUTER_STATE_PAT"];
  delete process.env["9ROUTER_STATE_REPO"];
  delete process.env["9ROUTER_STATE_BRANCH"];
  fs.writeFileSync(path.join(TMP, "db", "data.sqlite"), Buffer.from("sqlite-bytes-\u0000\u0001\u0002"));
  fs.writeFileSync(path.join(TMP, "jwt-secret"), "jwt-secret-value");
  fs.writeFileSync(path.join(TMP, "machine-id"), "machine-id-value");
});

afterEach(() => {
  mod.__resetForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function enableSync() {
  process.env["9ROUTER_STATE_PAT"] = "ghp_example_token_value";
  process.env["9ROUTER_STATE_REPO"] = "owner/name";
  process.env["9ROUTER_STATE_BRANCH"] = "state-data";
}

describe("githubState — gzip helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0, 200]);
    const b64 = mod.gzipToBase64(bytes);
    expect(mod.base64ToGunzip(b64).equals(bytes)).toBe(true);
  });
});

describe("githubState — disabled without PAT", () => {
  it("reports disabled and never calls the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(mod.isEnabled()).toBe(false);
    expect(mod.status().enabled).toBe(false);

    const result = await mod.flush("manual");
    expect(result).toEqual({ skipped: true, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();

    // push() is a no-op too (no timer scheduled).
    mod.push("connections");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("githubState — debounce coalescing", () => {
  it("coalesces rapid pushes into a single flush after the debounce window", async () => {
    enableSync();
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => makeResponse({ body: { content: { sha: "s" }, commit: { sha: "c" } } }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 5; i += 1) mod.push("connections");

    // Nothing fires before the debounce window elapses.
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    // Exactly one upload sequence ran: one PUT per state file + one manifest PUT.
    const puts = fetchMock.mock.calls.filter((c) => c[1] && c[1].method === "PUT");
    expect(puts.length).toBeGreaterThan(0);
    // 3 state files + manifest = 4 PUTs, from a single coalesced flush.
    expect(puts.length).toBe(4);
  });
});

describe("githubState — sha conflict retry", () => {
  it("re-reads the sha and retries the PUT after a 409", async () => {
    enableSync();
    // Only the db file present → one state file, keeping the mock deterministic.
    fs.rmSync(path.join(TMP, "jwt-secret"), { force: true });
    fs.rmSync(path.join(TMP, "machine-id"), { force: true });

    let dbPuts = 0;
    const fetchMock = vi.fn(async (url, init = {}) => {
      const method = init.method || "GET";
      if (url.includes("state-manifest.json")) {
        return makeResponse({ body: { content: { sha: "m1" }, commit: { sha: "commit1" } } });
      }
      if (url.includes("state.json")) {
        if (method === "PUT") {
          dbPuts += 1;
          if (dbPuts === 1) {
            return makeResponse({ status: 409, ok: false, body: { message: "sha conflict" } });
          }
          return makeResponse({ body: { content: { sha: "d2" }, commit: { sha: "commit2" } } });
        }
        return makeResponse({ body: { encoding: "base64", sha: "d1", content: "" } });
      }
      return makeResponse({ status: 404, ok: false, body: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await mod.flush("manual");

    expect(dbPuts).toBe(2); // first PUT conflicted, retry succeeded
    expect(result.pushed).toBe(true);
    expect(result.files).toContain("state.json");
    expect(mod.status().lastError).toBeNull();
    expect(mod.status().lastPushAt).toBeTruthy();
  });

  it("records an error and schedules a backoff retry when the push fails", async () => {
    enableSync();
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => makeResponse({ status: 500, ok: false, body: { message: "boom" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await mod.flush("manual");
    expect(result.error).toBeTruthy();
    expect(mod.status().lastError).toBeTruthy();

    const callsAfterFailure = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000); // retry backoff
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFailure);
  });
});
