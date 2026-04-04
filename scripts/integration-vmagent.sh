#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="$ROOT/runtime/vmagent"
CONFIG_FILE="$RUNTIME_DIR/config.yml"
COMPOSE_FILE="$ROOT/docker-compose.vmagent.yml"
BASE_URL="${BASE_URL:-http://127.0.0.1:3099}"

mkdir -p "$RUNTIME_DIR"
cp "$ROOT/config/sample-vmagent.yml" "$CONFIG_FILE"

docker compose -f "$COMPOSE_FILE" up -d --build
cleanup() {
  docker compose -f "$COMPOSE_FILE" down -v || true
}
trap cleanup EXIT

for _ in $(seq 1 90); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS "$BASE_URL/api/health" > "$ROOT/runtime/vmagent/health.json"; then
  echo "vmagent-ui failed to become ready; dumping compose state" >&2
  docker compose -f "$COMPOSE_FILE" ps >&2 || true
  docker compose -f "$COMPOSE_FILE" logs vmagent-ui >&2 || true
  exit 1
fi

curl -fsS -X POST "$BASE_URL/api/validate" \
  -H 'content-type: application/json' \
  --data-binary @- <<'JSON' > "$ROOT/runtime/vmagent/validate.json"
{
  "mode":"advanced",
  "yaml":"global:\n  scrape_interval: 15s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: integration_demo\n    static_configs:\n      - targets:\n          - 127.0.0.1:9100\n        labels:\n          env: integration\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n",
  "runtimeProfile":{
    "deployment":{"target":"docker"},
    "remoteWrite":{"tmpDataPath":"/var/lib/vmagent-remotewrite-data"},
    "governance":{"ruleBundle":{"enabled":true,"enforcementMode":"warn","rules":{"labelNaming":{"enabled":true,"pattern":"^[a-z_][a-z0-9_]*$"},"metricNaming":{"enabled":true,"pattern":"^[a-z_:][a-z0-9_:]*$"},"suspiciousChanges":{"enabled":true,"additionsThreshold":5}}}}
  },
  "author":"integration-test",
  "note":"integration validate"
}
JSON

curl -fsS -X POST "$BASE_URL/api/publish" \
  -H 'content-type: application/json' \
  --data-binary @- <<'JSON' > "$ROOT/runtime/vmagent/publish.json"
{
  "mode":"advanced",
  "yaml":"global:\n  scrape_interval: 30s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: integration_publish\n    static_configs:\n      - targets:\n          - 127.0.0.1:9100\n        labels:\n          env: integration\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n",
  "runtimeProfile":{
    "deployment":{"target":"docker"},
    "remoteWrite":{"tmpDataPath":"/var/lib/vmagent-remotewrite-data"},
    "governance":{"ruleBundle":{"enabled":true,"enforcementMode":"warn","rules":{"labelNaming":{"enabled":true,"pattern":"^[a-z_][a-z0-9_]*$"},"metricNaming":{"enabled":true,"pattern":"^[a-z_:][a-z0-9_:]*$"},"suspiciousChanges":{"enabled":true,"additionsThreshold":5}}}}
  },
  "author":"integration-test",
  "note":"integration publish"
}
JSON

curl -fsS http://127.0.0.1:8429/-/ready >/dev/null

grep -q 'integration_publish' "$CONFIG_FILE"
echo "integration vmagent test passed"
