# Owed — the agent that finds money your company is owed

Every SaaS contract promises service credits when the vendor misses its uptime SLA. Almost nobody claims them. **Owed** is an agent that runs every week on its own [Agent37](https://www.agent37.com) instance, pulls each vendor's incident history, checks it against that vendor's SLA, computes the credit, and drafts the claim with the incident timeline and the cited SLA clause. A human approves with one click. It also searches state unclaimed-property records for money held in the company's name.

Built at the "Build an Agent" hackathon (SF Tech Week, Oct 7, 2026).

## How it works

- **Agent37** — each customer gets an isolated agent instance. A weekly Agent37 cron runs the scan; "Run scan now" fires the same standing instructions on demand. The session transcript is the audit trail.
- **OpenAI** — `openai/gpt-5.4` (via Agent37's model router) reads incident feeds, matches them to SLA tiers, computes credits and writes the claim drafts.
- **Monid** — scraping tools (context.dev, surf) for pages that block plain fetches, e.g. SLA documents and status histories.
- **Supabase** — optional storage + realtime; when not configured, state lives as JSON on the instance (`/home/node/owed/*.json`).
- **InstaCloud** — hosts the dashboard.

## Run it

```bash
cp .env.example .env     # AGENT37_API_KEY, AGENT37_INSTANCE_ID, AGENT37_CRON_ID (+ Supabase, optional)
npm install
node server.mjs          # http://localhost:3000
```

`agent/prompt.md` is the agent's standing instructions (the cron prompt). `supabase/` has the schema and seed for Supabase mode.
