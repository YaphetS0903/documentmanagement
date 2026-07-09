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

export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || 'dev-document-platform-secret',
  dataDir,
  dbFile: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, 'db.json'),
  storageFile: process.env.STORAGE_FILE ? path.resolve(process.env.STORAGE_FILE) : path.join(dataDir, 'storage.json'),
  uploadDir,
  tmpDir,
  externalLibraryRoot: process.env.EXTERNAL_LIBRARY_ROOT || '',
  frontendDist: path.join(projectRoot, 'dist')
};
