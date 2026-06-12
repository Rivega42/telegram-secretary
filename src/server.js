/**
 * server.js — точка входа: валидация окружения, запуск Express, восстановление pending
 *
 * Логика приложения — в app.js (отделено, чтобы тесты могли поднимать
 * приложение без сайд-эффектов listen/loadPending).
 */

import 'dotenv/config';
import { createApp, createControlActions } from './app.js';
import { loadPendingFromFile, getDelayMinutes } from './scheduler.js';
import { startControlLoop } from './connectors/telegram/control.js';
import { startPostingSchedule } from './connectors/telegram/channel.js';
import { getSettings } from './core/modes.js';
import { rotateLogs } from './state.js';

const PORT = process.env.PORT || 18792;

/**
 * Проверка обязательных переменных при старте: лучше упасть с понятным
 * сообщением, чем молча стартовать и сломаться на первом сообщении.
 * В DRY_RUN-режимах — только предупреждения.
 */
function validateEnv() {
  const dryRun = process.env.DRY_RUN === 'true';
  const dryRunBrain = process.env.DRY_RUN_BRAIN === 'true' || process.env.DRY_RUN_VIKA === 'true';
  const problems = [];

  if (!process.env.BUSINESS_BOT_TOKEN) problems.push('BUSINESS_BOT_TOKEN — токен Business-бота');
  if (!process.env.OWNER_CHAT_ID) problems.push('OWNER_CHAT_ID — Telegram ID владельца');
  if (!process.env.ONEINT_BOT_TOKEN) problems.push('ONEINT_BOT_TOKEN — токен бота уведомлений');

  const hasLlm = process.env.LITELLM_API_KEY || process.env.GW_API_KEY
    || process.env.OPENCLAW_GATEWAY_TOKEN || process.env.INSTANCES_FILE;
  if (!hasLlm && !dryRunBrain) {
    problems.push('LLM: LITELLM_BASE_URL+LITELLM_API_KEY или GW_API_KEY (или DRY_RUN_BRAIN=true)');
  }

  if (problems.length) {
    if (dryRun) {
      console.warn('⚠️  Не заполнено (ок для DRY_RUN):\n   - ' + problems.join('\n   - '));
    } else {
      console.error('❌ Не заполнены обязательные переменные окружения:\n   - ' + problems.join('\n   - '));
      console.error('   Заполни .env (см. .env.example) или запусти с DRY_RUN=true для отладки.');
      process.exit(1);
    }
  }
}

validateEnv();

const app = createApp();

// Восстановить отложенные ответы, пережившие рестарт
loadPendingFromFile();

// Ротация логов (содержат переписки): при старте и раз в сутки
rotateLogs();
setInterval(rotateLogs, 24 * 60 * 60 * 1000).unref();

// Control plane: команды и кнопки владельца через бота уведомлений.
// В DRY_RUN не поллим (токены обычно фиктивные); CONTROL_POLLING=false — выключить.
if (process.env.CONTROL_POLLING !== 'false' && process.env.DRY_RUN !== 'true') {
  startControlLoop(createControlActions());
}

// Автопостинг канала (включается, если заданы CHANNEL_ID и POSTING_TIMES)
startPostingSchedule(createControlActions());

app.listen(PORT, () => {
  console.log(`\n🚀 Secretary Proxy started on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Webhook: POST http://localhost:${PORT}/tg/business-webhook`);
  console.log(`   Reply: POST http://localhost:${PORT}/api/reply`);
  console.log(`   Contacts: GET http://localhost:${PORT}/api/contacts`);
  console.log(`   Persons: GET http://localhost:${PORT}/api/persons`);
  console.log(`   Conversations: GET http://localhost:${PORT}/api/conversations`);
  console.log(`   Pending: GET http://localhost:${PORT}/api/pending`);
  console.log(`\n   Brain driver: ${process.env.BRAIN_DRIVER || 'stateless-llm'}`);
  const settings = getSettings();
  console.log(`   Mode: ${settings.mode}${settings.draft ? ' + draft' : ''} (управление: /on /off /vacation /draft /status в боте уведомлений)`);
  console.log(`   DRY_RUN: ${process.env.DRY_RUN === 'true' ? 'YES' : 'NO'}`);
  console.log(`   State dir: ${process.env.STATE_DIR || './state'}`);
  console.log(`   Persona dir: ${process.env.PERSONA_DIR || './persona'}`);
  console.log(`   Current delay: ${getDelayMinutes()} minutes (${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} MSK)`);
  if (!process.env.API_KEY) {
    console.warn('   ⚠️  API_KEY не задан — /api/* доступен без авторизации. Задай API_KEY в .env или закрой /api/* на уровне reverse-proxy.');
  }
  if (!process.env.WEBHOOK_SECRET) {
    console.warn('   ⚠️  WEBHOOK_SECRET не задан — webhook принимает запросы без проверки секрета.');
  }
  console.log('');
});
