#!/usr/bin/env bash
# Billy — first-time setup. Creates .env from .env.example, generates strong
# secrets, and prompts for the initial SYSADMIN credentials (the account manager
# created on first boot). Safe to re-run: it never overwrites an existing .env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
EXAMPLE="$ROOT/.env.example"

if [[ -f "$ENV_FILE" ]]; then
  echo "✓ .env already exists — leaving it untouched."
  echo "  (Edit it by hand, or delete it and re-run this script to regenerate.)"
  exit 0
fi

[[ -f "$EXAMPLE" ]] || { echo "✗ .env.example not found at $EXAMPLE"; exit 1; }

echo "Billy setup — creating .env"
echo

# ── Prompt for the initial sysadmin ──────────────────────────────────────────
read -r -p "Sysadmin email: " SYSADMIN_EMAIL
while [[ -z "${SYSADMIN_EMAIL// }" ]]; do read -r -p "Sysadmin email (required): " SYSADMIN_EMAIL; done

read -r -s -p "Sysadmin password (min 8 chars): " SYSADMIN_PASSWORD; echo
while [[ ${#SYSADMIN_PASSWORD} -lt 8 ]]; do
  read -r -s -p "Password too short (min 8) — try again: " SYSADMIN_PASSWORD; echo
done

read -r -p "Public hostname (e.g. billy.example.com) [localhost]: " PUBLIC_HOST
PUBLIC_HOST="${PUBLIC_HOST:-localhost}"

# ── Secret generator (openssl) ───────────────────────────────────────────────
gen() { openssl rand -base64 "${1:-32}" | tr -d '\n'; }
gen_alnum() { openssl rand -base64 "${1:-24}" | tr -d '/+=\n'; }

SESSION_SECRET="$(gen 48)"
JWT_SECRET="$(gen 48)"
DATA_ENCRYPTION_KEY="$(gen 32)"
REDIS_PASSWORD="$(gen_alnum 24)"
MINIO_PASSWORD="$(gen_alnum 24)"
BACKUP_ENCRYPTION_KEY="$(gen 32)"

# ── Write .env from the example, substituting the generated/prompted values ──
cp "$EXAMPLE" "$ENV_FILE"
# Portable in-place sed (BSD + GNU): write to a temp then move.
set_kv() {
  local key="$1" val="$2"
  # Escape & and / and \ for sed replacement.
  local esc; esc="$(printf '%s' "$val" | sed -e 's/[&/\\]/\\&/g')"
  sed "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
}

set_kv APP_ENV "production"
set_kv APP_URL "https://${PUBLIC_HOST}"
set_kv API_URL "https://${PUBLIC_HOST}/api"
set_kv PUBLIC_HOST "$PUBLIC_HOST"
set_kv SESSION_SECRET "$SESSION_SECRET"
set_kv JWT_SECRET "$JWT_SECRET"
set_kv DATA_ENCRYPTION_KEY "$DATA_ENCRYPTION_KEY"
set_kv REDIS_PASSWORD "$REDIS_PASSWORD"
set_kv MINIO_ROOT_PASSWORD "$MINIO_PASSWORD"
set_kv MINIO_SECRET_KEY "$MINIO_PASSWORD"
set_kv BACKUP_ENCRYPTION_KEY "$BACKUP_ENCRYPTION_KEY"
set_kv BOOTSTRAP_ADMIN_EMAIL "$SYSADMIN_EMAIL"
set_kv BOOTSTRAP_ADMIN_PASSWORD "$SYSADMIN_PASSWORD"

chmod 600 "$ENV_FILE"
echo
echo "✓ .env created with generated secrets + your sysadmin credentials."
echo "  The sysadmin ($SYSADMIN_EMAIL) is created automatically on first boot."
echo "  Next: pnpm install && pnpm build && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d"
echo "  ⚠  Back up DATA_ENCRYPTION_KEY separately — losing it makes encrypted fields unrecoverable."
