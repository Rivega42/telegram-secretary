# Развёртывание telegram-secretary

## Требования

- Docker (рекомендуется) **или** Node.js ≥ 18 + PM2
- Nginx с публичным HTTPS-доменом для webhook
- Два Telegram бота:
  - **Business-бот** — с включённым Business Mode (через @BotFather → Bot Settings → Business Mode)
  - **Бот уведомлений** — обычный бот для control plane владельца

## Вариант А: Docker (рекомендуется)

```bash
git clone https://github.com/Rivega42/telegram-secretary.git /opt/telegram-secretary
cd /opt/telegram-secretary
cp .env.example .env && chmod 600 .env
nano .env                      # заполнить (см. шаг «Конфигурация» ниже)

docker compose up -d           # только прокси
# или вместе с локальным OpenClaw Gateway (единая память):
docker compose --profile gateway up -d

docker compose logs -f secretary
curl http://127.0.0.1:18792/health
```

Стейт живёт в named volume `secretary-state` (внутри контейнера `/data`) и переживает
пересоздание контейнера. Бэкап: `docker run --rm -v secretary-state:/data -v $(pwd):/backup
alpine tar czf /backup/secretary-state.tar.gz /data`.

Обновление:

```bash
cd /opt/telegram-secretary
git pull
docker compose up -d --build
```

Дальше — шаги 4–6 (Nginx, регистрация webhook, подключение Business).

## Вариант Б: PM2

### Шаги

### 1. Подготовка сервера

```bash
git clone git@github.com:Rivega42/telegram-secretary.git /opt/telegram-secretary
cd /opt/telegram-secretary
npm install --omit=dev
mkdir -p /opt/telegram-secretary/state
```

### 2. Конфигурация

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Заполнить:
- `BUSINESS_BOT_TOKEN` — токен @VikaSecretary_bot
- `ONEINT_BOT_TOKEN` — токен @OneInt_bot
- `OWNER_CHAT_ID` — Telegram ID владельца
- `WEBHOOK_SECRET` — случайная строка (проверяется в заголовке webhook)
- `API_KEY` — случайная строка для авторизации админ-API `/api/*`
- `STATE_DIR` — путь к каталогу состояния
- LLM: `LITELLM_BASE_URL`+`LITELLM_API_KEY`+`VIKA_MODEL` либо `GW_BASE_URL`+`GW_API_KEY`

### 3. PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Проверка:
```bash
pm2 status secretary-proxy
pm2 logs secretary-proxy --lines 30
curl http://127.0.0.1:18792/health
```

### 4. Nginx

Положить `nginx/secretary-webhook.conf` в `/etc/nginx/sites-available/`, симлинк в `sites-enabled/`, перезагрузить:

```bash
ln -sf /opt/telegram-secretary/nginx/secretary-webhook.conf /etc/nginx/sites-available/
ln -sf /etc/nginx/sites-available/secretary-webhook.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 5. Регистрация webhook в Telegram

```bash
BOT_TOKEN="$BUSINESS_BOT_TOKEN"
SECRET="$WEBHOOK_SECRET"
WEBHOOK_URL="https://your-domain.example/secretary/tg/business-webhook"

curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WEBHOOK_URL}\",
    \"secret_token\": \"${SECRET}\",
    \"allowed_updates\": [
      \"message\",
      \"business_connection\",
      \"business_message\",
      \"edited_business_message\",
      \"deleted_business_messages\"
    ]
  }"
```

Проверка:
```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq
```

Поле `pending_update_count` должно быть `0`, `last_error_message` — пустое.

### 6. Подключение Business

Владелец в Telegram:
1. Открыть **Settings → Business → Chatbots**
2. Указать username `@VikaSecretary_bot`
3. Дать разрешения (read/reply)

После подключения secretary-proxy получит `business_connection` событие — оно сохранится в БД (`secretary.db`, таблица connections).

## Проверка работы

1. Любой контакт пишет владельцу
2. В `log-YYYY-MM-DD.jsonl` появится запись `type: "update"`, владельцу придёт уведомление с кнопками
3. Через **2 минуты** (днём) либо **3 минуты** (ночью) — секретарь отвечает в чат от имени владельца
4. Если владелец ответил сам — отложенный ответ отменяется

## Обновление

```bash
cd /opt/telegram-secretary
git pull
npm install --omit=dev
pm2 restart secretary-proxy
```

Стейт (`state/`) сохраняется между обновлениями.

## Бэкап

Весь стейт — в `STATE_DIR`: SQLite `secretary.db` (+`-wal`/`-shm`), лёгкие
конфиги (`mode.json`, `drafts.json`, `content-plan.json`, `instances.json`) и логи.

```bash
# Консистентный снимок БД (безопасно на работающем сервисе):
sqlite3 "$STATE_DIR/secretary.db" ".backup '/backup/secretary-$(date +%Y%m%d).db'"
# Либо весь каталог (останови сервис для полной консистентности WAL):
tar czf /backup/secretary-state-$(date +%Y%m%d).tar.gz "$STATE_DIR"
```

Перед launch — оцени `docs/production-readiness.md` (готовность, чеклист, ограничения).

## Откат

```bash
git checkout <previous-tag>
npm install --omit=dev
pm2 restart secretary-proxy
```
