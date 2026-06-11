/**
 * control.js — control plane владельца через бота уведомлений
 *
 * Принимает (long-polling getUpdates, только от OWNER_CHAT_ID):
 * - команды: /on /off /vacation /draft /status /help
 * - нажатия inline-кнопок (callback_query):
 *     pend:now:<chatId>      — ответить сейчас
 *     rep:<mappingId>        — «свой ответ»: следующий текст владельца уйдёт клиенту
 *     pend:cancel:<chatId>   — отменить автоответ
 *     draft:ok:<mappingId>   — отправить черновик клиенту
 *     draft:rw:<mappingId>   — переписать (следующий текст владельца — комментарий)
 *     draft:no:<mappingId>   — отбросить черновик
 *     pol:<policy>:<personId> — политика контакта (escalate/ignore/auto)
 * - свободный текст — если ожидается («свой ответ» / комментарий к переписыванию)
 *
 * Логика действий вынесена в handleControlUpdate (тестируется без сети);
 * startControlLoop — только транспорт.
 */

import { getControlUpdates, answerCallback, notifyOwnerText } from '../../forward.js';
import { getSettings, setMode, setDraft, VACATION_DELAY_SECONDS } from '../../core/modes.js';
import { setPersonPolicy, POLICIES } from '../../core/identity.js';
import { cancelPending, executePendingNow, getAllPending } from '../../scheduler.js';

const OWNER_CHAT_ID = () => String(process.env.OWNER_CHAT_ID || '');

// Ожидание свободного текста владельца: { type: 'reply'|'rewrite', ...context }
let awaitingInput = null;

export function getAwaitingInput() {
  return awaitingInput;
}

export function clearAwaitingInput() {
  awaitingInput = null;
}

const HELP_TEXT = `Команды секретаря:
/on — обычный режим (автоответ с задержкой)
/off — я свободен: только уведомления, без автоответов
/vacation — отпуск: отвечать почти сразу (~${VACATION_DELAY_SECONDS} сек)
/draft — вкл/выкл режим черновиков (ответ уходит только после твоего подтверждения)
/status — текущий режим и очередь
/help — эта справка

Кнопки под уведомлениями: ответить сейчас / свой ответ / отменить,
политика контакта (только мне / игнорить / авто).`;

function statusText() {
  const s = getSettings();
  const pending = Object.keys(getAllPending()).length;
  const modeLabel = { auto: '🟢 авто', off: '⏸ выключен (только уведомления)', vacation: '🏖 отпуск (быстрый ответ)' }[s.mode];
  return `Режим: ${modeLabel}\nЧерновики: ${s.draft ? '📝 включены (нужно подтверждение)' : 'выключены (автоотправка)'}\nОжидают ответа: ${pending}`;
}

/**
 * Обработать команду владельца. Возвращает текст ответа или null.
 */
export function handleCommand(text) {
  const cmd = text.trim().split(/[\s@]/)[0].toLowerCase();
  switch (cmd) {
    case '/on': setMode('auto'); return `🟢 Обычный режим.\n\n${statusText()}`;
    case '/off': setMode('off'); return `⏸ Автоответы выключены — буду только уведомлять.\n\n${statusText()}`;
    case '/vacation': setMode('vacation'); return `🏖 Режим отпуска — отвечаю почти сразу.\n\n${statusText()}`;
    case '/draft': {
      const next = !getSettings().draft;
      setDraft(next);
      return next
        ? '📝 Черновики включены: ответы будут приходить тебе на подтверждение.'
        : '📤 Черновики выключены: ответы уходят автоматически.';
    }
    case '/status': return statusText();
    case '/start':
    case '/help': return HELP_TEXT;
    default: return null;
  }
}

/**
 * Обработать callback кнопки. actions — внедряются из app.js
 * (sendReplyToClient, approveDraft, rejectDraft, requestRewrite).
 * Возвращает короткий текст для toast.
 */
