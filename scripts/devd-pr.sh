#!/usr/bin/env bash
# devd-pr: passthrough to gh pr create
set -euo pipefail
gh pr create "$@"
