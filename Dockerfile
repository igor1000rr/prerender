# Сборка prerender на основе Node 20 + Chromium из puppeteer.
# Цель — минимальный образ, без лишних dev-зависимостей, с быстрым стартом.
#
# Why node:20-bookworm-slim (а не alpine):
# Chromium под alpine — боль и бесполезные сборки. Debian-based stable.
#
# Why we install chromium отдельным пакетом, а не через puppeteer:
# puppeteer по умолчанию скачивает свою версию Chromium (~300MB).
# Мы пропускаем это через PUPPETEER_SKIP_CHROMIUM_DOWNLOAD и используем
# системный пакет chromium-from-debian — экономия диска и свежие security patches
# через apt.

FROM node:20-bookworm-slim

# Системный Chromium + все runtime-зависимости для него
# (фонты, libs, GTK и т.п.).
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
    && rm -rf /var/lib/apt/lists/*

# Не запускаем от root — puppeteer всё равно вынуждено бы лезть с --no-sandbox.
# Создаём юзера chrome и под ним запускаем.
RUN groupadd -r chrome && useradd -r -g chrome -G audio,video chrome \
    && mkdir -p /home/chrome/Downloads /app \
    && chown -R chrome:chrome /home/chrome /app

WORKDIR /app

# Говорим puppeteer (транзитивная зависимость prerender), не качать свой Chromium
# и использовать системный.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

COPY --chown=chrome:chrome package.json ./

# npm install вместо npm ci: в репо нет package-lock.json (проект новый),
# в ci это было бы проблемой, для прода-сборки одноразовой — ok.
# Лок создастся внутри build context и останется в образе.
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=chrome:chrome server.js ./

USER chrome

EXPOSE 3000

# Healthcheck — prerender отвечает 200 на GET / (с подсказкой как использовать).
# start-period 30s — время на старт Chromium-процесса.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/ || exit 1

# tini как init-процесс — правильно реапит зомби-Chromiumы и ловит SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