export async function handleCallback(data, actions) {
  const [ns, op, ...rest] = String(data).split(':');
  const arg = rest.join(':');

  if (ns === 'pend') {
    if (op === 'now') {
      const done = await executePendingNow(arg);
      return done ? '⚡ Отвечаю сейчас' : 'Задача уже не актуальна';
    }
    if (op === 'cancel') {
      return cancelPending(arg, 'cancelled by owner button')
        ? '🚫 Автоответ отменён' : 'Задача уже не актуальна';
    }
  }

  // «Свой ответ» — работает и при pending, и без него (эскалация, режим off);
  // отправка через sendReplyToClient сама отменит pending этого чата
  if (ns === 'rep') {
    const mappingId = [op, ...rest].filter(Boolean).join(':');
    awaitingInput = { type: 'reply', mappingId };
    await notifyOwnerText('✍️ Напиши ответ — отправлю от имени секретаря.');
    return 'Жду твой текст';
  }

  if (ns === 'draft') {
    if (op === 'ok') return actions.approveDraft(arg);
    if (op === 'no') return actions.rejectDraft(arg);
    if (op === 'rw') {
      awaitingInput = { type: 'rewrite', mappingId: arg };
      await notifyOwnerText('✍️ Напиши, что поправить («короче», «без эмодзи», «предложи звонок»…) — перегенерирую.');
      return 'Жду комментарий';
    }
  }

  if (ns === 'pol' && POLICIES.includes(op)) {
    const result = setPersonPolicy(arg, op);
    if (!result.ok) return result.error;
    const labels = { escalate: '🔴 только тебе (без автоответа)', ignore: '🔇 игнорируется', auto: '🟢 автоответ' };
    return `Политика: ${labels[op]}`;
  }

  return 'Неизвестное действие';
}

/**
 * Обработать один update control-бота. Транспортно-независимо (тестируемо).
 */
export async function handleControlUpdate(update, actions) {
  // Кнопки
  if (update.callback_query) {
    const cb = update.callback_query;
    if (String(cb.from?.id) !== OWNER_CHAT_ID()) {
      await answerCallback(cb.id, 'Не твоя кнопка 😉');
      return;
    }
    const toast = await handleCallback(cb.data, actions);
    await answerCallback(cb.id, toast || '');
    return;
  }

  // Сообщения — только от владельца
  const msg = update.message;
  if (!msg || String(msg.from?.id) !== OWNER_CHAT_ID()) return;
  const text = msg.text || '';

  // Команды
  if (text.startsWith('/')) {
    const reply = handleCommand(text);
    await notifyOwnerText(reply || 'Не понял команду. /help — справка.');
    return;
  }

  // Свободный текст — только если его ждём
  if (awaitingInput) {
    const ctx = awaitingInput;
    awaitingInput = null;
    if (ctx.type === 'reply') {
      const result = await actions.sendReplyToClient(ctx.mappingId, text);
      await notifyOwnerText(result.ok ? '✅ Отправлено от имени секретаря.' : `⚠️ Не удалось отправить: ${result.error}`);
    } else if (ctx.type === 'rewrite') {
      await notifyOwnerText('🔄 Переписываю…');
      await actions.requestRewrite(ctx.mappingId, text);
    }
    return;
  }

  await notifyOwnerText('Это control-чат секретаря. /help — команды. Чтобы ответить клиенту — используй кнопку «Свой ответ» под уведомлением.');
}

/**
 * Запустить long-polling цикл. Останавливается возвратом stop().
 */
export function startControlLoop(actions) {
  if (!process.env.ONEINT_BOT_TOKEN) {
    console.warn('[Control] ONEINT_BOT_TOKEN не задан — управление из Telegram отключено');
    return { stop: () => {} };
  }

  let running = true;
  let offset = 0;

  (async () => {
    console.log('[Control] Long-polling управления запущен (команды и кнопки владельца)');
    while (running) {
      const result = await getControlUpdates(offset);
      if (!running) break;
      if (!result.ok) {
        // сеть/конфликт — подождать и продолжить
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      for (const update of result.result || []) {
        offset = update.update_id + 1;
        try {
          await handleControlUpdate(update, actions);
        } catch (err) {
          console.error('[Control] Error handling update:', err);
        }
      }
    }
  })();

  return { stop: () => { running = false; } };
}
