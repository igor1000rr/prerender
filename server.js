// Prerender-сервер для SEO ботов.
//
// Слушает на :3000, принимает запросы GET /https://example.com/path,
// рендерит страницу в headless Chromium, отдаёт готовый HTML без JS.
//
// НАСТРОЙКИ ТАЙМАУТОВ:
// SPA-сайты vibecoding/grodno/tonforge загружают React + кучу скриптов, 30сек мало.
// Ставим 60 сек — это реальный бюджет для медленных страниц в single-process Chrome.
//
// КЭШИРОВАНИЕ: prerender-memory-cache, 1 час TTL, max 1000 страниц.
// Первый запрос на страницу — медленный (full render), последующие — мгновенные.
//
// browserForceRestart() НЕ используем — он рестартит Chrome ПОСЛЕ КАЖДОГО запроса
// (в prerender 5.21.6 это жёсткий default), от чего сильно медленные SPA не успевают отрендериться.
// Memory limit контейнера 1.5G в Coolify + restart on-failure:5 защищают от утечек.

const prerender = require('prerender');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const DEBUG_PORT = parseInt(process.env.BROWSER_DEBUGGING_PORT || '9222', 10);
const PAGE_LOAD_TIMEOUT = parseInt(process.env.PAGE_LOAD_TIMEOUT_MS || '60000', 10);

const server = prerender({
  port: 3000,
  chromeLocation: CHROME_PATH,
  browserDebuggingPort: DEBUG_PORT,

  // Таймауты: 60 сек на загрузку, проверка "страница готова" каждые 500мс,
  // после последнего запроса ждём 500мс перед возвратом HTML.
  pageDoneCheckTimeout: 500,
  pageLoadTimeout: PAGE_LOAD_TIMEOUT,
  waitAfterLastRequest: 500,

  // --remote-debugging-port ОБЯЗАТЕЛЬНО в chromeFlags — prerender НЕ добавляет его
  // автоматически если передаются свои флаги. См. lib/browsers/chrome.js в пакете.
  chromeFlags: [
    '--headless',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-setuid-sandbox',
    '--no-zygote',
    '--single-process',
    '--hide-scrollbars',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--mute-audio',
  ],

  followRedirects: true,
  logRequests: process.env.LOG_REQUESTS === '1',
});

// In-memory кэш — первый запрос медленный, последующие мгновенные.
const cacheTtl = parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10);
process.env.CACHE_MAXSIZE = process.env.CACHE_MAXSIZE || '1000';
process.env.CACHE_TTL = String(cacheTtl);

server.use(require('prerender-memory-cache'));
server.use(prerender.sendPrerenderHeader());
// browserForceRestart() УБРАН — он рестартит Chrome после КАЖДОГО запроса,
// тяжёлые страницы следующего запроса попадают на холодный Chrome и таймаутятся.
server.use(prerender.blockResources());
server.use(prerender.removeScriptTags());
server.use(prerender.httpHeaders());

server.start();

console.log(
  '[prerender] started on :3000, ' +
  'cache TTL=' + cacheTtl + 's, ' +
  'pageLoadTimeout=' + PAGE_LOAD_TIMEOUT + 'ms, ' +
  'Chrome=' + CHROME_PATH + ', debugPort=' + DEBUG_PORT
);

process.on('SIGTERM', () => {
  console.log('[prerender] SIGTERM, shutting down');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[prerender] SIGINT, shutting down');
  process.exit(0);
});
