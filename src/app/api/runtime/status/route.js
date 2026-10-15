import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { getActiveDriver } from "@/lib/db/driver.js";
import { DATA_FILE } from "@/lib/db/paths.js";
import { DATA_DIR } from "@/lib/dataDir.js";
import { status as stateSyncStatus } from "@/lib/stateSync/githubState";
import { isRender } from "@/shared/constants/deployEnv";
import pkg from "../../../../../package.json" with { type: "json" };

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RUNTIME_STATUS_FILE = path.join(process.env.DATA_DIR || DATA_DIR, "runtime", "status.json");
const CONTROL_FILE = path.join(process.env.DATA_DIR || DATA_DIR, "runtime", "control.json");

async function canAccess() {
  const settings = await getSettings().catch(() => ({}));
  if (settings?.requireLogin === false) return true;
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  return verifyDashboardAuthToken(token);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    if (!(await canAccess())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Bootstrap (the container entrypoint) owns the update loop and writes this file.
    // It is absent when the app runs via `custom-server.js` (local dev / Windows).
    const bootstrap = readJsonSafe(RUNTIME_STATUS_FILE);

    const requestLogsEnv = process.env.ENABLE_REQUEST_LOGS;
    const sync = stateSyncStatus();

    const warnings = [];
    if (isRender()) {
      warnings.push("Free plan: the container spins down after 15 min idle and the filesystem is ephemeral — state is restored from the state-data branch on boot.");
      warnings.push("MITM and tunnel binaries are disabled on this deployment (no root, no writable persistent disk).");
      if (requestLogsEnv === undefined) {
        warnings.push("Request logging defaults to off here.");
      }
    }
    if (getActiveDriver() === "sql.js") {
      warnings.push("sql.js is the last-resort driver: the database is held in memory and flushed on change, which is heavier than the native drivers.");
    }

    return NextResponse.json(
      {
        version: pkg.version,
        nodeVersion: process.version,
        platform: process.platform,
        driver: getActiveDriver(),
        dataDir: DATA_DIR,
        dbFile: DATA_FILE,
        render: isRender(),
        freeTierWarnings: warnings,
        requestLogsEnabled: requestLogsEnv
          ? requestLogsEnv.toLowerCase() === "true"
          : !isRender(),
        stateSync: sync,
        bootstrap: bootstrap
          ? {
            bootstrap: true,
            pid: bootstrap.pid,
            version: bootstrap.version,
            bundlePath: bootstrap.bundlePath,
            target: bootstrap.target,
            previousTarget: bootstrap.previousTarget,
            seeded: bootstrap.seeded,
            child: bootstrap.child,
            updates: bootstrap.updates,
            lastCommand: bootstrap.lastCommand,
            updatedAt: bootstrap.updatedAt,
          }
          : { bootstrap: false, reason: "running without the container bootstrap (local dev / custom-server.js)" },
        hostname: os.hostname(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to read runtime status" }, { status: 500 });
  }
}

// Cross-process control channel for the bootstrap (check / apply / rollback).
export async function POST(request) {
  try {
    if (!(await canAccess())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const command = String(body.command || "").trim();
    if (!["check", "apply", "rollback"].includes(command)) {
      return NextResponse.json({ error: "Unknown command" }, { status: 400 });
    }
    const current = readJsonSafe(CONTROL_FILE);
    const nextId = (current?.id || 0) + 1;
    const payload = { id: nextId, command, at: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
      fs.writeFileSync(`${CONTROL_FILE}.tmp`, JSON.stringify(payload, null, 2));
      fs.renameSync(`${CONTROL_FILE}.tmp`, CONTROL_FILE);
    } catch (error) {
      return NextResponse.json({ error: `Failed to signal bootstrap: ${error.message}` }, { status: 500 });
    }
    return NextResponse.json({ queued: true, ...payload }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to queue command" }, { status: 500 });
  }
}