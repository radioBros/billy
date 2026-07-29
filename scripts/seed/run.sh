#!/bin/bash
# Billy — bundle + run the demo seed inside the running stack.
#
# Prereqs: the stack is up (at least mongodb, minio, api, worker) — e.g.
#   docker compose up -d mongodb redis minio minio-init api worker
# Then:
#   ./scripts/seed/run.sh            # seed the demo data
#
# The seed reaches the api at http://api:3000, Mongo at mongodb:27017, and the
# presigned MinIO URLs at minio:9000 — all on the stack's internal network. It
# reuses the api runtime image (which has the native @node-rs/argon2 for hashing
# demo-user passwords). Refuses to run when APP_ENV=production (pass --force-insecure).
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "seed: bundling…"
node -e "
const esbuild=require('esbuild'), path=require('path');
esbuild.build({
  entryPoints:['scripts/seed/seed-demo.mjs'],
  outfile:'scripts/seed/seed-demo.bundle.cjs',
  bundle:true, platform:'node', format:'cjs', target:'node20',
  external:['@node-rs/argon2'],
  nodePaths:[path.resolve('apps/api/node_modules'), path.resolve('node_modules')],
  logLevel:'error',
}).then(()=>console.log('seed: bundled')).catch(e=>{console.error(e.message);process.exit(1)});
"

echo "seed: running inside the api container…"
docker compose run --rm --no-deps -T \
  -v "$PWD/scripts/seed/seed-demo.bundle.cjs:/app/seed.cjs:ro" \
  api node /app/seed.cjs "$@"
