# Worker runtime image — Chromium + fonts for PDF rendering, NO application code.
#
# The app bundle (apps/worker/dist/index.js) is BIND-MOUNTED at runtime, not
# copied in — so updating the worker is `pnpm build` + `docker compose restart
# worker`, never a rebuild. This image exists ONLY because the worker needs a
# native runtime dependency (Chromium) that cannot be bind-mounted; that is the
# documented exception to "never rebuild" (docker-compose_spec §1.2).
#
# The Playwright base image ships a matching Chromium + all system fonts/libs,
# so page.pdf() renders reliably. Pin to the same Playwright version as the app
# (apps/worker package.json: playwright ^1.61.1).
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Chromium is at the Playwright default cache location inside this base image;
# the bundle's lazy `chromium.launch()` finds it with no extra config.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # The base image already downloaded Chromium; don't re-download on npm install.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# No COPY of app code — apps/worker/dist is bind-mounted by compose. But the
# worker bundle EXTERNALIZES `playwright` (a JS launcher for the separate Chromium
# binary; esbuild can't inline it), and the base image ships Chromium *binaries*
# but NOT the `playwright` npm package on Node's resolution path. So install it
# into /app/node_modules — a flat, real dir Node resolves from /app/apps/worker/
# dist. Pin to the app's version (apps/worker/package.json playwright ^1.61.1).
# This is the same native-dependency exception as the api's argon2 image.
RUN npm install --omit=dev --no-package-lock playwright@1.61.1

CMD ["node", "apps/worker/dist/index.js"]
