import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import httpProxy from "http-proxy";
import cron from "node-cron";
import { chooseProvider, isImageRequest, nextFailureState, nextSuccessState } from "./lib/router.js";
import { normalizeCookieInput, validateArenaCookieFormat, encryptSecret, decryptSecret } from "./lib/cookies.js";
import { operateOnFile } from "./lib/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const PROJECT_ROOT = path.resolve(process.env.PROJECT_ROOT || path.join(DATA_DIR, "projects"));
const OMNI_PORT = Number(process.env.OMNIROUTE_INTERNAL_PORT || 20128);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const app = express();
const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true, proxyTimeout: 120000, timeout: 120000 });
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 8 })
  : null;
let omniProcess = null;
let omniAlive = false;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use("/api", express.json({ limit: "2mb" }));
app.use("/v1/chat/completions", express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

const providerSeeds = [
  { id: "pollinations-classic", name: "Pollinations classic (keyless)", endpoint: process.env.POLLINATIONS_CLASSIC_ENDPOINT || "https://text.pollinations.ai/", priority: 10, model: process.env.POLLINATIONS_CLASSIC_MODEL || "openai", image: false },
  { id: "pollinations-openai", name: "Pollinations OpenAI-compatible", endpoint: process.env.POLLINATIONS_OPENAI_ENDPOINT || (process.env.POLLINATIONS_API_KEY ? "https://gen.pollinations.ai/v1/chat/completions" : null), priority: 15, model: process.env.POLLINATIONS_MODEL || "openai", image: true },
  { id: "llm7", name: "LLM7.io anonymous", endpoint: process.env.LLM7_ENDPOINT || "https://api.llm7.io/v1/chat/completions", priority: 20, model: process.env.LLM7_MODEL || "auto", image: true },
  { id: "kilo", name: "Kilo anonymous free models", endpoint: process.env.KILO_ENDPOINT || "https://api.kilo.ai/api/gateway/chat/completions", priority: 30, model: process.env.KILO_MODEL || "google/gemma-4-26b-a4b-it:free", image: false },
  { id: "uncloseai", name: "UncloseAI keyless", endpoint: process.env.UNCLOSEAI_ENDPOINT || "https://hermes.ai.unturf.com/v1/chat/completions", priority: 40, model: process.env.UNCLOSEAI_MODEL || "auto", image: false },
  { id: "duckduckgo", name: "DuckDuckGo AI Chat", endpoint: process.env.DUCKDUCKGO_ENDPOINT || null, priority: 50, model: process.env.DUCKDUCKGO_MODEL || "auto", image: false },
  { id: "puter", name: "Puter.com AI", endpoint: process.env.PUTER_ENDPOINT || null, priority: 60, model: process.env.PUTER_MODEL || "auto", image: false },
  { id: "lmarena", name: "Arena / lmarena.ai cookie session", endpoint: process.env.LMARENA_ENDPOINT || null, priority: 70, model: process.env.LMARENA_MODEL || "auto", image: false }
];

async function dbQuery(sql, params = []) {
  if (!pool) throw new Error("DATABASE_URL is required; refusing to run with ephemeral in-memory state.");
  return pool.query(sql, params);
}

async function initializeDatabase() {
  await dbQuery(`CREATE TABLE IF NOT EXISTS provider_connections (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint_url TEXT, enabled BOOLEAN NOT NULL DEFAULT FALSE,
    priority INTEGER NOT NULL DEFAULT 100, default_model TEXT NOT NULL DEFAULT 'auto',
    capabilities JSONB NOT NULL DEFAULT '{}'::jsonb, quota_remaining NUMERIC, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS provider_health (
    provider_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
    failures INTEGER NOT NULL DEFAULT 0, health_status TEXT NOT NULL DEFAULT 'unknown',
    cooldown_until TIMESTAMPTZ, quarantined BOOLEAN NOT NULL DEFAULT FALSE, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS routing_sticky (
    session_key TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES provider_connections(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS user_tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, run_at TEXT NOT NULL DEFAULT '09:00',
    daily BOOLEAN NOT NULL DEFAULT TRUE, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_date TEXT, last_result TEXT, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS cookie_store (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, encrypted_cookie TEXT NOT NULL,
    expires_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'saved', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS system_backups (
    id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload JSONB NOT NULL
  )`);
  for (const p of providerSeeds) {
    await dbQuery(`INSERT INTO provider_connections (id,name,endpoint_url,enabled,priority,default_model,capabilities)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, endpoint_url=COALESCE(provider_connections.endpoint_url, EXCLUDED.endpoint_url),
      capabilities=EXCLUDED.capabilities`,
      [p.id, p.name, p.endpoint, Boolean(p.endpoint), p.priority, p.model, JSON.stringify({ chat: true, image: p.image, keyless: true })]);
    await dbQuery(`INSERT INTO provider_health (provider_id) VALUES ($1) ON CONFLICT (provider_id) DO NOTHING`, [p.id]);
  }
  if (process.env.AUTO_DISCOVER_PROVIDERS === "true") await discoverProviders();
  await fs.mkdir(PROJECT_ROOT, { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, "backups"), { recursive: true }).catch(() => {});
}

async function discoverProviders() {
  for (const p of providerSeeds) {
    const endpoint = process.env[p.id.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_ENDPOINT"];
    if (!endpoint) continue;
    await dbQuery("UPDATE provider_connections SET endpoint_url=$2, enabled=TRUE, updated_at=NOW() WHERE id=$1", [p.id, endpoint]);
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "ADMIN_TOKEN is not configured." });
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized. Provide the dashboard admin token." });
  next();
}

function safePublicProvider(row) {
  return {
    id: row.id, name: row.name, priority: row.priority, enabled: row.enabled,
    status: row.quarantined ? "quarantined" : row.health_status,
    failures: row.failures, quotaRemaining: row.quota_remaining === null ? null : Number(row.quota_remaining),
    endpointConfigured: Boolean(row.endpoint_url), defaultModel: row.default_model
  };
}

async function getProviders() {
  const result = await dbQuery(`SELECT c.*, h.failures, h.health_status, h.cooldown_until, h.quarantined, h.last_error
    FROM provider_connections c JOIN provider_health h ON h.provider_id=c.id ORDER BY c.priority ASC`);
  return result.rows;
}

app.get("/healthz", async (_req, res) => {
  try {
    await dbQuery("SELECT 1");
    res.json({ status: "ok", database: "connected", omniRouteEngine: omniAlive ? "running" : "starting_or_unavailable", timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: "degraded", database: "unavailable", error: error.message, timestamp: new Date().toISOString() });
  }
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/api/providers", requireAdmin, async (_req, res, next) => {
  try {
    const providers = await getProviders();
    res.json({ providers: providers.map((p) => ({ ...safePublicProvider(p), status: p.quarantined ? "quarantined" : (p.health_status || "unknown") })) });
  } catch (e) { next(e); }
});

app.post("/api/providers/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const endpoint = req.body.endpointUrl == null ? null : String(req.body.endpointUrl).trim();
    if (endpoint) {
      const u = new URL(endpoint);
      if (u.protocol !== "https:" || u.username || u.password) return res.status(400).json({ error: "Provider endpoints must be HTTPS URLs without embedded credentials." });
      if (["localhost", "127.0.0.1", "::1"].includes(u.hostname) || u.hostname.endsWith(".local")) return res.status(400).json({ error: "Private/local provider endpoints are not allowed." });
    }
    const priority = Number.isInteger(req.body.priority) ? req.body.priority : null;
    const enabled = req.body.enabled === true && Boolean(endpoint);
    const result = await dbQuery(`UPDATE provider_connections SET endpoint_url=$2, enabled=$3, priority=COALESCE($4,priority), updated_at=NOW()
      WHERE id=$1 RETURNING id,name,enabled,priority`, [id, endpoint, enabled, priority]);
    if (!result.rowCount) return res.status(404).json({ error: "Provider not found." });
    res.json({ provider: result.rows[0], message: "Provider configuration saved." });
  } catch (e) { next(e); }
});

