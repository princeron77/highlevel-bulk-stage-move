# Shared helpers for the demo scripts. Requires: running stack (docker compose up), curl, node.
set -euo pipefail
API=${API:-http://localhost:3000}
SMALL_WS=b0000000-0000-4000-8000-000000000001
LARGE_WS=a0000000-0000-4000-8000-000000000000

# json <expr>: read JSON from stdin, print a field, e.g.  ... | json '.jobId'
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const v=(new Function('o','return o'+process.argv[1]))(o);console.log(typeof v==='object'?JSON.stringify(v):v)})" "$1"; }

# sql "<query>": run SQL in the compose Postgres, unaligned output
sql() { docker compose exec -T postgres psql -U app -d opportunities -tAc "$1"; }

# stage <workspace> <position>: stage id
stage() { curl -s "$API/v1/stages" -H "X-Workspace-Id: $1" | json "[$2].id"; }

# submit <workspace> <idempotency-key> <body>: prints "HTTP <code> <body>"
submit() {
  curl -s -o /tmp/demo-submit.json -w '%{http_code}' -XPOST "$API/v1/bulk-moves" \
    -H "X-Workspace-Id: $1" -H "Idempotency-Key: $2" -H 'content-type: application/json' -d "$3" > /tmp/demo-code
  echo "HTTP $(cat /tmp/demo-code)  $(cat /tmp/demo-submit.json)"
}

# progress <workspace> <jobId>: one line
progress() {
  curl -s "$API/v1/bulk-moves/$2" -H "X-Workspace-Id: $1" |
    json '' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(new Date().toISOString().slice(11,19),p.status.padEnd(10),p.health.padEnd(9),String(p.processed).padStart(6)+'/'+p.total,String(p.percent).padStart(5)+'%','moved='+p.counts.moved,'conflict='+p.counts.skippedConflict,'noop='+p.counts.skippedNoop)})"
}

# fifty_k_body: a filter in the large workspace matching exactly 50,000 deals (newest of the biggest stage)
fifty_k_body() {
  local src dst from
  src=$(sql "SELECT s.id FROM stages s JOIN opportunities o ON o.stage_id=s.id WHERE s.workspace_id='$LARGE_WS' GROUP BY s.id ORDER BY count(*) DESC LIMIT 1")
  dst=$(sql "SELECT s.id FROM stages s LEFT JOIN opportunities o ON o.stage_id=s.id WHERE s.workspace_id='$LARGE_WS' GROUP BY s.id ORDER BY count(o.id) ASC LIMIT 1")
  from=$(sql "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM opportunities WHERE workspace_id='$LARGE_WS' AND stage_id='$src' ORDER BY created_at DESC OFFSET 49999 LIMIT 1")
  echo "{\"targetStageId\":\"$dst\",\"filter\":{\"stageId\":\"$src\",\"createdFrom\":\"$from\"}}"
}
