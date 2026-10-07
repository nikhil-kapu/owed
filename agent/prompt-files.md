FALLBACK STORAGE MODE (no Supabase). Everything below is identical to the main instructions except where data is written.

Instead of Supabase, keep all state as JSON files in /home/node/owed/ on this machine:
  /home/node/owed/vendors.json    # array of vendors (read; it is pre-seeded)
  /home/node/owed/incidents.json  # array; append counted incidents {id, vendor_id, title, started_at, ended_at, minutes, source_url}
  /home/node/owed/claims.json     # array; one object per vendor-month claim (same fields as the claims table; generate a uuid-like id; status 'found')
  /home/node/owed/runs.json       # array; append {id, started_at, finished_at, status, found_usd, log, session_id}
Read a file, modify the array in memory, write it back atomically (write to a temp file and mv). Never drop existing entries. Dedupe claims by vendor_id + period + source (update in place).
