/**
 * instances.js — реестр LLM/OpenClaw-инстансов и маршрутизация поверхностей
 *
 * Конфиг INSTANCES_FILE (по умолчанию STATE_DIR/instances.json):
 * {
 *   "instances": {
 *     "main":  { "driver": "openclaw", "base_url": "http://127.0.0.1:18789",
 *                "api_key": "${GW_API_KEY}", "model": "openclaw", "stateful": true },
 *     "cheap": { "driver": "stateless-llm", "base_url": "${LITELLM_BASE_URL}",
 *                "api_key": "${LITELLM_API_KEY}", "model": "openai/gpt-4o-mini" }
 *   },
 *   "routing": { "telegram:dm": "main", "default": "main" }
 * }
 *
 * Значения вида "${VAR}" подставляются из process.env — секреты не хранятся в файле.
 * Если файла нет — синтезируется один инстанс из env (LITELLM_* приоритетнее GW_*),
 * это режим «из коробки» без отдельного конфига.
 *
 * Инвариант: один владелец = один workspace памяти. Инстансов может быть много
 * (разные модели/роли), но при общей памяти они работают с общим workspace.
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR = process.env.STATE_DIR || './state';
const INSTANCES_FILE = process.env.INSTANCES_FILE || path.join(STATE_DIR, 'instances.json');

let cache = null;

function substituteEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (m, name) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v)]));
  }
  return value;
}

/**
 * Инстанс по умолчанию из env — поведение «из коробки», совместимое с .env.example.
 */
function defaultInstanceFromEnv() {
  const driver = process.env.BRAIN_DRIVER || 'stateless-llm';
  if (process.env.LITELLM_BASE_URL) {
    return {
      driver,
      base_url: process.env.LITELLM_BASE_URL.replace(/\/$/, ''),
      api_key: process.env.LITELLM_API_KEY || '',
      model: process.env.VIKA_MODEL || 'openai/gpt-4o',
      label: 'env:LiteLLM/OpenAI-compatible'
    };
  }
  return {
    driver,
    base_url: (process.env.GW_BASE_URL || 'http://127.0.0.1:18789').replace(/\/$/, ''),
    api_key: process.env.GW_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || '',
    model: process.env.VIKA_MODEL || 'openclaw',
    stateful: driver === 'openclaw',
    label: 'env:OpenClaw Gateway'
  };
}

export function loadInstances({ force = false } = {}) {
  if (cache && !force) return cache;

  let config = null;
  try {
    if (fs.existsSync(INSTANCES_FILE)) {
      config = substituteEnv(JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf-8')));
    }
  } catch (err) {
    console.error(`[Instances] Invalid ${INSTANCES_FILE}, falling back to env:`, err.message);
  }

  if (!config || !config.instances || !Object.keys(config.instances).length) {
    config = {
      instances: { default: defaultInstanceFromEnv() },
      routing: { default: 'default' }
    };
  } else {
    config.routing = config.routing || {};
    if (!config.routing.default) {
      config.routing.default = Object.keys(config.instances)[0];
    }
  }

  cache = config;
  return cache;
}

/**
 * Инстанс для ключа маршрутизации "platform:surface".
 * Порядок поиска: точный ключ → surface → default.
 */
export function getInstanceFor(key) {
  const { instances, routing } = loadInstances();
  const surface = key.includes(':') ? key.split(':')[1] : key;
  const name = routing[key] || routing[surface] || routing.default;
  const instance = instances[name];
  if (!instance) {
    throw new Error(`[Instances] No instance "${name}" for routing key "${key}"`);
  }
  return { name, ...instance };
}
