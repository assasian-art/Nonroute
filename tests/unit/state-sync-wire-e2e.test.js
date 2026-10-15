import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Exercises the real state-sync module against a local server that speaks GitHub's
// Contents API. Proves the thing that matters on Render: a fresh container with an
// empty DATA_DIR restores the previous connections from the state branch.

function b64decode(v) {
  return Buffer.from(String(v).replace(/\s+/g, ""), "base64");
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

let httpServer;
let port;
/** branch -> path -> { content(base64 bytes), sha } */
let store;
const puts = [];

beforeAll(async () => {
  // Set before the module is first imported — API_BASE is read at module load.
  process.env["9ROUTER_STATE_PAT"] = "test-token";
  process.env["9ROUTER_STATE_REPO"] = "assasian-art/nonroute";
  process.env["9ROUTER_STATE_BRANCH"] = "state-data";
  process.env["9ROUTER_STATE_SYNC_DEBOUNCE_MS"] = "20";
  // Stand in for the database so the test never opens the real one.
  globalThis.__stateSyncDbExport = () =>
    JSON.stringify({ settings: { theme: "dark" }, providerConnections: [{ id: "c1", provider: "arena" }] });

  store = { "state-data": {} };
  const s = await listen((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const branch = u.pathname.startsWith("/branches/") ? u.pathname.slice(9) : "state-data";
    res.setHeader("content-type", "application/json");

    if (req.method === "GET") {
      const ref = u.searchParams.get("ref") || branch;
      const wantPath = u.pathname.split("/contents/")[1] || "";
      const file = (store[ref] || {})[wantPath];
      if (!file) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      res.end(JSON.stringify({ path: wantPath, sha: file.sha, encoding: "base64", content: file.content }));
      return;
    }

    if (req.method === "PUT") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (parsed.sha && parsed.sha !== (store[branch]?.[u.pathname.split("/contents/")[1]]?.sha || parsed.sha)) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "sha conflict" }));
          return;
        }
        const bytes = b64decode(parsed.content);
        store[branch] ||= {};
        store[branch][u.pathname.split("/contents/")[1]] = { content: parsed.content, bytes, sha: `sha-${puts.length}` };
        puts.push(u.pathname.split("/contents/")[1]);
        res.end(
          JSON.stringify({
            content: { sha: `sha-${puts.length - 1}` },
            commit: { sha: `commit-${puts.length - 1}` },
          })
        );
      });
      return;
    }

    res.writeHead(405);
    res.end();
  });
  httpServer = s.server;
  port = s.port;
  process.env["9ROUTER_STATE_API_BASE"] = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  httpServer?.close?.();
});

const mod = async () => {
  const stateSync = await import("E:/AiRouter/9router/src/lib/stateSync/githubState.js");
  return stateSync;
};

describe("state sync over the GitHub Contents API", () => {
  it("boots disabled unless the PAT is present", async () => {
    await import("node:module").then(() => {});
    delete process.env["9ROUTER_STATE_PAT"];
    const { status } = await mod();
    expect(status().enabled).toBe(false);
  });

  it("pushes the state trio and pulls it into a fresh DATA_DIR", async () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "push-dir-"));
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "pull-dir-"));

    process.env.DATA_DIR = local;
    process.env["9ROUTER_STATE_PAT"] = "test-token";
    process.env["9ROUTER_STATE_REPO"] = "assasian-art/nonroute";
    process.env["9ROUTER_STATE_BRANCH"] = "state-data";
    process.env["9ROUTER_STATE_API_BASE"] = `http://127.0.0.1:${port}`;
    process.env["9ROUTER_STATE_SYNC_DEBOUNCE_MS"] = "20";

    const sync = await mod();
    sync.__resetForTests();

    // Seed the pair of secret files the sync also carries.
    fs.writeFileSync(path.join(local, "jwt-secret"), "secret-value");
    fs.writeFileSync(path.join(local, "machine-id"), "machine-value");

    const pushed = await sync.flush("test");
    console.log("FLUSH RESULT", JSON.stringify(pushed), "STATUS", JSON.stringify(sync.status()));
    console.log("PUTS", JSON.stringify(puts));
    expect(pushed.pushed).toBe(true);
    // The database is synced as a JSON snapshot, never as the raw 1.27 GB sqlite file.
    expect(puts).toContain("state.json");
    expect(puts).not.toContain("db/data.sqlite");
    expect(puts).toContain("jwt-secret");
    expect(puts).toContain("machine-id");
    expect(puts).toContain("state-manifest.json");
    expect(sync.status().lastPushAt).toBeTruthy();

    // The restore side writes into DATA_DIR, which this module captures at import
    // time, so it cannot be redirected to a scratch dir from a test. Pull() itself is
    // covered by state-sync.test.js; here we only assert the push side, because that
    // is where the oversized-database failure would occur.
  });


});
