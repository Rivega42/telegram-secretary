# telegram-secretary

> AI-секретарь для Telegram — отвечает за тебя в личке, а в перспективе ведёт канал,
> комментарии и другие платформы с единой памятью на базе OpenClaw.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![CI](https://github.com/Rivega42/telegram-secretary/actions/workflows/ci.yml/badge.svg)](https://github.com/Rivega42/telegram-secretary/actions/workflows/ci.yml)

Открытый шаблон на Node.js. Разворачивается за 10 минут. Работает через любой
OpenAI-совместимый API или OpenClaw Gateway.

**Хочешь готовое решение без настройки?** → [grandhub.ru](https://grandhub.ru)

---

## Что это

Прокси-сервер между Telegram Business API и LLM. Когда тебе пишут в личку, а ты занят —
ассистент отвечает сам. Поддерживает контекст последних 25 сообщений, знает кто пишет,
помнит историю диалога, видит твои собственные ответы и не противоречит им.

- Ответ через 2 мин днём (08–18 МСК), 3 мин ночью — настраивается
- Если ты ответил сам — отложенный ответ автоматически отменяется
- Контекст 25 сообщений с таймстемпами, включая твои реплики
- Копирует твой стиль общения (настраиваемый системный промпт)
- Уведомления и копии всех ответов тебе в личку через отдельного бота
- Работает через LiteLLM / OpenRouter / любой OpenAI-совместимый endpoint или OpenClaw Gateway

## Куда движется проект

Целевая архитектура — «коннекторы поверхностей ↔ мозг с единой памятью»:
личка, Telegram-канал, комментарии, групповые чаты, а затем ВКонтакте и другие платформы
подключаются к OpenClaw-инстансу, который помнит каждого человека во всех каналах сразу.

Подробно: [docs/openclaw-integration.md](./docs/openclaw-integration.md) ·
План: [ROADMAP.md](./ROADMAP.md)

## Быстрый старт

```bash
git clone https://github.com/Rivega42/telegram-secretary
cd telegram-secretary
cp .env.example .env
# Заполни .env (см. ниже)
npm install
npm start
```

Для боевого развёртывания (PM2, Nginx, webhook): [docs/deployment.md](./docs/deployment.md)

## Конфигурация (.env)

```env
BUSINESS_BOT_TOKEN=    # токен бота с включённым Business Mode
ONEINT_BOT_TOKEN=      # токен бота для уведомлений владельцу
OWNER_CHAT_ID=         # твой Telegram ID (число)
WEBHOOK_SECRET=        # случайная строка для проверки webhook
API_KEY=               # ключ авторизации админ-API (/api/*)
PORT=18792
STATE_DIR=./state

# LLM — вариант 1: любой OpenAI-совместимый (приоритетный, если задан)
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=sk-...
VIKA_MODEL=openai/gpt-4o

# LLM — вариант 2: OpenClaw Gateway (если LITELLM_BASE_URL не задан)
GW_BASE_URL=http://127.0.0.1:18789
GW_API_KEY=...
```

Полный список переменных с комментариями: [.env.example](./.env.example)

## Архитектура (текущая)

```
Telegram Business API
        ↓ webhook
  secretary-proxy (Express :18792)
        ↓
  scheduler.js — задержка 2/3 мин, отмена если владелец ответил сам
        ↓
  vika.js — промпт с историей (25 сообщений: клиент / Вика / владелец)
        ↓
  LiteLLM / OpenRouter / OpenClaw Gateway
```

```
src/
  server.js      # Express: webhook /tg/business-webhook, админ-API
  scheduler.js   # очередь отложенных ответов (переживает рестарт)
  vika.js        # промпт + вызов LLM
  state.js       # контакты, маппинги, история диалогов (файловый стейт)
  forward.js     # отправка через Telegram API, уведомления владельцу
```

## Документация

| Документ | Содержание |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | Текущая архитектура, поток сообщения, стейт |
| [docs/openclaw-integration.md](./docs/openclaw-integration.md) | Целевая архитектура: единая память, мультиплатформенность |
| [docs/deployment.md](./docs/deployment.md) | Развёртывание: PM2, Nginx, регистрация webhook |
| [docs/vika-style.md](./docs/vika-style.md) | Стиль общения секретаря |
| [docs/memory-update-rules.md](./docs/memory-update-rules.md) | Правила обновления памяти |
| [docs/contacts-template.md](./docs/contacts-template.md) | Шаблон карточки контакта |
| [USE-CASES.md](./USE-CASES.md) | Сценарии применения |
| [ROADMAP.md](./ROADMAP.md) | План развития по этапам |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Как участвовать в разработке |
| [CHANGELOG.md](./CHANGELOG.md) | История изменений |

## Безопасность

- `/api/*` защищён ключом `API_KEY` (заголовок `X-Api-Key`). Без ключа сервер пишет
  предупреждение при старте — не выставляй админ-API наружу без авторизации
- Webhook проверяет `WEBHOOK_SECRET` (заголовок `X-Telegram-Bot-Api-Secret-Token`)
- `.env` держи с `chmod 600`, каталог `STATE_DIR` содержит переписки — бэкапь и не публикуй

⚠️ **Об ответственности:** режим «не раскрывать ИИ-природу» предназначен для личного
использования. В ряде юрисдикций (например, EU AI Act) и на публичных площадках раскрытие
того, что собеседник общается с ИИ, обязательно. Используя шаблон, ты сам отвечаешь за
соответствие местным законам и правилам платформ.

## Участие

PR и issues приветствуются — см. [CONTRIBUTING.md](./CONTRIBUTING.md).
Язык проекта и документации — русский.

## Готовое решение

Этот репозиторий — шаблон. Если хочешь работающий сервис с биллингом, инфраструктурой
и поддержкой: **→ [grandhub.ru](https://grandhub.ru) — личный AI-ассистент для бизнеса**

---

[MIT License](./LICENSE) · Сделано с ❤️ в Санкт-Петербурге
