# Участие в разработке

Спасибо за интерес к проекту! Язык проекта — **русский**: документация, commit-сообщения,
issues и PR ведём на русском (имена переменных и кода — английские, как принято).

## Как начать

```bash
git clone https://github.com/Rivega42/telegram-secretary
cd telegram-secretary
npm install
cp .env.example .env   # для локальной разработки достаточно DRY_RUN
```

Локальный запуск без реальных токенов и LLM:

```bash
DRY_RUN=true DRY_RUN_VIKA=true OWNER_CHAT_ID=1 npm start
curl http://127.0.0.1:18792/health
```

Эмуляция входящего сообщения:

```bash
curl -X POST http://127.0.0.1:18792/tg/business-webhook \
  -H 'Content-Type: application/json' \
  -d '{"update_id":1,"business_message":{"business_connection_id":"c1","chat":{"id":42},"from":{"id":777,"username":"test","first_name":"Тест"},"text":"привет"}}'
```

## Процесс

1. Найди или создай issue. Крупные фичи обсуждаем в issue **до** написания кода —
   сверься с [ROADMAP.md](./ROADMAP.md) и [docs/openclaw-integration.md](./docs/openclaw-integration.md),
   чтобы не разойтись с целевой архитектурой.
2. Ветка от `main`: `feature/<кратко>`, `fix/<кратко>`, `docs/<кратко>`.
3. Commit-сообщения: `тип: описание` — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
4. Открой PR по шаблону. Draft — пока работа не готова к ревью.

## Документация — обязательная часть изменения

Правило простое: **изменил поведение — обнови документацию в том же PR.**

- Любое изменение `src/**` сопровождается записью в `CHANGELOG.md` (раздел `[Unreleased]`)
- Новые env-переменные → `.env.example` + README
- Изменение потока сообщений / стейта / эндпоинтов → `docs/architecture.md`
- Изменение шагов развёртывания → `docs/deployment.md`
- Архитектурные решения → `docs/openclaw-integration.md`

CI проверяет это автоматически: PR, меняющий `src/**` без изменений в `docs/**`,
`CHANGELOG.md`, `README.md` или `.env.example`, не пройдёт проверку
(`.github/workflows/docs-check.yml`).

## Проверки перед PR

```bash
# Синтаксис
for f in src/*.js; do node --check "$f"; done

# Smoke-тест (сервер должен подняться и ответить на /health)
DRY_RUN=true DRY_RUN_VIKA=true OWNER_CHAT_ID=1 npm start
```

## Принципы кода

- Node.js ≥ 18, ESM (`type: module`), без TypeScript (пока)
- Минимум зависимостей — сейчас их две (`express`, `dotenv`), каждая новая обсуждается в issue
- Любая отправка наружу должна уважать `DRY_RUN` / `DRY_RUN_VIKA`
- Секреты — только через env, никогда в коде и конфигах репозитория
- Платформо-специфичный код не должен протекать в ядро (см. целевую архитектуру)

## Безопасность

Нашёл уязвимость — не открывай публичный issue, напиши владельцу репозитория напрямую.
