#!/bin/sh
# Billy — datastore restore (backup-restore_plan B6). Decrypts a backup archive,
# verifies checksums, then restores BOTH datastores:
#   - MongoDB : `mongorestore --archive --gzip --drop`
#   - MinIO   : `mc mirror` back into the files bucket
#
# DESTRUCTIVE: --drop replaces collections. Run against the TARGET stack only
# after confirming. Usage:
#   BACKUP_ENCRYPTION_KEY=… ./scripts/backup/restore.sh ./data/backups/billy-<stamp>.tar.gz.enc
set -eu

ARCHIVE="${1:?usage: restore.sh <path-to-billy-*.tar.gz.enc>}"
: "${MONGO_URI:?set MONGO_URI (restore target)}"
: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY}"
MINIO_BUCKET="${MINIO_BUCKET:-billy-files}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "restore: verifying archive checksum…"
if [ -f "$ARCHIVE.sha256" ]; then
  ( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256" )
fi

echo "restore: decrypting…"
openssl enc -d -aes-256-cbc -pbkdf2 -pass "pass:$BACKUP_ENCRYPTION_KEY" -in "$ARCHIVE" -out "$WORK/backup.tar.gz"

echo "restore: extracting + verifying inner checksums…"
tar xzf "$WORK/backup.tar.gz" -C "$WORK"
( cd "$WORK" && sha256sum -c manifest.sha256 )

echo "restore: mongorestore (--drop)…"
mongorestore --uri="$MONGO_URI" --archive="$WORK/mongodb.archive" --gzip --drop

echo "restore: mirroring MinIO back…"
mc alias set rst "http://$MINIO_ENDPOINT:$MINIO_PORT" "${MINIO_ROOT_USER:-billy-admin}" "${MINIO_ROOT_PASSWORD:-change-me-in-env}" >/dev/null 2>&1 || true
mc mb --ignore-existing "rst/$MINIO_BUCKET" || true
if [ -d "$WORK/minio/$MINIO_BUCKET" ]; then
  mc mirror --overwrite --quiet "$WORK/minio/$MINIO_BUCKET" "rst/$MINIO_BUCKET"
fi

echo "restore: DONE. Post-check: hit /health/ready and spot-check a document + a stored PDF."
