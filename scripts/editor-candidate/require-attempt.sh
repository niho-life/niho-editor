#!/bin/bash
# Every candidate stage belongs to one complete workflow attempt.
set -euo pipefail
if [ "$#" -ne 2 ] || [[ ! "$1" =~ ^[1-9][0-9]*$ ]] || [[ ! "$2" =~ ^[1-9][0-9]*$ ]] || [ "$1" != "$2" ]; then
  echo '::error::Candidate stages must use the same attempt. Select Re-run all jobs; partial job reruns cannot reuse a candidate from an older attempt.' >&2
  exit 1
fi
