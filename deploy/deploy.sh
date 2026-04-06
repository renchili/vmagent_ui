#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${APP_DIR:-$BASE_DIR}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.prod.yml}"

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[ERROR] env file not found: $ENV_FILE"
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[ERROR] compose file not found: $COMPOSE_FILE"
  exit 1
fi

PREV_IMAGE_TAG="$(grep '^IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2 || true)"
echo "${PREV_IMAGE_TAG:-}" > .previous_image_tag

echo "[INFO] current IMAGE_TAG=${PREV_IMAGE_TAG:-<empty>}"
echo "[INFO] pulling latest configured image..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull

echo "[INFO] starting service..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

echo "[INFO] service status:"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

echo "[INFO] recent logs:"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=50
