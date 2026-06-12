#!/usr/bin/env bash
set -euo pipefail

APP_ROLE="${APP_ROLE:-web}"
export APP_ROLE

exec node server/index.js
