import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(backendRoot, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(backendRoot, 'data');
const uploadDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(backendRoot, 'uploads');
const tmpDir = process.env.TMP_DIR ? path.resolve(process.env.TMP_DIR) : path.join(backendRoot, 'tmp');
const backupDir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(backendRoot, 'backups');
const nodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const jwtSecret = String(process.env.JWT_SECRET || 'dev-document-platform-secret');

if (nodeEnv === 'production' && (jwtSecret === 'dev-document-platform-secret' || jwtSecret.length < 32)) {
  throw new Error('生产环境必须通过 JWT_SECRET 配置至少 32 个字符的随机密钥');
}

export const config = {
  nodeEnv,
  port: Number(process.env.PORT || 3000),
  jwtSecret,
  dataDir,
  dbFile: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, 'db.json'),
  storageFile: process.env.STORAGE_FILE ? path.resolve(process.env.STORAGE_FILE) : path.join(dataDir, 'storage.json'),
  uploadDir,
  tmpDir,
  backupDir,
  diskWarningPercent: Math.max(1, Math.min(Number(process.env.DISK_WARNING_PERCENT || 85), 99)),
  externalLibraryRoot: process.env.EXTERNAL_LIBRARY_ROOT || '',
  frontendDist: path.join(projectRoot, 'dist')
};
