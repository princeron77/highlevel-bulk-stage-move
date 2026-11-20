#!/usr/bin/env bash
# Resumability: start a 50k job, SIGKILL both workers at ~30k, restart them, watch it finish, verify.
source "$(dirname "$0")/_lib.sh"
submit $LARGE_WS "kill-$(date +%s)" "$(fifty_k_body)"
JOB=$(cat /tmp/demo-submit.json | json '.jobId')
while :; do
  line=$(progress $LARGE_WS $JOB); echo "$line"
  [[ $(echo "$line" | awk '{print $4}' | cut -d/ -f1) -ge 30000 ]] && break; sleep 0.5
done
echo "== docker compose kill -s SIGKILL worker"; docker compose kill -s SIGKILL worker
for i in 1 2 3 4 5 6; do progress $LARGE_WS $JOB; sleep 0.5; done
echo "== docker compose start worker";           docker compose start worker
"$(dirname "$0")/02-watch.sh" $JOB $LARGE_WS
"$(dirname "$0")/06-verify.sh" $JOB