app.post("/api/cookies/check", requireAdmin, async (req, res) => {
  try {
    const cookieHeader = normalizeCookieInput(req.body.cookie);
    const validation = validateArenaCookieFormat(cookieHeader);
    res.status(200).json({ ...validation, provider: "lmarena", liveSessionChecked: false });
  } catch (e) {
    res.status(200).json({ valid: false, message: "Invalid: " + e.message, provider: "lmarena", liveSessionChecked: false });
  }
});

app.post("/api/cookies", requireAdmin, async (req, res) => {
  try {
    const cookieHeader = normalizeCookieInput(req.body.cookie);
    const validation = validateArenaCookieFormat(cookieHeader);
    if (!validation.valid) return res.status(400).json({ error: validation.message, saved: false });
    const encrypted = encryptSecret(cookieHeader);
    await dbQuery("INSERT INTO cookie_store (id,provider_id,encrypted_cookie,expires_at,status) VALUES ($1,'lmarena',$2,$3,'saved')", [
      crypto.randomUUID(), encrypted, req.body.expiresAt ? new Date(req.body.expiresAt) : null
    ]);
    res.json({ saved: true, message: "Cookie saved encrypted. Live session validity has not been independently verified." });
  } catch (e) {
    console.error("Cookie save failed:", e.message);
    res.status(500).json({ error: "Cookie could not be saved. Check server configuration and try again.", saved: false });
  }
});

