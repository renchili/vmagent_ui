#!/usr/bin/env bash
set -euo pipefail

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3099}"
export MYSQL_DSN="${MYSQL_DSN:-root:root@tcp(127.0.0.1:3306)/vmagent_ui?parseTime=true&multiStatements=true}"
export STATIC_DIR="${STATIC_DIR:-public}"
export DEFAULT_CONFIG_PATH="${DEFAULT_CONFIG_PATH:-config/sample-vmagent.yml}"
export DEFAULT_AUTHOR="${DEFAULT_AUTHOR:-web-ui}"
export VMAGENT_CONFIG_PATH="${VMAGENT_CONFIG_PATH:-/etc/vmagent/config.yml}"

exec go run ./cmd/server
