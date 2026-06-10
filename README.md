# telegram-secretary

> AI-секретарь для Telegram — отвечает за тебя, ведёт каналы, не раскрывает себя.

Открытый шаблон на Node.js. Разворачивается за 10 минут. Работает через любой OpenAI-совместимый API.

**Хочешь готовое решение без настройки?** → [grandhub.ru](https://grandhub.ru)

---

## Что это

Прокси-сервер между Telegram Business API и LLM. Когда тебе пишут в личку, а ты занят — ассистент отвечает сам. Поддерживает контекст последних 25 сообщений, знает кто пишет, помнит историю диалога.

- Ответ через 2 мин днём, 3 мин ночью (настраивается)
- Контекст 25 сообщений с таймстемпами
- Копирует твой стиль общения
- Не раскрывает AI-природу
- Работает через OCPlatform Gateway или любой OpenAI-совместимый эндпоинт

## Быстрый старт

```bash
git clone https://github.com/Rivega42/telegram-secretary
cd telegram-secretary
cp .env.example .env
# Заполни .env
npm install
npm start
```

## .env

```env
BUSINESS_BOT_TOKEN=    # токен бота с подключением к Telegram Business
OWNER_CHAT_ID=         # твой Telegram ID (кому слать уведомления)
PORT=18792
STATE_DIR=./state

# LLM (выбери одно):
# Вариант 1 — OCPlatform Gateway (если есть)
GW_API_KEY=            # токен шлюза
# VIKA_MODEL по умолчанию: openclaw

# Вариант 2 — любой OpenAI-совместимый
LITELLM_BASE_URL=http://localhost:4000
VIKA_MODEL=openai/gpt-4o
```

## Архитектура

```
Telegram Business API
        ↓
  secretary-proxy (Express :18792)
        ↓
  scheduler.js — задержка 2/3 мин
        ↓
  vika.js — строит промпт с историей
        ↓
  OCPlatform Gateway / LiteLLM
        ↓
  Claude Sonnet / DeepSeek Flash
```

## Структура

```
src/
  server.js      # Express, webhook /tg/business-webhook
  scheduler.js   # Очередь задач с задержкой
  vika.js        # Промпт, вызов LLM
  state.js       # История диалогов (файловый стейт)
landing/
  index.html     # Лендинг про AI-ассистента
```

## Roadmap

Подробный план развития — [ROADMAP.md](./ROADMAP.md):

- Ведение Telegram-канала (автопостинг, комментарии)
- Воронка: канал → бот → продажа
- Проактивный дайджест владельцу (горячие лиды)
- ВКонтакте, Instagram, WhatsApp
- Голосовые сообщения (Whisper)

## Готовое решение

Этот репозиторий — шаблон. Если хочешь работающий сервис с биллингом, инфраструктурой и поддержкой:

**→ [grandhub.ru](https://grandhub.ru) — личный AI-ассистент для бизнеса**

---

MIT License · Сделано с ❤️ в Санкт-Петербурге