app.get("/api/tasks", requireAdmin, async (_req, res, next) => {
  try {
    const r = await dbQuery("SELECT id,title,run_at,daily,enabled,last_run_date,last_result,last_error,created_at FROM user_tasks ORDER BY created_at DESC");
    res.json({ tasks: r.rows });
  } catch (e) { next(e); }
});

app.post("/api/tasks", requireAdmin, async (req, res, next) => {
  try {
    const title = String(req.body.title || "").trim().slice(0, 160);
    const prompt = String(req.body.prompt || "").trim().slice(0, 12000);
    const runAt = String(req.body.runAt || "09:00");
    if (!title || !prompt) return res.status(400).json({ error: "Task title and instructions are required." });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(runAt)) return res.status(400).json({ error: "runAt must use HH:MM in 24-hour UTC time." });
    const id = crypto.randomUUID();
    const r = await dbQuery("INSERT INTO user_tasks (id,title,prompt,run_at,daily,enabled) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id,title,run_at,daily,enabled", [id,title,prompt,runAt,req.body.daily !== false]);
    res.status(201).json({ task: r.rows[0] });
  } catch (e) { next(e); }
});

app.delete("/api/tasks/:id", requireAdmin, async (req, res, next) => {
  try {
    const r = await dbQuery("DELETE FROM user_tasks WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Task not found." });
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

app.post("/api/agent/file", requireAdmin, async (req, res) => {
  try {
    const result = await operateOnFile({ projectRoot: PROJECT_ROOT, ...req.body });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

async function callBrain(messages, model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile") {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw Object.assign(new Error("GROQ_API_KEY is not configured."), { statusCode: 503 });
  const payload = { model, messages, temperature: 0.2 };
  const groq = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Authorization": "Bearer " + groqKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(60000)
  });
  if (![401, 403, 429].includes(groq.status)) {
    if (!groq.ok) throw Object.assign(new Error("Groq brain failed with HTTP " + groq.status), { statusCode: groq.status });
    return groq.json();
  }
  const cfBase = process.env.CLOUDFLARE_AI_BASE_URL;
  const cfToken = process.env.CLOUDFLARE_AI_TOKEN;
  if (!cfBase || !cfToken) throw Object.assign(new Error("Groq returned " + groq.status + " and Cloudflare fallback is not configured."), { statusCode: groq.status });
  const fallback = await fetch(cfBase, {
    method: "POST", headers: { "Authorization": "Bearer " + cfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, model: process.env.CLOUDFLARE_AI_MODEL || model }), signal: AbortSignal.timeout(60000)
  });
  if (!fallback.ok) throw Object.assign(new Error("Cloudflare fallback failed with HTTP " + fallback.status), { statusCode: fallback.status });
  return fallback.json();
}

app.post("/api/brain", requireAdmin, async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [{ role: "user", content: String(req.body.prompt || "") }];
    if (!messages.length || messages.some((m) => !m || !["system","user","assistant"].includes(m.role) || typeof m.content !== "string")) {
      return res.status(400).json({ error: "messages must contain role/content text entries." });
    }
    res.json(await callBrain(messages, req.body.model));
  } catch (e) { res.status(e.statusCode || 502).json({ error: e.message }); }
});

