#!/usr/bin/env python3
"""Owed deterministic scan. Runs on the customer's Agent37 instance.
feeds -> strict classification (with reasons) -> uptime per period -> SLA tiers -> claims + templated drafts.
Numbers never come from the LLM; the agent runs this first, then only polishes the claim emails."""
import json, os, re, sys, uuid, datetime as dt, urllib.request

STORE = "/home/node/owed"
NOW = dt.datetime.now(dt.timezone.utc)
FEEDS = {
    "Twilio": "https://status.twilio.com/api/v2/incidents.json",
    "GitHub": "https://www.githubstatus.com/api/v2/incidents.json",
    "Vercel": "https://www.vercel-status.com/api/v2/incidents.json",
    "Datadog": "https://status.datadoghq.com/api/v2/incidents.json",
}

def load(n, default):
    p = f"{STORE}/{n}.json"
    try:
        return json.load(open(p)) if os.path.getsize(p) > 1 else default
    except Exception:
        return default

def save(n, d):
    p = f"{STORE}/{n}.json"
    json.dump(d, open(p + ".tmp", "w"), indent=1); os.replace(p + ".tmp", p)

def iso(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "owed/1.0"})
    return json.load(urllib.request.urlopen(req, timeout=30))

# ---- periods: last 3 full months + current month to date
def month_start(d): return d.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
def next_month(m): return (m + dt.timedelta(days=32)).replace(day=1)
months = []
m = month_start(NOW)
for _ in range(4):
    months.append(m); m = (m - dt.timedelta(days=1)).replace(day=1)
months = sorted(months)
WINDOW_START = months[0]

def period_key(v, m):
    return f"{m.year}-Q{(m.month - 1) // 3 + 1}" if v.get("period") == "quarter" else m.strftime("%Y-%m")

def period_bounds(key):
    if "-Q" in key:
        y, q = key.split("-Q"); y, q = int(y), int(q)
        s = dt.datetime(y, 3 * (q - 1) + 1, 1, tzinfo=dt.timezone.utc)
        e = dt.datetime(y + 1, 1, 1, tzinfo=dt.timezone.utc) if q == 4 else dt.datetime(y, 3 * q + 1, 1, tzinfo=dt.timezone.utc)
        return s, e
    y, mo = map(int, key.split("-"))
    s = dt.datetime(y, mo, 1, tzinfo=dt.timezone.utc)
    return s, next_month(s)

# ---- strict classification: only full outages of covered core services count
EXCLUDE = [
    (r"copilot|model provider|\bopenai\b|\banthropic\b|\bgemini\b", "third-party model/provider issue"),
    (r"carrier|\b(brazil|india|mexico|uk|germany|france|japan|australia|canada|philippines|indonesia|nigeria|south africa|spain|italy|china|korea|turkey|argentina|colombia|vietnam|pakistan|egypt)\b", "carrier/country-specific"),
    (r"degrad|latenc|delay|slow|elevated|intermittent|partial", "degraded performance, not a full outage"),
    (r"dashboard|\bcli\b|log ?in|sign[- ]?in|billing|docs|documentation|integration|marketplace|\bbuild|deploy|webhook|analytics|notification|search", "dashboard/CLI/login/build-pipeline issue, outside the SLA scope"),
    (r"maintenance", "scheduled maintenance"),
]
VERCEL_SERVING = r"edge|serv|function|routing|dns|outage|unavailab|50\d|traffic|network|cdn|domain"

def classify(v, inc):
    impact = inc.get("impact"); title = inc.get("name") or ""
    if inc.get("scheduled_for") or impact == "none":
        return False, "scheduled maintenance / informational"
    if impact == "minor":
        return False, "minor impact (degraded, not an outage)"
    for pat, reason in EXCLUDE:
        if re.search(pat, title, re.I):
            return False, reason
    if impact not in ("major", "critical"):
        return False, f"impact {impact}"
    if v["name"] == "Vercel" and not re.search(VERCEL_SERVING, title, re.I):
        return False, "not content serving (Vercel SLA covers content serving only)"
    return True, ""

def draft_email(v, key, up, down, tier, months_in, amount, incs, company):
    lines = "\n".join(f"- {i['started_at'][:10]} — {i['title']} — {i['minutes_in_period']} min — {i.get('source_url') or v['status_url']}" for i in incs)
    return (f"Subject: SLA service credit request – {v['name']} – {key}\n\n"
            f"Hello {v['name']} support,\n\n"
            f"We are requesting a service credit under the {v['name']} SLA ({v['sla_url']}) for the period {key}.\n\n"
            f"Counted incidents ({len(incs)}), per {v['status_url']}:\n{lines}\n\n"
            f"Measured availability for the period: {up:.3f}% against the {v['sla_target']}% commitment. "
            f"Under the SLA this corresponds to a {tier['credit_pct']}% service credit on fees for the period "
            f"(${v['monthly_spend']:,.0f}/month × {months_in}). We request a credit of ${amount:,.2f}, applied to our next invoice.\n\n"
            f"Claim process: {v.get('how_to_claim', '')}\nDeadline noted: {v.get('claim_deadline', '')}\n\n"
            f"Thank you,\n{company}")

