/**
 * robokassa.js — приём оплаты через Robokassa (SaaS-биллинг)
 *
 * Поток: createInvoice (ядро) → buildPaymentUrl (ссылка клиенту) → клиент платит →
 * Robokassa дёргает Result URL (server-to-server) → verifyResult (подпись MD5) →
 * markInvoicePaid (ядро) → ответ `OK<InvId>`.
 *
 * Провайдеро-специфика (подписи, формат URL) — только здесь. Креды сервиса —
 * в env (единый аккаунт Robokassa на сервис, не per-tenant).
 *
 * Подписи (MD5):
 *   ссылка оплаты: md5(MerchantLogin:OutSum:InvId:Password1)
 *   Result URL:    md5(OutSum:InvId:Password2)
 */

import crypto from 'crypto';

const PAY_BASE = 'https://auth.robokassa.ru/Merchant/Index.aspx';

function cfg() {
  return {
    login: process.env.ROBOKASSA_MERCHANT_LOGIN || '',
    password1: process.env.ROBOKASSA_PASSWORD1 || '',
    password2: process.env.ROBOKASSA_PASSWORD2 || '',
    isTest: process.env.ROBOKASSA_TEST === 'true' || process.env.ROBOKASSA_TEST === '1'
  };
}

export function isConfigured() {
  const c = cfg();
  return !!(c.login && c.password1 && c.password2);
}

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

/** Сумма в строку для подписи и URL (Robokassa: целые без хвоста). */
function fmtSum(amount) {
  return String(amount);
}

/**
 * Ссылка оплаты для счёта { inv_id, amount, plan }.
 */
export function buildPaymentUrl(invoice, { description } = {}) {
  const c = cfg();
  if (!isConfigured()) return { ok: false, error: 'Robokassa не настроена (ROBOKASSA_*)' };
  const outSum = fmtSum(invoice.amount);
  const desc = description || `Тариф ${invoice.plan} (счёт ${invoice.inv_id})`;
  const signature = md5(`${c.login}:${outSum}:${invoice.inv_id}:${c.password1}`);

  const params = new URLSearchParams({
    MerchantLogin: c.login,
    OutSum: outSum,
    InvId: String(invoice.inv_id),
    Description: desc,
    SignatureValue: signature,
    Culture: 'ru',
    Encoding: 'utf-8'
  });
  if (c.isTest) params.set('IsTest', '1');
  return { ok: true, url: `${PAY_BASE}?${params.toString()}` };
}

/**
 * Проверка подписи Result URL. params — поля запроса Robokassa (любой регистр ключей
 * нормализуем). true — подпись валидна.
 */
export function verifyResult({ OutSum, InvId, SignatureValue } = {}) {
  const c = cfg();
  if (!isConfigured() || !OutSum || !InvId || !SignatureValue) return false;
  const expected = md5(`${OutSum}:${InvId}:${c.password2}`);
  // timing-safe сравнение хэшей одинаковой длины
  const a = Buffer.from(expected.toLowerCase());
  const b = Buffer.from(String(SignatureValue).toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Тело ответа Robokassa на успешный Result (подтверждение приёма). */
export function resultAck(invId) {
  return `OK${invId}`;
}
