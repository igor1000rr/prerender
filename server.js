// Prerender-сервер для SEO ботов.
//
// Слушает на :3000, принимает запросы вида GET /https://example.com/some/path,
// рендерит страницу в headless Chromium, отдаёт готовый HTML без JS.
//
// Кэширование в памяти на 1 час (prerender-memory-cache) — снижает нагрузку
// на CPU/RAM, особенно когда боты долбят пачкой.
//
// Внимание: процесс ОДИН на контейнер. Если упал — рестарт за счёт Docker
// (restart policy: on-failure:5). Никаких бесконечных рестарт-петель.

const prerender = require('prerender');

// Путь к Chromium внутри образа (системный из apt, см. Dockerfile).
// PUPPETEER_EXECUTABLE_PATH не работает с prerender — он не использует puppeteer
// в прямую, а запускает Chrome через child_process с указанным chromeLocation.
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';

const server = prerender({
  // Порт внутри контейнера, наружу не публикуется — общение через docker network
  port: 3000,

  // Критично: prerender ищет Chrome в нескольких стандартных местах,
  // но в debian-slim Chromium в /usr/bin/chromium, в список не входит — указываем явно.
  chromeLocation: CHROME_PATH,

  // Таймаут на одну страницу. 30 сек хватит для тяжёлых SPA, дальше — 504
  pageDoneCheckTimeout: 500,
  pageLoadTimeout: 30 * 1000,
  waitAfterLastRequest: 500,

  // Ограничиваем число параллельных Chrome-вкладок, чтоб не съесть всю память.
  // На 1.5G лимита контейнера разумно 2-3 параллельных страницы.
  chromeFlags: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-setuid-sandbox',
    '--no-zygote',
    '--single-process',
    '--hide-scrollbars',
  ],

  followRedirects: true,
  logRequests: process.env.LOG_REQUESTS === '1',
});

// In-memory кэш. CACHE_TTL/CACHE_MAXSIZE — это env-переменные самого плагина.
const cacheTtl = parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10);
process.env.CACHE_MAXSIZE = process.env.CACHE_MAXSIZE || '1000';
process.env.CACHE_TTL = String(cacheTtl);

server.use(require('prerender-memory-cache'));
server.use(prerender.sendPrerenderHeader());
server.use(prerender.browserForceRestart());
server.use(prerender.blockResources());
server.use(prerender.removeScriptTags());
server.use(prerender.httpHeaders());

server.start();

console.log('[prerender] started on :3000, cache TTL=' + cacheTtl + 's, Chrome=' + CHROME_PATH);

// Graceful shutdown — даём Chrome закрыться корректно
process.on('SIGTERM', () => {
  console.log('[prerender] SIGTERM, shutting down');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[prerender] SIGINT, shutting down');
  process.exit(0);
});
