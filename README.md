# 🤖 Telegram Secretary

OpenClaw-агент для ответов в Telegram-чатах, когда владелец занят.

## Что это

Этот репозиторий содержит конфигурацию OpenClaw gateway, настроенную как **личный секретарь** в Telegram. Агент:

- Подключается к указанным Telegram-группам и чатам
- Отвечает на сообщения, когда владелец не может ответить
- Использует Claude Sonnet/Opus (через Claude Max) или DeepSeek
- Хранит контекст бесед, учится стилю владельца
- Может работать 24/7 на VPS

## Структура

```
├── openclaw.json          # Конфигурация OpenClaw gateway
├── workspace/
│   ├── SOUL.md            # Личность агента
│   ├── AGENTS.md          # Правила работы
│   ├── USER.md            # Данные владельца
│   ├── MEMORY.md          # Долгосрочная память
│   ├── IDENTITY.md        # Самоидентификация
│   └── memory/            # Ежедневные логи и память
├── entrypoint.sh          # Скрипт запуска (Docker/host)
├── .env.example           # Шаблон переменных окружения
└── docker-compose.yml     # Docker Compose для деплоя
```

## Быстрый старт

### На VPS (рекомендуется)

```bash
git clone https://github.com/Rivega42/telegram-secretary
cd telegram-secretary
cp .env.example .env
# Отредактируй .env: BOT_TOKEN, MODEL и т.д.
docker compose up -d
```

### Напрямую (без Docker)

```bash
# Требуется Node.js 22+
npm install -g openclaw@latest
OPENCLAW_HOME=$(pwd)/workspace openclaw gateway run --port 18789
```

## Переменные окружения

| Переменная | Обязательно | Описание |
|-----------|-------------|----------|
| `BOT_TOKEN` | ✅ | Токен Telegram бота от @BotFather |
| `ANTHROPIC_API_KEY` | ✅ | Ключ Anthropic Claude (Claude Max) |
| `DEEPSEEK_API_KEY` | — | Ключ DeepSeek для fallback |

## Telegram Groups

В `openclaw.json` указываются ID групп, в которых агент отвечает:

```json
"groups": {
  "-1001234567890": {
    "enabled": true,
    "topics": {
      "2": { "requireMention": false, "enabled": true }
    }
  }
}
```

## License

MIT
