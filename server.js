// Prerender-сервер для SEO ботов.
//
// Слушает на :3000, принимает запросы вида GET /https://example.com/some/path,
// рендерит страницу в headless Chromium, отдаёт готовый HTML без JS.
//
// ВАЖНО: prerender 5.x имеет баг — если передать свои chromeFlags, он НЕ
// добавляет --remote-debugging-port автоматически. См. lib/browsers/chrome.js:
//   let chromeFlags = this.options.chromeFlags || [
//     '--headless', '--disable-gpu', '--remote-debugging-port=...', '--hide-scrollbars'
//   ];
// Т.е. в наших chromeFlags НАДО явно включить --remote-debugging-port=9222
// или брать порт из browserDebuggingPort из prerender.
//
// Кэширование в памяти на 1 час (prerender-memory-cache).

const prerender = require('prerender');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const DEBUG_PORT = parseInt(process.env.BROWSER_DEBUGGING_PORT || '9222', 10);

const server = prerender({
  port: 3000,
  chromeLocation: CHROME_PATH,
  browserDebuggingPort: DEBUG_PORT,

  pageDoneCheckTimeout: 500,
  pageLoadTimeout: 30 * 1000,
  waitAfterLastRequest: 500,

  // КРИТИЧНО: включаем --remote-debugging-port явно, prerender его НЕ добавит
  // автоматически к нашим кастомным флагам (см. выше).
  // И --headless тоже обязательно — иначе Chrome ждёт display.
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

// In-memory кэш
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

console.log(
  '[prerender] started on :3000, cache TTL=' + cacheTtl + 's, ' +
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
