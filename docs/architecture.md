# Архитектура telegram-secretary

Секретарь-прокси между владельцем и его контактами в Telegram, построенный по схеме
«коннекторы поверхностей ↔ мозг» (см. `openclaw-integration.md` — целевая картина).

## Зачем

Когда владелец занят / спит / в отпуске — секретарь:
- Принимает входящие от любых контактов через Telegram Business
- Отвечает в стиле владельца (персона настраивается в `persona/`)
- Эскалирует важное: контакты с политикой `escalate` (семья, VIP) и не-текстовые
  сообщения уходят владельцу без автоответа
- Если владелец ответил сам — отложенный автоответ отменяется, а его реплика
  сохраняется в историю (секретарь не противоречит сказанному)

## Компоненты

```
Контакт в TG ──► Business-бот ──► webhook ──► connectors/telegram/business.js
                                                      │ envelope
                                                      ▼
                                   ┌─ identity (персона человека, политика)
                                   ├─ scheduler (задержка 2/3 мин, отмена)
                                   ▼
                                core/brain ──► brains/stateless-llm ──► LiteLLM/OpenRouter/…
                                   │      └──► brains/openclaw ───────► OpenClaw-инстанс
                                   ▼                                    (единая память)
                          Business API (ответ от имени владельца)
                                   │
        бот уведомлений ◄──────────┘ (копии, эскалации, pending-уведомления)
```

### Слои

| Слой | Файлы | Ответственность |
|---|---|---|
| Точка входа | `src/server.js` | Валидация env, запуск, восстановление pending |
| Приложение | `src/app.js` | Webhook, политики, админ-API |
| Коннектор | `src/connectors/telegram/business.js` | telegram-поля ↔ конверт; ядро telegram не видит |
| Ядро | `src/core/*` | envelope, brain, persona, identity, instances |
| Мозги | `src/brains/*` | stateless-llm, openclaw (+ общий llm-http) |
| Отправка | `src/forward.js` | Telegram API, уважает DRY_RUN |
| Очередь | `src/scheduler.js` | Отложенные ответы, persistence |

### Зачем два бота

| Бот | Роль | Режим |
|---|---|---|
| Business-бот | Принимает входящие, отвечает «от владельца» | Business Mode (webhook) |
| Бот уведомлений | Личка владельца: pending-уведомления, копии, эскалации | sendMessage |

## Поток сообщения

1. Контакт пишет владельцу → Telegram доставляет `business_message` на webhook
2. Дедупликация по `update_id` (при ошибке обработки пометка снимается — ретрай Telegram не теряется)
3. Если автор — владелец: реплика → история (роль `owner`), pending отменяется
4. Иначе коннектор собирает **конверт**, identity-слой резолвит **персону**:
   - политика `ignore` → ничего
   - политика `escalate` → история + уведомление владельцу, без LLM
   - не-текст (голос/фото/…) → история (маркер вложения) + эскалация владельцу
   - политика `auto` → история + pending с задержкой **2 мин (08–18 МСК) / 3 мин (18–08 МСК)**
5. По таймеру: `core/brain` выбирает инстанс по маршрутизации и драйвер
   (`stateless-llm` | `openclaw`), генерирует ответ
6. Ответ уходит через Business API; **в историю пишется только успешно отправленное**;
   владелец получает копию

## Стейт (persistence)

`STATE_DIR` (по умолчанию `./state`, в Docker — volume `/data`):

| Файл | Содержание |
|---|---|
| `connections.json` | Активные business_connection_id |
| `contacts.json` | Контакты Telegram (исторический стейт) |
| `persons.json` | **Персоны**: память по людям, identities per-платформа, политики |
| `conversations.json` | Маппинг mapping_id ↔ business-чат |
| `conversations/<mapping_id>.jsonl` | История диалога (роли `client`/`vika`/`owner`, хронологически) |
| `pending.json` | Очередь отложенных ответов (+конверт, +person_id) |
| `instances.json` | Реестр инстансов и маршрутизация (опционально, см. `instances.example.json`) |
| `log-YYYY-MM-DD.jsonl` | Все события за день |

При рестарте pending восстанавливаются из `pending.json` — отложенные ответы не теряются.

## Конфиг персоны

`PERSONA_DIR` (по умолчанию `./persona`): `persona.json` + `base.md` + `dm.md` + `public.md`.
Если каталога нет — нейтральная generic-персона без имён. Раскрытие ИИ-природы —
флаг `disclosure` per-поверхность (публичные — по умолчанию раскрывают).

## Эндпоинты

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/tg/business-webhook` | Telegram Business webhook (снаружи через Nginx: `/secretary/tg/business-webhook`) |
| `POST` | `/api/reply` | Ручной ответ клиенту по mapping_id |
| `GET` | `/api/contacts` | Контакты Telegram |
| `GET` | `/api/persons` | Персоны и политики |
| `POST` | `/api/persons/:id/policy` | Сменить политику (`auto`/`escalate`/`ignore`) |
| `POST` | `/api/persons/:id/merge` | Явное слияние персон (решение владельца) |
| `GET` | `/api/conversations` | Карта разговоров |
| `GET` | `/api/pending` | Очередь отложенных |
| `DELETE` | `/api/pending/:chatId` | Отменить отложенный ответ |
| `GET` | `/health` | Health check |

Все пути `/api/*` требуют заголовок `X-Api-Key` (env `API_KEY`).

## Дополнительно

См. также:
- `openclaw-integration.md` — целевая архитектура: единая память, мультиплатформенность
- `vika-style.md` — стиль общения секретаря
- `secretary-proxy-rules.md` — правила «секретарь-прокси»
- `memory-update-rules.md` — как обновлять файлы памяти
- `deployment.md` — как разворачивать (Docker / PM2 + Nginx)
