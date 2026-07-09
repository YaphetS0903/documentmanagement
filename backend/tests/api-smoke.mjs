import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const testPort = '3100';
const base = `http://localhost:${testPort}/api/v1`;
const root = process.cwd();
const testRuntimeRoot = path.join(root, 'backend', 'tmp', 'api-smoke-runtime');
const sampleFile = path.join(root, 'backend', 'tmp', 'smoke.txt');
const externalRoot = path.join(root, 'backend', 'tmp', 'external-library-smoke');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${res.status} ${url}: ${text}`);
  }
  return body;
}

async function requestRaw(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { res, body, text };
}

async function loginPayload(username, password) {
  const captcha = await request(`${base}/auth/captcha`);
  const answer = captcha.data.question.match(/\d+/g).map(Number).reduce((sum, value) => sum + value, 0);
  return { username, password, captchaId: captcha.data.id, captchaAnswer: String(answer) };
}

await fs.rm(testRuntimeRoot, { recursive: true, force: true });

const server = spawn('node', ['backend/src/server.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: testPort,
    DATA_DIR: path.join(testRuntimeRoot, 'data'),
    UPLOAD_DIR: path.join(testRuntimeRoot, 'uploads'),
    TMP_DIR: path.join(testRuntimeRoot, 'tmp')
  }
});

try {
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      await request(`${base}/health`);
      ready = true;
      break;
    } catch {
      await wait(250);
    }
  }
  assert.equal(ready, true, 'server did not start');

  await request(`${base}/dev/reset`, { method: 'POST' });
  const login = await request(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await loginPayload('admin', 'admin123'))
  });
  const token = login.data.token;
  assert.ok(token);

  await request(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword: 'admin123', newPassword: 'admin456' })
  });
  await request(`${base}/auth/change-password`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword: 'admin456', newPassword: 'admin123' })
  });

  await request(`${base}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lockuser', displayName: '锁定测试用户', password: 'Lock1234', roleIds: ['r_employee'] })
  });
  for (let i = 0; i < 4; i += 1) {
    const failedLogin = await requestRaw(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await loginPayload('lockuser', 'bad-password'))
    });
    assert.equal(failedLogin.res.status, 401);
  }
  const lockedLogin = await requestRaw(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await loginPayload('lockuser', 'bad-password'))
  });
  assert.equal(lockedLogin.res.status, 423);
  const lockedCorrectLogin = await requestRaw(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await loginPayload('lockuser', 'Lock1234'))
  });
  assert.equal(lockedCorrectLogin.res.status, 423);
  const failedAudits = await request(`${base}/audit-logs?action=auth.login_failed&pageSize=10`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(failedAudits.data.total >= 5);

  const openapi = await request(`${base}/openapi.json`);
  assert.equal(openapi.openapi, '3.0.3');
  assert.ok(openapi.paths['/system-settings/file-policy']);
  assert.ok(openapi.paths['/system-settings/external-library']);
  assert.ok(openapi.paths['/external-library/sync']);
  assert.ok(openapi.paths['/permission-templates']);
  assert.ok(openapi.paths['/nodes/{id}/permission-rules/batch']);
  assert.ok(openapi.paths['/nodes/{id}/workflow']);
  assert.ok(openapi.paths['/nodes/{id}/workflow-actions']);
  assert.ok(openapi.paths['/nodes/{id}/approvals']);
  assert.ok(openapi.paths['/approvals/{id}/approve']);
  assert.ok(openapi.paths['/approvals/{id}']);
  assert.ok(openapi.paths['/files/{id}/version-logs']);
  assert.ok(openapi.paths['/nodes/{id}/view-access']);
  assert.ok(openapi.paths['/nodes/{id}/password']);
  assert.ok(openapi.paths['/nodes/{id}/security']);
  assert.ok(openapi.paths['/nodes/batch-metadata']);
  assert.ok(openapi.paths['/system-settings/security-policy']);
  assert.ok(openapi.paths['/system-settings/wecom']);
  assert.ok(openapi.paths['/system-settings/wecom/test']);
  assert.ok(openapi.paths['/recent-access']);
  assert.ok(openapi.paths['/audit-logs/report']);
  assert.ok(openapi.paths['/system/runtime-status']);
  assert.ok(openapi.paths['/sso/tickets']);

  const ssoTicket = await request(`${base}/sso/tickets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u_demo', expiresInMinutes: 5 })
  });
  assert.ok(ssoTicket.data.loginUrl.includes(ssoTicket.data.id));
  const ssoLogin = await request(`${base}/sso/consume?ticket=${encodeURIComponent(ssoTicket.data.id)}`);
  assert.equal(ssoLogin.data.user.username, 'demo');
  const consumedAgain = await requestRaw(`${base}/sso/consume?ticket=${encodeURIComponent(ssoTicket.data.id)}`);
  assert.equal(consumedAgain.res.status, 401);

  const originalFilePolicy = await request(`${base}/system-settings/file-policy`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const updatedFilePolicy = await request(`${base}/system-settings/file-policy`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowedExtensions: ['txt'], maxSizeMb: 1 })
  });
  assert.deepEqual(updatedFilePolicy.data.allowedExtensions, ['txt']);
  const blockedForm = new FormData();
  blockedForm.append('parentId', 'n_root');
  blockedForm.append('file', new Blob([Buffer.from('blocked body')]), 'blocked.exe');
  const blockedUpload = await requestRaw(`${base}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: blockedForm
  });
  assert.equal(blockedUpload.res.status, 400);
  assert.match(blockedUpload.body.message, /不允许上传/);
  await request(`${base}/system-settings/file-policy`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(originalFilePolicy.data)
  });

  await fs.chmod(path.join(externalRoot, '无权限目录'), 0o700).catch(() => {});
  await fs.rm(externalRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(externalRoot, '质量体系', '二级目录'), { recursive: true });
  await fs.mkdir(path.join(externalRoot, '无权限目录'), { recursive: true });
  await fs.writeFile(path.join(externalRoot, '质量体系', '外部质量手册.txt'), '外部目录质量手册 smoke sync content', 'utf8');
  await fs.writeFile(path.join(externalRoot, '项目台账.csv'), '项目,状态\n同步测试,运行', 'utf8');
  await fs.writeFile(path.join(externalRoot, '无权限目录', '不可读取.txt'), 'should be skipped', 'utf8');
  await fs.chmod(path.join(externalRoot, '无权限目录'), 0o000);
  const externalSettings = await request(`${base}/system-settings/external-library`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: externalRoot })
  });
  assert.equal(externalSettings.data.rootPath, externalRoot);
  const syncSummary = await request(`${base}/external-library/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  await fs.chmod(path.join(externalRoot, '无权限目录'), 0o700).catch(() => {});
  assert.ok(syncSummary.data.scanned >= 4);
  assert.ok(syncSummary.data.skipped >= 1);
  assert.ok(syncSummary.data.skippedPaths.some((item) => item.path.includes('无权限目录')));
  assert.ok(syncSummary.data.foldersCreated >= 2);
  assert.ok(syncSummary.data.filesCreated >= 2);
  const children = await request(`${base}/nodes/n_root/children`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const syncedFolder = children.data.find((item) => item.name === '质量体系');
  const syncedFile = children.data.find((item) => item.name === '项目台账.csv');
  assert.ok(syncedFolder);
  assert.ok(syncedFile);
  assert.equal(syncedFile.hasUnread, true);
  assert.equal(syncedFolder.sourceType, 'external');
  assert.equal(syncedFile.currentVersion.storageType, 'external');
  const syncedPreview = await request(`${base}/files/${syncedFile.id}/preview`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.match(syncedPreview.data.content, /同步测试/);

  const personalTree = await request(`${base}/personal-drive/tree`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const personalRoot = personalTree.data.find((item) => item.name === '我的网盘');
  assert.ok(personalRoot);
  const personalForm = new FormData();
  personalForm.append('parentId', personalRoot.id);
  personalForm.append('file', new Blob([Buffer.from('personal private smoke body')]), 'personal-smoke.txt');
  const personalUpload = await request(`${base}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: personalForm
  });
  assert.equal(personalUpload.data.spaceType, 'personal');
  const personalSummary = await request(`${base}/personal-drive/summary`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(personalSummary.data.files, 1);
  assert.equal(personalSummary.data.versions, 1);
  assert.ok(personalSummary.data.sizeBytes > 0);
  const demoLoginForPrivateDrive = await request(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await loginPayload('demo', 'user123'))
  });
  const demoExternalSettings = await requestRaw(`${base}/system-settings/external-library`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.equal(demoExternalSettings.res.status, 403);
  const demoSyncSummary = await request(`${base}/external-library/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: path.join(root, 'not-allowed-for-demo') })
  });
  assert.equal(demoSyncSummary.data.rootPath, externalRoot);
  assert.ok(demoSyncSummary.data.scanned >= 4);
  const demoPrivateSearch = await request(`${base}/search/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: 'personal-smoke', page: 1, pageSize: 10 })
  });
  assert.equal(demoPrivateSearch.data.total, 0);

  const department = await request(`${base}/departments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟部门', code: 'SMOKE_DEP' })
  });
  const childDepartment = await request(`${base}/departments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟子部门', parentId: department.data.id })
  });
  const updatedDepartment = await request(`${base}/departments/${childDepartment.data.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟子部门更新', parentId: null, status: 'disabled' })
  });
  assert.equal(updatedDepartment.data.status, 'disabled');
  await request(`${base}/departments/${department.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });

  const role = await request(`${base}/roles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟角色', code: 'SMOKE_ROLE' })
  });
  const childRole = await request(`${base}/roles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟子角色', parentId: role.data.id })
  });
  const updatedRole = await request(`${base}/roles/${childRole.data.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟子角色更新', parentId: null, status: 'disabled', description: 'updated' })
  });
  assert.equal(updatedRole.data.status, 'disabled');
  await request(`${base}/roles/${role.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });

  await fs.mkdir(path.dirname(sampleFile), { recursive: true });
  await fs.writeFile(sampleFile, '质量手册 smoke test content', 'utf8');
  const form = new FormData();
  form.append('parentId', 'n_root');
  form.append('description', 'smoke version');
  form.append('file', new Blob([await fs.readFile(sampleFile)]), 'smoke.txt');
  const upload = await request(`${base}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  assert.equal(upload.data.name, 'smoke.txt');
  assert.equal(upload.data.hasUnread, true);
  assert.equal(upload.data.unreadCount, 1);

  const demoUnreadChildren = await request(`${base}/nodes/n_root/children`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  const demoUnreadFile = demoUnreadChildren.data.find((item) => item.id === upload.data.id);
  assert.equal(demoUnreadFile.hasUnread, true);
  assert.equal(demoUnreadFile.unreadCount, 1);
  const demoUnreadTree = await request(`${base}/nodes/tree`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.equal(demoUnreadTree.data.find((item) => item.id === 'n_root')?.hasUnread, true);
  await request(`${base}/files/${upload.data.id}/preview`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  const demoReadUploadMessages = await request(`${base}/files/${upload.data.id}/read-upload-messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.equal(demoReadUploadMessages.data.readCount, 1);
  const demoReadChildren = await request(`${base}/nodes/n_root/children`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.equal(demoReadChildren.data.find((item) => item.id === upload.data.id)?.hasUnread, false);

  const originalSecurityPolicy = await request(`${base}/system-settings/security-policy`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const updatedSecurityPolicy = await request(`${base}/system-settings/security-policy`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...originalSecurityPolicy.data,
      enablePreviewWatermark: true,
      blockSensitiveDownload: true,
      allowAdminBypass: true,
      logSensitiveAccess: true,
      watermarkTextMode: 'custom',
      customWatermarkText: 'SMOKE WATERMARK'
    })
  });
  assert.equal(updatedSecurityPolicy.data.blockSensitiveDownload, true);
  const securityUpdatedNode = await request(`${base}/nodes/${upload.data.id}/security`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ securityLevel: 'confidential', sensitive: true, sensitiveReason: 'smoke sensitive' })
  });
  assert.equal(securityUpdatedNode.data.sensitive, true);
  assert.equal(securityUpdatedNode.data.securityLevel, 'confidential');
  const demoSensitivePreview = await request(`${base}/files/${upload.data.id}/preview`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.equal(demoSensitivePreview.data.watermark.enabled, true);
  assert.equal(demoSensitivePreview.data.watermark.text, 'SMOKE WATERMARK');
  const recentAccess = await request(`${base}/recent-access?pageSize=5`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.ok(recentAccess.data.items.some((item) => item.nodeId === upload.data.id && item.action === 'preview'));
  const blockedSensitiveDownload = await requestRaw(`${base}/files/${upload.data.id}/download`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.equal(blockedSensitiveDownload.res.status, 403);
  assert.equal(blockedSensitiveDownload.body.code, 'SENSITIVE_DOWNLOAD_BLOCKED');
  const downloadApproval = await request(`${base}/approvals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: upload.data.id, type: 'download', approverId: 'u_admin', reason: 'download smoke sensitive file' })
  });
  assert.equal(downloadApproval.data.type, 'download');
  assert.equal(downloadApproval.data.status, 'pending');
  const downloadApprovalDetail = await request(`${base}/approvals/${downloadApproval.data.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(downloadApprovalDetail.data.id, downloadApproval.data.id);
  await request(`${base}/approvals/${downloadApproval.data.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: 'allow smoke download' })
  });
  const approvedSensitiveDownload = await requestRaw(`${base}/files/${upload.data.id}/download`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.equal(approvedSensitiveDownload.res.status, 200);
  assert.match(approvedSensitiveDownload.text, /质量手册 smoke test content/);
  const permissionApproval = await request(`${base}/approvals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: upload.data.id, type: 'permission', approverId: 'u_admin', requestedActions: ['file:update'], reason: 'need edit smoke file' })
  });
  await request(`${base}/approvals/${permissionApproval.data.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: 'allow update smoke' })
  });
  const demoPermissionAfterApproval = await request(`${base}/nodes/${upload.data.id}/permissions/effective`, {
    headers: { Authorization: `Bearer ${demoLoginForPrivateDrive.data.token}` }
  });
  assert.equal(demoPermissionAfterApproval.data.actions.includes('file:update'), true);
  const batchMetadata = await request(`${base}/nodes/batch-metadata`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds: [upload.data.id], tags: ['二期测试'], businessStatus: 'draft', securityLevel: 'restricted', sensitive: false })
  });
  assert.equal(batchMetadata.data.count, 1);
  assert.equal(batchMetadata.data.nodes[0].businessStatus, 'draft');
  const wecomSettings = await request(`${base}/system-settings/wecom`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, corpId: 'corp-smoke', agentId: 'agent-smoke', secret: '<test-wecom-secret>', callbackUrl: '/api/v1/wecom/auth/callback', pushMessages: true })
  });
  assert.equal(wecomSettings.data.enabled, true);
  assert.equal(wecomSettings.data.hasSecret, true);
  const wecomTest = await request(`${base}/system-settings/wecom/test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(wecomTest.data.ok, true);
  const wecomCallback = await request(`${base}/wecom/auth/callback?code=smoke-code`);
  assert.equal(wecomCallback.data.status, 'reserved');
  const runtime = await request(`${base}/system/runtime-status`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(runtime.data.status, 'up');
  assert.equal(runtime.data.dataDirExists, true);
  assert.ok(runtime.data.backupItems.length >= 3);
  const auditReport = await request(`${base}/audit-logs/report`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(auditReport.data.total > 0);
  assert.ok(Array.isArray(auditReport.data.topActions));
  await request(`${base}/system-settings/security-policy`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(originalSecurityPolicy.data)
  });
  await request(`${base}/nodes/${upload.data.id}/security`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ securityLevel: 'internal', sensitive: false, sensitiveReason: '' })
  });
  await request(`${base}/nodes/${upload.data.id}/status`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessStatus: 'effective' })
  });

  const dashboard = await request(`${base}/dashboard`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(dashboard.data.growthTrend.length, 7);
  const growthTotals = dashboard.data.growthTrend.reduce((acc, item) => ({
    files: acc.files + item.files,
    versions: acc.versions + item.versions
  }), { files: 0, versions: 0 });
  assert.ok(growthTotals.files >= 1);
  assert.ok(growthTotals.versions >= 1);

  const conditionalRule = await request(`${base}/nodes/n_root/permission-rules`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subjectType: 'role',
      subjectId: 'r_employee',
      actions: ['file:download'],
      effect: 'deny',
      priority: 500,
      condition: { filenameContains: 'smoke', extensions: ['txt'] }
    })
  });
  assert.equal(conditionalRule.data.condition.filenameContains, 'smoke');
  const updatedRule = await request(`${base}/permission-rules/${conditionalRule.data.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 600, condition: { filenameContains: 'smoke', extensions: ['txt'], businessStatus: 'effective' } })
  });
  assert.equal(updatedRule.data.priority, 600);
  assert.equal(updatedRule.data.condition.businessStatus, 'effective');

  const credential = await request(`${base}/api-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟 API 凭证', scopes: ['files:read'] })
  });
  assert.ok(credential.data.accessKey);
  assert.ok(credential.data.secret);
  const apiMe = await request(`${base}/auth/me`, {
    headers: { 'X-Access-Key': credential.data.accessKey, 'X-Access-Secret': credential.data.secret }
  });
  assert.equal(apiMe.data.user.username, 'admin');
  const limitedCredential = await request(`${base}/api-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '限流 API 凭证', scopes: ['files:read'], rateLimitPerMinute: 1 })
  });
  await request(`${base}/auth/me`, {
    headers: { 'X-Access-Key': limitedCredential.data.accessKey, 'X-Access-Secret': limitedCredential.data.secret }
  });
  const rateLimited = await requestRaw(`${base}/auth/me`, {
    headers: { 'X-Access-Key': limitedCredential.data.accessKey, 'X-Access-Secret': limitedCredential.data.secret }
  });
  assert.equal(rateLimited.res.status, 429);
  assert.match(rateLimited.body.message, /频繁/);
  await wait(100);
  const callLogs = await request(`${base}/api-call-logs?pageSize=20`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const loggedCall = callLogs.data.items.find((item) => item.credentialId === credential.data.id);
  assert.ok(loggedCall);
  assert.ok(Number.isFinite(loggedCall.durationMs));
  assert.ok(loggedCall.requestSummary);

  const demoLoginForPermission = await request(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await loginPayload('demo', 'user123'))
  });
  const demoTokenForPermission = demoLoginForPermission.data.token;
  const demoEffectivePermission = await request(`${base}/nodes/${upload.data.id}/permissions/effective`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}` }
  });
  assert.equal(demoEffectivePermission.data.actions.includes('file:download'), false);
  const folderScopeRule = await request(`${base}/nodes/n_root/permission-rules`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subjectType: 'role',
      subjectId: 'r_employee',
      actions: ['file:preview'],
      effect: 'deny',
      scope: 'children_folders',
      priority: 700
    })
  });
  assert.equal(folderScopeRule.data.scope, 'children_folders');
  const demoFolderPermission = await request(`${base}/nodes/${syncedFolder.id}/permissions/effective`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}` }
  });
  assert.equal(demoFolderPermission.data.actions.includes('file:preview'), false);
  const demoFilePermissionAfterFolderScope = await request(`${base}/nodes/${upload.data.id}/permissions/effective`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}` }
  });
  assert.equal(demoFilePermissionAfterFolderScope.data.actions.includes('file:preview'), true);
  const previewPermission = await request(`${base}/nodes/${upload.data.id}/permissions/effective?userId=u_demo`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(previewPermission.data.user.id, 'u_demo');
  assert.equal(previewPermission.data.actions.includes('file:download'), false);

  const templates = await request(`${base}/permission-templates`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(templates.data.some((item) => item.name === '只读浏览'));
  const smokeTemplate = await request(`${base}/permission-templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '冒烟可见模板',
      description: '批量授权测试模板',
      actions: ['visible'],
      effect: 'allow',
      scope: 'self',
      priority: 900
    })
  });
  assert.equal(smokeTemplate.data.name, '冒烟可见模板');
  const batchFolder = await request(`${base}/folders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId: 'n_root', name: '批量授权目录' })
  });
  await request(`${base}/nodes/${batchFolder.data.id}/permission-rules`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subjectType: 'role', subjectId: 'r_employee', actions: ['visible'], effect: 'deny', scope: 'self', priority: 800 })
  });
  const demoRootBeforeBatch = await request(`${base}/nodes/n_root/children`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}` }
  });
  assert.equal(demoRootBeforeBatch.data.some((item) => item.id === batchFolder.data.id), false);
  const batchPermission = await request(`${base}/nodes/${batchFolder.data.id}/permission-rules/batch`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId: smokeTemplate.data.id, subjectType: 'department', subjectIds: ['d_quality'] })
  });
  assert.equal(batchPermission.data.created.length, 1);
  const demoRootAfterBatch = await request(`${base}/nodes/n_root/children`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}` }
  });
  assert.equal(demoRootAfterBatch.data.some((item) => item.id === batchFolder.data.id), true);

  await fs.mkdir(path.join(externalRoot, '仅同步目录', 'excluded'), { recursive: true });
  await fs.writeFile(path.join(externalRoot, '仅同步目录', 'allowed.txt'), 'include allowed smoke sync content', 'utf8');
  await fs.writeFile(path.join(externalRoot, '仅同步目录', 'skip.tmp'), 'should be excluded by extension', 'utf8');
  await fs.writeFile(path.join(externalRoot, '仅同步目录', 'excluded', 'hidden.txt'), 'should be excluded by folder rule', 'utf8');
  await request(`${base}/system-settings/external-library`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rootPath: externalRoot, includePaths: ['仅同步目录'], excludePatterns: ['*.tmp', 'excluded/*'] })
  });
  const includeSyncSummary = await request(`${base}/external-library/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(includeSyncSummary.data.includePaths[0], '仅同步目录');
  assert.ok(includeSyncSummary.data.skippedPaths.some((item) => item.path.includes('skip.tmp')));
  assert.ok(includeSyncSummary.data.skippedPaths.some((item) => item.path.includes('excluded')));
  const includeRootChildren = await request(`${base}/nodes/n_root/children`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const includedFolder = includeRootChildren.data.find((item) => item.name === '仅同步目录');
  assert.ok(includedFolder);
  const includedChildren = await request(`${base}/nodes/${includedFolder.id}/children`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.deepEqual(includedChildren.data.map((item) => item.name).sort(), ['allowed.txt']);
  const syncJobs = await request(`${base}/external-library/sync-jobs?pageSize=2`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(syncJobs.data.items[0].status, 'completed');

  const restrictedFolder = await request(`${base}/folders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId: 'n_root', name: '仅管理员可见目录' })
  });
  const viewAccess = await request(`${base}/nodes/${restrictedFolder.data.id}/view-access`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restricted: true, audience: { userIds: ['u_admin'] } })
  });
  assert.equal(viewAccess.data.restricted, true);
  assert.deepEqual(viewAccess.data.audience.userIds, ['u_admin']);
  const demoRootAfterViewAccess = await request(`${base}/nodes/n_root/children`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}` }
  });
  assert.equal(demoRootAfterViewAccess.data.some((item) => item.id === restrictedFolder.data.id), false);

  const protectedFolder = await request(`${base}/folders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId: 'n_root', name: '文件夹密码测试' })
  });
  const folderPassword = await request(`${base}/nodes/${protectedFolder.data.id}/password`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, password: 'Folder1234' })
  });
  assert.equal(folderPassword.data.passwordEnabled, true);
  assert.equal(folderPassword.data.passwordProtected, true);
  const lockedFolderChildren = await requestRaw(`${base}/nodes/${protectedFolder.data.id}/children`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}` }
  });
  assert.equal(lockedFolderChildren.res.status, 423);
  assert.equal(lockedFolderChildren.body.code, 'NODE_PASSWORD_REQUIRED');
  const badFolderPassword = await requestRaw(`${base}/nodes/${protectedFolder.data.id}/password/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoTokenForPermission}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'bad' })
  });
  assert.equal(badFolderPassword.res.status, 400);
  const folderUnlock = await request(`${base}/nodes/${protectedFolder.data.id}/password/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoTokenForPermission}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Folder1234' })
  });
  assert.ok(folderUnlock.data.unlockToken);
  const unlockedFolderChildren = await request(`${base}/nodes/${protectedFolder.data.id}/children`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}`, 'X-Node-Unlock': folderUnlock.data.unlockToken }
  });
  assert.deepEqual(unlockedFolderChildren.data, []);

  const protectedFileForm = new FormData();
  protectedFileForm.append('parentId', 'n_root');
  protectedFileForm.append('file', new Blob([Buffer.from('file password smoke content')]), 'file-password-smoke.txt');
  const protectedFile = await request(`${base}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: protectedFileForm
  });
  await request(`${base}/nodes/${protectedFile.data.id}/password`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, password: 'File1234' })
  });
  const lockedFilePreview = await requestRaw(`${base}/files/${protectedFile.data.id}/preview`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(lockedFilePreview.res.status, 423);
  const fileUnlock = await request(`${base}/nodes/${protectedFile.data.id}/password/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'File1234' })
  });
  const unlockedFilePreview = await request(`${base}/files/${protectedFile.data.id}/preview`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Node-Unlock': fileUnlock.data.unlockToken }
  });
  assert.match(unlockedFilePreview.data.content, /file password smoke/);

  const statusUpdate = await request(`${base}/nodes/${upload.data.id}/status`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessStatus: 'archived' })
  });
  assert.equal(statusUpdate.data.businessStatus, 'archived');

  const search = await request(`${base}/search/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: '质量手册', page: 1, pageSize: 10 })
  });
  assert.ok(search.data.total >= 1);
  const advancedSearch = await request(`${base}/search/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keyword: '质量手册',
      fileTypes: ['txt'],
      creatorId: 'u_admin',
      updatedFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      updatedTo: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sortBy: 'name',
      sortDir: 'asc',
      page: 1,
      pageSize: 10
    })
  });
  const advancedHit = advancedSearch.data.items.find((item) => item.id === upload.data.id);
  assert.ok(advancedHit);
  assert.equal(advancedHit.extension, 'txt');
  assert.equal(advancedHit.createdBy, 'u_admin');
  assert.equal(advancedHit.businessStatus, 'archived');
  assert.equal(advancedHit.matchedKeyword, '质量手册');
  assert.equal(advancedHit.highlight, '质量手册');

  const versions = await request(`${base}/files/${upload.data.id}/versions`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(versions.data.length, 1);
  const initialVersionLogs = await request(`${base}/files/${upload.data.id}/version-logs`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(initialVersionLogs.data[0].action, 'create');

  const directWorkflow = await request(`${base}/nodes/${upload.data.id}/workflow-actions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish', comment: 'direct publish smoke' })
  });
  assert.equal(directWorkflow.data.node.businessStatus, 'effective');
  const approval = await request(`${base}/nodes/${upload.data.id}/approvals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'invalidate', approverId: 'u_admin', comment: 'invalidate smoke approval' })
  });
  assert.equal(approval.data.status, 'pending');
  assert.equal(approval.data.requestedStatus, 'invalid');
  const approvalTodo = await request(`${base}/approvals?scope=todo&status=pending&pageSize=20`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(approvalTodo.data.items.some((item) => item.id === approval.data.id));
  const nodeWorkflow = await request(`${base}/nodes/${upload.data.id}/workflow`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(nodeWorkflow.data.approvals.some((item) => item.id === approval.data.id));
  const approved = await request(`${base}/approvals/${approval.data.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: 'approved smoke' })
  });
  assert.equal(approved.data.approval.status, 'approved');
  assert.equal(approved.data.node.businessStatus, 'invalid');

  const batchTarget = await request(`${base}/folders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentId: 'n_root', name: '冒烟批量目标' })
  });
  const batchForm = new FormData();
  batchForm.append('parentId', 'n_root');
  batchForm.append('file', new Blob([Buffer.from('batch body')]), 'batch-move.txt');
  const batchUpload = await request(`${base}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: batchForm
  });
  await request(`${base}/nodes/batch-move`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds: [batchUpload.data.id], targetParentId: batchTarget.data.id })
  });
  const batchChildren = await request(`${base}/nodes/${batchTarget.data.id}/children`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(batchChildren.data.some((item) => item.id === batchUpload.data.id));
  const batchDelete = await request(`${base}/nodes/batch-delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds: [batchUpload.data.id] })
  });
  assert.equal(batchDelete.data.count, 1);

  const attachmentForm = new FormData();
  attachmentForm.append('description', 'smoke attachment');
  attachmentForm.append('file', new Blob([Buffer.from('attachment body')]), 'attachment.txt');
  const attachment = await request(`${base}/nodes/${upload.data.id}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: attachmentForm
  });
  assert.equal(attachment.data.name, 'attachment.txt');
  const attachments = await request(`${base}/nodes/${upload.data.id}/attachments`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(attachments.data.length, 1);
  const attachmentDownload = await fetch(`${base}/attachments/${attachment.data.id}/download`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(attachmentDownload.ok, true);

  const relatedForm = new FormData();
  relatedForm.append('parentId', 'n_root');
  relatedForm.append('description', 'related file');
  relatedForm.append('file', new Blob([Buffer.from('related smoke file')]), 'related-smoke.txt');
  const relatedUpload = await request(`${base}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: relatedForm
  });
  const relation = await request(`${base}/nodes/${upload.data.id}/relations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ relatedNodeId: relatedUpload.data.id, description: 'smoke relation' })
  });
  assert.equal(relation.data.relatedNodeId, relatedUpload.data.id);
  const relations = await request(`${base}/nodes/${upload.data.id}/relations`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(relations.data.length, 1);

  const prop = await request(`${base}/property-definitions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '生效时间', dataType: 'date', targetType: 'file' })
  });
  assert.equal(prop.data.name, '生效时间');

  const enumProp = await request(`${base}/property-definitions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '保密等级', dataType: 'enum', targetType: 'file', required: true, options: ['内部', '秘密'] })
  });
  const updatedEnumProp = await request(`${base}/property-definitions/${enumProp.data.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '保密级别', dataType: 'enum', targetType: 'file', required: true, options: '公开,内部,秘密' })
  });
  assert.deepEqual(updatedEnumProp.data.options, ['公开', '内部', '秘密']);

  const category = await request(`${base}/categories`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟分类', sortOrder: 20 })
  });
  const childCategory = await request(`${base}/categories`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟子分类', parentId: category.data.id })
  });
  const updatedCategory = await request(`${base}/categories/${childCategory.data.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟子分类更新', parentId: null, status: 'disabled', sortOrder: 30 })
  });
  assert.equal(updatedCategory.data.fullPath, '/冒烟子分类更新');
  assert.equal(updatedCategory.data.status, 'disabled');

  await request(`${base}/nodes/${upload.data.id}/properties`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: ['质量体系'], categoryIds: ['c_iso'], values: { [prop.data.id]: '2026-07-08' } })
  });

  const categoryFiles = await request(`${base}/categories/c_iso/files?pageSize=20`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(categoryFiles.data.items.some((item) => item.id === upload.data.id));

  const tagSearch = await request(`${base}/search/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: '质量体系', page: 1, pageSize: 10 })
  });
  assert.ok(tagSearch.data.total >= 1);

  const share = await request(`${base}/nodes/${upload.data.id}/share`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'share',
      description: 'smoke share',
      audience: { userIds: ['u_demo'] },
      actions: ['visible', 'file:preview', 'file:download']
    })
  });
  assert.equal(share.data.status, 'active');
  const shares = await request(`${base}/shares?pageSize=20`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(shares.data.items.some((item) => item.id === share.data.id));
  const revokedShare = await request(`${base}/shares/${share.data.id}/revoke`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(revokedShare.data.status, 'revoked');

  const announcementForm = new FormData();
  announcementForm.append('title', '冒烟公告');
  announcementForm.append('content', '公告内容 smoke announcement');
  announcementForm.append('status', 'draft');
  announcementForm.append('audience', JSON.stringify({ all: true }));
  announcementForm.append('file', new Blob([Buffer.from('announcement attachment')]), 'announcement.txt');
  const announcement = await request(`${base}/announcements`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: announcementForm
  });
  assert.equal(announcement.data.status, 'draft');
  const publishedAnnouncement = await request(`${base}/announcements/${announcement.data.id}/publish`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(publishedAnnouncement.data.status, 'published');
  const announcementDownload = await fetch(`${base}/announcements/${announcement.data.id}/attachment`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(announcementDownload.ok, true);
  const demoAnnouncementMessages = await request(`${base}/messages?pageSize=20`, {
    headers: { Authorization: `Bearer ${demoTokenForPermission}` }
  });
  assert.ok(demoAnnouncementMessages.data.items.some((item) => item.messageType === 'announcement.publish'));

  const reminder = await request(`${base}/nodes/${upload.data.id}/reminders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ triggerAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), cycle: 'none', remark: 'smoke reminder' })
  });
  assert.equal(reminder.data.status, 'active');
  const updatedReminder = await request(`${base}/reminders/${reminder.data.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      triggerAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      endAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      cycle: 'weekly',
      intervalDays: 2,
      remindBy: ['system', 'email'],
      remark: 'updated smoke reminder'
    })
  });
  assert.equal(updatedReminder.data.cycle, 'weekly');
  assert.deepEqual(updatedReminder.data.remindBy, ['system', 'email']);
  const reminders = await request(`${base}/reminders`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(reminders.data.some((item) => item.id === reminder.data.id));
  await request(`${base}/reminders/${reminder.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });

  const demoLogin = await request(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await loginPayload('demo', 'user123'))
  });
  const demoToken = demoLogin.data.token;
  await request(`${base}/nodes/${upload.data.id}/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventTypes: ['update', 'delete'] })
  });
  const demoSubscriptions = await request(`${base}/subscriptions`, {
    headers: { Authorization: `Bearer ${demoToken}` }
  });
  assert.ok(demoSubscriptions.data.some((item) => item.nodeId === upload.data.id));

  await fs.writeFile(sampleFile, '质量手册 smoke test content version two', 'utf8');
  const versionForm = new FormData();
  versionForm.append('description', 'second version');
  versionForm.append('file', new Blob([await fs.readFile(sampleFile)]), 'smoke.txt');
  await request(`${base}/files/${upload.data.id}/versions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: versionForm
  });
  const updatedVersions = await request(`${base}/files/${upload.data.id}/versions`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(updatedVersions.data.length, 2);
  const uploadVersionLogs = await request(`${base}/files/${upload.data.id}/version-logs`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(uploadVersionLogs.data.some((item) => item.action === 'upload' && item.toVersionNo === 2));
  const historicalPreview = await request(`${base}/files/${upload.data.id}/preview?versionId=${updatedVersions.data[1].id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(historicalPreview.data.version.id, updatedVersions.data[1].id);
  const rollback = await request(`${base}/files/${upload.data.id}/versions/${updatedVersions.data[1].id}/rollback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(rollback.data.currentVersion.id, updatedVersions.data[1].id);
  const rollbackVersionLogs = await request(`${base}/files/${upload.data.id}/version-logs`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(rollbackVersionLogs.data[0].action, 'rollback');
  assert.match(historicalPreview.data.content, /质量手册 smoke test content/);

  const demoMessages = await request(`${base}/messages?pageSize=20`, {
    headers: { Authorization: `Bearer ${demoToken}` }
  });
  const subscriptionMessage = demoMessages.data.items.find((item) => item.messageType === 'subscription.update');
  assert.ok(subscriptionMessage);
  const messageDetail = await request(`${base}/messages/${subscriptionMessage.id}`, {
    headers: { Authorization: `Bearer ${demoToken}` }
  });
  assert.equal(messageDetail.data.id, subscriptionMessage.id);
  assert.equal(messageDetail.data.relatedNode.id, upload.data.id);
  const unreadMessagesBeforeRead = await request(`${base}/messages?unread=true&pageSize=20`, {
    headers: { Authorization: `Bearer ${demoToken}` }
  });
  assert.ok(unreadMessagesBeforeRead.data.items.some((item) => item.id === subscriptionMessage.id));
  const readMessage = await request(`${base}/messages/${subscriptionMessage.id}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${demoToken}` }
  });
  assert.ok(readMessage.data.readAt);
  const unreadMessagesAfterRead = await request(`${base}/messages?unread=true&pageSize=20`, {
    headers: { Authorization: `Bearer ${demoToken}` }
  });
  assert.equal(unreadMessagesAfterRead.data.items.some((item) => item.id === subscriptionMessage.id), false);
  await request(`${base}/subscriptions/${demoSubscriptions.data.find((item) => item.nodeId === upload.data.id).id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${demoToken}` }
  });

  await request(`${base}/relations/${relation.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  await request(`${base}/attachments/${attachment.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  await request(`${base}/property-definitions/${enumProp.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  await request(`${base}/categories/${category.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });

  await request(`${base}/nodes/${upload.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  const trash = await request(`${base}/trash?pageSize=20`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(trash.data.items.some((item) => item.id === upload.data.id));
  await request(`${base}/trash/${upload.data.id}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });

  const audit = await request(`${base}/audit-logs`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.ok(audit.data.total >= 1);
  const auditExport = await fetch(`${base}/audit-logs/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(auditExport.ok, true);
  assert.match(await auditExport.text(), /动作/);

  console.log('api smoke passed');
} finally {
  await fs.chmod(path.join(externalRoot, '无权限目录'), 0o700).catch(() => {});
  server.kill('SIGTERM');
}
