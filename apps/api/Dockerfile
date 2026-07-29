# API runtime image — thin node with the ONE native runtime dependency baked in,
# NO application code. The app bundle (apps/api/dist/index.js) is BIND-MOUNTED at
# runtime, not copied — so updating the api is `pnpm build` + `docker compose
# restart api`, never a rebuild.
#
# Why this image exists at all: the esbuild bundle inlines everything EXCEPT
# `@node-rs/argon2`, a napi native addon with a per-platform `.node` binary that
# cannot be inlined by a JS bundler NOR safely bind-mounted from the host (the
# host's binary is the host's OS/arch, and pnpm's symlinked layout dangles when
# only apps/api/node_modules is mounted). So we install the Linux binary INTO the
# image — the documented native-dependency exception to "never rebuild"
# (docker-compose_spec §1.2), exactly like the worker's Chromium.
#
# The bundle does `require("@node-rs/argon2")`; Node resolves it from
# /app/node_modules here.
FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production

# Install ONLY the native external into /app/node_modules (a flat, real dir —
# not a pnpm symlink). Pin to the version in apps/api/package.json.
RUN npm install --omit=dev --no-package-lock @node-rs/argon2@2.0.2

CMD ["node", "apps/api/dist/index.js"]
