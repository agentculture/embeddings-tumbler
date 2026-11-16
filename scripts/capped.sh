#!/usr/bin/env bash
# Run a test, node or browser command under a hard memory cap and a time limit.
# Usage: scripts/capped.sh <seconds> <command> [args...]
# A command that is killed, times out or hangs is not run again until its cause is known.
set -euo pipefail
seconds="$1"
shift
exec systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 timeout "$seconds" "$@"
