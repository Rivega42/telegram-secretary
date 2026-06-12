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
    TGAPI -->|"webhook (update)"| APP

    subgraph PROXY["secretary-proxy (Express)"]
        APP["app.js<br>webhook + админ-API"]
        CONN["connectors/telegram/business.js<br>telegram-поля ↔ конверт"]
        SCHED["scheduler.js<br>задержка 2/3 мин, отмена"]

        subgraph CORE["ядро src/core/ — платформо-нейтральное"]
            ENV["envelope.js<br>конверт + capabilities"]
            IDENT["identity.js<br>персоны и политики"]
            PERS["persona.js<br>характер из persona/"]
            BRAIN["brain.js<br>интерфейс мозга"]
            INST["instances.js<br>реестр + маршрутизация"]
            PROMPT["prompt.js<br>общий промпт-билдер"]
        end

        subgraph BRAINS["драйверы src/brains/"]
            SLLM["stateless-llm<br>локальная история"]
            OCLAW["openclaw<br>сессии per-человек"]
        end

        CTRL["connectors/telegram/control.js<br>команды и кнопки владельца"]
        COMM["connectors/telegram/community.js<br>комментарии канала, Q&A в чате<br>(+ rate-limit, публичные черновики)"]
        MODES["core/modes.js + drafts.js<br>режимы, черновики"]
        FWD["forward.js<br>отправка, DRY_RUN"]
        STATE[("state.js + STATE_DIR<br>история, маппинги,<br>persons, pending")]
    end

    APP --> CONN --> ENV
    APP --> IDENT
    APP --> SCHED --> BRAIN
    BRAIN --> INST
    BRAIN --> SLLM & OCLAW
    SLLM & OCLAW --> PROMPT & PERS
    SLLM -->|"chat/completions"| LLM["LiteLLM / OpenRouter /<br>любой OpenAI-совместимый"]
    OCLAW -->|"сессия + user"| OC["OpenClaw-инстанс"]
    OC --- WS[("workspace<br>единая память")]
    APP --> FWD
    SCHED --> FWD
    FWD -->|"ответ от имени владельца"| TGAPI
    FWD -->|"уведомления, копии,<br>эскалации, черновики"| NOTIFY["Бот уведомлений<br>(личка владельца)"]
    NOTIFY -->|"команды /on /off /vacation /draft,<br>кнопки (long-polling)"| CTRL
    GROUP(["Discussion-группа канала /<br>групповой чат"]) -->|"тот же long-polling"| CTRL
    CTRL -->|"сообщения групп"| COMM
    COMM --> BRAIN
    COMM -->|"черновик владельцу"| FWD
    CTRL --> MODES
    CTRL --> SCHED
    APP --> MODES
    APP <--> STATE
```

Ключевое правило слоёв: **telegram-специфичные поля не выходят за пределы
`connectors/`** — ядро и драйверы видят только конверт (`envelope`).

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

```mermaid
flowchart LR
    subgraph STATE_DIR["STATE_DIR (в Docker — volume /data)"]
        P1["persons.json<br>люди, identities, политики"]
        P2["conversations/&lt;id&gt;.jsonl<br>история: client/vika/owner,<br>хронологически"]
        P3["pending.json<br>очередь + конверт"]
        P4["contacts.json, connections.json<br>telegram-стейт"]
        P5["instances.json (опц.)<br>реестр мозгов"]
        P6["log-YYYY-MM-DD.jsonl<br>все события"]
    end
    subgraph PERSONA_DIR["PERSONA_DIR"]
        Q1["persona.json + base.md<br>+ dm.md + public.md"]
    end
```

| Файл | Содержание | Кто пишет |
|---|---|---|
| `persons.json` | Персоны: identities per-платформа, политики `auto/escalate/ignore` | `core/identity.js` |
| `conversations/<mapping>.jsonl` | История диалога, **хронологически**, роли `client`/`vika`/`owner` | `state.js` |
| `pending.json` | Отложенные ответы (+конверт, +person_id); переживает рестарт | `scheduler.js` |
| `contacts.json`, `connections.json` | Telegram-метаданные (статистика контактов, подключения) | `state.js` |
| `instances.json` | Реестр мозгов и маршрутизация; секреты через `${ENV}` | владелец (вручную) |
| `log-*.jsonl` | Полный журнал событий | `state.js` |

`contacts.json` и `persons.json` — намеренно разные сторы: contacts — сырые
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
| `GET` | `/health` | Health check |

Управление режимами и черновиками — командами/кнопками в Telegram
(см. `operations.md`), API даёт чтение состояния.

Все пути `/api/*` требуют заголовок `X-Api-Key` (env `API_KEY`).

## Известные ограничения (осознанные, MVP)

- Файловый стейт с синхронным I/O: `persons.json` перечитывается на каждое сообщение,
  история читается целиком — до ~50 активных диалогов в день это незаметно;
  дальше — SQLite (роадмап, этап 5, issue #26).
- Очередь pending ключуется telegram-`chat_id`; при добавлении второй платформы
  будет переведена на `envelope.thread_key` (этап 4).
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
