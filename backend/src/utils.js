import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function now() {
  return new Date().toISOString();
}

export function newId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, user) {
  if (!user?.passwordSalt || !user?.passwordHash) return false;
  const { hash } = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash));
}

export function fileMd5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

export async function fileMd5FromPath(filePath) {
  const data = await fs.readFile(filePath);
  return fileMd5(data);
}

export function safeFilename(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
}

export function extname(name) {
  return path.extname(name || '').replace('.', '').toLowerCase();
}

export function ok(data = null, message = 'success') {
  return { code: 'OK', message, data };
}

export function createError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export function pickPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    status: user.status,
    departmentIds: user.departmentIds || [],
    roleIds: user.roleIds || [],
    avatarUrl: user.avatarUrl || ''
  };
}
