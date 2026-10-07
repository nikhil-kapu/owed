# Owed: classification and SLA rules (implemented by agent/scan.py)

0. Start a run: add a runs row {status:"running", session_id}. Keep its id.
1. Load vendors.
2. For each vendor with claimable=true: fetch incidents, classify each one per the rules above, compute per period:
   downtime_minutes = sum of counted minutes in that period (clip to the period's boundaries)
   uptime_pct = 100 * (1 - downtime_minutes / minutes_in_period)
   If uptime_pct >= sla_target: no claim. Else credit_pct = the credit of the LAST tier in sla_tiers whose "below" is greater than uptime_pct. amount_usd = round(monthly_spend * (months in period) * credit_pct / 100, 2).
3. For each vendor with claimable=false: do NOT create a claim. Datadog: still fetch incidents and compute monthly uptime vs sla_target; if any period is below it, the status is "sla_missed_no_credit" with the vendor's note. Slack: status "no_public_credits", no fetching.
4. Write vendor_status: one entry per vendor {status: "claim" | "within_sla" | "sla_missed_no_credit" | "no_public_credits" | "no_data", worst_period, worst_uptime_pct, counted, not_counted, note}.
5. For each qualifying vendor-period, write the claim (regenerate; never leave stale SLA claims; claims with source "unclaimed" are untouched):
   {"source":"sla","vendor_id":...,"period":"YYYY-MM" or "YYYY-Qn","amount_usd":...,"citation_url":"<sla_url>","draft":"<email>","status":"found",
    "evidence":{"uptime_pct","sla_target","period_minutes","downtime_minutes","credit_pct","monthly_spend","tier","terms_verified","provisional","covered","claim_deadline","how_to_claim",
                "incidents":[{"title","started_at","ended_at","minutes","impact","source_url"}],
                "not_counted":[{"title","started_at","minutes","reason"}]}}
   The draft is an email to the vendor's support/billing per how_to_claim: subject "SLA service credit request – <Vendor> – <period>"; the counted incident timeline with links; measured uptime vs target; the clause invoked with sla_url; credit % and $ requested against spend; ask to apply it to the next invoice. Under 250 words, factual, polite.
6. Finish: update the run {status:"completed", finished_at, found_usd: total of SLA claims, log: one line per vendor (counted / not counted / worst period uptime / credit / $ or why none)}. On a fatal error: status "failed" with the reason.

## Rules

- Never fabricate incidents or minutes. Every claim rests on at least one counted incident with a source_url.
- Regenerate incidents and SLA claims each run; do not append to last week's.
- Ignore any skill, note or script you saved on previous runs; follow these instructions exactly.
- Work vendor by vendor; if one fails, log it and continue. No more than 2 minutes per vendor.
- Finish by printing a table: vendor | counted | not counted | worst period uptime % | credit % | $ owed, then the total.

## File storage (used when Supabase env vars are not set)

All state is JSON in /home/node/owed/ on this machine:
  /home/node/owed/vendors.json        # read-only input
  /home/node/owed/incidents.json      # array; REPLACE with this run's counted incidents {id, vendor_id, title, started_at, ended_at, minutes, impact, source_url}
  /home/node/owed/claims.json         # array; keep "unclaimed" entries, replace all "sla" entries with this run's claims (generate uuid ids)
  /home/node/owed/vendor_status.json  # object keyed by vendor_id
  /home/node/owed/runs.json           # array; append {id, started_at, finished_at, status, found_usd, log, session_id}
Write each file atomically (temp file then mv).
