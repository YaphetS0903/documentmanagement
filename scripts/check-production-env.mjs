import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const errors = [];
const warnings = [];
const secret = String(process.env.JWT_SECRET || '');
const requiredDirectories = ['DATA_DIR', 'UPLOAD_DIR', 'TMP_DIR', 'BACKUP_DIR', 'QUARANTINE_DIR'];

if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') errors.push('NODE_ENV 必须为 production');
if (secret.length < 32 || secret === 'dev-document-platform-secret') errors.push('JWT_SECRET 必须是至少 32 个字符的随机密钥');
if (process.env.INITIAL_ADMIN_PASSWORD && String(process.env.INITIAL_ADMIN_PASSWORD).length < 12) errors.push('INITIAL_ADMIN_PASSWORD 至少需要 12 个字符');
if (!Number.isInteger(Number(process.env.PORT)) || Number(process.env.PORT) < 1 || Number(process.env.PORT) > 65535) errors.push('PORT 必须是有效端口');

for (const name of requiredDirectories) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    errors.push(`${name} 未配置`);
    continue;
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) errors.push(`${name} 目录不存在：${resolved}`);
  else {
    try {
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      errors.push(`${name} 目录不可读写：${resolved}`);
    }
  }
}

if (!String(process.env.EXTERNAL_LIBRARY_ROOT || '').trim()) warnings.push('EXTERNAL_LIBRARY_ROOT 未配置，将使用后台设置');

warnings.forEach((message) => console.warn(`警告：${message}`));
if (errors.length) {
  errors.forEach((message) => console.error(`错误：${message}`));
  process.exit(1);
}
console.log('生产环境变量与运行目录检查通过');
