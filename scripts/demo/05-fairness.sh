#!/usr/bin/env bash
# Isolation: a 50k job in the large workspace does not block a small job in another workspace.
source "$(dirname "$0")/_lib.sh"
submit $LARGE_WS "big-$(date +%s)" "$(fifty_k_body)"; BIG=$(cat /tmp/demo-submit.json | json '.jobId')
sleep 2
submit $SMALL_WS "small-$(date +%s)" "{\"targetStageId\":\"$(stage $SMALL_WS 11)\",\"filter\":{\"stageId\":\"$(stage $SMALL_WS 4)\"}}"
SMALL=$(cat /tmp/demo-submit.json | json '.jobId')
for i in $(seq 1 8); do
  echo "big:   $(progress $LARGE_WS $BIG)"; echo "small: $(progress $SMALL_WS $SMALL)"; echo; sleep 0.7
done
