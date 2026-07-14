import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SYSTEM_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information']);
const INVALID_NAME_PATTERN = /[\u0000-\u001f\\:*?"<>|]/;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

export function parseArgs(argv) {
  const result = { command: argv[0] || 'help', _: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const equalsIndex = token.indexOf('=');
    const key = token.slice(2, equalsIndex > 0 ? equalsIndex : undefined);
    const value = equalsIndex > 0 ? token.slice(equalsIndex + 1) : (argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined ? true : argv[++index]);
    if (result[key] === undefined) result[key] = value;
    else result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
  }
  return result;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function wildcardRegex(pattern) {
  const escaped = String(pattern || '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function normalizePatterns(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
}

function matchesExcluded(relativePath, patterns) {
  const normalized = toPosix(relativePath);
  return patterns.some((pattern) => {
    const directoryPattern = pattern.replace(/\/(\*\*)?$/, '');
    return wildcardRegex(pattern).test(normalized) || wildcardRegex(`**/${pattern}`).test(normalized) || (directoryPattern !== pattern && wildcardRegex(directoryPattern).test(normalized));
  });
}

async function md5File(filePath) {
  const hash = crypto.createHash('md5');
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export async function scanDirectory(sourcePath, options = {}) {
  const source = path.resolve(sourcePath);
  const excludes = normalizePatterns(options.exclude);
  const entries = [];
  const issues = [];
  const siblingNames = new Map();
  const summary = { folders: 0, files: 0, bytes: 0, symlinks: 0, unreadable: 0, invalidNames: 0, duplicateNames: 0, extensions: {} };

  const sourceStat = await fs.stat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error(`迁移源目录不存在或不是目录：${source}`);

  async function walk(currentPath, relativeDir = '') {
    let directoryEntries;
    try {
      directoryEntries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      summary.unreadable += 1;
      issues.push({ severity: 'error', code: 'UNREADABLE_DIRECTORY', relativePath: relativeDir || '.', message: error.message });
      return;
    }
    directoryEntries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const item of directoryEntries) {
      const relativePath = toPosix(path.join(relativeDir, item.name));
      if (SYSTEM_NAMES.has(item.name) || matchesExcluded(relativePath, excludes)) continue;
      const absolutePath = path.join(currentPath, item.name);
      const key = relativeDir.toLowerCase();
      const normalizedName = item.name.toLocaleLowerCase('zh-Hans-CN');
      const names = siblingNames.get(key) || new Map();
      if (names.has(normalizedName) && names.get(normalizedName) !== item.name) {
        summary.duplicateNames += 1;
        issues.push({ severity: 'error', code: 'CASE_COLLISION', relativePath, message: `同目录存在仅大小写不同的名称：${names.get(normalizedName)} / ${item.name}` });
      } else names.set(normalizedName, item.name);
      siblingNames.set(key, names);

      if (INVALID_NAME_PATTERN.test(item.name) || item.name === '.' || item.name === '..') {
        summary.invalidNames += 1;
        issues.push({ severity: 'error', code: 'INVALID_NAME', relativePath, message: '名称包含平台不支持的字符' });
      }
      if (relativePath.length > Number(options.maxPathLength || 500)) {
        issues.push({ severity: 'warning', code: 'LONG_PATH', relativePath, message: `相对路径长度为 ${relativePath.length}` });
      }

      const stats = await fs.lstat(absolutePath).catch((error) => {
        summary.unreadable += 1;
        issues.push({ severity: 'error', code: 'UNREADABLE_ENTRY', relativePath, message: error.message });
        return null;
      });
      if (!stats) continue;
      if (stats.isSymbolicLink()) {
        summary.symlinks += 1;
        issues.push({ severity: 'warning', code: 'SYMLINK_SKIPPED', relativePath, message: '符号链接默认不迁移' });
        continue;
      }
      if (stats.isDirectory()) {
        summary.folders += 1;
        entries.push({ type: 'folder', relativePath, sizeBytes: 0, modifiedAt: stats.mtime.toISOString() });
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        issues.push({ severity: 'warning', code: 'SPECIAL_FILE_SKIPPED', relativePath, message: '非普通文件，已跳过' });
        continue;
      }
      try {
        await fs.access(absolutePath, fsSync.constants.R_OK);
      } catch (error) {
        summary.unreadable += 1;
        issues.push({ severity: 'error', code: 'UNREADABLE_FILE', relativePath, message: error.message });
        continue;
      }
      const extension = path.extname(item.name).slice(1).toLowerCase();
      summary.files += 1;
      summary.bytes += stats.size;
      summary.extensions[extension || '(无扩展名)'] = Number(summary.extensions[extension || '(无扩展名)'] || 0) + 1;
      const entry = { type: 'file', relativePath, sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString(), extension };
      if (options.hash) entry.md5 = await md5File(absolutePath);
      entries.push(entry);
    }
  }

  await walk(source);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN'));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source,
    options: { excludes, hash: Boolean(options.hash), maxPathLength: Number(options.maxPathLength || 500) },
    summary,
    issues,
    entries
  };
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

export function reportMarkdown(report) {
  const extensionRows = Object.entries(report.summary.extensions).sort((a, b) => b[1] - a[1]);
  const lines = [
    '# 文档迁移预检报告', '',
    `- 生成时间：${report.generatedAt}`,
    `- 迁移源：\`${report.source}\``,
    `- 文件夹：${report.summary.folders}`,
    `- 文件：${report.summary.files}`,
    `- 总容量：${formatBytes(report.summary.bytes)}`,
    `- 错误：${report.issues.filter((item) => item.severity === 'error').length}`,
    `- 警告：${report.issues.filter((item) => item.severity === 'warning').length}`,
    '', '## 文件类型', '', '| 扩展名 | 数量 |', '|---|---:|',
    ...extensionRows.map(([extension, count]) => `| ${extension} | ${count} |`),
    '', '## 风险项', '', '| 级别 | 编码 | 路径 | 说明 |', '|---|---|---|---|',
    ...(report.issues.length ? report.issues.map((item) => `| ${item.severity} | ${item.code} | ${String(item.relativePath).replace(/\|/g, '\\|')} | ${String(item.message).replace(/\|/g, '\\|')} |`) : ['| - | - | - | 未发现风险项 |'])
  ];
  return `${lines.join('\n')}\n`;
}

async function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempPath, resolved);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function authHeaders(env = process.env) {
  if (env.MIGRATION_TOKEN) return { Authorization: `Bearer ${env.MIGRATION_TOKEN}` };
  if (env.MIGRATION_ACCESS_KEY && env.MIGRATION_ACCESS_SECRET) {
    return { 'X-Access-Key': env.MIGRATION_ACCESS_KEY, 'X-Access-Secret': env.MIGRATION_ACCESS_SECRET };
  }
  throw new Error('请通过 MIGRATION_TOKEN，或 MIGRATION_ACCESS_KEY + MIGRATION_ACCESS_SECRET 提供迁移认证');
}

function joinApi(baseUrl, apiPath) {
  return `${String(baseUrl).replace(/\/+$/, '')}/api/v1${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
}

async function requestApi(context, apiPath, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const headers = { ...context.auth, ...(options.headers || {}) };
      let body = options.body;
      if (body && !(body instanceof FormData) && typeof body !== 'string') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
      const response = await context.fetchImpl(joinApi(context.baseUrl, apiPath), { method: options.method || 'GET', headers, body });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok || payload.code !== 'OK') {
        const error = new Error(payload.message || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = payload.code;
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } else return payload.data;
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500 && error.status !== 429) throw error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 300));
  }
  throw lastError;
}

async function uploadSmallFile(context, filePath, parentId, filename, description) {
  const form = new FormData();
  form.append('parentId', parentId);
  form.append('name', filename);
  form.append('originalFilename', filename);
  form.append('description', description);
  form.append('file', new Blob([await fs.readFile(filePath)]), transportFilename(filename));
  return requestApi(context, '/files', { method: 'POST', body: form });
}

async function uploadVersion(context, filePath, nodeId, filename, description) {
  const stats = await fs.stat(filePath);
  if (stats.size > 250 * 1024 * 1024) throw new Error('现有文件的新版本超过 250MB，请改为 skip 后人工处理该冲突文件');
  const form = new FormData();
  form.append('description', description);
  form.append('unlock', 'false');
  form.append('originalFilename', filename);
  form.append('file', new Blob([await fs.readFile(filePath)]), transportFilename(filename));
  await requestApi(context, `/files/${encodeURIComponent(nodeId)}/versions`, { method: 'POST', body: form });
  return { id: nodeId, name: filename, migratedAsVersion: true };
}

function transportFilename(filename) {
  const extension = path.extname(filename).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,20}$/.test(extension) ? extension : '.bin';
  const digest = crypto.createHash('sha256').update(filename).digest('hex').slice(0, 16);
  return `migration-upload-${digest}${safeExtension}`;
}

async function uploadChunkedFile(context, filePath, parentId, filename, entry, options) {
  const chunkSize = Number(options.chunkSize || DEFAULT_CHUNK_SIZE);
  const totalChunks = Math.max(1, Math.ceil(entry.sizeBytes / chunkSize));
  const md5 = entry.md5 || await md5File(filePath);
  const session = await requestApi(context, '/uploads/chunked/init', {
    method: 'POST',
    body: { parentId, filename, sizeBytes: entry.sizeBytes, totalChunks, md5, description: options.description }
  });
  const uploaded = new Set(session.uploadedChunks || []);
  if (!session.instantAvailable) {
    const handle = await fs.open(filePath, 'r');
    try {
      for (let index = 0; index < totalChunks; index += 1) {
        if (uploaded.has(index)) continue;
        const offset = index * chunkSize;
        const length = Math.min(chunkSize, entry.sizeBytes - offset);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        const form = new FormData();
        form.append('chunk', new Blob([buffer]), `${filename}.part-${index}`);
        await requestApi(context, `/uploads/chunked/${encodeURIComponent(session.id)}/chunks/${index}`, { method: 'PUT', body: form });
      }
    } finally {
      await handle.close();
    }
  }
  return requestApi(context, `/uploads/chunked/${encodeURIComponent(session.id)}/complete`, { method: 'POST', body: {} });
}

export async function importDirectory(options) {
  const source = path.resolve(options.source);
  const report = options.report || await scanDirectory(source, { exclude: options.exclude, hash: Boolean(options.hash) });
  const blockingIssues = report.issues.filter((item) => item.severity === 'error');
  if (blockingIssues.length) throw new Error(`迁移预检发现 ${blockingIssues.length} 个错误，请先处理后再执行`);

  const context = {
    baseUrl: options.baseUrl || 'http://localhost:3000',
    auth: options.auth || authHeaders(options.env),
    fetchImpl: options.fetchImpl || fetch
  };
  const targetParentId = options.targetParentId || 'n_root';
  const conflict = ['skip', 'version'].includes(options.conflict) ? options.conflict : 'skip';
  const apply = Boolean(options.apply);
  const statePath = path.resolve(options.statePath || path.join(os.tmpdir(), 'document-platform-migration-state.json'));
  const state = await readJson(statePath, { schemaVersion: 1, source, targetParentId, completed: {}, startedAt: new Date().toISOString() });
  if (state.source !== source || state.targetParentId !== targetParentId) throw new Error(`断点文件与当前迁移源或目标不一致：${statePath}`);

  const policy = await requestApi(context, '/system-settings/file-policy');
  const allowedExtensions = new Set((policy.allowedExtensions || []).map((item) => String(item).toLowerCase()));
  const maxBytes = Number(policy.maxSizeMb || 300) * 1024 * 1024;
  const policyErrors = report.entries.filter((entry) => entry.type === 'file').flatMap((entry) => {
    const errors = [];
    if (allowedExtensions.size && !allowedExtensions.has(entry.extension)) errors.push(`${entry.relativePath}：${entry.extension ? `扩展名 .${entry.extension}` : '无扩展名文件'}不在上传白名单`);
    if (entry.sizeBytes > maxBytes) errors.push(`${entry.relativePath}：超过平台上限 ${policy.maxSizeMb}MB`);
    return errors;
  });
  if (policyErrors.length) throw new Error(`迁移文件不符合平台策略：\n${policyErrors.slice(0, 20).join('\n')}${policyErrors.length > 20 ? `\n另有 ${policyErrors.length - 20} 项` : ''}`);

  const result = { apply, source, targetParentId, conflict, statePath, foldersCreated: 0, foldersReused: 0, filesUploaded: 0, versionsUploaded: 0, filesSkipped: 0, resumed: 0, errors: [] };
  if (!apply) return { ...result, plannedFolders: report.summary.folders, plannedFiles: report.summary.files, plannedBytes: report.summary.bytes };

  const childrenCache = new Map();
  async function children(parentId, refresh = false) {
    if (!refresh && childrenCache.has(parentId)) return childrenCache.get(parentId);
    const items = await requestApi(context, `/nodes/${encodeURIComponent(parentId)}/children`);
    childrenCache.set(parentId, items);
    return items;
  }
  const folderIds = new Map([['', targetParentId]]);
  const rootFolderName = options.rootFolder === false ? '' : (typeof options.rootFolder === 'string' ? options.rootFolder : path.basename(source));
  if (rootFolderName) {
    const rootItems = await children(targetParentId);
    let rootFolder = rootItems.find((item) => item.nodeType === 'folder' && item.name === rootFolderName);
    if (!rootFolder) {
      rootFolder = await requestApi(context, '/folders', { method: 'POST', body: { parentId: targetParentId, name: rootFolderName } });
      result.foldersCreated += 1;
      await children(targetParentId, true);
    } else result.foldersReused += 1;
    folderIds.set('', rootFolder.id);
  }

  const folders = report.entries.filter((entry) => entry.type === 'folder').sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length || a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN'));
  for (const entry of folders) {
    const parentRelative = toPosix(path.dirname(entry.relativePath)) === '.' ? '' : toPosix(path.dirname(entry.relativePath));
    const parentId = folderIds.get(parentRelative);
    if (!parentId) throw new Error(`找不到迁移目标上级目录：${parentRelative}`);
    const name = path.basename(entry.relativePath);
    const existing = (await children(parentId)).find((item) => item.name === name);
    if (existing && existing.nodeType !== 'folder') throw new Error(`目标位置存在同名文件，无法创建目录：${entry.relativePath}`);
    if (existing) {
      folderIds.set(entry.relativePath, existing.id);
      result.foldersReused += 1;
      continue;
    }
    const folder = await requestApi(context, '/folders', { method: 'POST', body: { parentId, name } });
    folderIds.set(entry.relativePath, folder.id);
    result.foldersCreated += 1;
    await children(parentId, true);
  }

  const files = report.entries.filter((entry) => entry.type === 'file');
  for (const entry of files) {
    if (state.completed[entry.relativePath]?.status === 'success') {
      result.resumed += 1;
      continue;
    }
    const parentRelative = toPosix(path.dirname(entry.relativePath)) === '.' ? '' : toPosix(path.dirname(entry.relativePath));
    const parentId = folderIds.get(parentRelative);
    const filename = path.basename(entry.relativePath);
    const absolutePath = path.join(source, ...entry.relativePath.split('/'));
    try {
      const existing = (await children(parentId)).find((item) => item.name === filename);
      let node;
      if (existing) {
        if (existing.nodeType !== 'file') throw new Error('目标位置存在同名文件夹');
        if (conflict === 'skip') {
          result.filesSkipped += 1;
          state.completed[entry.relativePath] = { status: 'skipped', nodeId: existing.id, reason: '目标已存在', completedAt: new Date().toISOString() };
          await writeJsonAtomic(statePath, state);
          continue;
        }
        node = await uploadVersion(context, absolutePath, existing.id, filename, options.description || '旧系统迁移版本');
        result.versionsUploaded += 1;
      } else if (entry.sizeBytes > Number(options.chunkThreshold || DEFAULT_CHUNK_SIZE)) {
        node = await uploadChunkedFile(context, absolutePath, parentId, filename, entry, { chunkSize: options.chunkSize, description: options.description || '旧系统数据迁移' });
        result.filesUploaded += 1;
      } else {
        node = await uploadSmallFile(context, absolutePath, parentId, filename, options.description || '旧系统数据迁移');
        result.filesUploaded += 1;
      }
      state.completed[entry.relativePath] = { status: 'success', nodeId: node.id, sizeBytes: entry.sizeBytes, completedAt: new Date().toISOString() };
      await writeJsonAtomic(statePath, state);
      await children(parentId, true);
    } catch (error) {
      result.errors.push({ relativePath: entry.relativePath, message: error.message });
      state.completed[entry.relativePath] = { status: 'failed', message: error.message, failedAt: new Date().toISOString() };
      await writeJsonAtomic(statePath, state);
      if (!options.continueOnError) throw error;
    }
  }
  state.finishedAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);
  return result;
}

function usage() {
  return `文档管理平台文件迁移工具

扫描：
  node scripts/migrate-filesystem.mjs scan --source /old-docs --output /tmp/migration-report.json [--hash] [--exclude '*.tmp']

演练（默认不写入）：
  MIGRATION_TOKEN=... node scripts/migrate-filesystem.mjs import --source /old-docs --base-url http://127.0.0.1:3000 --target-parent n_root

执行：
  MIGRATION_TOKEN=... node scripts/migrate-filesystem.mjs import --source /old-docs --base-url http://127.0.0.1:3000 --target-parent n_root --state /data/migration-state.json --conflict skip --apply

认证也可使用 MIGRATION_ACCESS_KEY 和 MIGRATION_ACCESS_SECRET。凭据只从环境变量读取。`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.help) {
    console.log(usage());
    return;
  }
  if (!args.source) throw new Error('缺少 --source 迁移源目录');
  if (args.command === 'scan') {
    const report = await scanDirectory(args.source, { exclude: args.exclude, hash: Boolean(args.hash), maxPathLength: args['max-path-length'] });
    const output = path.resolve(args.output || path.join(os.tmpdir(), `document-platform-migration-report-${Date.now()}.json`));
    await writeJsonAtomic(output, report);
    const markdownPath = output.replace(/\.json$/i, '.md');
    await fs.writeFile(markdownPath, reportMarkdown(report), 'utf8');
    console.log(`迁移预检完成：${report.summary.files} 个文件，${formatBytes(report.summary.bytes)}`);
    console.log(`JSON 报告：${output}`);
    console.log(`Markdown 报告：${markdownPath}`);
    if (report.issues.some((item) => item.severity === 'error')) process.exitCode = 2;
    return;
  }
  if (args.command !== 'import') throw new Error(`未知命令：${args.command}`);
  const result = await importDirectory({
    source: args.source,
    baseUrl: args['base-url'],
    targetParentId: args['target-parent'],
    statePath: args.state,
    conflict: args.conflict,
    rootFolder: args['no-root-folder'] ? false : args['root-folder'],
    exclude: args.exclude,
    hash: Boolean(args.hash),
    apply: Boolean(args.apply),
    continueOnError: Boolean(args['continue-on-error'])
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.apply) console.log('当前为演练模式，未写入平台。确认后增加 --apply 执行。');
  if (result.errors.length) process.exitCode = 3;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`迁移失败：${error.message}`);
    process.exitCode = 1;
  });
}
