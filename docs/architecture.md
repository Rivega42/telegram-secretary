# Архитектура telegram-secretary

Секретарь-прокси между владельцем и его контактами в Telegram, построенный по схеме
«коннекторы поверхностей ↔ мозг» (целевая картина — `openclaw-integration.md`,
управление в работе — `operations.md`).

## Зачем

Когда владелец занят / спит / в отпуске — секретарь:
- принимает входящие от любых контактов через Telegram Business;
- отвечает в стиле владельца (персона настраивается в `persona/`);
- эскалирует важное: контакты с политикой `escalate` (семья, VIP) и не-текстовые
  сообщения уходят владельцу без автоответа;
- если владелец ответил сам — автоответ отменяется, а его реплика сохраняется
  в историю (секретарь не противоречит сказанному).

## Карта компонентов: кто с кем работает

```mermaid
flowchart TB
    CLIENT(["Контакт в Telegram"]) -->|пишет владельцу| TGAPI["Telegram Business API"]
    OWNER(["Владелец"]) -.->|отвечает сам| TGAPI
    TGAPI -->|"webhook"| APP
    VKU(["Клиент во ВКонтакте"]) --> VKAPI["VK Callback API"] -->|"/vk/callback"| APP
    WAU(["Клиент в WhatsApp"]) --> WAAPI["WA Cloud API"] -->|"/wa/webhook"| APP

    subgraph PROXY["secretary-proxy (Express)"]
        APP["app.js<br>webhooks + админ-API"]
        CONN["connectors/telegram/business.js<br>+ stt.js (голос → текст)"]
        VKC["connectors/vk/"]
        WAC["connectors/whatsapp/"]
        SCHED["scheduler.js<br>задержка 2/3 мин, отмена"]

        subgraph CORE["ядро src/core/ — платформо-нейтральное"]
            ENV["envelope.js<br>конверт + capabilities"]
            IDENT["identity.js<br>персоны, политики,<br>склейка по подтверждению"]
            PERS["persona.js<br>характер из persona/"]
            BRAIN["brain.js<br>интерфейс мозга"]
            INST["instances.js<br>реестр + маршрутизация"]
        end

        subgraph BRAINS["драйверы src/brains/"]
            SLLM["stateless-llm<br>локальная история"]
            OCLAW["openclaw<br>сессии per-человек"]
        end

        CTRL["connectors/telegram/control.js<br>команды и кнопки владельца"]
        COMM["community.js<br>комменты, Q&A, лиды"]
        CHAN["channel.js<br>автопостинг по плану"]
        MODES["core/modes.js + drafts.js<br>режимы, черновики"]
        FWD["forward.js<br>отправка, DRY_RUN"]
        DB[("secretary.db (SQLite)<br>персоны, история,<br>маппинги, pending")]
    end

    APP --> CONN & VKC & WAC --> ENV
    APP --> IDENT
    APP --> SCHED --> BRAIN
    VKC & WAC & COMM & CHAN --> BRAIN
    BRAIN --> INST & PERS
    BRAIN --> SLLM & OCLAW
    SLLM -->|"chat/completions"| LLM["LiteLLM / OpenRouter /<br>любой OpenAI-совместимый"]
    OCLAW -->|"сессия + user"| OC["OpenClaw-инстанс"]
    OC --- WS[("workspace<br>единая память")]
    SCHED & APP & COMM & CHAN --> FWD
    FWD -->|"ответы от имени владельца"| TGAPI & VKAPI & WAAPI
    FWD -->|"уведомления, эскалации,<br>черновики с кнопками"| NOTIFY["Бот уведомлений<br>(пульт владельца)"]
    NOTIFY -->|"команды, кнопки,<br>группы, лиды (long-polling)"| CTRL
    CTRL --> COMM & CHAN & MODES & SCHED
    APP & IDENT & SCHED <--> DB
```

Ключевое правило слоёв: **платформо-специфичные поля не выходят за пределы
`connectors/`** — ядро и драйверы видят только конверт (`envelope`).
Подробный справочник модулей и функций — [`code-map.md`](./code-map.md).

## Поток входящего сообщения

```mermaid
sequenceDiagram
    autonumber
    participant C as Клиент
    participant TG as Telegram
    participant A as app.js
    participant I as identity
    participant S as scheduler
    participant B as brain
    participant O as Владелец

    C->>TG: сообщение в личку владельца
    TG->>A: webhook business_message
    A->>A: дедупликация update_id
    A->>I: resolvePerson(telegram, user_id)
    alt политика ignore
        A-->>TG: 200 (тишина)
    else политика escalate / не-текст
        A->>O: 🔴 эскалация (без LLM)
    else политика auto
        A->>S: createPending(конверт, persona_id)
        A->>O: 📨 «отвечу через N мин»
        Note over S: задержка 2 мин (день) / 3 мин (ночь)
        opt владелец ответил сам
            O->>TG: своё сообщение в чат
            TG->>A: webhook (from = владелец)
            A->>S: cancelPending ✓
            A->>A: реплика владельца → история (роль owner)
        end
        S->>B: respond(envelope, {persona, person, history})
        B->>B: маршрутизация → инстанс → драйвер
        B-->>S: текст (или fallback из персоны)
        S->>TG: ответ от имени владельца
        TG->>C: сообщение «от владельца»
        S->>A: история ← ответ (только если отправка ok)
        S->>O: 💼 копия ответа
    end
```