async function markProviderSuccess(providerId, response) {
  const reset = nextSuccessState();
  const remaining = response.headers.get("x-ratelimit-remaining") || response.headers.get("x-rate-limit-remaining");
  await dbQuery(`UPDATE provider_health SET failures=0,health_status='healthy',cooldown_until=NULL,quarantined=FALSE,last_error=NULL,updated_at=NOW() WHERE provider_id=$1`, [providerId]);
  if (remaining !== null && /^\d+(\.\d+)?$/.test(remaining)) await dbQuery("UPDATE provider_connections SET quota_remaining=$2,updated_at=NOW() WHERE id=$1", [providerId, Number(remaining)]);
  return reset;
}

async function markProviderFailure(provider, errorText) {
  const state = nextFailureState(provider);
  await dbQuery(`UPDATE provider_health SET failures=$2,health_status=$3,cooldown_until=$4,quarantined=$5,last_error=$6,updated_at=NOW() WHERE provider_id=$1`,
    [provider.id,state.failures,state.health_status,state.cooldown_until,state.quarantined,String(errorText).slice(0,500)]);
}

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const providers = await getProviders();
    const sessionKey = String(req.body.user || req.headers["x-session-id"] || req.body.model || "default").slice(0,200);
    const stickyRow = await dbQuery("SELECT provider_id FROM routing_sticky WHERE session_key=$1", [sessionKey]);
    const imageNeeded = isImageRequest(req.body);
    const tried = new Set();
    let lastError = "No eligible provider.";
    for (let attempt = 0; attempt < providers.length; attempt++) {
      const currentProviders = providers.filter((p) => !tried.has(p.id));
      const chosen = chooseProvider(currentProviders, stickyRow.rows[0]?.provider_id || null, imageNeeded);
      const provider = chosen.provider;
      if (!provider) break;
      tried.add(provider.id);
      try {
        if (provider.id === "pollinations-classic" && req.body.stream) {
          lastError = "Pollinations classic adapter does not support streaming.";
          continue;
        }
        let providerModel = req.body.model && req.body.model !== "auto" ? req.body.model : provider.default_model;
        if (!providerModel || providerModel === "auto") {
          try {
            const modelsUrl = new URL(provider.endpoint_url);
            modelsUrl.pathname = modelsUrl.pathname.endsWith("/chat/completions") ? modelsUrl.pathname.replace("/chat/completions", "/models") : modelsUrl.pathname.replace(/\/$/, "") + "/models";
            const modelResponse = await fetch(modelsUrl, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
            const modelData = modelResponse.ok ? await modelResponse.json() : null;
            providerModel = modelData?.data?.[0]?.id || modelData?.models?.[0]?.id || modelData?.models?.[0]?.name;
            if (providerModel) await dbQuery("UPDATE provider_connections SET default_model=$2 WHERE id=$1", [provider.id,providerModel]);
          } catch {}
          if (!providerModel || providerModel === "auto") {
            lastError = provider.id + " could not discover a default model.";
            await markProviderFailure(provider,lastError);
            continue;
          }
        }
        let response;
        if (provider.id === "pollinations-classic") {
          const prompt = (req.body.messages || []).map((m) => String(m.role || "user") + ": " + (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
          const classicUrl = new URL(encodeURIComponent(prompt), provider.endpoint_url.endsWith("/") ? provider.endpoint_url : provider.endpoint_url + "/");
          classicUrl.searchParams.set("model", providerModel);
          response = await fetch(classicUrl, { method: "GET", headers: { "Accept": "text/plain" }, signal: AbortSignal.timeout(90000) });
          if (response.ok) {
            const text = await response.text();
            response = new Response(JSON.stringify({ id: "chatcmpl-nonroute", object: "chat.completion", created: Math.floor(Date.now()/1000), model: providerModel, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
          }
        } else {
          const headers = { "Content-Type": "application/json", "Accept": "application/json" };
          if (provider.id === "pollinations-openai" && process.env.POLLINATIONS_API_KEY) headers.Authorization = "Bearer " + process.env.POLLINATIONS_API_KEY;
          if (provider.id === "llm7" && process.env.LLM7_API_KEY) headers.Authorization = "Bearer " + process.env.LLM7_API_KEY;
          if (provider.id === "kilo" && process.env.KILO_API_KEY) headers.Authorization = "Bearer " + process.env.KILO_API_KEY;
          if (provider.id === "lmarena") {
            const cookie = await dbQuery("SELECT encrypted_cookie FROM cookie_store WHERE provider_id='lmarena' ORDER BY created_at DESC LIMIT 1");
            if (cookie.rows[0]) headers.Cookie = decryptSecret(cookie.rows[0].encrypted_cookie);
          }
          response = await fetch(provider.endpoint_url, {
            method: "POST", headers,
            body: JSON.stringify({ ...req.body, model: providerModel }),
            signal: AbortSignal.timeout(90000)
          });
        }
        if (!response.ok) {
          const bodyText = (await response.text()).slice(0, 1000);
          lastError = provider.id + " returned HTTP " + response.status + (bodyText ? ": " + bodyText : "");
          await markProviderFailure(provider, lastError);
          continue;
        }
        await markProviderSuccess(provider.id, response);
        await dbQuery(`INSERT INTO routing_sticky (session_key,provider_id,updated_at) VALUES ($1,$2,NOW())
          ON CONFLICT (session_key) DO UPDATE SET provider_id=EXCLUDED.provider_id,updated_at=NOW()`, [sessionKey,provider.id]);
        res.setHeader("x-nonroute-provider", provider.id);
        res.status(response.status);
        const contentType = response.headers.get("content-type");
        if (contentType) res.setHeader("content-type", contentType);
        if (!response.body) return res.end();
        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (res.destroyed) break;
          res.write(Buffer.from(value));
        }
        return res.end();
      } catch (e) {
        lastError = provider.id + " failed: " + e.message;
        await markProviderFailure(provider, lastError);
      }
    }
    res.status(503).json({ error: { message: "All configured providers failed or are unavailable.", type: "provider_unavailable", detail: lastError } });
  } catch (e) {
    res.status(500).json({ error: { message: "Routing failed.", detail: e.message } });
  }
});

async function runDueTasks() {
  const now = new Date();
  const hhmm = now.toISOString().slice(11,16);
  const date = now.toISOString().slice(0,10);
  const tasks = await dbQuery("SELECT id,title,prompt,daily,last_run_date FROM user_tasks WHERE enabled=TRUE AND run_at <= $1 AND (last_run_date IS DISTINCT FROM $2)", [hhmm,date]);
  for (const task of tasks.rows) {
    const lock = await dbQuery("UPDATE user_tasks SET last_run_date=$2,last_error=NULL WHERE id=$1 AND last_run_date IS DISTINCT FROM $2 RETURNING id", [task.id,date]);
    if (!lock.rowCount) continue;
    try {
      const result = await callBrain([{ role: "user", content: task.prompt }]);
      const text = result.choices?.[0]?.message?.content || JSON.stringify(result);
      await dbQuery("UPDATE user_tasks SET last_result=$2,last_error=NULL,enabled=$3 WHERE id=$1", [task.id,String(text).slice(0,20000),Boolean(task.daily)]);
    } catch (e) {
      await dbQuery("UPDATE user_tasks SET last_error=$2,enabled=$3 WHERE id=$1", [task.id,e.message.slice(0,1000),Boolean(task.daily)]);
    }
  }
}

async function backupState() {
  const tables = ["provider_connections","provider_health","routing_sticky","user_tasks","cookie_store"];
  const payload = {};
  for (const table of tables) {
    const result = await dbQuery("SELECT * FROM " + table);
    payload[table] = result.rows;
  }
  const id = new Date().toISOString().replace(/[:.]/g,"-");
  const serialized = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), payload });
  const backupDir = path.join(DATA_DIR, "backups");
  await fs.mkdir(backupDir, { recursive: true });
  const tempPath = path.join(backupDir, id + ".json.tmp");
  const finalPath = path.join(backupDir, id + ".json");
  await fs.writeFile(tempPath, serialized, { mode: 0o600 });
  await fs.rename(tempPath, finalPath);
  await dbQuery("INSERT INTO system_backups (id,payload) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO NOTHING", [id,JSON.stringify(payload)]);
  await dbQuery("DELETE FROM system_backups WHERE created_at < NOW() - INTERVAL '14 days'");
}

