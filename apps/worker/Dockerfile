# Worker runtime image — Chromium + fonts for PDF rendering, NO application code.
#
# The app bundle (apps/worker/dist/index.js) is BIND-MOUNTED at runtime, not
# copied in — so updating the worker is `pnpm build` + `docker compose restart
# worker`, never a rebuild. This image exists ONLY because the worker needs a
# native runtime dependency (Chromium) that cannot be bind-mounted; that is the
# documented exception to "never rebuild" (docker-compose_spec §1.2).
#
# Built from the patched Node runtime (not the Playwright MCR image, which pins
# an older Node line) and installs matching Chromium via `playwright install`.
# Keep the playwright version in sync with apps/worker/package.json.
FROM node:26.12.1-bookworm

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install playwright + Chromium (+ OS deps) into /app/node_modules — a flat,
# real dir Node resolves from /app/apps/worker/dist. Same native-dependency
# exception as the api's argon2 image.
RUN npm install --omit=dev --no-package-lock playwright@1.64.1 \
 && npx playwright install --with-deps chromium

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

CMD ["node", "apps/worker/dist/index.js"]
