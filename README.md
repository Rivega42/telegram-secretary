# 🤖 Telegram Secretary Proxy

**Telegram Business Webhook Proxy** — сервер для автоматических ответов в Telegram Business, когда владелец (Роман) не отвечает.

## Как работает

1. Клиент пишет Роману в Telegram (Business-аккаунт)
2. Telegram отправляет webhook на `/tg/business-webhook`
3. Прокси создаёт **отложенный ответ** и уведомляет Романа
4. Если Роман не ответил сам через N минут — **Вика (LLM)** генерирует ответ
5. Ответ отправляется клиенту через Business API
6. Копия диалога отправляется Роману в другой чат

### Если Роман отвечает сам
- Pending-задача отменяется автоматически
- Роман получает уведомление: "Ты ответил сам — отложенный ответ отменён"

## Архитектура

```
┌──────────────┐     Telegram API     ┌──────────────────┐
│   Telegram   │ ◄──────────────────► │  Secretary Proxy  │
│  Business    │                      │  (Express :18791) │
│  Account     │                      │                   │
└──────────────┘                      │  ┌──────────────┐ │
        │                             │  │   vika.js    │ │
        │ Webhook                     │  │ (LLM через   │ │
        ▼                             │  │  LiteLLM)    │ │
  ┌──────────┐                        │  └──────────────┘ │
  │  Nginx   │                        │                   │
  │  Reverse │                        │  ┌──────────────┐ │
  │  Proxy   │                        │  │ scheduler.js │ │
  └──────────┘                        │  │ (таймеры)    │ │
                                      │  └──────────────┘ │
                                      │                   │
                                      │  ┌──────────────┐ │
                                      │  │  state.js    │ │
                                      │  │ (данные)     │ │
                                      │  └──────────────┘ │
                                      └──────────────────┘
                                               │
                                               ▼
                                      ┌──────────────────┐
                                      │  Telegram Bot    │
                                      │  (@oneint_bot)   │
                                      │  Уведомления     │
                                      │  Роману          │
                                      └──────────────────┘
```

## Быстрый старт

```bash
git clone https://github.com/Rivega42/telegram-secretary
cd telegram-secretary
cp .env.example .env
# Заполни .env (см. ниже)
npm install
npm start
```

## Переменные окружения

| Переменная | Описание |
|-----------|----------|
| `BUSINESS_BOT_TOKEN` | Токен Telegram Business бота |
| `ONEINT_BOT_TOKEN` | Токен бота для уведомлений Роману |
| `OWNER_CHAT_ID` | Chat ID Романа |
| `LITELLM_API_KEY` | Ключ для LiteLLM |
| `WEBHOOK_SECRET` | Секрет webhook (опционально) |
| `DELAY_MINUTES` | Задержка перед ответом Вики (по умолч. 5) |
| `DRY_RUN` | Режим без реальных ответов |
| `PORT` | Порт сервера (по умолч. 18791) |

## API

- `POST /tg/business-webhook` — Webhook от Telegram
- `POST /api/reply` — Ручной ответ Вики
- `GET /api/contacts` — Список контактов
- `GET /api/conversations` — Разговоры
- `GET /api/pending` — Отложенные ответы
- `DELETE /api/pending/:chatId` — Отменить ответ
- `GET /health` — Проверка

## Deploy

### PM2 (рекомендуется)
```bash
npm install pm2 -g
pm2 start ecosystem.config.cjs
pm2 save
```

### Nginx
Смотри `nginx/secretary.conf` за reverse proxy.

## Разработка

```bash
npm run dev
```

## Репозиторий

Исходный репозиторий: https://github.com/Rivega42/gh-secretary (ветка develop).
