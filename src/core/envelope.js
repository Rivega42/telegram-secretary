/**
 * envelope.js — платформо-нейтральный конверт входящего сообщения
 *
 * Единственный формат, в котором ядро (core/, brains/) видит сообщения.
 * Платформо-специфичные поля (business_connection_id и т.п.) живут в `raw`
 * и используются только коннектором, который создал конверт.
 *
 * Поверхности (surface): dm | comments | channel_post | group
 */

export const SURFACES = ['dm', 'comments', 'channel_post', 'group'];

export function createEnvelope({
  platform,
  surface,
  identity,
  threadKey,
  text = '',
  attachments = [],
  capabilities = {},
  raw = {}
}) {
  if (!platform) throw new Error('envelope: platform is required');
  if (!SURFACES.includes(surface)) throw new Error(`envelope: unknown surface "${surface}"`);
  if (!identity || identity.platform_user_id === undefined || identity.platform_user_id === null) {
    throw new Error('envelope: identity.platform_user_id is required');
  }
  if (!threadKey) throw new Error('envelope: threadKey is required');

  return {
    platform,
    surface,
    identity: {
      platform_user_id: String(identity.platform_user_id),
      username: identity.username || null,
      display_name: identity.display_name || ''
    },
    thread_key: threadKey,
    text: text || '',
    attachments,
    capabilities: {
      typing: false,
      read_receipt: false,
      buttons: false,
      edit: false,
      ...capabilities
    },
    raw,
    received_at: new Date().toISOString()
  };
}

/**
 * Ключ маршрутизации для реестра инстансов: "telegram:dm"
 */
export function routingKey(envelope) {
  return `${envelope.platform}:${envelope.surface}`;
}