async function restoreLatestDiskBackup() {
  const backupDir = path.join(DATA_DIR, "backups");
  const names = (await fs.readdir(backupDir).catch(() => [])).filter((n) => n.endsWith(".json")).sort().reverse();
  if (!names.length) return { restored: false, reason: "No disk backup found." };
  const parsed = JSON.parse(await fs.readFile(path.join(backupDir,names[0]),"utf8"));
  if (parsed.version !== 1 || !parsed.payload) throw new Error("Backup format is not supported.");
  const order = ["provider_connections","provider_health","routing_sticky","user_tasks","cookie_store"];
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    for (const table of [...order].reverse()) await client.query("DELETE FROM " + table);
    for (const row of parsed.payload.provider_connections || []) await client.query(
      "INSERT INTO provider_connections (id,name,endpoint_url,enabled,priority,default_model,capabilities,quota_remaining,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
      [row.id,row.name,row.endpoint_url,row.enabled,row.priority,row.default_model,JSON.stringify(row.capabilities || {}),row.quota_remaining,row.updated_at]);
    for (const row of parsed.payload.provider_health || []) await client.query(
      "INSERT INTO provider_health (provider_id,failures,health_status,cooldown_until,quarantined,last_error,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [row.provider_id,row.failures,row.health_status,row.cooldown_until,row.quarantined,row.last_error,row.updated_at]);
    for (const row of parsed.payload.routing_sticky || []) await client.query("INSERT INTO routing_sticky (session_key,provider_id,updated_at) VALUES ($1,$2,$3)",[row.session_key,row.provider_id,row.updated_at]);
    for (const row of parsed.payload.user_tasks || []) await client.query(
      "INSERT INTO user_tasks (id,title,prompt,run_at,daily,enabled,last_run_date,last_result,last_error,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [row.id,row.title,row.prompt,row.run_at,row.daily,row.enabled,row.last_run_date,row.last_result,row.last_error,row.created_at]);
    for (const row of parsed.payload.cookie_store || []) await client.query(
      "INSERT INTO cookie_store (id,provider_id,encrypted_cookie,expires_at,status,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [row.id,row.provider_id,row.encrypted_cookie,row.expires_at,row.status,row.created_at]);
    await client.query("COMMIT");
    return { restored: true, file: names[0] };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

app.post("/api/admin/backup", requireAdmin, async (_req, res) => {
  try { await backupState(); res.json({ ok: true, message: "Encrypted-cookie-safe state backup written to persistent disk." }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/admin/restore-latest-backup", requireAdmin, async (_req, res) => {
  try { res.json(await restoreLatestDiskBackup()); }
  catch (e) { res.status(500).json({ error: "Restore failed: " + e.message }); }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/opencode/")) {
    const target = process.env.OPENCODE_RELAY_BASE_URL;
    if (!target) return res.status(503).json({ error: "Vercel OpenCode relay is not configured." });
    req.url = req.url.replace(/^\/opencode/, "") || "/";
    return proxy.web(req,res,{target,changeOrigin:true},(err)=>{ if(!res.headersSent)res.status(502).json({error:"OpenCode relay unavailable: "+err.message}); });
  }
  if (req.path.startsWith("/omni/")) req.url = req.url.replace(/^\/omni/, "") || "/";
  proxy.web(req, res, { target: process.env.OMNIROUTE_INTERNAL_URL || `http://127.0.0.1:${OMNI_PORT}` }, (err) => {
    if (!res.headersSent) res.status(502).json({ error: "OmniRoute engine is not reachable.", detail: err.message });
  });
});

app.use((err, _req, res, _next) => {
  console.error("Request failed:", err.message);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error." });
});

proxy.on("error", (err, _req, res) => {
  if (res && !res.headersSent) res.status(502).json({ error: "Upstream proxy error.", detail: err.message });
});

async function startOmniRouteEngine() {
  if (process.env.ENABLE_OMNIROUTE_ENGINE === "false") return;
  const cli = path.join(__dirname, "node_modules", "omniroute", "bin", "omniroute.mjs");
  try { await fs.access(cli); } catch { console.error("OmniRoute package CLI not found; custom API will remain available."); return; }
  await fs.mkdir(process.env.OMNIROUTE_DATA_DIR || path.join(DATA_DIR,"omniroute"), { recursive: true }).catch(()=>{});
  omniProcess = spawn(process.execPath, [cli], {
    env: { ...process.env, PORT: String(OMNI_PORT), HOSTNAME: "127.0.0.1", HOME: DATA_DIR, OMNIROUTE_DATA_DIR: process.env.OMNIROUTE_DATA_DIR || path.join(DATA_DIR,"omniroute") },
    stdio: ["ignore","inherit","inherit"]
  });
  omniProcess.on("spawn", () => { omniAlive = true; });
  omniProcess.on("exit", (code) => { omniAlive = false; console.error("OmniRoute engine exited with code", code); });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${OMNI_PORT}/`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { omniAlive = true; return; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  omniProcess.kill("SIGTERM");
  throw new Error("OmniRoute engine did not become ready on port " + OMNI_PORT);
}

async function main() {
  if (!pool) throw new Error("DATABASE_URL is required. Configure a durable PostgreSQL database before starting Nonroute.");
  await initializeDatabase();
  await startOmniRouteEngine();
  cron.schedule("* * * * *", () => runDueTasks().catch((e) => console.error("Task scheduler error:",e.message)));
  cron.schedule("17 */6 * * *", () => backupState().catch((e) => console.error("Backup failed:",e.message)));
  cron.schedule("* * * * *", async () => {
    try {
      const r = await dbQuery("SELECT id,expires_at FROM cookie_store WHERE provider_id='lmarena' AND expires_at IS NOT NULL AND expires_at <= NOW() + INTERVAL '5 minutes' AND status <> 'refresh_due'");
      for (const row of r.rows) await dbQuery("UPDATE cookie_store SET status='refresh_due' WHERE id=$1",[row.id]);
      // No fake refresh: only mark due because the upstream provider does not expose a verified refresh contract here.
    } catch (e) { console.error("Cookie expiry check failed:",e.message); }
  });
  const server = http.createServer(app);
  server.on("upgrade", (req,socket,head) => {
    if (req.url.startsWith("/omni/")) req.url = req.url.replace(/^\/omni/, "") || "/";
    proxy.ws(req,socket,head,{target:process.env.OMNIROUTE_INTERNAL_URL || `http://127.0.0.1:${OMNI_PORT}`});
  });
  server.listen(PORT,"0.0.0.0",() => console.log(`Nonroute listening on 0.0.0.0:${PORT}`));
  const shutdown = async () => {
    server.close();
    if (omniProcess && !omniProcess.killed) omniProcess.kill("SIGTERM");
    await pool.end().catch(()=>{});
    process.exit(0);
  };
  process.on("SIGTERM",shutdown);
  process.on("SIGINT",shutdown);
}

main().catch((e) => { console.error("Startup failed:",e.message); process.exit(1); });
