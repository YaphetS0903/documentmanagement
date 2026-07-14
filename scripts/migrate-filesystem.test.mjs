import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { importDirectory, parseArgs, reportMarkdown, scanDirectory } from './migrate-filesystem.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'document-platform-migration-test-'));
const source = path.join(root, '旧文档');
const statePath = path.join(root, 'state.json');
await fs.mkdir(path.join(source, '制度'), { recursive: true });
await fs.mkdir(path.join(source, '空目录'), { recursive: true });
await fs.writeFile(path.join(source, '制度', '质量手册.txt'), 'quality manual migration test', 'utf8');
await fs.writeFile(path.join(source, '忽略.tmp'), 'ignored', 'utf8');

const parsed = parseArgs(['scan', '--source', source, '--exclude=*.tmp', '--hash']);
assert.equal(parsed.command, 'scan');
assert.equal(parsed.source, source);
assert.equal(parsed.hash, true);

const report = await scanDirectory(source, { exclude: '*.tmp', hash: true });
assert.equal(report.summary.folders, 2);
assert.equal(report.summary.files, 1);
assert.equal(report.entries.some((item) => item.relativePath === '忽略.tmp'), false);
assert.match(report.entries.find((item) => item.type === 'file').md5, /^[a-f0-9]{32}$/);
assert.match(reportMarkdown(report), /\| txt \| 1 \|/);

const nodes = new Map([['n_root', []]]);
let sequence = 0;
const calls = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuffer = Buffer.concat(chunks);
    const send = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status < 400 ? { code: 'OK', message: 'success', data } : { code: 'ERROR', message: data }));
    };
    calls.push({ method: req.method, url: req.url, contentType: req.headers['content-type'] || '', body: bodyBuffer.toString('utf8') });
    if (req.method === 'GET' && req.url === '/api/v1/system-settings/file-policy') return send({ allowedExtensions: ['txt'], maxSizeMb: 100, chunkSizeMb: 8 });
    const childrenMatch = req.url.match(/^\/api\/v1\/nodes\/([^/]+)\/children$/);
    if (req.method === 'GET' && childrenMatch) return send(nodes.get(decodeURIComponent(childrenMatch[1])) || []);
    if (req.method === 'POST' && req.url === '/api/v1/folders') {
      const body = JSON.parse(bodyBuffer.toString('utf8'));
      const folder = { id: `folder-${++sequence}`, parentId: body.parentId, nodeType: 'folder', name: body.name };
      nodes.set(folder.id, []);
      nodes.set(body.parentId, [...(nodes.get(body.parentId) || []), folder]);
      return send(folder);
    }
    if (req.method === 'POST' && req.url === '/api/v1/files') {
      const file = { id: `file-${++sequence}`, nodeType: 'file', name: '质量手册.txt' };
      const targetFolder = [...nodes.keys()].find((key) => key.startsWith('folder-') && (nodes.get(key) || []).length === 0);
      if (targetFolder) nodes.set(targetFolder, [file]);
      return send(file);
    }
    return send('not found', 404);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  const dryRun = await importDirectory({ source, report, baseUrl: `http://127.0.0.1:${address.port}`, targetParentId: 'n_root', auth: { Authorization: 'Bearer test' }, statePath, apply: false });
  assert.equal(dryRun.plannedFiles, 1);
  assert.equal(calls.some((item) => item.url === '/api/v1/files'), false);

  const applied = await importDirectory({ source, report, baseUrl: `http://127.0.0.1:${address.port}`, targetParentId: 'n_root', auth: { Authorization: 'Bearer test' }, statePath, apply: true });
  assert.equal(applied.filesUploaded, 1);
  assert.equal(applied.foldersCreated, 3);
  const uploadCall = calls.find((item) => item.url === '/api/v1/files' && item.contentType.startsWith('multipart/form-data'));
  assert.ok(uploadCall);
  assert.match(uploadCall.body, /name="name"\r\n\r\n质量手册\.txt/);
  assert.match(uploadCall.body, /name="originalFilename"\r\n\r\n质量手册\.txt/);
  assert.match(uploadCall.body, /filename="migration-upload-[a-f0-9]{16}\.txt"/);
  assert.doesNotMatch(uploadCall.body, /filename="质量手册\.txt"/);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.completed['制度/质量手册.txt'].status, 'success');
} finally {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
}

console.log('migration tool tests passed');