## Данные: кто что хранит

Основной стейт — **SQLite** `secretary.db` (better-sqlite3, WAL, issue #26);
старые JSON-файлы импортируются автоматически при первом старте (`*.migrated`).

```mermaid
flowchart LR
    subgraph STATE_DIR["STATE_DIR (в Docker — volume /data)"]
        DB[("secretary.db (SQLite)<br>persons + identities · history<br>conversations · contacts<br>connections · pending")]
        P5["instances.json, mode.json,<br>drafts.json, content-plan.json<br>лёгкие конфиги — файлами"]
        P6["log-YYYY-MM-DD.jsonl<br>все события (ротация LOG_TTL_DAYS)"]
    end
    subgraph PERSONA_DIR["PERSONA_DIR"]
        Q1["persona.json + base.md<br>+ dm.md + public.md"]
    end
```

| Хранилище | Содержание | Кто пишет |
|---|---|---|
| `secretary.db` → `persons`, `person_identities` | Персоны: identities per-платформа, политики `auto/escalate/ignore` (O(1)-резолв) | `core/identity.js` |
| `secretary.db` → `history` | История диалогов per thread, **хронологически**, роли `client`/`vika`/`owner` | `state.js` |
| `secretary.db` → `pending` | Отложенные ответы (+конверт, +person_id); переживает рестарт | `scheduler.js` |
| `secretary.db` → `contacts`, `connections`, `conversations` | Telegram-метаданные и маппинги (индекс по чату) | `state.js` |
| `mode.json`, `drafts.json`, `content-plan.json` | Лёгкие конфиги — остаются файлами (удобно править руками) | `core/modes.js`, `core/drafts.js`, `channel.js` |
| `instances.json` | Реестр мозгов и маршрутизация; секреты через `${ENV}` | владелец (вручную) |
| `log-*.jsonl` | Полный журнал событий | `state.js` |

`contacts` и `persons` — намеренно разные сторы: contacts — сырые
telegram-метаданные (статистика), persons — платформо-независимая идентичность
и политики. Слияние персон между платформами — **только явное** (`/api/persons/:id/merge`).

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
| `GET` | `/api/mode` | Текущий режим (auto/off/vacation) и draft-флаг |
| `GET`/`POST` | `/api/admin/*` | Управление арендаторами (SaaS): реестр, тарифы, персона, расход, онбординг — отдельный `ADMIN_API_KEY`. Полный список — [saas-architecture.md](./saas-architecture.md) |
| `GET` | `/health` | Health check |

Управление режимами и черновиками — командами/кнопками в Telegram
(см. `operations.md`), API даёт чтение состояния.

Все пути `/api/*` требуют заголовок `X-Api-Key` (env `API_KEY`); `/api/admin/*` —
суперадмин-ключ `ADMIN_API_KEY`.

**Маршрутизация вебхука (мультиарендность, SaaS S5):** `POST /tg/business-webhook`
определяет арендатора по `X-Telegram-Bot-Api-Secret-Token` (per-tenant секрет, заданный
при онбординге через `setWebhook`). Нет совпадения — одно-владельческий режим: проверка
глобального `WEBHOOK_SECRET` и арендатор `default`. Per-tenant секреты и bot-токены лежат
в таблице `tenant_secrets` (вне env; наружу через API не отдаются).

## Известные ограничения (осознанные, MVP)

- Очередь pending ключуется telegram-`chat_id` (ВК отвечает без pending);
  при необходимости отложенных ответов на других платформах будет переведена
  на `envelope.thread_key`.
- Кэш `persona`/`instances` живёт до рестарта — правки конфигов требуют перезапуска.
- При падении процесса в момент генерации ответа задача уже снята с очереди —
  ответ не ретраится (владелец видит отсутствие копии).

## Дополнительно

- `operations.md` — управление: режимы, политики, мониторинг, бэкап
- `openclaw-integration.md` — целевая архитектура: единая память, мультиплатформенность
- `vika-style.md` — стиль общения секретаря
- `secretary-proxy-rules.md` — правила «секретарь-прокси»
- `memory-update-rules.md` — как обновлять файлы памяти
- `deployment.md` — как разворачивать (Docker / PM2 + Nginx)
