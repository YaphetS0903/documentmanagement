import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { config } from './config.js';
import { ensureDir, now } from './utils.js';

const STORE_TABLE = 'document_platform_store';
const DB_STORE_KEY = 'db';

const DEFAULT_STORAGE_CONFIG = {
  provider: 'json',
  mysql: {
    host: '',
    port: 3306,
    database: '',
    user: '',
    password: '',
    ssl: false
  },
  updatedAt: null
};

let runtimeInfo = {
  configuredProvider: 'json',
  activeProvider: 'json',
  lastError: null,
  lastLoadedAt: null,
  lastSavedAt: null
};

function normalizeProvider(provider) {
  return provider === 'mysql' ? 'mysql' : 'json';
}

function normalizeMysqlConfig(mysqlConfig = {}, existingMysql = DEFAULT_STORAGE_CONFIG.mysql) {
  const next = {
    ...DEFAULT_STORAGE_CONFIG.mysql,
    ...(existingMysql || {}),
    ...(mysqlConfig || {})
  };
  const incomingPassword = mysqlConfig?.password;
  return {
    host: String(next.host || '').trim(),
    port: Math.max(1, Math.min(Number(next.port || 3306), 65535)),
    database: String(next.database || '').trim(),
    user: String(next.user || '').trim(),
    password: incomingPassword === undefined || incomingPassword === '' ? String(existingMysql?.password || '') : String(incomingPassword),
    ssl: Boolean(next.ssl)
  };
}

export function hasCompleteMysqlConfig(mysqlConfig = {}) {
  return Boolean(mysqlConfig.host && mysqlConfig.port && mysqlConfig.database && mysqlConfig.user);
}

export function sanitizeStorageConfig(storageConfig = DEFAULT_STORAGE_CONFIG) {
  return {
    provider: normalizeProvider(storageConfig.provider),
    mysql: {
      host: storageConfig.mysql?.host || '',
      port: Number(storageConfig.mysql?.port || 3306),
      database: storageConfig.mysql?.database || '',
      user: storageConfig.mysql?.user || '',
      ssl: Boolean(storageConfig.mysql?.ssl),
      hasPassword: Boolean(storageConfig.mysql?.password)
    },
    updatedAt: storageConfig.updatedAt || null
  };
}

export function normalizeStorageConfig(input = {}, existing = DEFAULT_STORAGE_CONFIG) {
  return {
    provider: normalizeProvider(input.provider ?? existing.provider),
    mysql: normalizeMysqlConfig(input.mysql || {}, existing.mysql),
    updatedAt: input.updatedAt || existing.updatedAt || null
  };
}

export async function readStorageConfig({ includePassword = false } = {}) {
  await ensureDir(config.dataDir);
  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(config.storageFile, 'utf8'));
  } catch {
    stored = {};
  }
  const merged = normalizeStorageConfig(stored, stored);
  return includePassword ? merged : sanitizeStorageConfig(merged);
}

export async function writeStorageConfig(input = {}) {
  const existing = await readStorageConfig({ includePassword: true });
  const next = { ...normalizeStorageConfig(input, existing), updatedAt: now() };
  await ensureDir(config.dataDir);
  await fs.writeFile(config.storageFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function mysqlConnectionOptions(mysqlConfig) {
  return {
    host: mysqlConfig.host,
    port: Number(mysqlConfig.port || 3306),
    user: mysqlConfig.user,
    password: mysqlConfig.password || '',
    database: mysqlConfig.database,
    charset: 'utf8mb4',
    connectTimeout: 8000,
    ssl: mysqlConfig.ssl ? { rejectUnauthorized: false } : undefined
  };
}

export async function testMysqlConnection(mysqlConfig) {
  const normalized = normalizeMysqlConfig(mysqlConfig, mysqlConfig);
  if (!hasCompleteMysqlConfig(normalized)) {
    throw Object.assign(new Error('请完整填写 MySQL 主机、端口、数据库名和用户名'), { code: 'VALIDATION_ERROR', status: 400 });
  }
  const connection = await mysql.createConnection(mysqlConnectionOptions(normalized));
  try {
    const [rows] = await connection.query('SELECT VERSION() AS version, DATABASE() AS databaseName');
    return {
      ok: true,
      version: rows?.[0]?.version || '',
      database: rows?.[0]?.databaseName || normalized.database
    };
  } finally {
    await connection.end();
  }
}

export async function ensureMysqlStore(mysqlConfig) {
  const connection = await mysql.createConnection(mysqlConnectionOptions(mysqlConfig));
  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS ${STORE_TABLE} (
        store_key VARCHAR(64) NOT NULL PRIMARY KEY,
        store_value LONGTEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
  } finally {
    await connection.end();
  }
}

export async function loadMysqlSnapshot(storageConfig = null) {
  const activeConfig = storageConfig || await readStorageConfig({ includePassword: true });
  const mysqlConfig = activeConfig.mysql;
  if (!hasCompleteMysqlConfig(mysqlConfig)) return null;
  await ensureMysqlStore(mysqlConfig);
  const connection = await mysql.createConnection(mysqlConnectionOptions(mysqlConfig));
  try {
    const [rows] = await connection.execute(`SELECT store_value FROM ${STORE_TABLE} WHERE store_key = ? LIMIT 1`, [DB_STORE_KEY]);
    if (!rows.length) return null;
    return JSON.parse(rows[0].store_value);
  } finally {
    await connection.end();
  }
}

export async function saveMysqlSnapshot(db, storageConfig = null) {
  const activeConfig = storageConfig || await readStorageConfig({ includePassword: true });
  const mysqlConfig = activeConfig.mysql;
  if (!hasCompleteMysqlConfig(mysqlConfig)) {
    throw Object.assign(new Error('MySQL 连接配置不完整'), { code: 'VALIDATION_ERROR', status: 400 });
  }
  await ensureMysqlStore(mysqlConfig);
  const connection = await mysql.createConnection(mysqlConnectionOptions(mysqlConfig));
  try {
    await connection.execute(
      `INSERT INTO ${STORE_TABLE} (store_key, store_value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE store_value = VALUES(store_value), updated_at = CURRENT_TIMESTAMP`,
      [DB_STORE_KEY, JSON.stringify(db)]
    );
  } finally {
    await connection.end();
  }
}

export function markStorageRuntime(patch = {}) {
  runtimeInfo = { ...runtimeInfo, ...patch };
}

export function getStorageRuntimeInfo() {
  return { ...runtimeInfo };
}
