import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

// Render runs the container as `node runtime/bootstrap.js`. This exercises that
// entrypoint end to end with a fixture app: the bootstrap must resolve a bundle,
// start the child, expose it on the health endpoint, write its status file, and —
// when no update credentials are set — stay dormant instead of phoning home.

const REPO = "E:/AiRouter/9router";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-"));
const APP_DIR = path.join(TMP, "app");
const DATA_DIR = path.join(TMP, "data");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let boot = null;

afterAll(() => {
  if (boot && !boot.killed) boot.kill("SIGKILL");
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("bootstrap entrypoint (Render container path)", () => {
  it("starts the child app, serves /api/health, writes status.json and stays dormant", async () => {
    // Fixture app: what the bootstrap expects — custom-server.js listening on PORT.
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(APP_DIR, "package.json"),
      JSON.stringify({ name: "fixture", version: "9.9.9" }, null, 2)
    );
    fs.writeFileSync(
      path.join(APP_DIR, "custom-server.js"),
      `const http = require("node:http");
const port = Number(process.env.PORT || 20128);
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end("nope");
});
server.listen(port, process.env.HOSTNAME || "0.0.0.0", () => {
  require("node:fs").writeFileSync(process.env.CHILD_MARKER, String(process.pid));
  console.log("fixture listening on " + port);
});
`
    );

    const port = await freePort();
    const childMarker = path.join(TMP, "child.pid");

    boot = spawn(process.execPath, [path.join(REPO, "runtime", "bootstrap.js")], {
      env: {
        ...process.env,
        BOOTSTRAP_APP_DIR: APP_DIR,
        DATA_DIR,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        CHILD_MARKER: childMarker,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bootOut = "";
    boot.stdout.on("data", (d) => { bootOut += d; });
    boot.stderr.on("data", (d) => { bootOut += d; });

    // Health must come up on the bootstrap's port.
    const deadline = Date.now() + 60000;
    let healthy = false;
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2000 }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
      if (ok) { healthy = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(healthy, `health via bootstrap; bootstrap output: ${bootOut}`).toBe(true);

    // The child really is a separate process that the bootstrap spawned.
    const childPid = Number(fs.readFileSync(childMarker, "utf8"));
    expect(Number.isInteger(childPid)).toBe(true);
    expect(() => process.kill(childPid, 0)).not.toThrow();

    // Status file: written by the bootstrap under its runtime dir.
    const statuses = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "status.json") statuses.push(p);
      }
    })(DATA_DIR);
    expect(statuses.length, "bootstrap writes status.json").toBeGreaterThan(0);
    const st = JSON.parse(fs.readFileSync(statuses[0], "utf8"));
    expect(st.updates.enabled).toBe(false);
    expect(st.updates.dormant).toBe(true);
    expect(st.child.pid).toBe(childPid);
    expect(st.bundlePath).toBe(APP_DIR);

    // Stopping the bootstrap must take the child with it (no orphan).
    const childRef = childPid;
    boot.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 4000));
    let childAlive = true;
    try { process.kill(childRef, 0); } catch { childAlive = false; }
    expect(childAlive, "child should be stopped when the bootstrap exits").toBe(false);
  }, 90000);
}, 120000);
