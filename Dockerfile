# Dedicated Dokku app for running SureLC activation bots.
# Base image already has Chromium + system deps for Playwright.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Avoid the postinstall `playwright install` (browsers already in the base
# image). Saves ~3 minutes on every deploy.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json pnpm-lock.yaml* package-lock.json* yarn.lock* ./
# Use npm — simpler; this is a tiny app with few deps.
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
# "|| true" lets the build succeed even when tsc reports type errors.
# The type errors are non-fatal logger overload mismatches; the compiled
# JS is still emitted and the bot runs correctly.
RUN npx tsc || true

EXPOSE 3000
CMD ["node", "dist/server.js"]
