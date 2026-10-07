// Owed dashboard server: serves public/, proxies Agent37 (key stays server-side), approves claims.
// Storage: Supabase when SUPABASE_URL is set; otherwise JSON files on the Agent37 instance (/workspace/owed/*.json).
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(here, ".env"))) {
  for (const line of readFileSync(join(here, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const {
  AGENT37_API_KEY, AGENT37_INSTANCE_ID, AGENT37_CRON_ID,
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  PORT = 3000,
} = process.env;
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const RUN_MODEL = process.env.RUN_MODEL || "openai/gpt-5.4";
const STORE = "/home/node/owed";

const AGENT_URL = `https://${AGENT37_INSTANCE_ID}.agent37.app`;
const HOST_URL = "https://api.agent37.com/v1";
const agentHeaders = { "X-Agent37-Key": AGENT37_API_KEY, "Content-Type": "application/json" };
const hostHeaders = { Authorization: `Bearer ${AGENT37_API_KEY}`, "Content-Type": "application/json" };
const sbHeaders = {
  apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json", Prefer: "return=representation",
};

// ---- storage helpers
async function sbGet(table, q = "") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*${q}`, { headers: sbHeaders });
  return r.ok ? r.json() : [];
}
async function instRead(path) {
  const r = await fetch(`${AGENT_URL}/v1/files/content?path=${encodeURIComponent(path)}`, { headers: agentHeaders });
  if (!r.ok) return [];
  try { return JSON.parse(await r.text()); } catch { return []; }
}
async function instExec(command) {
  const r = await fetch(`${HOST_URL}/instances/${AGENT37_INSTANCE_ID}/exec`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ command }) });
  return r.json();
}
export function buildPrompt() {
  let p = readFileSync(join(here, "agent", "prompt.md"), "utf8");
  if (!USE_SUPABASE) p += "\n\n" + readFileSync(join(here, "agent", "prompt-files.md"), "utf8");
  return p;
}

const app = express();
app.use(express.json());
app.use(express.static(join(here, "public")));

app.get("/api/config", (_req, res) => {
  res.json({ supabaseUrl: USE_SUPABASE ? SUPABASE_URL : "", supabaseAnonKey: USE_SUPABASE ? SUPABASE_ANON_KEY : "", instanceId: AGENT37_INSTANCE_ID, hasCron: !!AGENT37_CRON_ID, storage: USE_SUPABASE ? "supabase" : "instance-files" });
});

// Everything the dashboard needs in one call.
app.get("/api/data", async (_req, res) => {
  try {
    if (USE_SUPABASE) {
      const [vendors, claims, incidents, runs] = await Promise.all([sbGet("vendors"), sbGet("claims"), sbGet("incidents"), sbGet("runs", "&order=started_at.desc&limit=10")]);
      return res.json({ vendors, claims, incidents, runs });
    }
    const [vendors, claims, incidents, runs, vendor_status] = await Promise.all(["vendors", "claims", "incidents", "runs", "vendor_status"].map(n => instRead(`${STORE}/${n}.json`)));
    res.json({ vendors, claims, incidents, runs, vendor_status: Array.isArray(vendor_status) ? {} : vendor_status });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Fire this week's scan now: the standing instructions as a streamed turn on OpenAI (via Agent37's
// router), returning as soon as the session exists. RUN_VIA_CRON=1 fires the weekly cron instead.
app.post("/api/run", async (_req, res) => {
  try {
    if (AGENT37_CRON_ID && process.env.RUN_VIA_CRON === "1") {
      const r = await fetch(`${HOST_URL}/instances/${AGENT37_INSTANCE_ID}/crons/${AGENT37_CRON_ID}/run`, { method: "POST", headers: hostHeaders });
      return res.status(r.status).json(await r.json());
    }
    const r = await fetch(`${AGENT_URL}/v1/responses`, {
      method: "POST", headers: agentHeaders,
      body: JSON.stringify({ input: buildPrompt(), stream: true, model: RUN_MODEL, metadata: { job: "weekly-scan" } }),
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", created = null;
    while (!created) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/event: response\.created\ndata: (.+)\n/);
      if (m) created = JSON.parse(m[1]);
    }
    (async () => { try { while (!(await reader.read()).done) {} } catch {} })(); // keep the turn alive
    res.json({ status: "triggered", session_id: created?.session_id, response_id: created?.id, model: RUN_MODEL });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Live event stream of a running turn (re-attachable SSE passthrough) for the dashboard's activity feed.
app.get("/api/stream/:responseId", async (req, res) => {
  try {
    const r = await fetch(`${AGENT_URL}/v1/responses/${req.params.responseId}/stream`, { headers: agentHeaders });
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.flushHeaders?.();
    const reader = r.body.getReader(); const dec = new TextDecoder();
    req.on("close", () => reader.cancel().catch(() => {}));
    for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(dec.decode(value)); }
  } catch {}
  res.end();
});

// The weekly cron, straight from Agent37 (proves the schedule is real).
app.get("/api/cron", async (_req, res) => {
  try {
    if (!AGENT37_CRON_ID) return res.json({});
    const [c, r] = await Promise.all([
      fetch(`${HOST_URL}/instances/${AGENT37_INSTANCE_ID}/crons/${AGENT37_CRON_ID}`, { headers: hostHeaders }).then(x => x.json()),
      fetch(`${HOST_URL}/instances/${AGENT37_INSTANCE_ID}/crons/${AGENT37_CRON_ID}/runs`, { headers: hostHeaders }).then(x => x.json()).catch(() => ({})),
    ]);
    res.json({ id: c.id, name: c.name, schedule: c.schedule, timezone: c.timezone, enabled: c.enabled, next_run: c.next_run, last_run: c.last_run, runs: (r.data || []).slice(0, 5) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Session transcript (audit trail) proxied from the instance.
app.get("/api/session/:id", async (req, res) => {
  try {
    const r = await fetch(`${AGENT_URL}/v1/sessions/${req.params.id}`, { headers: agentHeaders });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// One-click approval. Status: found -> approved -> filed.
app.post("/api/claims/:id/:action", async (req, res) => {
  const status = { approve: "approved", file: "filed", reset: "found" }[req.params.action];
  if (!status) return res.status(400).json({ error: "bad action" });
  const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, "");
  if (USE_SUPABASE) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/claims?id=eq.${id}`, { method: "PATCH", headers: sbHeaders, body: JSON.stringify({ status }) });
    return res.status(r.status).json(await r.json());
  }
  const py = `import json;p='${STORE}/claims.json';d=json.load(open(p));[c.update(status='${status}') for c in d if c.get('id')=='${id}'];json.dump(d,open(p+'.tmp','w'),indent=1);import os;os.replace(p+'.tmp',p);print('ok')`;
  const out = await instExec(`python3 -c "${py.replace(/"/g, '\\"')}"`);
  res.json({ ok: out.exit_code === 0, out: out.stdout, err: out.stderr });
});

app.get("/healthz", (_req, res) => res.json({ ok: true, storage: USE_SUPABASE ? "supabase" : "instance-files" }));
app.listen(PORT, () => console.log(`Owed dashboard on :${PORT} (instance ${AGENT37_INSTANCE_ID}, storage ${USE_SUPABASE ? "supabase" : "instance-files"})`));
