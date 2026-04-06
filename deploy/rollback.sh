#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${APP_DIR:-$BASE_DIR}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.prod.yml}"
PREV_TAG_FILE="${PREV_TAG_FILE:-$APP_DIR/.previous_image_tag}"

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[ERROR] env file not found: $ENV_FILE"
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[ERROR] compose file not found: $COMPOSE_FILE"
  exit 1
fi

if [[ ! -f "$PREV_TAG_FILE" ]]; then
  echo "[ERROR] previous image tag file not found: $PREV_TAG_FILE"
  exit 1
fi

ROLLBACK_TAG="$(cat "$PREV_TAG_FILE")"

if [[ -z "$ROLLBACK_TAG" ]]; then
  echo "[ERROR] rollback tag is empty"
  exit 1
fi

echo "[INFO] rolling back to IMAGE_TAG=$ROLLBACK_TAG"

if grep -q '^IMAGE_TAG=' "$ENV_FILE"; then
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${ROLLBACK_TAG}/" "$ENV_FILE"
else
  echo "IMAGE_TAG=${ROLLBACK_TAG}" >> "$ENV_FILE"
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

echo "[INFO] rollback completed"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
