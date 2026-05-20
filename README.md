# prerender

Self-hosted prerender-сервер для SEO ботов на SPA-сайтах vibecoding/grodno/tonforge.

## Что делает

Когда Googlebot/Bingbot/Yandex/Telegrambot заходит на SPA-сайт, он видит пустой `<div id="root">` и не индексирует контент. Этот сервис принимает url, открывает его в headless Chromium, ждёт пока React/Vue отрендерится, возвращает готовый HTML без `<script>`-тегов.

Nginx внутри каждого приложения смотрит на `User-Agent`. Если это бот — проксирует запрос на этот сервис.

## Стек

- Node 20 (bookworm-slim)
- Chromium из apt (системный, не puppeteer-кид)
- Open-source [`prerender`](https://github.com/prerender/prerender) npm-пакет
- `prerender-memory-cache` для 1-часового кэша в RAM
- `tini` как init-процесс — корректно убивает зомби-Chromium
- Запуск под non-root юзером `chrome`

## Coolify deploy

Настройки:
- **Build Pack**: Dockerfile
- **Port**: 3000 (не публикуется наружу)
- **Memory limit**: `1.5G` (Resource Limits)
- **Restart policy**: `on-failure:5` — НЕ `unless-stopped`, иначе при crash-loop сожрёт диск
- **Domain**: можно оставить пустым, сервис только для внутренней docker-сети

## Env

| Var | Default | Описание |
|---|---|---|
| `PORT` | `3000` | Порт внутри контейнера |
| `CACHE_TTL_SECONDS` | `3600` | TTL кэша в секундах |
| `CACHE_MAXSIZE` | `1000` | Макс. количество страниц в кэше |
| `LOG_REQUESTS` | `0` | `1` чтобы логировать каждый запрос (debug) |

## Использование из nginx

Классический паттерн:

```nginx
map $http_user_agent $prerender_bot {
  default 0;
  ~*(googlebot|bingbot|yandex|baiduspider|twitterbot|facebookexternalhit|linkedinbot|telegrambot|whatsapp|slackbot|pinterest|embedly|w3c_validator) 1;
}

server {
  # ...

  location / {
    if ($prerender_bot = 1) {
      rewrite ^(.*)$ /https://$host$1 break;
      proxy_pass http://prerender:3000;
    }
    try_files $uri $uri/ /index.html;
  }
}
```

`prerender` в proxy_pass — имя контейнера в docker-сети. Coolify нужно подключить prerender-приложение в ту же docker network что приложение-клиент.

## История

Первая итерация — `prerender-custom` — упала в OOM-петлю на 13 000 рестартов, съела 5GB диска. Эта версия исключает повтор:

1. Memory limit жёсткий в Coolify (1.5G)
2. `restart: on-failure:5` — не молотит бесконечно
3. `--single-process` + `--disable-dev-shm-usage` — Chromium не плодит зомби
4. `tini` reaps мёртвых child-процессов
5. `prerender.browserForceRestart()` — перезапуск браузера после N запросов (память не утекает)
