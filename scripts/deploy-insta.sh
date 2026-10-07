#!/usr/bin/env bash
# One-shot InstaCloud deploy for the Owed dashboard. Requires `npx insta login` done once.
# Usage (from src/): bash scripts/deploy-insta.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
I="npx -y insta@latest"

if ! $I status 2>/dev/null | grep -q "project:.*[a-z0-9]" || $I status 2>/dev/null | grep -q "project: *(none"; then
  echo "== creating + linking project 'owed'"
  $I project create owed --json 2>/dev/null | tee /tmp/insta-project.json || true
  PID=$(python3 -c 'import json;d=json.load(open("/tmp/insta-project.json"));print(d.get("id") or d.get("project",{}).get("id",""))' 2>/dev/null || true)
  [ -n "${PID:-}" ] && $I project link "$PID" || true
fi
$I status

echo "== compute service 'app'"
$I services add compute app 2>&1 | tail -3 || true

echo "== secrets"
for k in AGENT37_API_KEY AGENT37_INSTANCE_ID AGENT37_CRON_ID; do
  printf '%s' "${!k}" | $I secrets set "$k" >/dev/null && echo "  set $k"
done
printf '%s' "${RUN_MODEL:-openai/gpt-5.4}" | $I secrets set RUN_MODEL >/dev/null && echo "  set RUN_MODEL"
if [ -n "${SUPABASE_URL:-}" ]; then
  for k in SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do printf '%s' "${!k}" | $I secrets set "$k" >/dev/null && echo "  set $k"; done
fi

echo "== deploy"
$I deploy . --port 3000 --json 2>/tmp/insta-build.log | tee /tmp/insta-deploy.json
echo
echo "== URL"
python3 - <<'EOF'
import json
d=json.load(open("/tmp/insta-deploy.json"))
def find(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k in ("url","publicUrl","public_url") and isinstance(v,str): print(v); return True
            if find(v): return True
    if isinstance(o,list):
        for x in o:
            if find(x): return True
    return False
find(d) or print(json.dumps(d)[:600])
EOF
