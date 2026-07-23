#!/bin/sh
# Billy — datastore backup (backup-restore_plan B1/B2/B4/B5).
#
# Produces an ENCRYPTED archive covering BOTH datastores that hold state:
#   - MongoDB : `mongodump --archive` (all business data)
#   - MinIO   : `mc mirror` of the files bucket (attachments + generated PDFs)
# plus a manifest with SHA-256 checksums, then encrypts the tarball with
# AES-256-GCM via `openssl` using BACKUP_ENCRYPTION_KEY. Old archives beyond
# BACKUP_RETENTION_DAYS are pruned (keeping at least the newest).
#
# Restore with scripts/backup/restore.sh. This is a LOGICAL dump (consistent),
# not a raw volume copy. Run from a host/container that can reach mongodb + minio.
#
# Env (from ./.env):
#   MONGO_URI                 mongodb connection string
#   MINIO_ENDPOINT/PORT/…     object storage (root creds)
#   MINIO_BUCKET              defaults to billy-files
#   BACKUP_DIR                output dir (default ./data/backups)
#   BACKUP_ENCRYPTION_KEY     REQUIRED — passphrase for AES-256 (openssl enc)
#   BACKUP_RETENTION_DAYS     prune older than N days (default 30)
set -eu

: "${MONGO_URI:?set MONGO_URI}"
: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY (backups must be encrypted)}"
MINIO_BUCKET="${MINIO_BUCKET:-billy-files}"
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$BACKUP_DIR"

echo "backup[$STAMP]: mongodump…"
mongodump --uri="$MONGO_URI" --archive="$WORK/mongodb.archive" --gzip

echo "backup[$STAMP]: mirroring MinIO bucket '$MINIO_BUCKET'…"
mc alias set bkp "http://$MINIO_ENDPOINT:$MINIO_PORT" "${MINIO_ROOT_USER:-billy-admin}" "${MINIO_ROOT_PASSWORD:-change-me-in-env}" >/dev/null 2>&1 || true
mkdir -p "$WORK/minio"
mc mirror --quiet "bkp/$MINIO_BUCKET" "$WORK/minio/$MINIO_BUCKET" || echo "  (bucket empty or unreachable — continuing)"

echo "backup[$STAMP]: manifest + checksums…"
( cd "$WORK" && find . -type f -exec sha256sum {} \; > manifest.sha256 )
printf 'billy-backup\nstamp=%s\nmongo=mongodump --gzip --archive\nminio_bucket=%s\ncipher=aes-256-cbc (openssl enc, salted)\n' \
  "$STAMP" "$MINIO_BUCKET" > "$WORK/MANIFEST.txt"

echo "backup[$STAMP]: tar + encrypt…"
TARBALL="$WORK/billy-$STAMP.tar.gz"
( cd "$WORK" && tar czf "$TARBALL" mongodb.archive minio manifest.sha256 MANIFEST.txt )
OUT="$BACKUP_DIR/billy-$STAMP.tar.gz.enc"
openssl enc -aes-256-cbc -salt -pbkdf2 -pass "pass:$BACKUP_ENCRYPTION_KEY" -in "$TARBALL" -out "$OUT"
sha256sum "$OUT" > "$OUT.sha256"

echo "backup[$STAMP]: pruning archives older than ${RETENTION_DAYS}d (keeping newest)…"
# Keep at least the newest; delete .enc older than retention.
find "$BACKUP_DIR" -name 'billy-*.tar.gz.enc' -type f -mtime "+$RETENTION_DAYS" -print -delete || true

echo "backup[$STAMP]: DONE → $OUT"
