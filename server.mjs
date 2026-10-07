// Owed server: landing + per-customer dashboards. Each customer = one Agent37 instance + one weekly cron.
// Storage: JSON files on each customer's Agent37 instance (/home/node/owed/*.json); the customer registry
// and waitlist live on the primary (demo) instance. Keys never leave this server.
import express from "express";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(here, ".env"))) {
  for (const line of readFileSync(join(here, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const { AGENT37_API_KEY, AGENT37_INSTANCE_ID, AGENT37_CRON_ID, MONID_API_KEY, PORT = 3000 } = process.env;
const RUN_MODEL = process.env.RUN_MODEL || "openai/gpt-5.4";
const STORE = "/home/node/owed";
const HOST_URL = "https://api.agent37.com/v1";
const agentUrl = (id) => `https://${id}.agent37.app`;
const agentHeaders = { "X-Agent37-Key": AGENT37_API_KEY, "Content-Type": "application/json" };
const hostHeaders = { Authorization: `Bearer ${AGENT37_API_KEY}`, "Content-Type": "application/json" };
const prompt = () => readFileSync(join(here, "agent", "prompt.md"), "utf8");

// ---- Agent37 helpers
async function hostApi(path, body, method = "POST") {
  const r = await fetch(`${HOST_URL}${path}`, { method, headers: hostHeaders, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function instRead(id, path) {
  const r = await fetch(`${agentUrl(id)}/v1/files/content?path=${encodeURIComponent(path)}`, { headers: agentHeaders });
  if (!r.ok) return null;
  try { return JSON.parse(await r.text()); } catch { return null; }
}
async function instExec(id, command, user) {
  return hostApi(`/instances/${id}/exec`, user ? { command, user } : { command });
}
const pyWrite = (file, pyBody) => `python3 - <<'PY'\nimport json,os\np='${STORE}/${file}'\n${pyBody}\njson.dump(d,open(p+'.tmp','w'),indent=1); os.replace(p+'.tmp',p); print(len(d))\nPY`;

// ---- customers (registry on the primary instance)
let customers = null;
async function loadCustomers() {
  const c = await instRead(AGENT37_INSTANCE_ID, `${STORE}/customers.json`);
  customers = c && !Array.isArray(c) ? c : {};
  customers.demo ||= { slug: "demo", company: "Kafka Labs", instance_id: AGENT37_INSTANCE_ID, cron_id: AGENT37_CRON_ID, created_at: "2026-10-07T22:12:00Z" };
  return customers;
}
async function cust(req) {
  if (!customers) await loadCustomers();
  const slug = String(req.query.c || "demo").replace(/[^a-z0-9-]/g, "");
  const c = customers[slug];
  if (!c) { const e = new Error("unknown customer"); e.status = 404; throw e; }
  return c;
}

// ---- run a scan: the standing instructions as a streamed turn; return once the session exists
async function startRun(c) {
  const r = await fetch(`${agentUrl(c.instance_id)}/v1/responses`, {
    method: "POST", headers: agentHeaders,
    body: JSON.stringify({ input: prompt(), stream: true, model: RUN_MODEL, metadata: { job: "weekly-scan", customer: c.slug } }),
  });
  if (!r.ok) throw new Error(`run -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = "", created = null;
  while (!created) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/event: response\.created\ndata: (.+)\n/);
    if (m) created = JSON.parse(m[1]);
  }
  (async () => { try { while (!(await reader.read()).done) {} } catch {} })(); // keep the turn alive
  return { status: "triggered", session_id: created?.session_id, response_id: created?.id, model: RUN_MODEL };
}

const app = express();
app.use(express.json());
app.use(express.static(join(here, "public")));
const wrap = (fn) => (req, res) => fn(req, res).catch(e => res.status(e.status || 500).json({ error: String(e.message || e) }));

app.get("/api/config", wrap(async (req, res) => {
  const c = await cust(req);
  res.json({ slug: c.slug, company: c.company, instanceId: c.instance_id, hasCron: !!c.cron_id, storage: "instance-files", customers: Object.values(customers).filter(x => !x.hidden).length });
}));

app.get("/api/data", wrap(async (req, res) => {
  const c = await cust(req);
  const [vendors, claims, incidents, runs, vendor_status] = await Promise.all(["vendors", "claims", "incidents", "runs", "vendor_status"].map(n => instRead(c.instance_id, `${STORE}/${n}.json`)));
  res.json({ vendors: vendors || [], claims: claims || [], incidents: incidents || [], runs: runs || [], vendor_status: vendor_status && !Array.isArray(vendor_status) ? vendor_status : {} });
}));

app.post("/api/run", wrap(async (req, res) => res.json(await startRun(await cust(req)))));

app.get("/api/stream/:responseId", wrap(async (req, res) => {
  const c = await cust(req);
  const r = await fetch(`${agentUrl(c.instance_id)}/v1/responses/${req.params.responseId}/stream`, { headers: agentHeaders });
  res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.flushHeaders?.();
  const reader = r.body.getReader(); const dec = new TextDecoder();
  req.on("close", () => reader.cancel().catch(() => {}));
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(dec.decode(value)); } } catch {}
  res.end();
}));

app.get("/api/cron", wrap(async (req, res) => {
  const c = await cust(req);
  if (!c.cron_id) return res.json({});
  const [k, r] = await Promise.all([
    hostApi(`/instances/${c.instance_id}/crons/${c.cron_id}`, null, "GET"),
    hostApi(`/instances/${c.instance_id}/crons/${c.cron_id}/runs`, null, "GET").catch(() => ({})),
  ]);
  res.json({ id: k.id, name: k.name, schedule: k.schedule, timezone: k.timezone, enabled: k.enabled, next_run: k.next_run, last_run: k.last_run, runs: (r.data || []).slice(0, 5) });
}));

app.get("/api/session/:id", wrap(async (req, res) => {
  const c = await cust(req);
  const r = await fetch(`${agentUrl(c.instance_id)}/v1/sessions/${req.params.id}`, { headers: agentHeaders });
  res.status(r.status).json(await r.json());
}));

// One-click approval. found -> approved -> filed.
app.post("/api/claims/:id/:action", wrap(async (req, res) => {
  const c = await cust(req);
  const status = { approve: "approved", file: "filed", reset: "found" }[req.params.action];
  if (!status) return res.status(400).json({ error: "bad action" });
  const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, "");
  const out = await instExec(c.instance_id, pyWrite("claims.json", `d=json.load(open(p))\n[x.update(status='${status}') for x in d if x.get('id')=='${id}']`));
  res.json({ ok: out.exit_code === 0, status });
}));

// Sign up: company + email -> their own Agent37 instance, vendors, Monid, weekly cron, first scan.
app.post("/api/signup", wrap(async (req, res) => {
  const company = String(req.body.company || "").trim().slice(0, 80);
  const email = String(req.body.email || "").trim().slice(0, 120);
  if (!company || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Company and a valid work email are required." });
  if (!customers) await loadCustomers();
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) + "-" + randomBytes(2).toString("hex");

  // 1. The customer's own computer, with a spend cap.
  const inst = await hostApi("/instances", { template: "agent37-hermes", name: `owed-${slug}`, budget: { credit_micros: 2_000_000, monthly_cap_micros: 10_000_000 } });
  // 2. Seed the vendor list (SLA terms from sla_terms.json) and empty stores; Monid CLI installs in the background.
  const vendors = readFileSync(join(here, "agent", "vendors.json"), "utf8");
  const scan = readFileSync(join(here, "agent", "scan.py"), "utf8");
  await instExec(inst.id, `mkdir -p ${STORE} && cd ${STORE} && cat > vendors.json <<'JSON'\n${vendors}\nJSON\ncat > scan.py <<'PYEOF'\n${scan}\nPYEOF\ncat > customer.json <<'JSON'\n${JSON.stringify({ company, email })}\nJSON\nfor f in incidents claims runs; do echo '[]' > $f.json; done; echo '{}' > vendor_status.json; echo seeded`);
  if (MONID_API_KEY) instExec(inst.id, `nohup sh -c 'npm i -g @monid-ai/cli && export PATH=/home/node/.npm-global/bin:$PATH && monid keys add --label main --key ${MONID_API_KEY} && monid keys activate --label main' >/tmp/monid.log 2>&1 &`).catch(() => {});
  // 3. The job it owns from now on.
  const cron = await hostApi(`/instances/${inst.id}/crons`, { name: "Owed weekly recovery scan", prompt: prompt(), schedule: "0 9 * * 1", timezone: "America/Los_Angeles" });
  // 4. Register, then kick off the first scan.
  const c = { slug, company, email, instance_id: inst.id, cron_id: cron.id, created_at: new Date().toISOString() };
  customers[slug] = c;
  await instExec(AGENT37_INSTANCE_ID, pyWrite("customers.json", `d=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p)>2 else {}\nd[${JSON.stringify(slug)}]=json.loads(${JSON.stringify(JSON.stringify(c))})`));
  let run = {}; try { run = await startRun(c); } catch (e) { run = { run_error: String(e.message || e) }; }
  res.json({ slug, company, instance_id: inst.id, instance_url: inst.url, cron_id: cron.id, ...run });
}));

app.post("/api/waitlist", wrap(async (req, res) => {
  const email = String(req.body.email || "").trim().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  const entry = { email, company: String(req.body.company || "").slice(0, 80), created_at: new Date().toISOString() };
  const out = await instExec(AGENT37_INSTANCE_ID, pyWrite("waitlist.json", `d=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p)>2 else []\nd.append(json.loads(${JSON.stringify(JSON.stringify(entry))}))`));
  res.json({ ok: out.exit_code === 0, position: parseInt(out.stdout) || null });
}));

app.get("/api/customers", wrap(async (_req, res) => {
  if (!customers) await loadCustomers();
  const visible = Object.values(customers).filter(c => !c.hidden);
  res.json({ count: visible.length, customers: visible.map(({ slug, company, instance_id, created_at }) => ({ slug, company, instance_id, created_at })) });
}));

app.get("/healthz", (_req, res) => res.json({ ok: true, storage: "instance-files" }));
app.listen(PORT, () => console.log(`Owed on :${PORT} (primary instance ${AGENT37_INSTANCE_ID})`));
