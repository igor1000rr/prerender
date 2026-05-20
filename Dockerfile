# Prerender v2: Node 20 + puppeteer-core + системный Chromium.
# Puppeteer-core НЕ скачивает свой Chromium (в отличие от puppeteer),
# экономим ~300MB и используем apt-версию.

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libnspr4 \
      libnss3 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      tini \
      curl \
      netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r chrome && useradd -r -g chrome -G audio,video chrome \
    && mkdir -p /home/chrome/Downloads /app \
    && chown -R chrome:chrome /home/chrome /app

WORKDIR /app

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    PORT=3000

COPY --chown=chrome:chrome package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=chrome:chrome server.js ./

USER chrome

EXPOSE 3000

# Healthcheck — свой endpoint /health возвращает 200 OK.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
