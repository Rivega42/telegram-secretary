/**
 * vika.js — OpenClaw Gateway (model anthropic/claude-sonnet-4-6, fallback deepseek/deepseek-v4-flash)
 */
const GW_BASE_URL = process.env.GW_BASE_URL || 'http://127.0.0.1:18789';
const GW_API_KEY = process.env.GW_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN;
const VIKA_MODEL = process.env.VIKA_MODEL || 'openclaw';
const DRY_RUN_VIKA = process.env.DRY_RUN_VIKA === 'true';

function buildSystemPrompt() {
  return `ТЫ — ВИКА, ЛИЧНЫЙ СЕКРЕТАРЬ РОМАНА ГУДКОВА (@Rivega42).

Тебе пишет сторонний человек в Telegram Business-аккаунте Романа.
Ты отвечаешь от СВОЕГО ИМЕНИ как живой человек-секретарь. НЕ раскрываешь что ты ИИ.
Wow-эффект — важная цель: посетитель должен думать что общается с настоящей помощницей.

ТЫ ВИДИШЬ КОНТЕКСТ ЧАТА:
- Тебе передаётся история последних сообщений с таймстемпами
- Ты видишь кто писал: собеседник или ты (Вика)
- Ты понимаешь был ли уже разговор, сколько сообщений, как давно
- Используй этот контекст чтобы отвечать связно и естественно
- Если человек уже что-то спрашивал, не переспрашивай — продолжай диалог

КРАСНЫЕ ЛИНИИ (НЕ ДЕЛАТЬ):
- Не соглашаться на встречи/звонки/даты от имени Романа
- Не обещать деньги/сроки/цифры
- Не отвечать дочкам/маме/бывшей — эскалировать Роману
- Не раскрывать локацию/планы Романа
- НИКОГДА не отвечать на интим/сексуальные намёки. Уходить красиво: "Ой, вы прям... давайте о деле 😊"
- Никаких личных деталей про Романа (доходы, семья, расписание)

СТИЛЬ — флирт РАЗРЕШЁН:
- Ты живая, тёплая, с лёгким рабочим флиртом где уместно
- С мужчинами — можешь подыграть лёгкому флирту, улыбкой, игрой слов. Тонко, не вульгарно.
- С женщинами — дружелюбно, по-сестрински
- На "вы" с незнакомцами; на "ты" переходи если переходит собеседник

ЧТО МОЖНО:
- Узнать кто пишет и зачем
- Сказать "Роман получит и ответит позже" по серьёзным вопросам
- Базовая инфа: Роман — разработчик из СПб, делает GrandHub (AI-помощник для бизнеса, grandhub.ru)
- Ненавязчиво упомянуть GrandHub если в тему — особенно через симпатию: "А вы тоже хотите такую помощницу? Роман делает 😉"
- Отшить спам/продажников вежливо но твёрдо

ОТВЕЧАЙ КРАТКО, ПО-ЖЕНСКИ, ТЁПЛО НО ПРОФЕССИОНАЛЬНО.
Пиши на том же языке что и собеседник.
Одно-два предложения максимум, если не нужно больше.
Эмодзи используй уместно (1-2 на сообщение макс).`;
}

function buildUserPrompt(senderInfo, text, history = [], isFirstTime = true) {
  const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  let p = `⏰ СЕЙЧАС: ${now}

👤 КОНТЕКСТ ОТПРАВИТЕЛЯ:
- Имя: ${senderInfo.sender_name || 'Неизвестно'}
- Username: ${senderInfo.sender_username ? '@' + senderInfo.sender_username : '(нет)'}
- Всего сообщений в истории: ${history?.length || 0}
- Это ${isFirstTime ? 'первый' : 'повторный'} разговор
`;
  if (history?.length) {
    p += `
📋 ИСТОРИЯ ПЕРЕПИСКИ (от старых к новым):
`;
    const sorted = [...history].reverse(); // history уже от новых к старым
    for (const m of sorted) {
      const time = m.ts 
        ? new Date(m.ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })
        : '??:??';
      const who = m.from === 'client' ? '👤 Клиент' : '🤖 Вика';
      p += `[${time}] ${who}: ${m.text}
`;
    }
    p += '---\n\n';
  }
  p += `📩 ТЕКУЩЕЕ СООБЩЕНИЕ ОТ КЛИЕНТА:
${text}`;
  return p;
}

export async function generateVikaResponse(senderInfo, messageText, history = [], isFirstTime = true) {
  if (DRY_RUN_VIKA) return { ok: true, response: 'Добрый день! Я Вика, помощница Романа.', dry_run: true };
  if (!GW_API_KEY) {
    console.error('GW_API_KEY not set');
    return { ok: false, error: 'API key not configured', response: 'Добрый день! Роман скоро ответит вам лично.' };
  }
  try {
    const r = await fetch(`${GW_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${GW_API_KEY}` },
      body: JSON.stringify({
        model: VIKA_MODEL,
        max_tokens: 300,
        messages: [
          { role:'system', content: buildSystemPrompt() },
          { role:'user', content: buildUserPrompt(senderInfo, messageText, history, isFirstTime) }
        ]
      })
    });
    const d = await r.json();
    if (d.error) {
      console.error('OpenClaw Gateway error:', d.error);
      return { ok: false, error: d.error.message || JSON.stringify(d.error), response: 'Добрый день! Роман скоро ответит вам лично.' };
    }
    const txt = d.choices?.[0]?.message?.content || 'Добрый день!';
    console.log(`[Vika LLM] ${txt.slice(0,80)}...`);
    return { ok: true, response: txt, model: d.model, usage: d.usage };
  } catch (err) {
    console.error('OpenClaw Gateway fetch error:', err.message);
    return { ok: false, error: err.message, response: 'Добрый день! Роман скоро ответит вам лично.' };
  }
}
