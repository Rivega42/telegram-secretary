# CLAUDE.md — инструкции для AI-агентов

## О проекте

AI-секретарь для Telegram Business: прокси между Telegram и LLM с отложенными ответами.
Целевая архитектура — «коннекторы поверхностей ↔ мозг с единой памятью (OpenClaw)»,
см. `docs/openclaw-integration.md`. Текущая архитектура — `docs/architecture.md`.

## Язык

Весь проект на **русском**: документация, комментарии, commit-сообщения, issues, PR.
Идентификаторы в коде — английские.

## Команды

```bash
npm install
npm start                    # боевой запуск (нужен заполненный .env)
npm run dev                  # с --watch
npm test                     # тесты (node:test, без доп. зависимостей)

# Локально без токенов и LLM:
DRY_RUN=true DRY_RUN_BRAIN=true OWNER_CHAT_ID=1 npm start

# Docker:
docker compose up -d                      # только прокси
docker compose --profile gateway up -d    # прокси + OpenClaw Gateway
```

## Структура

- `src/server.js` — точка входа: валидация env, listen
- `src/app.js` — Express: webhook `/tg/business-webhook`, политики, админ-API `/api/*` (авторизация `X-Api-Key`)
- `src/scheduler.js` — очередь отложенных ответов, persistence в `pending.json`
- `src/core/` — ядро: `envelope.js` (конверт+capabilities), `brain.js` (интерфейс мозга),
  `persona.js` (персона из `persona/`), `identity.js` (персоны/политики), `instances.js` (реестр+routing),
  `modes.js` (режимы /on /off /vacation + draft), `drafts.js` (черновики), `prompt.js`, `format.js`
- `src/brains/` — драйверы: `stateless-llm.js` (OpenAI-совместимый endpoint), `openclaw.js` (сессии per-человек)
- `src/connectors/telegram/business.js` — Telegram Business ↔ конверт (telegram-поля не выходят за коннектор)
- `src/connectors/telegram/control.js` — control plane: команды/кнопки владельца (long-polling бота уведомлений)
- `src/connectors/telegram/community.js` — комментарии канала, Q&A в группах, лид-воронка
- `src/connectors/telegram/channel.js` — автопостинг по контент-плану (только через черновик)
- `src/state.js` — файловый стейт в `STATE_DIR`: контакты, маппинги, история (`conversations/*.jsonl`)
- `src/forward.js` — отправка через Telegram API, уважает `DRY_RUN`
- `persona/` — конфиг персоны (persona.json, base.md, dm.md, public.md)
- `tests/` — node:test; e2e поднимает app через `createApp()` без listen-сайд-эффектов

## Правила синхронизации документации (ОБЯЗАТЕЛЬНО)

После любого изменения поведения обнови документацию **в том же коммите/PR**:

| Что изменил | Что обновить |
|---|---|
| Любой код в `src/**` | `CHANGELOG.md` → раздел `[Unreleased]` |
| Env-переменные | `.env.example` + раздел «Конфигурация» в `README.md` |
| Эндпоинты, поток сообщений, стейт | `docs/architecture.md` |
| Шаги развёртывания, nginx, PM2 | `docs/deployment.md` |
| Архитектурные решения | `docs/openclaw-integration.md` |
| Новая фича целиком | `README.md` (возможности) + `ROADMAP.md` (отметить выполненное) |

CI (`.github/workflows/docs-check.yml`) отклонит PR с изменениями `src/**` без изменений документации.

## Инварианты кода

- История диалога хранится и передаётся в LLM **хронологически** (старые → новые). Не реверсить.
- Роли в истории: `client` / `vika` / `owner`. Ответы владельца обязаны попадать в историю.
- В историю пишется только то, что реально отправлено (`replyResult.ok`).
- Любая отправка наружу проверяет `DRY_RUN` / `DRY_RUN_BRAIN` (алиас `DRY_RUN_VIKA`).
- При ошибке обработки webhook — `unmarkProcessed(update_id)`, чтобы не потерять ретрай Telegram.
- Секреты только через env. В `.env.example` — только плейсхолдеры, никаких реальных ID/токенов.
- Платформо-специфичные детали (telegram-поля) живут только в `src/connectors/**`;
  ядро (`src/core/`, `src/brains/`) видит только конверт (`envelope`).
- Политики персон проверяются **до** вызова Brain: `escalate`/`ignore` не должны доходить до LLM.
- Слияние персон (`mergePersons`) — только по явному действию владельца, автосклейка запрещена.

## Чего не делать

- Не добавлять зависимости без необходимости (сейчас только `express` и `dotenv`; тесты — node:test)
- Не менять формат файлов стейта без миграции — у пользователей живые данные
  (новые поля добавлять можно, обрабатывая их отсутствие)
- Не хардкодить персону/имена в код — персона живёт в `persona/` (generic-фоллбек в `core/persona.js`
  обязан оставаться нейтральным, без имён)
