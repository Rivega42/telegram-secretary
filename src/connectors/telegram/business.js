/**
 * business.js — коннектор Telegram Business (личка от имени владельца)
 *
 * Единственное место, где telegram-поля business_message превращаются
 * в платформо-нейтральный конверт. Ядро (core/, brains/) telegram-полей не видит:
 * business_connection_id и chat_id живут в envelope.raw и используются
 * только здесь при отправке ответа.
 */

import { createEnvelope } from '../../core/envelope.js';
import { sendBusinessReply } from '../../forward.js';

const ATTACHMENT_FIELDS = [
  ['voice', 'voice'],
  ['audio', 'audio'],
  ['photo', 'photo'],
  ['video', 'video'],
  ['video_note', 'video_note'],
  ['document', 'document'],
  ['sticker', 'sticker'],
  ['location', 'location'],
  ['contact', 'contact']
];

export function detectAttachments(msg) {
  const attachments = [];
  for (const [field, type] of ATTACHMENT_FIELDS) {
    if (msg[field]) attachments.push({ type });
  }
  return attachments;
}

/**
 * business_message → envelope.
 */
export function toEnvelope(msg) {
  return createEnvelope({
    platform: 'telegram',
    surface: 'dm',
    identity: {
      platform_user_id: msg.from.id,
      username: msg.from.username || null,
      display_name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
    },
    threadKey: `telegram:dm:${msg.chat.id}`,
    text: msg.text || msg.caption || '',
    attachments: detectAttachments(msg),
    capabilities: { typing: true, read_receipt: true, buttons: false, edit: false },
    raw: {
      business_connection_id: msg.business_connection_id,
      chat_id: msg.chat.id,
      message_id: msg.message_id
    }
  });
}

/**
 * Отправка ответа в чат, из которого пришёл конверт.
 */
export async function reply(envelope, text) {
  return sendBusinessReply(envelope.raw.business_connection_id, envelope.raw.chat_id, text);
}
