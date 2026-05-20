# Сборка prerender на основе Node 20 + системный Chromium из apt.

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
      wget \
      curl \
      netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r chrome && useradd -r -g chrome -G audio,video chrome \
    && mkdir -p /home/chrome/Downloads /app \
    && chown -R chrome:chrome /home/chrome /app

WORKDIR /app

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

COPY --chown=chrome:chrome package.json ./

RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=chrome:chrome server.js ./

USER chrome

EXPOSE 3000

# Healthcheck: пререндер отвечает 400 на GET / (пустой URL — ожидаемое поведение).
# Нам нужно проверить что процесс вообще живой и принимает TCP на 3000.
# nc -z — простой TCP-knock, возвращает 0 если порт принимает соединения.
# Это быстрее и надёжнее чем парсинг HTTP-ответа.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD nc -z 127.0.0.1 3000 || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
