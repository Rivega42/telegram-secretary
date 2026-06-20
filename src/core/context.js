/**
 * context.js — контекст арендатора текущего запроса (SaaS, фаза S2)
 *
 * Через AsyncLocalStorage: коннектор на входе вызывает runWithTenant(id, fn),
 * а слой данных внутри читает currentTenantId() и подставляет фильтр по
 * tenant_id. Так изоляция гарантируется слоем данных, а не вызывающим кодом
 * (нельзя «забыть» передать tenant). Без контекста — арендатор `default`,
 * поэтому одно-владельческий режим работает без изменений.
 *
 * См. docs/saas-architecture.md (фаза S2).
 */

import { AsyncLocalStorage } from 'async_hooks';

export const DEFAULT_TENANT = 'default';

const als = new AsyncLocalStorage();

/**
 * Выполнить fn в контексте арендатора. Поддерживает sync и async fn.
 */
export function runWithTenant(tenantId, fn) {
  return als.run({ tenantId: tenantId || DEFAULT_TENANT }, fn);
}

/**
 * Текущий арендатор (или `default`, если контекст не установлен).
 */
export function currentTenantId() {
  return als.getStore()?.tenantId || DEFAULT_TENANT;
}
