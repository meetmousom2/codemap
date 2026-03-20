#!/usr/bin/env bash
# devd-push: passthrough to git push
set -euo pipefail
git push "$@"