def main():
    company = (load("customer", {}) or {}).get("company") or (sys.argv[sys.argv.index("--company") + 1] if "--company" in sys.argv else "Our company")
    vendors = load("vendors", [])
    old_claims = [c for c in load("claims", []) if c.get("source") == "unclaimed"]
    run = {"id": str(uuid.uuid4()), "started_at": NOW.isoformat().replace("+00:00", "Z"), "status": "running", "found_usd": 0, "log": "", "session_id": os.environ.get("OWED_SESSION_ID"), "method": "scan.py (deterministic) + agent-drafted claims"}
    incidents, claims, status, log = [], [], {}, []
    for v in vendors:
        name = v["name"]
        st = {"status": "no_data", "note": v.get("note", ""), "counted": 0, "not_counted": 0, "worst_period": None, "worst_uptime_pct": None}
        try:
            if name == "Slack":
                st["status"] = "no_public_credits"; log.append(f"{name}: no public SLA credits; check contract"); status[v["id"]] = st; continue
            if name not in FEEDS:
                st["note"] = "No public per-account incident feed; connect AWS Health API for this vendor"
                log.append(f"{name}: no public per-account feed (no_data)"); status[v["id"]] = st; continue
            data = fetch(FEEDS[name]).get("incidents", [])
            counted, not_counted = [], []
            for i in data:
                s = iso(i["created_at"])
                if s < WINDOW_START:
                    continue
                e = iso(i["resolved_at"]) if i.get("resolved_at") else NOW
                minutes = max(0, min(1440, int((e - s).total_seconds() // 60)))
                ok, reason = classify(v, i)
                rec = {"id": str(uuid.uuid4()), "vendor_id": v["id"], "title": i.get("name"), "started_at": i["created_at"], "ended_at": i.get("resolved_at"), "minutes": minutes, "impact": i.get("impact"), "source_url": i.get("shortlink")}
                if ok: counted.append(rec)
                else: not_counted.append({**rec, "reason": reason})
            incidents += counted
            st["counted"], st["not_counted"] = len(counted), len(not_counted)
            worst = None
            for key in sorted({period_key(v, m) for m in months}):
                ps, pe = period_bounds(key)
                mins_period = int((pe - ps).total_seconds() // 60)
                down, incs = 0, []
                for c in counted:
                    s = iso(c["started_at"]); e = iso(c["ended_at"]) if c["ended_at"] else NOW
                    cs, ce = max(s, ps), min(e, pe)
                    if ce > cs:
                        d = min(1440, int((ce - cs).total_seconds() // 60)); down += d; incs.append({**c, "minutes_in_period": d})
                up = 100 * (1 - down / mins_period)
                if worst is None or up < worst[1]: worst = (key, up)
                if not v.get("claimable") or v.get("sla_target") is None or up >= v["sla_target"]:
                    continue
                tier = None
                for t in v["sla_tiers"]:
                    if up < t["below"]: tier = t
                if not tier:
                    continue
                months_in = 3 if "-Q" in key else 1
                amount = round(v["monthly_spend"] * months_in * tier["credit_pct"] / 100, 2)
                nc = [n for n in not_counted if ps <= iso(n["started_at"]) < pe]
                claims.append({"id": str(uuid.uuid4()), "source": "sla", "vendor_id": v["id"], "period": key, "amount_usd": amount,
                    "citation_url": v["sla_url"], "status": "found", "created_at": run["started_at"],
                    "draft": draft_email(v, key, up, down, tier, months_in, amount, incs, company),
                    "evidence": {"uptime_pct": round(up, 5), "sla_target": v["sla_target"], "period_minutes": mins_period, "downtime_minutes": down,
                                 "credit_pct": tier["credit_pct"], "monthly_spend": v["monthly_spend"], "tier": tier, "terms_verified": v.get("terms_verified", False),
                                 "provisional": pe > NOW, "covered": v.get("covered", ""), "claim_deadline": v.get("claim_deadline", ""), "how_to_claim": v.get("how_to_claim", ""),
                                 "incidents": [{k: i[k] for k in ("title", "started_at", "ended_at", "minutes_in_period", "impact", "source_url")} | {"minutes": i["minutes_in_period"]} for i in incs],
                                 "not_counted": [{k: n[k] for k in ("title", "started_at", "minutes", "reason")} for n in nc]}})
            st["worst_period"], st["worst_uptime_pct"] = worst[0], round(worst[1], 5)
            mine = [c for c in claims if c["vendor_id"] == v["id"]]
            if mine: st["status"] = "claim"
            elif v.get("claimable"): st["status"] = "within_sla"
            else: st["status"] = "sla_missed_no_credit" if (v.get("sla_target") and worst[1] < v["sla_target"]) else "within_sla"
            owed = sum(c["amount_usd"] for c in mine)
            log.append(f"{name}: {len(counted)} counted, {len(not_counted)} listed but not counted, worst {worst[0]} {worst[1]:.3f}%, " + (f"{len(mine)} claim(s) ${owed:,.2f}" if mine else ("SLA missed, no credit (" + v.get("note", "") + ")" if st["status"] == "sla_missed_no_credit" else "within SLA, no claim")))
        except Exception as ex:
            st["status"] = "no_data"; st["note"] = f"fetch failed: {ex}"; log.append(f"{name}: fetch failed: {ex}")
        status[v["id"]] = st
    run.update(status="completed", finished_at=dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"), found_usd=round(sum(c["amount_usd"] for c in claims), 2), log="\n".join(log))
    save("incidents", incidents); save("claims", old_claims + claims); save("vendor_status", status)
    runs = load("runs", []); runs.append(run); save("runs", runs)
    print(json.dumps({"found_usd": run["found_usd"], "claims": len(claims), "incidents": len(incidents)}))
    print(run["log"])

if __name__ == "__main__":
    main()
