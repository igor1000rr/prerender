// Prerender v2 — переписан с нуля на puppeteer-core + Express.
//
// Почему не npm-пакет prerender: он архивируется, имеет баги с chromeFlags,
// browserForceRestart после каждого запроса ломает тяжёлые SPA, поддержки нет.
//
// API:
//   GET /render?url=https://example.com/path  — основной endpoint
//   GET /https://example.com/path             — legacy-формат (совместимый с остальными prerender)
//   GET /health                                — для Docker healthcheck
//
// Кэш: Map в памяти, TTL из ENV, LRU-вытеснение по размеру.
//
// Chromium живёт ODIN экземпляр на весь процесс, но каждый запрос в своём BrowserContext —
// изоляция кук, localStorage и т.д., без рестарта всего браузера. Экономия CPU/RAM.

const express = require('express');
const puppeteer = require('puppeteer-core');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const PORT = parseInt(process.env.PORT || '3000', 10);
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT_MS || '60000', 10);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10) * 1000;
const CACHE_MAX = parseInt(process.env.CACHE_MAX || '500', 10);
const USER_AGENT =
  process.env.PRERENDER_USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36 Prerender (+https://github.com/igor1000rr/prerender)';

// Простой LRU-кэш через Map (в JS он сохраняет порядок вставки).
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  // LRU bump: перекладываем в конец (свежее = в конце)
  cache.delete(key);
  cache.set(key, entry);
  return entry.html;
}

function cacheSet(key, html) {
  if (cache.size >= CACHE_MAX) {
    // вытесняем самый старый
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { html, expires: Date.now() + CACHE_TTL_MS });
}

// Глобальный экземпляр браузера, ленивая инициализация.
let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      // проверка живости: если процесс упал — пересоздаём
      if (b.connected) return b;
      console.log('[prerender] browser disconnected, recreating');
      browserPromise = null;
    } catch (e) {
      console.error('[prerender] browser launch failed previously:', e.message);
      browserPromise = null;
    }
  }
  browserPromise = puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new', // новый headless mode (стабильнее старого --headless)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-zygote',
      // single-process НЕ ставим — он делает Chromium нестабильным на тяжёлых SPA.
      // Memory limit 1.5G в Coolify и tini как init-процесс ловят зомби.
    ],
    // Игнорируем HTTPS ошибки — пререндерим свои сайты, из внутренней сети
    // может попасть на self-signed.
    ignoreHTTPSErrors: true,
  });
  const b = await browserPromise;
  b.on('disconnected', () => {
    console.log('[prerender] browser disconnected event');
    browserPromise = null;
  });
  console.log('[prerender] browser launched, version=' + (await b.version()));
  return b;
}

async function renderPage(targetUrl) {
  const browser = await getBrowser();
  // BrowserContext = incognito-вкладка, изолированная от других запросов.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    // Блокируем ресурсы которые не влияют на DOM — экономия времени рендера.
    // Имаги/фонты/медиа SEO-боту не нужны.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: PAGE_TIMEOUT,
    });

    // Удаляем все <script>-теги из финального HTML — ботам они не нужны,
    // и бот не должен запускать JS на уже отрендеренной странице.
    const html = await page.evaluate(() => {
      document.querySelectorAll('script').forEach((s) => s.remove());
      // вырезаем link rel=preload для js — браузер всё равно пытался бы загрузить.
      document.querySelectorAll('link[rel="preload"][as="script"]').forEach((s) => s.remove());
      return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    });

    return html;
  } finally {
    await context.close().catch(() => {});
  }
}

// Парсим URL из prerender-legacy-формата: "/https://site.com/path"
function extractLegacyUrl(reqPath, reqUrl) {
  // reqUrl: "/https://site.com/path?q=1"
  // убираем лидирующий "/"
  const stripped = reqUrl.replace(/^\//, '');
  if (stripped.startsWith('http://') || stripped.startsWith('https://')) {
    return stripped;
  }
  return null;
}

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/render', async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    return res.status(400).type('text/plain').send('Missing ?url=');
  }
  return handleRender(url, res);
});

// Legacy-формат для совместимости с nginx-конфигами в стиле prerender.io
app.get(/^\/(https?:\/\/.+)/, async (req, res) => {
  const url = extractLegacyUrl(req.path, req.url);
  if (!url) return res.status(400).type('text/plain').send('Invalid URL');
  return handleRender(url, res);
});

async function handleRender(url, res) {
  const started = Date.now();

  // Кэш
  const cached = cacheGet(url);
  if (cached) {
    res.set('X-Prerender-Cache', 'HIT');
    res.set('X-Prerender-Time-Ms', String(Date.now() - started));
    return res.type('text/html').send(cached);
  }

  try {
    const html = await renderPage(url);
    cacheSet(url, html);
    res.set('X-Prerender-Cache', 'MISS');
    res.set('X-Prerender-Time-Ms', String(Date.now() - started));
    return res.type('text/html').send(html);
  } catch (e) {
    console.error('[prerender] render failed for', url, '|', e.message);
    res.set('X-Prerender-Error', e.message.slice(0, 200));
    return res.status(502).type('text/plain').send('Render failed: ' + e.message);
  }
}

app.get('/', (req, res) => {
  res.type('text/plain').send(
    'prerender-vibecoding v2\n' +
    'Usage: GET /render?url=https://example.com\n' +
    '   or: GET /https://example.com\n' +
    'Health: GET /health\n'
  );
});

const server = app.listen(PORT, () => {
  console.log(
    '[prerender] v2 listening on :' + PORT + ' | ' +
    'cache=' + CACHE_MAX + ' items × ' + CACHE_TTL_MS / 1000 + 's | ' +
    'pageTimeout=' + PAGE_TIMEOUT + 'ms | ' +
    'chrome=' + CHROME_PATH
  );
  // Прогрев браузера при старте — первый запрос будет быстрым.
  getBrowser().catch((e) => console.error('[prerender] warmup failed:', e.message));
});

function shutdown(sig) {
  console.log('[prerender] ' + sig + ', shutting down');
  server.close(() => {
    if (browserPromise) {
      browserPromise.then((b) => b.close()).catch(() => {}).finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
  // hard exit через 10с если виснет
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
