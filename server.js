#!/usr/bin/env node
/**
 * Brain Dump — always-on nag server.
 * Dependency-free. Serves the UI, stores tasks/config on disk,
 * and posts hourly Slack nags for overdue tasks even when no browser is open.
 *
 *   node server.js
 *   open http://localhost:3000
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const INDEX_FILE = path.join(__dirname, "index.html");

const DEFAULT_CFG = {
  // Webhook can also be supplied via env SLACK_WEBHOOK_URL
  webhook: process.env.SLACK_WEBHOOK_URL || "",
  deadlineMin: 60,
  intervalMin: 60,
  quietStart: "22:00",
  quietEnd: "08:00",
};

// ---------- persistence (private GitHub data repo if configured, else local file) ----------
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GH_DATA_REPO || "majodelacruz-nusava/brain-dump-data";
const GH_PATH = process.env.GH_DATA_PATH || "state.json";
const GH_BRANCH = process.env.GH_BRANCH || "main";
const USE_GITHUB = !!GH_TOKEN;
let ghSha = null;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error("write failed", file, e.message); }
}
function ghUrl() { return "https://api.github.com/repos/" + GH_REPO + "/contents/" + GH_PATH; }
async function ghApi(method, extra) {
  const url = ghUrl() + (method === "GET" ? "?ref=" + GH_BRANCH : "");
  return fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + GH_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "brain-dump-nagger",
      "Content-Type": "application/json",
    },
    body: extra ? JSON.stringify(extra) : undefined,
  });
}

let tasks = [];
let cfg = Object.assign({}, DEFAULT_CFG);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// The webhook always comes from the environment, never persisted to storage.
function cfgForStorage() { const c = Object.assign({}, cfg); delete c.webhook; return c; }

async function loadState() {
  if (USE_GITHUB) {
    try {
      const r = await ghApi("GET");
      if (r.status === 200) {
        const j = await r.json();
        ghSha = j.sha;
        const state = JSON.parse(Buffer.from(j.content, "base64").toString("utf8") || "{}");
        tasks = Array.isArray(state.tasks) ? state.tasks : [];
        cfg = Object.assign({}, DEFAULT_CFG, state.cfg || {}, { webhook: DEFAULT_CFG.webhook });
        console.log("Loaded from GitHub data repo:", tasks.length, "tasks");
      } else if (r.status === 404) {
        ghSha = null; tasks = []; cfg = Object.assign({}, DEFAULT_CFG);
        console.log("No state file yet — will create it on first save.");
      } else {
        console.error("GitHub load failed:", r.status, (await r.text()).slice(0, 200));
        tasks = []; cfg = Object.assign({}, DEFAULT_CFG);
      }
    } catch (e) { console.error("GitHub load error:", e.message); tasks = []; cfg = Object.assign({}, DEFAULT_CFG); }
  } else {
    tasks = readJSON(TASKS_FILE, []);
    cfg = Object.assign({}, DEFAULT_CFG, readJSON(CONFIG_FILE, {}), { webhook: DEFAULT_CFG.webhook });
  }
}

// Serialize all writes so commits never race on the file SHA.
let saveChain = Promise.resolve();
async function commitState() {
  if (!USE_GITHUB) { writeJSON(TASKS_FILE, tasks); writeJSON(CONFIG_FILE, cfgForStorage()); return; }
  const content = Buffer.from(JSON.stringify({ tasks, cfg: cfgForStorage() })).toString("base64");
  const body = { message: "update state " + new Date().toISOString(), content, branch: GH_BRANCH };
  if (ghSha) body.sha = ghSha;
  let r = await ghApi("PUT", body);
  if (r.status === 409 || r.status === 422) { // SHA drifted — refetch and retry once
    const g = await ghApi("GET");
    if (g.status === 200) { ghSha = (await g.json()).sha; body.sha = ghSha; r = await ghApi("PUT", body); }
  }
  if (r.ok) { const j = await r.json(); ghSha = j.content && j.content.sha; }
  else console.error("GitHub save failed:", r.status, (await r.text()).slice(0, 200));
}
function persist() { saveChain = saveChain.then(() => commitState().catch(e => console.error("persist:", e.message))); return saveChain; }
async function saveTasks() { await persist(); }
async function saveCfg() { await persist(); }
let dirty = false; // set by the nag loop; flushed on a timer to limit commit volume

// ---------- time helpers (server local time) ----------
function inQuietHours(d) {
  const [sh, sm] = cfg.quietStart.split(":").map(Number);
  const [eh, em] = cfg.quietEnd.split(":").map(Number);
  const cur = d.getHours() * 60 + d.getMinutes(), s = sh * 60 + sm, e = eh * 60 + em;
  if (s === e) return false;
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}
function nextQuietEnd(d) {
  const [eh, em] = cfg.quietEnd.split(":").map(Number);
  const n = new Date(d); n.setHours(eh, em, 0, 0);
  if (n <= d) n.setDate(n.getDate() + 1);
  return n.getTime();
}
function fmtDur(ms) {
  const a = Math.abs(ms), h = Math.floor(a / 3600000), m = Math.floor((a % 3600000) / 60000);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return Math.max(0, Math.floor(a / 1000)) + "s";
}

// ---------- Slack ----------
async function sendSlack(text, webhook) {
  const url = webhook || cfg.webhook;
  if (!url) return { ok: false, error: "No webhook configured." };
  if (typeof fetch !== "function") return { ok: false, error: "Node 18+ required (global fetch missing)." };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return { ok: false, error: "Slack returned " + r.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function nagText(t) {
  const over = Date.now() - t.deadline;
  const when = over < 60000 ? "now due" : "overdue by " + fmtDur(over);
  const lead = t.nags === 0 ? "⏰ Time's up" : "🔁 Still not done (" + t.nags + "x)";
  return lead + " — *" + t.text + "*  (" + when + "). Just do it and make me stop.";
}

// ---------- the nag loop ----------
async function nagLoop() {
  const now = Date.now();
  let changed = false;
  for (const t of tasks) {
    if (t.done) continue;
    if (now >= t.nextNag) {
      if (inQuietHours(new Date(now))) {
        t.nextNag = nextQuietEnd(new Date(now)); // hold until quiet hours end
        changed = true;
      } else {
        const res = await sendSlack(nagText(t));
        t.nags = (t.nags || 0) + 1;
        t.lastNag = now;
        t.nextNag = now + cfg.intervalMin * 60000;
        changed = true;
        console.log(new Date().toISOString(), res.ok ? "nagged:" : "nag FAILED (" + res.error + "):", t.text);
      }
    }
  }
  if (changed) dirty = true; // flushed by the timer below to keep commit volume low
}

// ---------- HTTP helpers ----------
function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json", "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}
// Only the app page itself is ever served — never server.js, config.json, etc.
function serveStatic(res, urlPath) {
  if (urlPath === "/" || urlPath === "/index.html") {
    return fs.readFile(INDEX_FILE, (err, buf) => {
      if (err) return send(res, 404, "not found", "text/plain");
      send(res, 200, buf, "text/html; charset=utf-8");
    });
  }
  if (urlPath === "/favicon.ico") return send(res, 204, "");
  return send(res, 404, "not found", "text/plain");
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (p === "/api/state" && req.method === "GET") {
    // Never expose the webhook URL over the public endpoint — just whether one is set.
    const safeCfg = Object.assign({}, cfg, { webhook: "" });
    return send(res, 200, { tasks, cfg: safeCfg, webhookSet: !!cfg.webhook });
  }
  if (p === "/api/tasks" && req.method === "POST") {
    const body = await readBody(req);
    const lines = (body.lines || []).map(s => String(s).trim()).filter(Boolean);
    const now = Date.now();
    for (const text of lines) {
      tasks.unshift({ id: uid(), text, created: now, deadline: now + cfg.deadlineMin * 60000, nextNag: now + cfg.deadlineMin * 60000, nags: 0, done: false, doneAt: null });
    }
    await saveTasks();
    return send(res, 200, { ok: true, tasks });
  }
  let m = p.match(/^\/api\/tasks\/([^/]+)\/toggle$/);
  if (m && req.method === "POST") {
    const t = tasks.find(x => x.id === m[1]);
    if (t) { t.done = !t.done; t.doneAt = t.done ? Date.now() : null; await saveTasks(); }
    return send(res, 200, { ok: true, tasks });
  }
  m = p.match(/^\/api\/tasks\/([^/]+)$/);
  if (m && req.method === "DELETE") {
    tasks = tasks.filter(x => x.id !== m[1]); await saveTasks();
    return send(res, 200, { ok: true, tasks });
  }
  if (p === "/api/restore" && req.method === "POST") {
    // Re-seed from the browser's backup, but only if the server lost its data
    // (e.g. after a free-tier restart). Never clobber a non-empty list.
    const body = await readBody(req);
    if (Array.isArray(body.tasks) && tasks.length === 0 && body.tasks.length) {
      tasks = body.tasks.filter(t => t && t.id && t.text);
      await saveTasks();
      console.log(new Date().toISOString(), "restored", tasks.length, "tasks from browser backup");
    }
    return send(res, 200, { ok: true, tasks });
  }
  if (p === "/api/config" && req.method === "POST") {
    const body = await readBody(req);
    cfg = Object.assign({}, cfg, {
      webhook: (typeof body.webhook === "string" && body.webhook.trim()) ? body.webhook.trim() : cfg.webhook,
      deadlineMin: Math.max(1, +body.deadlineMin || cfg.deadlineMin),
      intervalMin: Math.max(1, +body.intervalMin || cfg.intervalMin),
      quietStart: body.quietStart || cfg.quietStart,
      quietEnd: body.quietEnd || cfg.quietEnd,
    });
    await saveCfg();
    return send(res, 200, { ok: true, cfg });
  }
  if (p === "/api/test" && req.method === "POST") {
    const body = await readBody(req);
    const res2 = await sendSlack("✅ Brain Dump server is wired up. This is your test nag.", body.webhook);
    return send(res, 200, res2);
  }

  if (p.startsWith("/api/")) return send(res, 404, { error: "unknown endpoint" });
  return serveStatic(res, p);
});

// Load persisted state first, then start serving and nagging.
loadState().then(() => {
  server.listen(PORT, () => {
    console.log("Brain Dump running at http://localhost:" + PORT);
    console.log("Storage:", USE_GITHUB ? "GitHub data repo " + GH_REPO + " (persistent)" : "local file " + DATA_DIR);
    if (!cfg.webhook) console.log("⚠  No Slack webhook yet — add one in Settings or via SLACK_WEBHOOK_URL.");
  });
  setInterval(() => { nagLoop().catch(e => console.error("nagLoop", e)); }, 30000);
  setInterval(() => { if (dirty) { dirty = false; persist(); } }, 30000); // flush nag-state changes
});
