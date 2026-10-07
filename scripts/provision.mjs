// Onboard a new customer: one Agent37 instance, seeded vendors, Monid CLI, weekly cron.
// Usage: node scripts/provision.mjs --name acme [--spend '{"GitHub":5000,...}']
// This is exactly what signup does: POST /instances -> exec (seed) -> POST /crons.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith("--") ? [a.slice(2), arr[i + 1]] : []).filter(Boolean));
const name = args.name || "customer";
const spend = args.spend ? JSON.parse(args.spend) : null;

const H = { Authorization: `Bearer ${process.env.AGENT37_API_KEY}`, "Content-Type": "application/json" };
const api = async (path, body, method = "POST") => {
  const r = await fetch(`https://api.agent37.com/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};

// 1. The customer's own computer, with a spend cap.
const inst = await api("/instances", { template: "agent37-hermes", name: `owed-${name}`, budget: { credit_micros: 2_000_000, monthly_cap_micros: 10_000_000 } });
console.log("instance", inst.id, inst.url, inst.status);

// 2. Seed its vendor list (SLA terms from sla_terms.json via agent/vendors.json) and install the Monid CLI.
const vendors = JSON.parse(readFileSync(join(root, "agent", "vendors.json"), "utf8")).map(v => spend?.[v.name] ? { ...v, monthly_spend: spend[v.name] } : v);
const seed = `mkdir -p /home/node/owed && cd /home/node/owed && cat > vendors.json <<'JSON'\n${JSON.stringify(vendors)}\nJSON\nfor f in incidents claims runs; do [ -f $f.json ] || echo '[]' > $f.json; done; echo '{}' > vendor_status.json; ls`;
console.log("seed:", (await api(`/instances/${inst.id}/exec`, { command: seed })).stdout.trim().replace(/\n/g, " "));
if (process.env.MONID_API_KEY) {
  const r = await api(`/instances/${inst.id}/exec`, { command: `npm i -g @monid-ai/cli >/dev/null 2>&1; export PATH=/home/node/.npm-global/bin:$PATH; monid keys add --label main --key ${process.env.MONID_API_KEY} >/dev/null 2>&1; monid keys activate --label main 2>&1 | tail -1`, user: "root" });
  console.log("monid:", r.stdout.trim());
}

// 3. The job it owns from now on: every Monday 9am, the standing instructions.
const cron = await api(`/instances/${inst.id}/crons`, {
  name: "Owed weekly recovery scan", prompt: readFileSync(join(root, "agent", "prompt.md"), "utf8"),
  schedule: "0 9 * * 1", timezone: "America/Los_Angeles",
});
console.log("cron", cron.id, cron.schedule, "next", new Date(cron.next_run * 1000).toISOString());
console.log(`\nAGENT37_INSTANCE_ID=${inst.id}\nAGENT37_CRON_ID=${cron.id}`);
