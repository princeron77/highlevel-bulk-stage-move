#!/usr/bin/env bash
# Watch a job's progress until it finishes:  02-watch.sh <jobId> [workspace]
source "$(dirname "$0")/_lib.sh"
JOB=$1; WS=${2:-$LARGE_WS}
while :; do
  line=$(progress $WS $JOB); echo "$line"
  [[ $line == *completed* || $line == *failed* ]] && break
  sleep 0.5
done
