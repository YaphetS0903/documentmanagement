import express from 'express';
import cors from 'cors';
import multer from 'multer';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mime from 'mime-types';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import httpProxy from 'http-proxy';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { SAML } from '@node-saml/node-saml';
import { Client as LdapClient } from 'ldapts';
import NodeClam from 'clamscan';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { addAudit, addMessage, ACTIONS, fullActions, loadDb, reloadDb, resetDb, saveDb } from './db.js';
import {
  ensureMysqlStore,
  getStorageRuntimeInfo,
  normalizeStorageConfig,
  readStorageConfig,
  sanitizeStorageConfig,
  saveMysqlSnapshot,
  testMysqlConnection,
  writeStorageConfig
} from './storage.js';
import { signToken, verifyToken } from './token.js';
import { createBlankOfficeBuffer } from './officeTemplates.js';
import {
  createError,
  ensureDir,
  extname,
  fileMd5FromPath,
  hashPassword,
  newId,
  now,
  ok,
  pickPublicUser,
  safeFilename,
  verifyPassword
} from './utils.js';

await ensureDir(config.uploadDir);
await ensureDir(config.tmpDir);
await ensureDir(config.backupDir);
await ensureDir(config.quarantineDir);
await loadDb();

const upload = multer({ dest: config.tmpDir, limits: { fileSize: 1024 * 1024 * 300 } });
const app = express();
const onlyOfficeProxy = httpProxy.createProxyServer({ changeOrigin: true, xfwd: true, ws: true });
const DEFAULT_FILE_POLICY = {
  allowedExtensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'csv', 'json', 'xml', 'html', 'png', 'jpg', 'jpeg', 'gif', 'zip'],
  maxSizeMb: 2048,
  chunkSizeMb: 8,
  enableVirusScan: false,
  rejectExecutableFiles: true
};
const SECURITY_LEVELS = ['public', 'internal', 'restricted', 'confidential'];
const SECURITY_LEVEL_LABELS = {
  public: '公开',
  internal: '内部',
  restricted: '受限',
  confidential: '机密'
};
const DEFAULT_SECURITY_POLICY = {
  enablePreviewWatermark: true,
  enableDownloadWatermark: false,
  blockSensitiveDownload: true,
  allowAdminBypass: true,
  logSensitiveAccess: true,
  watermarkTextMode: 'user',
  customWatermarkText: '',
  requireDownloadApprovalForSensitive: false,
  requirePublishApproval: true,
  requirePermissionApproval: true
};
const DEFAULT_ATTACHMENT_PURPOSES = [
  { code: 'supplement', name: '正文补充', enabled: true },
  { code: 'approval', name: '审批材料', enabled: true },
  { code: 'evidence', name: '证明文件', enabled: true },
  { code: 'reference', name: '参考资料', enabled: true },
  { code: 'other', name: '其他', enabled: true }
];
const DEFAULT_IDENTITY_SETTINGS = {
  oidc: { enabled: false, issuer: '', clientId: '', clientSecret: '', redirectUri: '', scopes: 'openid profile email', usernameClaim: 'preferred_username', displayNameClaim: 'name', emailClaim: 'email', autoProvision: false },
  saml: { enabled: false, entryPoint: '', issuer: 'document-platform', callbackUrl: '', idpCert: '', usernameAttribute: 'nameID', displayNameAttribute: 'displayName', emailAttribute: 'email', autoProvision: false },
  ldap: { enabled: false, url: '', bindDn: '', bindPassword: '', baseDn: '', userFilter: '(objectClass=person)', usernameAttribute: 'sAMAccountName', displayNameAttribute: 'displayName', emailAttribute: 'mail', departmentAttribute: 'department', syncUsers: true },
  hr: { enabled: false, syncSecret: '', autoDisableMissing: false }
};
const DEFAULT_FILE_STORAGE_SETTINGS = {
  provider: 'local',
  nasRoot: '',
  s3: { endpoint: '', region: 'us-east-1', bucket: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: true },
  quota: { totalGb: 0, defaultUserGb: 0, userLimitsGb: {} },
  lifecycle: { uploadSessionDays: 7, quarantineDays: 30, historicalVersionDays: 0, keepLatestVersions: 3 },
  updatedAt: null,
  updatedBy: null
};
const DEFAULT_WECOM_SETTINGS = {
  enabled: false,
  corpId: '',
  agentId: '',
  secret: '',
  callbackUrl: '',
  syncDepartments: true,
  syncUsers: true,
  pushMessages: false,
  apiBaseUrl: 'https://qyapi.weixin.qq.com',
  lastSyncAt: null,
  lastSyncResult: null,
  lastTestAt: null,
  lastTestResult: null
};
const DEFAULT_OFFICE_PREVIEW_SETTINGS = {
  enabled: false,
  provider: 'onlyoffice',
  documentServerUrl: '',
  publicBaseUrl: '',
  jwtSecret: '',
  lastTestAt: null,
  lastTestResult: null
};
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MINUTES = 15;
const NODE_PASSWORD_UNLOCK_MS = 30 * 60 * 1000;
const VIEW_ACCESS_ACTIONS = ['visible', 'file:preview', 'file:download'];
const EXTERNAL_SYNC_IGNORED_DIR_NAMES = new Set([
  '.Trash',
  '.git',
  '.svn',
  '.hg',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.yarn',
  'node_modules',
  'Library',
  'Caches',
  '$RECYCLE.BIN',
  'System Volume Information'
]);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'xml', 'html', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'jsonl', 'log',
  'py', 'pyw', 'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'config', 'properties', 'env', 'example', 'gitignore',
  'sql', 'java', 'kt', 'kts', 'go', 'rs', 'php', 'rb', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift',
  'dockerfile', 'makefile'
]);
const TEXT_PREVIEW_FILENAMES = new Set(['.gitignore', '.dockerignore', '.npmrc', '.nvmrc', '.env', 'dockerfile', 'makefile', 'readme', 'license']);
const JSON_PREVIEW_EXTENSIONS = new Set(['json']);
const OFFICE_PREVIEW_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const OFFICE_EDIT_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const SEARCH_OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const captchaStore = new Map();
const apiRateBuckets = new Map();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

function onlyOfficeProxyTarget(db) {
  const settings = currentOfficePreviewSettings(db);
  if (!settings.enabled || !settings.documentServerUrl) {
    throw createError(503, 'OFFICE_PREVIEW_UNAVAILABLE', 'Office 原版预览服务未启用');
  }
  let target;
  try {
    target = new URL(settings.documentServerUrl);
  } catch {
    throw createError(503, 'OFFICE_PREVIEW_UNAVAILABLE', 'Office 原版预览服务地址无效');
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw createError(503, 'OFFICE_PREVIEW_UNAVAILABLE', 'Office 原版预览服务地址仅支持 HTTP 或 HTTPS');
  }
  return target.toString().replace(/\/+$/, '');
}

function onlyOfficeProxyHeaders(req, forwardedPath = '') {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const headers = {
    'X-Forwarded-Host': req.headers.host || `localhost:${config.port}`,
    'X-Forwarded-Proto': forwardedProto || (req.socket.encrypted ? 'https' : 'http')
  };
  if (forwardedPath) headers['X-Forwarded-Path'] = forwardedPath;
  return headers;
}

function isOnlyOfficeRootPath(url = '') {
  const pathname = String(url).split('?')[0];
  return /^(?:\/\d+\.\d+\.\d+[.-][\w-]+)?\/(?:web-apps|sdkjs|sdkjs-plugins|fonts|dictionaries|cache|internal|info|coauthoring|doc)(?:\/|$)/i.test(pathname)
    || /^\/(?:ConvertService|CommandService|healthcheck)(?:\.ashx)?(?:\/|$)/i.test(pathname);
}

function proxyOnlyOfficeRequest(req, res, next, forwardedPath = '') {
  Promise.resolve(loadDb())
    .then((db) => {
      const target = onlyOfficeProxyTarget(db);
      onlyOfficeProxy.web(req, res, { target, headers: onlyOfficeProxyHeaders(req, forwardedPath) }, (error) => {
        next(createError(502, 'OFFICE_PREVIEW_PROXY_ERROR', `Office 原版预览代理失败：${error.message}`));
      });
    })
    .catch(next);
}

app.use((req, res, next) => {
  if (!isOnlyOfficeRootPath(req.url)) return next();
  return proxyOnlyOfficeRequest(req, res, next);
});

app.use('/onlyoffice', (req, res, next) => {
  return proxyOnlyOfficeRequest(req, res, next, '/onlyoffice');
});

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function saveDbBestEffort(db, label) {
  try {
    await saveDb(db);
    return true;
  } catch (error) {
    console.error(`${label} save failed`, error);
    return false;
  }
}

function getBearer(req) {
  const queryToken = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  if (queryToken) return String(queryToken);
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function attachApiCallLogger(req, res) {
  if (!req.apiCredential) return;
  const startedAt = Date.now();
  const requestSummary = {
    query: req.query || {},
    bodyKeys: req.body && typeof req.body === 'object' && !(req.body instanceof Buffer) ? Object.keys(req.body).slice(0, 30) : []
  };
  res.on('finish', () => {
    req.db.apiCallLogs.unshift({
      id: newId('acl_'),
      credentialId: req.apiCredential.id,
      accessKey: req.apiCredential.accessKey,
      userId: req.user.id,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      requestSummary,
      ip: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
      createdAt: now()
    });
    saveDb(req.db).catch((error) => console.error('failed to save api call log', error));
  });
}

function checkApiRateLimit(credential) {
  const limit = Number(credential.rateLimitPerMinute || 120);
  const bucketKey = credential.id;
  const currentMinute = Math.floor(Date.now() / 60000);
  const bucket = apiRateBuckets.get(bucketKey);
  if (!bucket || bucket.minute !== currentMinute) {
    apiRateBuckets.set(bucketKey, { minute: currentMinute, count: 1 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) throw createError(429, 'RATE_LIMITED', 'API 调用过于频繁，请稍后再试');
}

function validatePasswordPolicy(password) {
  const value = String(password || '');
  if (value.length < 8) throw createError(400, 'VALIDATION_ERROR', '密码至少 8 位');
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) throw createError(400, 'VALIDATION_ERROR', '密码必须同时包含字母和数字');
  return value;
}

function createCaptcha() {
  const left = Math.floor(Math.random() * 8) + 2;
  const right = Math.floor(Math.random() * 8) + 2;
  const id = newId('cap_');
  captchaStore.set(id, { answer: String(left + right), expiresAt: Date.now() + 5 * 60 * 1000 });
  return { id, question: `${left} + ${right} = ?` };
}

function validateCaptcha(captchaId, captchaAnswer) {
  const captcha = captchaStore.get(captchaId);
  captchaStore.delete(captchaId);
  if (!captcha || captcha.expiresAt < Date.now()) throw createError(400, 'VALIDATION_ERROR', '验证码已过期，请刷新后重试');
  if (String(captchaAnswer || '').trim() !== captcha.answer) throw createError(400, 'VALIDATION_ERROR', '验证码错误');
}

async function authenticate(req, res, next) {
  const db = ensureDbShape(await loadDb());
  const accessKey = req.headers['x-access-key'];
  const accessSecret = req.headers['x-access-secret'];
  if (accessKey || accessSecret) {
    const credential = db.apiCredentials.find((item) => item.accessKey === accessKey && item.status === 'enabled');
    if (!credential || !verifyPassword(accessSecret || '', { passwordHash: credential.secretHash, passwordSalt: credential.secretSalt })) {
      return next(createError(401, 'UNAUTHORIZED', 'API 凭证无效'));
    }
    if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now()) {
      credential.status = 'expired';
      await saveDb(db);
      return next(createError(401, 'UNAUTHORIZED', 'API 凭证已过期'));
    }
    try {
      checkApiRateLimit(credential);
    } catch (error) {
      return next(error);
    }
    const user = db.users.find((item) => item.id === credential.userId && item.status === 'enabled');
    if (!user) return next(createError(401, 'UNAUTHORIZED', '凭证关联用户不存在或已禁用'));
    credential.lastUsedAt = now();
    credential.callCount = Number(credential.callCount || 0) + 1;
    req.user = user;
    req.db = db;
    req.apiCredential = credential;
    attachWebhookDispatcher(req, res);
    attachApiCallLogger(req, res);
    return next();
  }
  const token = getBearer(req);
  const payload = verifyToken(token);
  if (!payload) return next(createError(401, 'UNAUTHORIZED', '登录已过期，请重新登录'));
  const user = db.users.find((item) => item.id === payload.userId && item.status === 'enabled');
  if (!user) return next(createError(401, 'UNAUTHORIZED', '用户不存在或已禁用'));
  req.user = user;
  req.db = db;
  attachWebhookDispatcher(req, res);
  next();
}

function requireAuth(req, res, next) {
  return authenticate(req, res, next);
}

function isAdmin(user) {
  return (user.roleIds || []).includes('r_admin');
}

const COLLECTIONS = [
  'users',
  'departments',
  'roles',
  'nodes',
  'versions',
  'permissionTemplates',
  'permissionRules',
  'categories',
  'documentCategories',
  'propertyDefinitions',
  'propertyValues',
  'messages',
  'notificationDeliveries',
  'backupJobs',
  'systemAlerts',
  'favorites',
  'favoriteFolders',
  'comments',
  'ratings',
  'attachments',
  'fileRelations',
  'reminders',
  'documentApprovals',
  'approvalTemplates',
  'documentReviews',
  'versionChangeLogs',
  'officeEditSessions',
  'subscriptions',
  'shares',
  'externalLinks',
  'externalLinkAccessLogs',
  'announcements',
  'auditLogs',
  'apiCredentials',
  'apiCallLogs',
  'webhookSubscriptions',
  'webhookDeliveries',
  'loginTickets',
  'wecomSyncJobs',
  'externalSyncJobs',
  'recentAccesses',
  'searchEvents'
  ,'uploadSessions'
  ,'quarantineItems'
];

function defaultPermissionTemplates(timestamp = now()) {
  return [
    {
      id: 'pt_readonly',
      name: '只读浏览',
      description: '允许查看、预览和下载，适合普通员工查阅资料。',
      actions: ['visible', 'file:preview', 'file:download'],
      effect: 'allow',
      scope: 'all',
      priority: 100,
      condition: null,
      inheritEnabled: true,
      systemBuiltIn: true,
      createdBy: 'u_admin',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: 'pt_maintainer',
      name: '文档维护',
      description: '允许创建、更新、删除和版本维护，适合文档管理员。',
      actions: ['visible', 'folder:create', 'file:create', 'file:preview', 'file:download', 'file:update', 'file:delete'],
      effect: 'allow',
      scope: 'all',
      priority: 200,
      condition: null,
      inheritEnabled: true,
      systemBuiltIn: true,
      createdBy: 'u_admin',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: 'pt_no_download',
      name: '禁止下载',
      description: '保留可见和预览，禁止下载，适合受控资料。',
      actions: ['file:download'],
      effect: 'deny',
      scope: 'all',
      priority: 600,
      condition: null,
      inheritEnabled: true,
      systemBuiltIn: true,
      createdBy: 'u_admin',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
}

function ensureDbShape(db) {
  const hadPermissionTemplates = Array.isArray(db.permissionTemplates);
  COLLECTIONS.forEach((name) => {
    if (!Array.isArray(db[name])) db[name] = [];
  });
  db.meta = db.meta || {};
  if (!hadPermissionTemplates && !db.meta.permissionTemplateDefaultsSeeded) {
    const existingIds = new Set(db.permissionTemplates.map((item) => item.id));
    defaultPermissionTemplates().forEach((template) => {
      if (!existingIds.has(template.id)) db.permissionTemplates.push(template);
    });
    db.meta.permissionTemplateDefaultsSeeded = true;
  }
  db.settings = db.settings || {};
  const defaultCategories = [
    { id: 'c_contract', name: '合同' },
    { id: 'c_project', name: '项目' },
    { id: 'c_archive', name: '档案' },
    { id: 'c_case_file', name: '案卷' },
    { id: 'c_iso', name: 'ISO9000文件' }
  ];
  defaultCategories.forEach((category, index) => {
    if (!db.categories.some((item) => item.id === category.id || (item.parentId == null && item.name === category.name))) {
      db.categories.push({ ...category, parentId: null, fullPath: `/${category.name}`, sortOrder: index + 1, status: 'enabled' });
    }
  });
  db.settings.filePolicy = {
    ...DEFAULT_FILE_POLICY,
    ...(db.settings.filePolicy || {})
  };
  db.settings.securityPolicy = normalizeSecurityPolicy(db.settings.securityPolicy || {});
  db.settings.attachmentPurposes = Array.isArray(db.settings.attachmentPurposes) && db.settings.attachmentPurposes.length
    ? db.settings.attachmentPurposes
    : DEFAULT_ATTACHMENT_PURPOSES.map((item) => ({ ...item }));
  db.settings.identity = normalizeIdentitySettings(db.settings.identity || {});
  db.settings.fileStorage = normalizeFileStorageSettings(db.settings.fileStorage || {});
  db.settings.wecom = normalizeWecomSettings(db.settings.wecom || {});
  db.settings.officePreview = normalizeOfficePreviewSettings(db.settings.officePreview || {});
  db.settings.externalLibrary = {
    rootPath: db.settings.externalLibrary?.rootPath || config.externalLibraryRoot || '',
    includePaths: normalizeOptions(db.settings.externalLibrary?.includePaths || []),
    excludePatterns: normalizeOptions(db.settings.externalLibrary?.excludePatterns || []),
    lastSyncedAt: db.settings.externalLibrary?.lastSyncedAt || null,
    lastSyncSummary: db.settings.externalLibrary?.lastSyncSummary || null,
    lastSyncJob: db.settings.externalLibrary?.lastSyncJob || null
  };
  db.users.forEach((user) => {
    user.failedLoginCount = Number(user.failedLoginCount || 0);
    user.lastFailedLoginAt = user.lastFailedLoginAt || null;
    user.lockedUntil = user.lockedUntil || null;
    user.defaultWorkPathId = user.defaultWorkPathId || null;
    user.avatarStorageKey = user.avatarStorageKey || '';
    user.avatarMimeType = user.avatarMimeType || '';
  });
  db.messages.forEach((message) => {
    message.archivedAt = message.archivedAt || null;
    message.deletedAt = message.deletedAt || null;
  });
  db.nodes.forEach((node) => {
    ensureNodeSecurityShape(db, node);
    ensureNodeGovernanceShape(node);
  });
  return db;
}

function nodeById(db, id) {
  return db.nodes.find((item) => item.id === id && item.status !== 'deleted');
}

function includeDeletedNodeById(db, id) {
  return db.nodes.find((item) => item.id === id);
}

function versionById(db, id) {
  return db.versions.find((item) => item.id === id);
}

function currentVersion(db, node) {
  return node?.currentVersionId ? versionById(db, node.currentVersionId) : null;
}

function ancestors(db, node) {
  const result = [];
  let cursor = node;
  while (cursor?.parentId) {
    const parent = includeDeletedNodeById(db, cursor.parentId);
    if (!parent) break;
    result.push(parent);
    cursor = parent;
  }
  return result;
}

function descendants(db, nodeId) {
  const result = [];
  const walk = (parentId) => {
    db.nodes
      .filter((item) => item.parentId === parentId && item.status !== 'deleted')
      .forEach((child) => {
        result.push(child);
        if (child.nodeType === 'folder') walk(child.id);
      });
  };
  walk(nodeId);
  return result;
}

function descendantsIncludingDeleted(db, nodeId) {
  const result = [];
  const walk = (parentId) => {
    db.nodes
      .filter((item) => item.parentId === parentId)
      .forEach((child) => {
        result.push(child);
        if (child.nodeType === 'folder') walk(child.id);
      });
  };
  walk(nodeId);
  return result;
}

function subjectMatches(rule, user) {
  if (rule.subjectType === 'all') return true;
  if (rule.subjectType === 'user') return rule.subjectId === user.id;
  if (rule.subjectType === 'department') return (user.departmentIds || []).includes(rule.subjectId);
  if (rule.subjectType === 'role') return (user.roleIds || []).includes(rule.subjectId);
  return false;
}

function audienceMatches(audience = {}, user) {
  const userIds = audience.userIds || [];
  const departmentIds = audience.departmentIds || [];
  const roleIds = audience.roleIds || [];
  if (audience.all) return true;
  if (userIds.includes(user.id)) return true;
  if (departmentIds.some((id) => (user.departmentIds || []).includes(id))) return true;
  if (roleIds.some((id) => (user.roleIds || []).includes(id))) return true;
  return false;
}

function isExpired(record) {
  return record.expiresAt && new Date(record.expiresAt).getTime() < Date.now();
}

function isNotYetEffective(record) {
  return record.effectiveAt && new Date(record.effectiveAt).getTime() > Date.now();
}

function collectAudienceUsers(db, audience = {}) {
  return db.users
    .filter((user) => user.status === 'enabled')
    .filter((user) => audienceMatches(audience, user))
    .map((user) => user.id);
}

function nodeMatchesSharedScope(db, share, node) {
  if (share.nodeId === node.id) return true;
  if (!share.includeChildren) return false;
  return ancestors(db, node).some((item) => item.id === share.nodeId);
}

function sharedActionsForUser(db, user, node) {
  const actions = new Set();
  (db.shares || [])
    .filter((share) => share.status === 'active' && !isExpired(share) && !isNotYetEffective(share))
    .filter((share) => nodeMatchesSharedScope(db, share, node))
    .filter((share) => audienceMatches(share.audience, user))
    .forEach((share) => (share.actions || []).forEach((action) => actions.add(action)));
  return [...actions];
}

function conditionMatches(db, rule, node) {
  const condition = rule.condition || {};
  const filenameContains = String(condition.filenameContains || '').trim().toLowerCase();
  if (filenameContains && !String(node.name || '').toLowerCase().includes(filenameContains)) return false;
  const pathPrefix = String(condition.pathPrefix || '').trim();
  if (pathPrefix && !String(node.fullPath || '').startsWith(pathPrefix)) return false;
  const extensions = Array.isArray(condition.extensions)
    ? condition.extensions.map((item) => String(item).replace(/^\./, '').toLowerCase()).filter(Boolean)
    : [];
  if (extensions.length && !extensions.includes(String(node.extension || '').toLowerCase())) return false;
  const businessStatus = String(condition.businessStatus || '').trim();
  if (businessStatus && node.businessStatus !== businessStatus) return false;
  const categoryIds = Array.isArray(condition.categoryIds) ? condition.categoryIds.map(String).filter(Boolean) : [];
  if (categoryIds.length && !categoryIds.every((categoryId) => db.documentCategories.some((item) => item.nodeId === node.id && item.categoryId === categoryId))) return false;
  const propertyId = String(condition.propertyId || '').trim();
  const propertyValue = String(condition.propertyValue || '').trim();
  if (propertyId) {
    const values = db.propertyValues.filter((item) => item.nodeId === node.id && item.propertyId === propertyId).map((item) => String(item.value ?? ''));
    if (!values.length) return false;
    if (propertyValue) {
      const normalizedValue = propertyValue.toLowerCase();
      if (condition.propertyOperator === 'contains') {
        if (!values.some((value) => value.toLowerCase().includes(normalizedValue))) return false;
      } else if (!values.some((value) => value.toLowerCase() === normalizedValue)) return false;
    }
  }
  return true;
}

function ruleApplies(db, rule, node) {
  if (!conditionMatches(db, rule, node)) return false;
  const scope = rule.scope || 'all';
  const isCurrent = rule.nodeId === node.id;
  const nodeAncestors = ancestors(db, node);
  const isDescendant = nodeAncestors.some((item) => item.id === rule.nodeId);
  const directParentId = nodeAncestors[0]?.id || null;
  if (scope === 'self') return isCurrent;
  if (scope === 'self_and_files') return isCurrent || (directParentId === rule.nodeId && node.nodeType === 'file');
  if (scope === 'children') return !isCurrent && rule.inheritEnabled && isDescendant;
  if (scope === 'children_folders') return !isCurrent && rule.inheritEnabled && isDescendant && node.nodeType === 'folder';
  if (scope === 'children_files') return !isCurrent && rule.inheritEnabled && isDescendant && node.nodeType === 'file';
  if (scope === 'files') return (isCurrent && node.nodeType === 'file') || (rule.inheritEnabled && isDescendant && node.nodeType === 'file');
  if (isCurrent) return true;
  if (!rule.inheritEnabled) return false;
  return isDescendant;
}

function effectiveActions(db, user, node) {
  if (!node) return [];
  if (node.spaceType === 'personal' && node.personalOwnerId && node.personalOwnerId !== user.id) {
    return sharedActionsForUser(db, user, node);
  }
  if (isAdmin(user)) return fullActions();
  const actions = new Set();
  const rules = db.permissionRules
    .filter((rule) => ruleApplies(db, rule, node) && subjectMatches(rule, user))
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));
  for (const rule of rules) {
    const ruleActions = rule.actions?.includes('full_control') ? fullActions() : rule.actions || [];
    if (rule.effect === 'deny') {
      ruleActions.forEach((action) => actions.delete(action));
    } else {
      ruleActions.forEach((action) => actions.add(action));
    }
  }
  if (node.createdBy === user.id || node.ownerId === user.id) {
    ['visible', 'folder:create', 'file:create', 'file:preview', 'file:download', 'file:update', 'file:delete'].forEach((action) => actions.add(action));
  }
  sharedActionsForUser(db, user, node).forEach((action) => actions.add(action));
  (db.documentApprovals || [])
    .filter((approval) => ['permission', 'borrow', 'external'].includes(approval.type || 'workflow'))
    .filter((approval) => approval.status === 'approved' && approval.requesterId === user.id && approval.nodeId === node.id)
    .filter((approval) => !approval.expiresAt || new Date(approval.expiresAt).getTime() >= Date.now())
    .forEach((approval) => (approval.requestedActions || []).forEach((action) => actions.add(action)));
  return [...actions];
}

function hasAction(db, user, node, action) {
  const actions = effectiveActions(db, user, node);
  return actions.includes('full_control') || actions.includes(action);
}

function requireNodeAction(req, node, action) {
  if (!node) throw createError(404, 'NOT_FOUND', '文件或文件夹不存在');
  if (!hasAction(req.db, req.user, node, action)) throw createError(403, 'FORBIDDEN', '没有权限执行该操作');
}

function passwordProtectedNodes(db, node) {
  if (!node) return [];
  return [node, ...ancestors(db, node)].filter((item) => item.passwordEnabled && item.passwordHash && item.passwordSalt);
}

function nodePasswordProtected(db, node) {
  return passwordProtectedNodes(db, node).length > 0;
}

function unlockTokensFromRequest(req) {
  const values = [];
  const addValues = (value) => {
    if (Array.isArray(value)) value.forEach(addValues);
    else if (value) values.push(...String(value).split(','));
  };
  const headerValue = req?.headers?.['x-node-unlock'];
  addValues(headerValue);
  addValues(req?.query?.unlockToken);
  addValues(req?.body?.unlockToken);
  addValues(req?.body?.unlockTokens);
  return values.map((item) => String(item || '').trim()).filter(Boolean);
}

function hasUnlockForNode(req, protectedNode) {
  return unlockTokensFromRequest(req).some((token) => {
    const payload = verifyToken(token);
    return payload?.kind === 'node_unlock' && payload.userId === req.user.id && payload.nodeId === protectedNode.id;
  });
}

function requiredPasswordNode(req, node) {
  return passwordProtectedNodes(req.db, node).find((item) => !hasUnlockForNode(req, item)) || null;
}

function isNodePasswordAccessible(req, node) {
  return !requiredPasswordNode(req, node);
}

function requireNodePasswordAccess(req, node) {
  const protectedNode = requiredPasswordNode(req, node);
  if (!protectedNode) return;
  const error = createError(423, 'NODE_PASSWORD_REQUIRED', `访问“${protectedNode.name}”需要输入加密密码`);
  error.data = { requiredNodeId: protectedNode.id, requiredNodeName: protectedNode.name };
  throw error;
}

function publicVersion(version) {
  if (!version) return null;
  return {
    id: version.id,
    nodeId: version.nodeId,
    versionNo: version.versionNo,
    storageType: version.storageType || 'local',
    originalFilename: version.originalFilename,
    sizeBytes: version.sizeBytes,
    md5: version.md5,
    mimeType: version.mimeType,
    description: version.description,
    previewStatus: version.previewStatus,
    indexStatus: version.indexStatus,
    createdBy: version.createdBy,
    createdAt: version.createdAt
  };
}

function unreadUploadCountsByNode(db, user) {
  const counts = new Map();
  if (!user) return counts;
  const nodeCache = new Map();
  (db.messages || [])
    .filter((item) => item.receiverId === user.id && !item.readAt && item.messageType === 'file.upload' && item.relatedNodeId)
    .forEach((item) => {
      let unreadNode = nodeCache.get(item.relatedNodeId);
      if (!nodeCache.has(item.relatedNodeId)) {
        unreadNode = nodeById(db, item.relatedNodeId);
        nodeCache.set(item.relatedNodeId, unreadNode || null);
      }
      if (!unreadNode || unreadNode.nodeType !== 'file') return;
      if (!hasAction(db, user, unreadNode, 'visible')) return;
      counts.set(unreadNode.id, (counts.get(unreadNode.id) || 0) + 1);
      ancestors(db, unreadNode).forEach((parent) => {
        counts.set(parent.id, (counts.get(parent.id) || 0) + 1);
      });
    });
  return counts;
}

function nodeUnreadUploadCount(db, user, node, unreadUploadCounts = null) {
  if (!node || !user) return 0;
  const counts = unreadUploadCounts || unreadUploadCountsByNode(db, user);
  return counts.get(node.id) || 0;
}

function publicNode(db, user, node, options = {}) {
  ensureNodeSecurityShape(db, node);
  const version = currentVersion(db, node);
  const unreadCount = nodeUnreadUploadCount(db, user, node, options.unreadUploadCounts);
  const security = nodeSecuritySummary(db, node);
  return {
    id: node.id,
    parentId: node.parentId,
    nodeType: node.nodeType,
    name: node.name,
    fullPath: node.fullPath,
    extension: node.extension,
    ownerId: node.ownerId,
    spaceType: node.spaceType || 'enterprise',
    personalOwnerId: node.personalOwnerId || null,
    sourceType: node.sourceType || 'local',
    externalRelativePath: node.externalRelativePath || '',
    createdBy: node.createdBy,
    updatedBy: node.updatedBy,
    lockedBy: node.lockedBy,
    lockedAt: node.lockedAt,
    status: node.status,
    businessStatus: node.businessStatus,
    ...security,
    sensitiveDownloadBlocked: sensitiveDownloadBlocked(db, user, node),
    passwordEnabled: Boolean(node.passwordEnabled),
    passwordProtected: nodePasswordProtected(db, node),
    tags: node.tags || [],
    review: publicReviewSettings(db, node),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    deletedAt: node.deletedAt || null,
    deletedBy: node.deletedBy || null,
    pendingApprovalCount: (db.documentApprovals || []).filter((item) => item.nodeId === node.id && item.status === 'pending').length,
    approvedDownloadApprovalId: approvedApprovalFor(db, user, node, 'download')?.id || null,
    hasUnread: unreadCount > 0,
    unreadCount,
    currentVersion: publicVersion(version),
    permissions: effectiveActions(db, user, node)
  };
}

function childPath(parent, name) {
  if (!parent || parent.id === 'n_root') return `/${name}`;
  return `${parent.fullPath}/${name}`;
}

function refreshPathRecursive(db, node) {
  const parent = includeDeletedNodeById(db, node.parentId);
  node.fullPath = parent ? childPath(parent, node.name) : '/';
  db.nodes.filter((item) => item.parentId === node.id).forEach((child) => refreshPathRecursive(db, child));
}

function buildTree(items, parentId = null) {
  return items
    .filter((item) => item.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .map((item) => ({ ...item, children: buildTree(items, item.id) }));
}

function collectionDescendants(items, id) {
  const result = [];
  const walk = (parentId) => {
    items
      .filter((item) => item.parentId === parentId)
      .forEach((child) => {
        result.push(child);
        walk(child.id);
      });
  };
  walk(id);
  return result;
}

function validateParentChange(items, id, parentId, label) {
  if (!parentId) return null;
  if (parentId === id) throw createError(400, 'VALIDATION_ERROR', `${label}不能挂到自身下`);
  const parent = items.find((item) => item.id === parentId);
  if (!parent) throw createError(404, 'NOT_FOUND', `上级${label}不存在`);
  if (collectionDescendants(items, id).some((item) => item.id === parentId)) {
    throw createError(400, 'VALIDATION_ERROR', `${label}不能挂到自己的下级下`);
  }
  return parentId;
}

function refreshCategoryPathRecursive(db, category) {
  const parent = category.parentId ? db.categories.find((item) => item.id === category.parentId) : null;
  category.fullPath = parent ? `${parent.fullPath}/${category.name}` : `/${category.name}`;
  db.categories.filter((item) => item.parentId === category.id).forEach((child) => refreshCategoryPathRecursive(db, child));
}

function normalizeOptions(options) {
  if (Array.isArray(options)) return options.map((item) => String(item).trim()).filter(Boolean);
  return String(options || '')
    .split(/[,\n，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeExtensions(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[,\s，]+/);
  return [...new Set(values.map((item) => String(item).replace(/^\./, '').trim().toLowerCase()).filter(Boolean))];
}

function normalizeSecurityLevel(value, fallback = 'internal') {
  const normalized = String(value || fallback || 'internal').trim();
  return SECURITY_LEVELS.includes(normalized) ? normalized : 'internal';
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'on', '启用', '是'].includes(String(value).toLowerCase());
}

function normalizeSecurityPolicy(input = {}) {
  const mode = ['user', 'company', 'custom'].includes(input.watermarkTextMode) ? input.watermarkTextMode : DEFAULT_SECURITY_POLICY.watermarkTextMode;
  return {
    enablePreviewWatermark: normalizeBoolean(input.enablePreviewWatermark, DEFAULT_SECURITY_POLICY.enablePreviewWatermark),
    enableDownloadWatermark: normalizeBoolean(input.enableDownloadWatermark, DEFAULT_SECURITY_POLICY.enableDownloadWatermark),
    blockSensitiveDownload: normalizeBoolean(input.blockSensitiveDownload, DEFAULT_SECURITY_POLICY.blockSensitiveDownload),
    allowAdminBypass: normalizeBoolean(input.allowAdminBypass, DEFAULT_SECURITY_POLICY.allowAdminBypass),
    logSensitiveAccess: normalizeBoolean(input.logSensitiveAccess, DEFAULT_SECURITY_POLICY.logSensitiveAccess),
    watermarkTextMode: mode,
    customWatermarkText: String(input.customWatermarkText || '').trim(),
    requireDownloadApprovalForSensitive: normalizeBoolean(input.requireDownloadApprovalForSensitive, DEFAULT_SECURITY_POLICY.requireDownloadApprovalForSensitive),
    requirePublishApproval: normalizeBoolean(input.requirePublishApproval, DEFAULT_SECURITY_POLICY.requirePublishApproval),
    requirePermissionApproval: normalizeBoolean(input.requirePermissionApproval, DEFAULT_SECURITY_POLICY.requirePermissionApproval),
    updatedBy: input.updatedBy || null,
    updatedAt: input.updatedAt || null
  };
}

function currentSecurityPolicy(db) {
  db.settings = db.settings || {};
  db.settings.securityPolicy = normalizeSecurityPolicy(db.settings.securityPolicy || {});
  return db.settings.securityPolicy;
}

function normalizeWecomSettings(input = {}, fallback = {}) {
  return {
    ...DEFAULT_WECOM_SETTINGS,
    ...fallback,
    enabled: normalizeBoolean(input.enabled ?? fallback.enabled, DEFAULT_WECOM_SETTINGS.enabled),
    corpId: String(input.corpId ?? fallback.corpId ?? '').trim(),
    agentId: String(input.agentId ?? fallback.agentId ?? '').trim(),
    secret: String(input.secret ?? fallback.secret ?? '').trim(),
    callbackUrl: String(input.callbackUrl ?? fallback.callbackUrl ?? '').trim(),
    syncDepartments: normalizeBoolean(input.syncDepartments ?? fallback.syncDepartments, DEFAULT_WECOM_SETTINGS.syncDepartments),
    syncUsers: normalizeBoolean(input.syncUsers ?? fallback.syncUsers, DEFAULT_WECOM_SETTINGS.syncUsers),
    pushMessages: normalizeBoolean(input.pushMessages ?? fallback.pushMessages, DEFAULT_WECOM_SETTINGS.pushMessages),
    apiBaseUrl: String(input.apiBaseUrl ?? fallback.apiBaseUrl ?? DEFAULT_WECOM_SETTINGS.apiBaseUrl).trim().replace(/\/+$/, ''),
    lastSyncAt: input.lastSyncAt ?? fallback.lastSyncAt ?? null,
    lastSyncResult: input.lastSyncResult ?? fallback.lastSyncResult ?? null,
    lastTestAt: input.lastTestAt ?? fallback.lastTestAt ?? null,
    lastTestResult: input.lastTestResult ?? fallback.lastTestResult ?? null
  };
}

async function requestWecomJson(settings, pathname, query = {}) {
  const url = new URL(`${settings.apiBaseUrl}${pathname}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload.errcode || 0) !== 0) {
    throw createError(502, 'WECOM_API_ERROR', `企业微信接口失败：${payload.errmsg || `HTTP ${response.status}`}`);
  }
  return payload;
}

async function getWecomAccessToken(settings) {
  if (!settings.enabled || !settings.corpId || !settings.secret) {
    throw createError(400, 'WECOM_NOT_CONFIGURED', '企业微信 CorpID、Secret 或启用状态未配置完整');
  }
  const payload = await requestWecomJson(settings, '/cgi-bin/gettoken', {
    corpid: settings.corpId,
    corpsecret: settings.secret
  });
  if (!payload.access_token) throw createError(502, 'WECOM_API_ERROR', '企业微信未返回 access_token');
  return payload.access_token;
}

function encodeWecomState(redirectUri) {
  const payload = Buffer.from(JSON.stringify({ redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyWecomState(state) {
  const [payload, signature] = String(state || '').split('.');
  if (!payload || !signature) throw createError(400, 'VALIDATION_ERROR', '企业微信登录 state 无效');
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
  const valid = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) throw createError(400, 'VALIDATION_ERROR', '企业微信登录 state 校验失败');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!decoded.expiresAt || decoded.expiresAt < Date.now()) throw createError(400, 'VALIDATION_ERROR', '企业微信登录请求已过期');
  return decoded;
}

async function syncWecomDirectory(db, actorId, req) {
  const settings = currentWecomSettings(db);
  const startedAt = now();
  const job = {
    id: newId('wcs_'),
    status: 'running',
    startedAt,
    finishedAt: null,
    createdBy: actorId,
    departments: { created: 0, updated: 0 },
    users: { created: 0, updated: 0, conflicts: 0 },
    conflictDetails: [],
    error: ''
  };
  db.wecomSyncJobs.unshift(job);
  db.wecomSyncJobs = db.wecomSyncJobs.slice(0, 100);
  try {
    const accessToken = await getWecomAccessToken(settings);
    const departmentMap = new Map();
    if (settings.syncDepartments) {
      const payload = await requestWecomJson(settings, '/cgi-bin/department/list', { access_token: accessToken });
      const remoteDepartments = Array.isArray(payload.department) ? payload.department : [];
      remoteDepartments.forEach((remote) => {
        const externalId = String(remote.id);
        let department = db.departments.find((item) => String(item.wecomDepartmentId || '') === externalId);
        if (!department) {
          department = {
            id: newId('d_'), parentId: null, name: String(remote.name || `企业微信部门${externalId}`),
            code: `wecom:${externalId}`, sortOrder: Number(remote.order || 100), status: 'enabled',
            sourceType: 'wecom', wecomDepartmentId: externalId, createdAt: now(), updatedAt: now()
          };
          db.departments.push(department);
          job.departments.created += 1;
        } else {
          Object.assign(department, {
            name: String(remote.name || department.name),
            sortOrder: Number(remote.order || department.sortOrder || 100),
            status: 'enabled', sourceType: 'wecom', updatedAt: now()
          });
          job.departments.updated += 1;
        }
        departmentMap.set(externalId, department);
      });
      remoteDepartments.forEach((remote) => {
        const department = departmentMap.get(String(remote.id));
        const parentExternalId = String(remote.parentid || '');
        department.parentId = parentExternalId && parentExternalId !== '0' ? departmentMap.get(parentExternalId)?.id || null : null;
      });
    } else {
      db.departments.filter((item) => item.wecomDepartmentId).forEach((item) => departmentMap.set(String(item.wecomDepartmentId), item));
    }

    if (settings.syncUsers) {
      const rootDepartmentId = [...departmentMap.keys()][0] || '1';
      const payload = await requestWecomJson(settings, '/cgi-bin/user/list', {
        access_token: accessToken, department_id: rootDepartmentId, fetch_child: 1
      });
      const remoteUsers = Array.isArray(payload.userlist) ? payload.userlist : [];
      remoteUsers.forEach((remote) => {
        const wecomUserId = String(remote.userid || '').trim();
        if (!wecomUserId) return;
        let user = db.users.find((item) => item.wecomUserId === wecomUserId);
        if (!user) {
          const usernameConflict = db.users.find((item) => item.username === wecomUserId);
          if (usernameConflict && usernameConflict.sourceType !== 'wecom') {
            job.users.conflicts += 1;
            job.conflictDetails.push({ wecomUserId, reason: '本地存在同名账号，未自动覆盖' });
            return;
          }
          user = usernameConflict;
        }
        const departmentIds = (remote.department || []).map((id) => departmentMap.get(String(id))?.id).filter(Boolean);
        if (!user) {
          const hp = hashPassword(crypto.randomBytes(32).toString('base64url'));
          user = {
            id: newId('u_'), username: wecomUserId, displayName: remote.name || wecomUserId,
            passwordHash: hp.hash, passwordSalt: hp.salt, email: remote.email || remote.biz_mail || '', phone: remote.mobile || '',
            avatarUrl: remote.avatar || '', status: Number(remote.enable ?? 1) === 1 ? 'enabled' : 'disabled',
            departmentIds, roleIds: ['r_employee'], sourceType: 'wecom', wecomUserId,
            lastLoginAt: null, failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null,
            createdAt: now(), updatedAt: now()
          };
          db.users.push(user);
          job.users.created += 1;
        } else {
          Object.assign(user, {
            displayName: remote.name || user.displayName, email: remote.email || remote.biz_mail || user.email || '',
            phone: remote.mobile || user.phone || '', avatarUrl: remote.avatar || user.avatarUrl || '',
            status: Number(remote.enable ?? 1) === 1 ? 'enabled' : 'disabled', departmentIds,
            sourceType: 'wecom', wecomUserId, updatedAt: now()
          });
          job.users.updated += 1;
        }
      });
    }
    job.status = job.users.conflicts ? 'completed_with_conflicts' : 'completed';
    job.finishedAt = now();
    settings.lastSyncAt = job.finishedAt;
    settings.lastSyncResult = { status: job.status, departments: job.departments, users: job.users };
    addAudit(db, actorId, 'system.wecom.sync', 'system_setting', 'wecom', settings.lastSyncResult, req);
    return job;
  } catch (error) {
    job.status = 'failed';
    job.finishedAt = now();
    job.error = error.message;
    settings.lastSyncAt = job.finishedAt;
    settings.lastSyncResult = { status: 'failed', error: error.message };
    throw error;
  }
}

function sanitizeWecomSettings(settings = {}) {
  const normalized = normalizeWecomSettings(settings);
  const { secret: _secret, ...safe } = normalized;
  return {
    ...safe,
    hasSecret: Boolean(normalized.secret)
  };
}

function currentWecomSettings(db) {
  db.settings = db.settings || {};
  db.settings.wecom = normalizeWecomSettings(db.settings.wecom || {});
  return db.settings.wecom;
}

function normalizeOfficePreviewSettings(input = {}, fallback = {}) {
  const provider = String(input.provider ?? fallback.provider ?? DEFAULT_OFFICE_PREVIEW_SETTINGS.provider).trim().toLowerCase();
  return {
    ...DEFAULT_OFFICE_PREVIEW_SETTINGS,
    ...fallback,
    enabled: normalizeBoolean(input.enabled ?? fallback.enabled, DEFAULT_OFFICE_PREVIEW_SETTINGS.enabled),
    provider: provider === 'onlyoffice' ? 'onlyoffice' : DEFAULT_OFFICE_PREVIEW_SETTINGS.provider,
    documentServerUrl: String(input.documentServerUrl ?? fallback.documentServerUrl ?? '').trim().replace(/\/+$/, ''),
    publicBaseUrl: String(input.publicBaseUrl ?? fallback.publicBaseUrl ?? '').trim().replace(/\/+$/, ''),
    jwtSecret: String(input.jwtSecret ?? fallback.jwtSecret ?? '').trim(),
    lastTestAt: input.lastTestAt ?? fallback.lastTestAt ?? null,
    lastTestResult: input.lastTestResult ?? fallback.lastTestResult ?? null
  };
}

function sanitizeOfficePreviewSettings(settings = {}) {
  const normalized = normalizeOfficePreviewSettings(settings);
  const { jwtSecret: _jwtSecret, ...safe } = normalized;
  return {
    ...safe,
    hasJwtSecret: Boolean(normalized.jwtSecret)
  };
}

function currentOfficePreviewSettings(db) {
  db.settings = db.settings || {};
  db.settings.officePreview = normalizeOfficePreviewSettings(db.settings.officePreview || {});
  return db.settings.officePreview;
}

function joinUrl(base, suffix) {
  return `${String(base || '').replace(/\/+$/, '')}/${String(suffix || '').replace(/^\/+/, '')}`;
}

function requestPublicBaseUrl(req, settings) {
  const configured = String(settings.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function officePreviewConfigurationIssue(req, settings) {
  const documentServerUrl = String(settings.documentServerUrl || '').trim().replace(/\/+$/, '');
  const publicBaseUrl = requestPublicBaseUrl(req, settings);
  if (!documentServerUrl || !publicBaseUrl) return '';
  if (documentServerUrl === publicBaseUrl) {
    return '平台外部访问地址不能填写 ONLYOFFICE Document Server 地址；该地址必须指向文档管理平台后端。';
  }
  try {
    const documentServerHost = new URL(documentServerUrl).hostname;
    const publicBaseHost = new URL(publicBaseUrl).hostname;
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    if (!localHosts.has(documentServerHost) && localHosts.has(publicBaseHost)) {
      return '远程 ONLYOFFICE 无法访问本机 localhost；请填写 Document Server 可回连的平台公网地址或建立预览通道。';
    }
  } catch {
    return '请检查 Document Server 地址和平台外部访问地址的 URL 格式。';
  }
  return '';
}

function officeDocumentType(extension) {
  if (['doc', 'docx'].includes(extension)) return 'word';
  if (['xls', 'xlsx'].includes(extension)) return 'cell';
  if (['ppt', 'pptx'].includes(extension)) return 'slide';
  return '';
}

function signOnlyOfficeToken(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function officeDocumentKey(version, documentUrl = '') {
  let stableDocumentUrl = String(documentUrl || '');
  try {
    const parsed = new URL(stableDocumentUrl);
    parsed.search = '';
    parsed.hash = '';
    stableDocumentUrl = parsed.toString();
  } catch {
    stableDocumentUrl = stableDocumentUrl.split(/[?#]/)[0];
  }
  const sourceKey = crypto.createHash('sha1').update(`raw-token-v3|${stableDocumentUrl}`).digest('hex').slice(0, 10);
  return String(`${version.id}-${version.md5 || version.createdAt || version.versionNo || ''}-${sourceKey}`)
    .replace(/[^A-Za-z0-9_.=-]/g, '_')
    .slice(0, 80);
}

function officeEditSessionById(db, sessionId) {
  return (db.officeEditSessions || []).find((item) => item.id === sessionId) || null;
}

function activeOfficeEditSession(db, nodeId) {
  return (db.officeEditSessions || []).find((item) => item.nodeId === nodeId && item.status === 'active') || null;
}

function publicOfficeEditSession(db, session) {
  if (!session) return null;
  const user = db.users.find((item) => item.id === session.userId);
  return {
    id: session.id,
    nodeId: session.nodeId,
    baseVersionId: session.baseVersionId,
    userId: session.userId,
    userName: user?.displayName || user?.username || session.userId,
    status: session.status,
    savedVersionId: session.savedVersionId || null,
    startedAt: session.startedAt,
    completedAt: session.completedAt || null,
    lastCallbackStatus: session.lastCallbackStatus ?? null,
    lastError: session.lastError || ''
  };
}

function finishOfficeEditSession(db, session, status = 'closed') {
  session.status = status;
  session.completedAt = now();
  const node = nodeById(db, session.nodeId);
  if (node?.lockedBy === session.userId) {
    node.lockedBy = null;
    node.lockedAt = null;
  }
  return node;
}

function officeEditCallbackUrl(req, settings, session) {
  const ticket = signToken({
    kind: 'office_edit_callback',
    sessionId: session.id,
    nodeId: session.nodeId,
    versionId: session.baseVersionId,
    userId: session.userId
  }, 12 * 60 * 60 * 1000);
  return joinUrl(requestPublicBaseUrl(req, settings), `/api/v1/office-edit/callback?ticket=${encodeURIComponent(ticket)}`);
}

function buildOnlyOfficeEditor(req, node, version, extension, session) {
  const settings = currentOfficePreviewSettings(req.db);
  const documentType = officeDocumentType(extension);
  if (!settings.enabled || !settings.documentServerUrl || !documentType || !OFFICE_EDIT_EXTENSIONS.has(extension)) return null;
  const sourceToken = encodeURIComponent(signToken({
    userId: req.user.id,
    purpose: 'office-edit-source',
    nodeId: node.id,
    versionId: version.id,
    sessionId: session.id
  }, 12 * 60 * 60 * 1000));
  const documentUrl = joinUrl(requestPublicBaseUrl(req, settings), `/storage/raw/${version.id}?token=${sourceToken}`);
  const config = {
    type: 'desktop',
    documentType,
    document: {
      title: version.originalFilename || node.name,
      url: documentUrl,
      fileType: extension,
      key: session.documentKey,
      permissions: {
        edit: true,
        download: false,
        print: false,
        copy: true,
        comment: true,
        review: true
      }
    },
    editorConfig: {
      mode: 'edit',
      lang: 'zh-CN',
      callbackUrl: officeEditCallbackUrl(req, settings, session),
      user: {
        id: req.user.id,
        name: req.user.displayName || req.user.username
      },
      customization: {
        compactHeader: true,
        compactToolbar: false,
        hideRightMenu: false,
        toolbarNoTabs: false,
        autosave: true,
        forcesave: true
      }
    }
  };
  if (settings.jwtSecret) config.token = signOnlyOfficeToken(config, settings.jwtSecret);
  return { provider: 'onlyoffice', scriptUrl: '/web-apps/apps/api/documents/api.js', config };
}

function validateOfficeCallbackDownloadUrl(settings, value) {
  let downloadUrl;
  let documentServerUrl;
  try {
    downloadUrl = new URL(String(value || ''));
    documentServerUrl = new URL(settings.documentServerUrl);
  } catch {
    throw createError(400, 'VALIDATION_ERROR', 'ONLYOFFICE 回传文件地址无效');
  }
  if (!['http:', 'https:'].includes(downloadUrl.protocol) || downloadUrl.username || downloadUrl.password) {
    throw createError(400, 'VALIDATION_ERROR', 'ONLYOFFICE 回传文件地址来源不受信任');
  }
  if (downloadUrl.origin === documentServerUrl.origin) return downloadUrl.toString();
  if (!downloadUrl.pathname.startsWith('/cache/files/')) {
    throw createError(400, 'VALIDATION_ERROR', 'ONLYOFFICE 回传文件地址来源不受信任');
  }
  return new URL(`${downloadUrl.pathname}${downloadUrl.search}`, documentServerUrl).toString();
}

async function downloadOfficeEditedFile(db, settings, sourceUrl, session, extension) {
  const downloadUrl = validateOfficeCallbackDownloadUrl(settings, sourceUrl);
  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw createError(502, 'OFFICE_EDIT_DOWNLOAD_FAILED', `下载编辑结果失败（HTTP ${response.status}）`);
  const maxBytes = Number(currentFilePolicy(db).maxSizeMb || 300) * 1024 * 1024;
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw createError(413, 'FILE_TOO_LARGE', '在线编辑结果超过文件大小限制');
  const tempPath = path.join(config.tmpDir, `${session.id}-${Date.now()}.${extension}`);
  const fileHandle = await fs.open(tempPath, 'w');
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw createError(413, 'FILE_TOO_LARGE', '在线编辑结果超过文件大小限制');
      await fileHandle.write(chunk);
    }
  } catch (error) {
    await fileHandle.close();
    await fs.rm(tempPath, { force: true });
    throw error;
  }
  await fileHandle.close();
  if (!size) {
    await fs.rm(tempPath, { force: true });
    throw createError(502, 'OFFICE_EDIT_DOWNLOAD_FAILED', 'ONLYOFFICE 返回了空文件');
  }
  return tempPath;
}

function pdfWatermarkText(db, user, node) {
  const raw = `${watermarkTextFor(db, user, node)} | ${node.name || 'document'}`;
  return raw.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim() || `${user?.username || user?.id || 'user'} | ${node.name || 'document'}`;
}

async function addPdfWatermark(buffer, text) {
  const document = await PDFDocument.load(buffer);
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.getPages().forEach((page) => {
    const { width, height } = page.getSize();
    const fontSize = Math.max(16, Math.min(28, width / 24));
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const stepX = Math.max(textWidth + 100, width * 0.55);
    const stepY = Math.max(120, height * 0.22);
    for (let y = -20; y < height + stepY; y += stepY) {
      for (let x = -width * 0.2; x < width + stepX; x += stepX) {
        page.drawText(text, { x, y, size: fontSize, font, color: rgb(0.45, 0.48, 0.52), opacity: 0.16, rotate: degrees(28) });
      }
    }
  });
  return Buffer.from(await document.save());
}

async function convertVersionToPdf(req, node, version) {
  const extension = extname(version.originalFilename || node.name);
  const filePath = versionFilePath(version, node, req.db);
  if (!fsSync.existsSync(filePath)) throw createError(404, 'NOT_FOUND', '文件内容不存在');
  if (extension === 'pdf' || version.mimeType === 'application/pdf') return fs.readFile(filePath);
  if (!OFFICE_PREVIEW_EXTENSIONS.has(extension)) throw createError(400, 'PDF_EXPORT_UNSUPPORTED', '当前仅支持 Office 和 PDF 文件导出或打印');
  const settings = currentOfficePreviewSettings(req.db);
  const configurationIssue = officePreviewConfigurationIssue(req, settings);
  if (configurationIssue) throw createError(503, 'PDF_EXPORT_UNAVAILABLE', configurationIssue);
  if (!settings.enabled || !settings.documentServerUrl) throw createError(503, 'PDF_EXPORT_UNAVAILABLE', '请先配置并启用 ONLYOFFICE Document Server');
  const sourceToken = encodeURIComponent(signToken({ userId: req.user.id, purpose: 'pdf-export', nodeId: node.id, versionId: version.id }, 10 * 60 * 1000));
  const unlockTokenValue = unlockTokensFromRequest(req).join(',');
  const unlockToken = unlockTokenValue ? `&unlockToken=${encodeURIComponent(unlockTokenValue)}` : '';
  const sourceUrl = joinUrl(requestPublicBaseUrl(req, settings), `/storage/raw/${version.id}?token=${sourceToken}${unlockToken}`);
  const payload = {
    async: false,
    filetype: extension,
    key: crypto.createHash('sha256').update(`${version.id}:${version.md5 || version.createdAt}:pdf`).digest('hex').slice(0, 20),
    outputtype: 'pdf',
    title: version.originalFilename || node.name,
    url: sourceUrl
  };
  const headers = { 'Content-Type': 'application/json' };
  if (settings.jwtSecret) {
    const jwt = signOnlyOfficeToken(payload, settings.jwtSecret);
    headers.Authorization = `Bearer ${jwt}`;
    payload.token = jwt;
  }
  const response = await fetch(joinUrl(settings.documentServerUrl, '/ConvertService.ashx'), {
    method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error || result.endConvert === false || !(result.fileUrl || result.fileurl)) {
    throw createError(502, 'PDF_EXPORT_FAILED', `ONLYOFFICE PDF 转换失败${result.error ? `（错误 ${result.error}）` : ''}`);
  }
  const downloadUrl = validateOfficeCallbackDownloadUrl(settings, result.fileUrl || result.fileurl);
  const converted = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!converted.ok) throw createError(502, 'PDF_EXPORT_FAILED', `下载转换结果失败（HTTP ${converted.status}）`);
  const bytes = Buffer.from(await converted.arrayBuffer());
  if (!bytes.length) throw createError(502, 'PDF_EXPORT_FAILED', 'ONLYOFFICE 返回了空 PDF');
  return bytes;
}

async function controlledPdfOutput(req, res, { action, inline = false } = {}) {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, action);
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能输出文件');
  const version = req.query.versionId ? versionById(req.db, req.query.versionId) : currentVersion(req.db, node);
  if (!version || version.nodeId !== node.id) throw createError(404, 'NOT_FOUND', '版本不存在');
  const converted = await convertVersionToPdf(req, node, version);
  const output = await addPdfWatermark(converted, pdfWatermarkText(req.db, req.user, node));
  const baseName = String(version.originalFilename || node.name).replace(/\.[^.]+$/, '');
  addAudit(req.db, req.user.id, action === 'file:print' ? 'file.print' : 'file.export_pdf', 'node', node.id, {
    targetPath: node.fullPath, versionNo: version.versionNo, watermarked: true
  }, req);
  recordRecentAccess(req.db, req.user, node, action === 'file:print' ? 'print' : 'export_pdf');
  await saveDb(req.db);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', output.length);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(`${baseName}.pdf`)}`);
  res.end(output);
}

function buildOnlyOfficePreview(req, node, version, extension) {
  const settings = currentOfficePreviewSettings(req.db);
  if (!settings.enabled || !settings.documentServerUrl) return null;
  const documentType = officeDocumentType(extension);
  if (!documentType) return null;
  const previewToken = encodeURIComponent(signToken({
    userId: req.user.id,
    purpose: 'office-preview',
    nodeId: node.id,
    versionId: version.id
  }, 30 * 60 * 1000));
  const unlockTokenValue = unlockTokensFromRequest(req).join(',');
  const unlockToken = unlockTokenValue ? `&unlockToken=${encodeURIComponent(unlockTokenValue)}` : '';
  const rawUrl = `/storage/raw/${version.id}?token=${previewToken}${unlockToken}`;
  const documentUrl = joinUrl(requestPublicBaseUrl(req, settings), rawUrl);
  const editorConfig = {
    type: 'desktop',
    documentType,
    document: {
      title: version.originalFilename || node.name,
      url: documentUrl,
      fileType: extension,
      key: officeDocumentKey(version, documentUrl),
      permissions: {
        edit: false,
        download: false,
        print: false,
        copy: true,
        comment: false,
        review: false
      }
    },
    editorConfig: {
      mode: 'view',
      lang: 'zh-CN',
      user: {
        id: req.user.id,
        name: req.user.displayName || req.user.username
      },
      customization: {
        compactHeader: true,
        compactToolbar: true,
        hideRightMenu: true,
        toolbarNoTabs: true
      }
    }
  };
  if (settings.jwtSecret) editorConfig.token = signOnlyOfficeToken(editorConfig, settings.jwtSecret);
  return {
    provider: 'onlyoffice',
    scriptUrl: '/web-apps/apps/api/documents/api.js',
    config: editorConfig
  };
}

function currentFilePolicy(db) {
  return {
    ...DEFAULT_FILE_POLICY,
    ...(db.settings?.filePolicy || {}),
    allowedExtensions: normalizeExtensions(db.settings?.filePolicy?.allowedExtensions || DEFAULT_FILE_POLICY.allowedExtensions),
    maxSizeMb: Number(db.settings?.filePolicy?.maxSizeMb || DEFAULT_FILE_POLICY.maxSizeMb),
    chunkSizeMb: Math.max(1, Math.min(Number(db.settings?.filePolicy?.chunkSizeMb || DEFAULT_FILE_POLICY.chunkSizeMb), 64)),
    enableVirusScan: normalizeBoolean(db.settings?.filePolicy?.enableVirusScan, DEFAULT_FILE_POLICY.enableVirusScan),
    rejectExecutableFiles: normalizeBoolean(db.settings?.filePolicy?.rejectExecutableFiles, DEFAULT_FILE_POLICY.rejectExecutableFiles)
  };
}

function ensureNodeSecurityShape(db, node) {
  if (!node) return null;
  const parent = node.parentId ? includeDeletedNodeById(db, node.parentId) : null;
  node.securityLevel = normalizeSecurityLevel(node.securityLevel, parent?.securityLevel || 'internal');
  node.sensitive = Boolean(node.sensitive);
  node.sensitiveReason = String(node.sensitiveReason || '');
  node.securityUpdatedBy = node.securityUpdatedBy || null;
  node.securityUpdatedAt = node.securityUpdatedAt || null;
  return node;
}

function ensureNodeGovernanceShape(node) {
  if (!node) return null;
  node.reviewEnabled = Boolean(node.reviewEnabled);
  node.reviewCycleDays = Math.max(1, Math.min(3650, Number(node.reviewCycleDays || 365)));
  node.reviewOwnerId = node.reviewOwnerId || null;
  node.nextReviewAt = node.nextReviewAt || null;
  node.lastReviewedAt = node.lastReviewedAt || null;
  node.lastReviewedBy = node.lastReviewedBy || null;
  node.lastReviewConclusion = String(node.lastReviewConclusion || '');
  node.lastReviewNote = String(node.lastReviewNote || '');
  return node;
}

function reviewStatusForNode(node, referenceTime = Date.now()) {
  ensureNodeGovernanceShape(node);
  if (!node.reviewEnabled || !node.nextReviewAt) return 'not_scheduled';
  const dueAt = new Date(node.nextReviewAt).getTime();
  if (!Number.isFinite(dueAt)) return 'not_scheduled';
  if (dueAt < referenceTime) return 'overdue';
  if (dueAt - referenceTime <= 30 * 24 * 60 * 60 * 1000) return 'due_soon';
  return 'normal';
}

function publicReviewSettings(db, node) {
  ensureNodeGovernanceShape(node);
  const owner = node.reviewOwnerId ? db.users.find((item) => item.id === node.reviewOwnerId) : null;
  const lastReviewer = node.lastReviewedBy ? db.users.find((item) => item.id === node.lastReviewedBy) : null;
  return {
    enabled: node.reviewEnabled,
    cycleDays: node.reviewCycleDays,
    ownerId: node.reviewOwnerId,
    owner: owner ? pickPublicUser(owner) : null,
    nextReviewAt: node.nextReviewAt,
    status: reviewStatusForNode(node),
    lastReviewedAt: node.lastReviewedAt,
    lastReviewedBy: node.lastReviewedBy,
    lastReviewer: lastReviewer ? pickPublicUser(lastReviewer) : null,
    lastConclusion: node.lastReviewConclusion,
    lastNote: node.lastReviewNote
  };
}

function nodeSecuritySummary(db, node) {
  ensureNodeSecurityShape(db, node);
  return {
    securityLevel: node.securityLevel,
    securityLevelLabel: SECURITY_LEVEL_LABELS[node.securityLevel] || node.securityLevel,
    sensitive: Boolean(node.sensitive),
    sensitiveReason: node.sensitiveReason || '',
    securityUpdatedBy: node.securityUpdatedBy || null,
    securityUpdatedAt: node.securityUpdatedAt || null
  };
}

function watermarkTextFor(db, user, node) {
  const policy = currentSecurityPolicy(db);
  if (policy.watermarkTextMode === 'custom' && policy.customWatermarkText) return policy.customWatermarkText;
  if (policy.watermarkTextMode === 'company' && policy.customWatermarkText) return policy.customWatermarkText;
  const operator = user?.displayName || user?.username || '用户';
  const account = user?.username ? `(${user.username})` : '';
  return `${operator}${account} ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
}

function approvedApprovalFor(db, user, node, type, action = '') {
  const current = Date.now();
  return (db.documentApprovals || []).find((item) => {
    const approvalType = item.type || 'workflow';
    if (approvalType !== type) return false;
    if (item.status !== 'approved') return false;
    if (item.requesterId !== user.id) return false;
    if (item.nodeId !== node.id) return false;
    if (item.expiresAt && new Date(item.expiresAt).getTime() < current) return false;
    if (type === 'permission' && action) return (item.requestedActions || []).includes(action);
    return true;
  });
}

function sensitiveDownloadBlocked(db, user, node) {
  if (!node || node.nodeType !== 'file') return false;
  const policy = currentSecurityPolicy(db);
  if (!node.sensitive) return false;
  if (!policy.blockSensitiveDownload && !policy.requireDownloadApprovalForSensitive) return false;
  if (policy.allowAdminBypass && isAdmin(user)) return false;
  if (approvedApprovalFor(db, user, node, 'download')) return false;
  return true;
}

function sensitiveDownloadBlockError(node) {
  const error = createError(403, 'SENSITIVE_DOWNLOAD_BLOCKED', '该文件受安全策略限制，仅允许在线预览或提交下载审批');
  error.data = {
    nodeId: node.id,
    nodeName: node.name,
    canRequestApproval: true,
    securityLevel: node.securityLevel,
    sensitive: Boolean(node.sensitive)
  };
  return error;
}

function recordRecentAccess(db, user, node, action = 'view') {
  if (!user || !node) return;
  db.recentAccesses = db.recentAccesses || [];
  db.recentAccesses = db.recentAccesses.filter((item) => !(item.userId === user.id && item.nodeId === node.id && item.action === action));
  db.recentAccesses.unshift({
    id: newId('ra_'),
    userId: user.id,
    nodeId: node.id,
    action,
    nodeName: node.name,
    nodePath: node.fullPath,
    nodeType: node.nodeType,
    accessedAt: now()
  });
  db.recentAccesses = db.recentAccesses.slice(0, 500);
}

async function validateUploadedFileByPolicy(db, file) {
  if (!file) return;
  const policy = currentFilePolicy(db);
  const extension = extname(file.originalname);
  if (policy.allowedExtensions.length && !policy.allowedExtensions.includes(extension)) {
    if (fsSync.existsSync(file.path)) await fs.unlink(file.path);
    throw createError(400, 'VALIDATION_ERROR', `不允许上传 .${extension || 'unknown'} 类型文件`);
  }
  const maxBytes = Number(policy.maxSizeMb || 300) * 1024 * 1024;
  if (file.size > maxBytes) {
    if (fsSync.existsSync(file.path)) await fs.unlink(file.path);
    throw createError(400, 'VALIDATION_ERROR', `文件大小不能超过 ${policy.maxSizeMb} MB`);
  }
}

async function quarantineUploadedFile(db, filePath, originalFilename, reason, actorId = null) {
  const id = newId('qua_');
  const filename = `${id}-${safeFilename(originalFilename || 'file.bin')}`;
  const targetPath = path.join(config.quarantineDir, filename);
  await fs.rename(filePath, targetPath).catch(async () => {
    await fs.copyFile(filePath, targetPath);
    await fs.rm(filePath, { force: true });
  });
  const item = { id, originalFilename, storageKey: filename, reason, status: 'quarantined', createdBy: actorId, createdAt: now() };
  db.quarantineItems.unshift(item);
  db.quarantineItems = db.quarantineItems.slice(0, 1000);
  return item;
}

async function scanIncomingFile(db, filePath, originalFilename, actorId = null) {
  const policy = currentFilePolicy(db);
  const extension = extname(originalFilename);
  const executableExtensions = new Set(['exe', 'dll', 'com', 'scr', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'hta', 'jar', 'sh']);
  const handle = await fs.open(filePath, 'r');
  const probe = Buffer.alloc(8192);
  const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
  await handle.close();
  const head = probe.subarray(0, bytesRead);
  const text = head.toString('latin1');
  let reason = '';
  if (text.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) reason = '检测到 EICAR 测试病毒签名';
  else if (policy.rejectExecutableFiles && (executableExtensions.has(extension) || (head[0] === 0x4d && head[1] === 0x5a))) reason = '禁止上传可执行或脚本文件';
  else if (/powershell\s+-enc|<script[^>]+src\s*=\s*["']?javascript:/i.test(text)) reason = '检测到危险脚本签名';
  if (!reason && policy.enableVirusScan) {
    if (!config.clamavHost && !config.clamavSocket && !fsSync.existsSync('/usr/bin/clamscan') && !fsSync.existsSync('/usr/bin/clamdscan')) {
      throw createError(503, 'VIRUS_SCANNER_UNAVAILABLE', '已启用病毒扫描，但 ClamAV 服务不可用');
    }
    const scanner = await new NodeClam().init({
      removeInfected: false, quarantineInfected: false, preference: config.clamavHost || config.clamavSocket ? 'clamdscan' : 'clamscan',
      clamdscan: { host: config.clamavHost || false, port: config.clamavPort, socket: config.clamavSocket || false, timeout: 120000, localFallback: true, active: true },
      clamscan: { path: '/usr/bin/clamscan', scanArchives: true, active: true }
    });
    const result = await scanner.isInfected(filePath);
    if (result.isInfected) reason = `ClamAV 检测到病毒：${(result.viruses || []).join(', ') || 'unknown'}`;
    if (result.isInfected === null) throw createError(503, 'VIRUS_SCAN_FAILED', 'ClamAV 无法完成文件扫描');
  }
  if (reason) {
    const quarantine = await quarantineUploadedFile(db, filePath, originalFilename, reason, actorId);
    await saveDb(db);
    const error = createError(400, 'FILE_QUARANTINED', `文件未通过安全扫描：${reason}`);
    error.data = { quarantineId: quarantine.id };
    throw error;
  }
  return { clean: true, scannedBy: policy.enableVirusScan ? 'built-in+clamav' : 'built-in' };
}

function validateName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) throw createError(400, 'VALIDATION_ERROR', '名称不能为空');
  if (/[\\/:*?"<>|]/.test(normalized)) throw createError(400, 'VALIDATION_ERROR', '名称不能包含特殊字符');
  return normalized;
}

function currentExternalLibrarySettings(db) {
  db.settings.externalLibrary = {
    rootPath: db.settings.externalLibrary?.rootPath || config.externalLibraryRoot || '',
    includePaths: normalizeOptions(db.settings.externalLibrary?.includePaths || []),
    excludePatterns: normalizeOptions(db.settings.externalLibrary?.excludePatterns || []),
    lastSyncedAt: db.settings.externalLibrary?.lastSyncedAt || null,
    lastSyncSummary: db.settings.externalLibrary?.lastSyncSummary || null,
    lastSyncJob: db.settings.externalLibrary?.lastSyncJob || null
  };
  return db.settings.externalLibrary;
}

function resolveExternalRootPath(db, explicitRootPath = null) {
  const configured = String(explicitRootPath ?? currentExternalLibrarySettings(db).rootPath ?? '').trim();
  if (!configured) throw createError(400, 'VALIDATION_ERROR', '请先配置服务器文档根目录');
  return path.resolve(configured);
}

function externalRelativePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).split(path.sep).join('/');
}

function isPathInside(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function wildcardPatternToRegex(pattern) {
  const escaped = String(pattern || '').trim().replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
}

function externalPathExcluded(relativePath, name, patterns = []) {
  const normalizedRelative = String(relativePath || '').split(path.sep).join('/');
  const segments = normalizedRelative.split('/').filter(Boolean);
  return patterns.some((pattern) => {
    const normalizedPattern = String(pattern || '').trim().replace(/^\/+|\/+$/g, '');
    if (!normalizedPattern) return false;
    if (normalizedPattern.endsWith('/*')) {
      const basePattern = normalizedPattern.slice(0, -2);
      if (basePattern && !basePattern.includes('*')) {
        const baseSegments = basePattern.split('/').filter(Boolean);
        const containsBasePath = segments.some((_, index) => segments.slice(index, index + baseSegments.length).join('/') === basePattern);
        if (name === basePattern || normalizedRelative === basePattern || containsBasePath) return true;
      }
    }
    const matcher = wildcardPatternToRegex(normalizedPattern);
    if (normalizedPattern.includes('/')) return matcher.test(normalizedRelative);
    return matcher.test(name) || segments.some((segment) => matcher.test(segment));
  });
}

function shouldIgnoreExternalDirectory(name, relativePath, excludePatterns = []) {
  return EXTERNAL_SYNC_IGNORED_DIR_NAMES.has(name) || (name.startsWith('.') && name !== '.') || externalPathExcluded(relativePath, name, excludePatterns);
}

async function scanExternalEntries(rootPath, options = {}) {
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat || !stat.isDirectory()) throw createError(400, 'VALIDATION_ERROR', '服务器文档根目录不存在或不是文件夹');
  const includePaths = normalizeOptions(options.includePaths || []);
  const excludePatterns = normalizeOptions(options.excludePatterns || []);
  const entries = [];
  const skipped = [];
  const seenRelativePaths = new Set();
  const skip = (targetPath, error) => {
    skipped.push({
      path: targetPath,
      code: error?.code || 'UNKNOWN',
      message: error?.message || '无法读取'
    });
  };
  const walk = async (dirPath) => {
    let dirents = [];
    try {
      dirents = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      skip(dirPath, error);
      return;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const absPath = path.join(dirPath, dirent.name);
      const relativePath = externalRelativePath(rootPath, absPath);
      if (dirent.isDirectory() && shouldIgnoreExternalDirectory(dirent.name, relativePath, excludePatterns)) {
        skip(absPath, { code: 'IGNORED', message: '已跳过系统、缓存或开发依赖目录' });
        continue;
      }
      if (!dirent.isDirectory() && externalPathExcluded(relativePath, dirent.name, excludePatterns)) {
        skip(absPath, { code: 'EXCLUDED', message: '已按排除规则跳过' });
        continue;
      }
      let itemStat = null;
      try {
        itemStat = await fs.stat(absPath);
      } catch (error) {
        skip(absPath, error);
        continue;
      }
      if (seenRelativePaths.has(relativePath)) continue;
      seenRelativePaths.add(relativePath);
      if (itemStat.isDirectory()) {
        entries.push({ nodeType: 'folder', name: dirent.name, externalPath: absPath, externalRelativePath: relativePath, mtimeMs: itemStat.mtimeMs, sizeBytes: 0 });
        await walk(absPath);
      } else if (itemStat.isFile()) {
        entries.push({
          nodeType: 'file',
          name: dirent.name,
          externalPath: absPath,
          externalRelativePath: relativePath,
          mtimeMs: itemStat.mtimeMs,
          sizeBytes: itemStat.size
        });
      }
    }
  };
  const targets = includePaths.length ? includePaths : [''];
  for (const includePath of targets) {
    const normalizedInclude = String(includePath || '').trim().replace(/^\/+|\/+$/g, '');
    const absIncludePath = path.resolve(rootPath, normalizedInclude || '.');
    if (!isPathInside(rootPath, absIncludePath)) {
      skip(absIncludePath, { code: 'INVALID_INCLUDE_PATH', message: '指定目录不在服务器根目录内' });
      continue;
    }
    const includeStat = await fs.stat(absIncludePath).catch((error) => {
      skip(absIncludePath, error);
      return null;
    });
    if (!includeStat) continue;
    if (includeStat.isDirectory()) {
      if (normalizedInclude) {
        const name = path.basename(absIncludePath);
        const relativePath = externalRelativePath(rootPath, absIncludePath);
        if (!seenRelativePaths.has(relativePath)) {
          seenRelativePaths.add(relativePath);
          entries.push({ nodeType: 'folder', name, externalPath: absIncludePath, externalRelativePath: relativePath, mtimeMs: includeStat.mtimeMs, sizeBytes: 0 });
        }
      }
      await walk(absIncludePath);
    } else if (includeStat.isFile()) {
      const name = path.basename(absIncludePath);
      const relativePath = externalRelativePath(rootPath, absIncludePath);
      if (externalPathExcluded(relativePath, name, excludePatterns)) {
        skip(absIncludePath, { code: 'EXCLUDED', message: '已按排除规则跳过' });
        continue;
      }
      if (!seenRelativePaths.has(relativePath)) {
        seenRelativePaths.add(relativePath);
        entries.push({ nodeType: 'file', name, externalPath: absIncludePath, externalRelativePath: relativePath, mtimeMs: includeStat.mtimeMs, sizeBytes: includeStat.size });
      }
    }
  }
  entries.sort((a, b) => {
    const depthDiff = a.externalRelativePath.split('/').length - b.externalRelativePath.split('/').length;
    if (depthDiff !== 0) return depthDiff;
    if (a.nodeType !== b.nodeType) return a.nodeType === 'folder' ? -1 : 1;
    return a.externalRelativePath.localeCompare(b.externalRelativePath, 'zh-Hans-CN');
  });
  return { entries, skipped };
}

function findExternalNodeByRelativePath(db, relativePath) {
  return db.nodes.find((item) => item.sourceType === 'external' && item.externalRelativePath === relativePath);
}

function parentRelativePath(relativePath) {
  const parts = String(relativePath || '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function externalVersionPathCandidates(version, node = null, db = null) {
  const candidates = [version?.externalPath, node?.externalPath].filter(Boolean);
  const relativePath = version?.externalRelativePath || node?.externalRelativePath || '';
  if (!relativePath) return candidates;
  const roots = [node?.externalRootPath, db?.settings?.externalLibrary?.rootPath].filter(Boolean);
  roots.forEach((rootPath) => {
    const resolvedRoot = path.resolve(rootPath);
    candidates.push(path.resolve(resolvedRoot, relativePath));
    const rootName = path.basename(resolvedRoot);
    if (rootName && relativePath.startsWith(`${rootName}/`)) {
      candidates.push(path.resolve(resolvedRoot, relativePath.slice(rootName.length + 1)));
    }
  });
  return [...new Set(candidates)];
}

async function createExternalVersion(db, node, entry, userId) {
  const extension = extname(entry.name);
  const versionNo = db.versions.filter((item) => item.nodeId === node.id).length + 1;
  const versionId = newId('ver_');
  const mimeType = mime.lookup(entry.name) || 'application/octet-stream';
  const md5 = await fileMd5FromPath(entry.externalPath).catch(() => '');
  const searchText = await extractSearchText(entry.externalPath, extension, mimeType, entry.name);
  const version = {
    id: versionId,
    nodeId: node.id,
    versionNo,
    storageType: 'external',
    storageKey: null,
    externalRootPath: node.externalRootPath || '',
    externalPath: entry.externalPath,
    externalRelativePath: entry.externalRelativePath,
    externalMtimeMs: entry.mtimeMs,
    externalSignature: `${entry.mtimeMs}:${entry.sizeBytes}`,
    originalFilename: entry.name,
    sizeBytes: entry.sizeBytes,
    md5,
    mimeType,
    description: versionNo === 1 ? '服务器目录同步' : '服务器文件变更同步',
    searchText,
    previewStatus: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'txt', 'md'].includes(extension) || mimeType.startsWith('text/') ? 'ready' : 'unsupported',
    indexStatus: indexStatusForSearchText(searchText, extension, mimeType, entry.name),
    createdBy: userId,
    createdAt: now()
  };
  db.versions.push(version);
  node.currentVersionId = version.id;
  node.extension = extension;
  addVersionChangeLog(db, node, version, userId, versionNo === 1 ? 'external_create' : 'external_update', {
    description: version.description,
    externalRelativePath: entry.externalRelativePath
  });
  return version;
}

function notifyVisibleUsersAboutNewFile(db, actorId, node, actionLabel = '上传了') {
  const actor = db.users.find((item) => item.id === actorId);
  db.users
    .filter((user) => user.status === 'enabled' && hasAction(db, user, node, 'visible'))
    .forEach((user) => {
      addMessage(
        db,
        user.id,
        'file.upload',
        '新文件上传',
        `${actor?.displayName || '用户'} ${actionLabel} ${node.fullPath}`,
        node.id
      );
    });
}

function trimExternalSyncJobs(db) {
  db.externalSyncJobs = (db.externalSyncJobs || [])
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
    .slice(0, 100);
}

function publicExternalSyncJob(job) {
  return job ? { ...job } : null;
}

async function syncExternalDirectory(db, rootPath, userId, req = null, options = {}) {
  const root = nodeById(db, 'n_root');
  if (!root) throw createError(404, 'NOT_FOUND', '企业文档库根目录不存在');
  const settings = currentExternalLibrarySettings(db);
  const includePaths = normalizeOptions(options.includePaths ?? settings.includePaths);
  const excludePatterns = normalizeOptions(options.excludePatterns ?? settings.excludePatterns);
  const timestamp = now();
  const job = {
    id: newId('sync_'),
    status: 'running',
    rootPath,
    includePaths,
    excludePatterns,
    triggerUserId: userId,
    startedAt: timestamp,
    finishedAt: null,
    durationMs: null,
    progress: { scanned: 0, processed: 0, total: 0 },
    summary: null,
    error: null
  };
  db.externalSyncJobs.unshift(job);
  settings.lastSyncJob = job;
  trimExternalSyncJobs(db);

  try {
  const { entries, skipped: scanSkipped } = await scanExternalEntries(rootPath, { includePaths, excludePatterns });
  const byRelativePath = new Map(db.nodes.filter((item) => item.sourceType === 'external').map((item) => [item.externalRelativePath, item]));
  const seenNodeIds = new Set();
  const summary = {
    rootPath,
    includePaths,
    excludePatterns,
    scanned: entries.length,
    foldersCreated: 0,
    filesCreated: 0,
    filesUpdated: 0,
    restored: 0,
    deleted: 0,
    skipped: scanSkipped.length,
    skippedPaths: scanSkipped.slice(0, 20)
  };
  job.progress.scanned = entries.length;
  job.progress.total = entries.length;

  for (const entry of entries) {
    job.progress.processed += 1;
    const parentRel = parentRelativePath(entry.externalRelativePath);
    const parent = parentRel ? byRelativePath.get(parentRel) : root;
    if (!parent || parent.status === 'deleted' || parent.nodeType !== 'folder') {
      summary.skipped += 1;
      continue;
    }
    let node = byRelativePath.get(entry.externalRelativePath) || findExternalNodeByRelativePath(db, entry.externalRelativePath);
    const isNewNode = !node;
    if (!node) {
      node = {
        id: newId('n_'),
        parentId: parent.id,
        nodeType: entry.nodeType,
        name: validateName(entry.name),
        fullPath: childPath(parent, entry.name),
        extension: entry.nodeType === 'file' ? extname(entry.name) : '',
        currentVersionId: null,
        ownerId: userId,
        spaceType: 'enterprise',
        personalOwnerId: null,
        sourceType: 'external',
        externalRootPath: rootPath,
        externalPath: entry.externalPath,
        externalRelativePath: entry.externalRelativePath,
        externalSyncedAt: timestamp,
        createdBy: userId,
        updatedBy: userId,
        lockedBy: null,
        lockedAt: null,
        status: 'normal',
        businessStatus: 'effective',
        securityLevel: parent.securityLevel || 'internal',
        sensitive: false,
        sensitiveReason: '',
        securityUpdatedBy: null,
        securityUpdatedAt: null,
        tags: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      };
      db.nodes.push(node);
      byRelativePath.set(entry.externalRelativePath, node);
      if (entry.nodeType === 'folder') summary.foldersCreated += 1;
      else summary.filesCreated += 1;
    } else {
      if (node.status === 'deleted') summary.restored += 1;
      node.parentId = parent.id;
      node.nodeType = entry.nodeType;
      node.name = validateName(entry.name);
      node.fullPath = childPath(parent, entry.name);
      node.extension = entry.nodeType === 'file' ? extname(entry.name) : '';
      node.spaceType = 'enterprise';
      node.personalOwnerId = null;
      node.sourceType = 'external';
      node.externalRootPath = rootPath;
      node.externalPath = entry.externalPath;
      node.externalRelativePath = entry.externalRelativePath;
      node.externalSyncedAt = timestamp;
      node.status = 'normal';
      node.deletedAt = null;
      node.deletedBy = null;
      node.updatedBy = userId;
      node.updatedAt = timestamp;
      byRelativePath.set(entry.externalRelativePath, node);
    }
    seenNodeIds.add(node.id);
    if (entry.nodeType === 'file') {
      const signature = `${entry.mtimeMs}:${entry.sizeBytes}`;
      const current = currentVersion(db, node);
      if (!current || current.externalSignature !== signature || current.externalPath !== entry.externalPath) {
        await createExternalVersion(db, node, entry, userId);
        if (current) summary.filesUpdated += 1;
      }
      if (isNewNode) notifyVisibleUsersAboutNewFile(db, userId, node, '同步了');
    }
  }

  db.nodes
    .filter((item) => item.sourceType === 'external' && item.status !== 'deleted' && !seenNodeIds.has(item.id))
    .forEach((item) => {
      item.status = 'deleted';
      item.deletedAt = timestamp;
      item.deletedBy = userId;
      item.updatedBy = userId;
      item.updatedAt = timestamp;
      summary.deleted += 1;
    });

  currentExternalLibrarySettings(db).rootPath = rootPath;
  db.settings.externalLibrary.lastSyncedAt = timestamp;
  db.settings.externalLibrary.lastSyncSummary = summary;
  job.status = 'completed';
  job.finishedAt = now();
  job.durationMs = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
  job.summary = summary;
  db.settings.externalLibrary.lastSyncJob = publicExternalSyncJob(job);
  addAudit(db, userId, 'external_library.sync', 'system_setting', 'external_library', summary, req);
  return summary;
  } catch (error) {
    job.status = 'failed';
    job.finishedAt = now();
    job.durationMs = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
    job.error = { code: error.code || 'SYNC_FAILED', message: error.message || '同步失败' };
    db.settings.externalLibrary.lastSyncJob = publicExternalSyncJob(job);
    throw error;
  }
}

function ensureSiblingNameAvailable(db, parentId, name, exceptId = null) {
  const exists = db.nodes.some((item) => item.parentId === parentId && item.name === name && item.id !== exceptId && item.status !== 'deleted');
  if (exists) throw createError(409, 'CONFLICT', '同级目录下已存在同名文件或文件夹');
}

function ensureNodeMoveAllowed(db, node, targetParent) {
  if (node.id === 'n_root') throw createError(400, 'VALIDATION_ERROR', '根目录不能移动');
  if (targetParent.nodeType !== 'folder') throw createError(400, 'VALIDATION_ERROR', '目标必须是文件夹');
  if (node.id === targetParent.id || descendants(db, node.id).some((item) => item.id === targetParent.id)) {
    throw createError(400, 'VALIDATION_ERROR', '不能移动到自身或下级目录');
  }
  ensureSiblingNameAvailable(db, targetParent.id, node.name, node.id);
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function textFromOfficeXml(xml) {
  const textNodes = [];
  const textNodePattern = /<(?:[A-Za-z0-9]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?t>/g;
  for (const match of xml.matchAll(textNodePattern)) {
    const text = decodeXmlText(match[1]);
    if (text) textNodes.push(text);
  }
  if (textNodes.length) return textNodes.join(' ');
  return decodeXmlText(xml);
}

async function extractSearchText(filePath, extension, mimeType, filename = '') {
  const normalizedFilename = path.basename(String(filename || filePath || '')).toLowerCase();
  if (
    mimeType?.startsWith('text/') ||
    TEXT_PREVIEW_EXTENSIONS.has(extension) ||
    JSON_PREVIEW_EXTENSIONS.has(extension) ||
    TEXT_PREVIEW_FILENAMES.has(normalizedFilename)
  ) {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw.slice(0, 200000);
  }
  if (['docx', 'xlsx', 'pptx'].includes(extension)) {
    try {
      const zip = new AdmZip(filePath);
      const xmlEntries = zip
        .getEntries()
        .filter((entry) => !entry.isDirectory && entry.entryName.endsWith('.xml'))
        .filter((entry) => /word\/document|xl\/sharedStrings|xl\/worksheets|ppt\/slides/.test(entry.entryName));
      const text = xmlEntries
        .map((entry) => textFromOfficeXml(entry.getData().toString('utf8')))
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();
      return text.slice(0, 200000);
    } catch {
      return '';
    }
  }
  return '';
}

function supportsSearchText(extension, mimeType, filename = '') {
  const normalizedExtension = String(extension || '').replace(/^\./, '').toLowerCase();
  const normalizedFilename = path.basename(String(filename || '')).toLowerCase();
  return Boolean(
    mimeType?.startsWith('text/') ||
    TEXT_PREVIEW_EXTENSIONS.has(normalizedExtension) ||
    JSON_PREVIEW_EXTENSIONS.has(normalizedExtension) ||
    SEARCH_OFFICE_EXTENSIONS.has(normalizedExtension) ||
    TEXT_PREVIEW_FILENAMES.has(normalizedFilename)
  );
}

function indexStatusForSearchText(searchText, extension, mimeType, filename = '') {
  if (String(searchText || '').trim()) return 'ready';
  return supportsSearchText(extension, mimeType, filename) ? 'empty' : 'unsupported';
}

function trimPreviewContent(content) {
  return String(content || '').replace(/\r\n/g, '\n').slice(0, 200000);
}

function lineDiff(beforeText, afterText) {
  const before = String(beforeText || '').replace(/\r\n/g, '\n').split('\n').slice(0, 5000);
  const after = String(afterText || '').replace(/\r\n/g, '\n').split('\n').slice(0, 5000);
  const maxCells = 2_000_000;
  if (before.length * after.length > maxCells) {
    const beforeSet = new Set(before);
    return after.map((line) => ({ type: beforeSet.has(line) ? 'unchanged' : 'added', text: line }));
  }
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) table[left][right] = before[left] === after[right] ? table[left + 1][right + 1] + 1 : Math.max(table[left + 1][right], table[left][right + 1]);
  }
  const rows = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) { rows.push({ type: 'unchanged', text: before[left] }); left += 1; right += 1; }
    else if (right < after.length && (left >= before.length || table[left][right + 1] >= table[left + 1][right])) { rows.push({ type: 'added', text: after[right] }); right += 1; }
    else { rows.push({ type: 'removed', text: before[left] }); left += 1; }
  }
  return rows;
}

async function versionComparableText(db, node, version) {
  const extension = extname(version.originalFilename || node.name);
  const filePath = await ensureVersionLocalPath(db, version, node);
  if (version.mimeType?.startsWith('text/') || TEXT_PREVIEW_EXTENSIONS.has(extension) || JSON_PREVIEW_EXTENSIONS.has(extension)) return fs.readFile(filePath, 'utf8');
  if (['docx', 'xlsx', 'pptx'].includes(extension)) return extractSearchText(filePath, extension, version.mimeType, version.originalFilename);
  throw createError(400, 'VERSION_DIFF_UNSUPPORTED', '当前格式无法可靠提取内容进行版本差异比较');
}

async function readPreviewText(version, node, db) {
  const filePath = versionFilePath(version, node, db);
  if (filePath && fsSync.existsSync(filePath)) {
    try {
      return trimPreviewContent(await fs.readFile(filePath, 'utf8'));
    } catch {
      return trimPreviewContent(version.searchText);
    }
  }
  return trimPreviewContent(version.searchText);
}

function formatJsonPreview(content) {
  const raw = trimPreviewContent(content);
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function versionFilePath(version, node = null, db = null) {
  if (!version) return '';
  if ((version.storageType || 'local') === 'external') {
    const candidates = externalVersionPathCandidates(version, node, db);
    return candidates.find((candidate) => fsSync.existsSync(candidate)) || candidates[0] || '';
  }
  return path.join(config.uploadDir, version.storageKey || '');
}

async function createVersionFromUpload(db, node, file, userId, description = '') {
  enforceStorageQuota(db, userId, Number(file.size || 0));
  const extension = extname(file.originalname);
  const versionNo = db.versions.filter((item) => item.nodeId === node.id).length + 1;
  const versionId = newId('ver_');
  const storageName = `${versionId}-${safeFilename(file.originalname)}`;
  const storageKey = path.join(config.uploadDir, storageName);
  await fs.rename(file.path, storageKey);
  const md5 = await fileMd5FromPath(storageKey);
  const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
  const searchText = await extractSearchText(storageKey, extension, mimeType, file.originalname);
  const version = {
    id: versionId,
    nodeId: node.id,
    versionNo,
    storageType: 'local',
    storageKey: storageName,
    originalFilename: file.originalname,
    sizeBytes: file.size,
    md5,
    mimeType,
    description,
    searchText,
    previewStatus: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'txt', 'md'].includes(extension) || mimeType.startsWith('text/') ? 'ready' : 'unsupported',
    indexStatus: indexStatusForSearchText(searchText, extension, mimeType, file.originalname),
    createdBy: userId,
    createdAt: now()
  };
  db.versions.push(version);
  await replicateVersionToConfiguredStorage(db, version, storageKey);
  node.currentVersionId = version.id;
  node.extension = extension;
  node.updatedBy = userId;
  node.updatedAt = now();
  return version;
}

async function createVersionFromFile(db, node, filePath, originalFilename, userId, description = '') {
  const extension = extname(originalFilename);
  const stats = await fs.stat(filePath);
  enforceStorageQuota(db, userId, Number(stats.size || 0));
  const versionNo = db.versions.filter((item) => item.nodeId === node.id).length + 1;
  const versionId = newId('ver_');
  const storageName = `${versionId}-${safeFilename(originalFilename)}`;
  const storagePath = path.join(config.uploadDir, storageName);
  await fs.rename(filePath, storagePath);
  let md5;
  let mimeType;
  let searchText;
  try {
    md5 = await fileMd5FromPath(storagePath);
    mimeType = mime.lookup(originalFilename) || 'application/octet-stream';
    searchText = await extractSearchText(storagePath, extension, mimeType, originalFilename);
  } catch (error) {
    await fs.rm(storagePath, { force: true });
    throw error;
  }
  const version = {
    id: versionId,
    nodeId: node.id,
    versionNo,
    storageType: 'local',
    storageKey: storageName,
    originalFilename,
    sizeBytes: stats.size,
    md5,
    mimeType,
    description,
    searchText,
    previewStatus: 'unsupported',
    indexStatus: indexStatusForSearchText(searchText, extension, mimeType, originalFilename),
    createdBy: userId,
    createdAt: now()
  };
  await replicateVersionToConfiguredStorage(db, version, storagePath);
  db.versions.push(version);
  node.currentVersionId = version.id;
  node.extension = extension;
  node.updatedBy = userId;
  node.updatedAt = now();
  return version;
}

function createFileNode(db, parent, name, userId, businessStatus = 'effective') {
  const node = {
    id: newId('n_'),
    parentId: parent.id,
    nodeType: 'file',
    name,
    fullPath: childPath(parent, name),
    extension: extname(name),
    currentVersionId: null,
    ownerId: userId,
    spaceType: parent.spaceType || 'enterprise',
    personalOwnerId: parent.spaceType === 'personal' ? parent.personalOwnerId : null,
    createdBy: userId,
    updatedBy: userId,
    lockedBy: null,
    lockedAt: null,
    status: 'normal',
    businessStatus,
    securityLevel: parent.securityLevel || 'internal',
    sensitive: false,
    sensitiveReason: '',
    securityUpdatedBy: null,
    securityUpdatedAt: null,
    tags: [],
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null
  };
  db.nodes.push(node);
  return node;
}

async function streamVersion(res, version, downloadName = null, options = {}) {
  const filePath = await ensureVersionLocalPath(options.db, version, options.node);
  if (!fsSync.existsSync(filePath)) {
    const message = (version?.storageType || 'local') === 'external'
      ? '同步源文件不存在，请重新同步目录或检查服务器路径'
      : '文件内容不存在';
    throw createError(404, 'NOT_FOUND', message);
  }
  res.setHeader('Content-Type', version.mimeType || 'application/octet-stream');
  if (downloadName) {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  }
  fsSync.createReadStream(filePath).pipe(res);
}

async function recursiveZipNodes(db, archive, node, user, req = null) {
  if (req && !isNodePasswordAccessible(req, node)) return;
  if (node.nodeType === 'file') {
    if (!hasAction(db, user, node, 'file:download')) return;
    if (sensitiveDownloadBlocked(db, user, node)) return;
    const version = currentVersion(db, node);
    if (version) {
      const filePath = await ensureVersionLocalPath(db, version, node);
      if (fsSync.existsSync(filePath)) archive.file(filePath, { name: node.fullPath.replace(/^\//, '') });
    }
    return;
  }
  if (!hasAction(db, user, node, 'visible')) return;
  const children = db.nodes.filter((item) => item.parentId === node.id && item.status !== 'deleted');
  if (!children.length) archive.append('', { name: `${node.fullPath.replace(/^\//, '')}/` });
  await Promise.all(children.map((child) => recursiveZipNodes(db, archive, child, user, req)));
}

function blockedSensitiveDownloadNodes(db, user, node) {
  const candidates = node.nodeType === 'file' ? [node] : descendants(db, node.id).filter((item) => item.nodeType === 'file');
  return candidates.filter((item) => hasAction(db, user, item, 'file:download') && sensitiveDownloadBlocked(db, user, item));
}

function listVisibleDescendants(db, user) {
  return db.nodes.filter((node) => node.status !== 'deleted' && hasAction(db, user, node, 'visible'));
}

function pageData(items, page = 1, pageSize = 20) {
  const p = Math.max(Number(page) || 1, 1);
  const ps = Math.max(Number(pageSize) || 20, 1);
  const start = (p - 1) * ps;
  return { items: items.slice(start, start + ps), page: p, pageSize: ps, total: items.length };
}

function sendPage(res, items, page = 1, pageSize = 20) {
  res.json(ok(pageData(items, page, pageSize)));
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeCondition(condition = null) {
  if (!condition || typeof condition !== 'object') return null;
  const normalized = {};
  const filenameContains = String(condition.filenameContains || '').trim();
  const pathPrefix = String(condition.pathPrefix || '').trim();
  const businessStatus = String(condition.businessStatus || '').trim();
  const categoryIds = Array.isArray(condition.categoryIds) ? [...new Set(condition.categoryIds.map(String).filter(Boolean))] : [];
  const propertyId = String(condition.propertyId || '').trim();
  const propertyOperator = condition.propertyOperator === 'contains' ? 'contains' : 'equals';
  const propertyValue = String(condition.propertyValue || '').trim();
  const extensions = Array.isArray(condition.extensions)
    ? condition.extensions.map((item) => String(item).replace(/^\./, '').trim().toLowerCase()).filter(Boolean)
    : String(condition.extensions || '')
      .split(/[,\s，]+/)
      .map((item) => item.replace(/^\./, '').trim().toLowerCase())
      .filter(Boolean);
  if (filenameContains) normalized.filenameContains = filenameContains;
  if (pathPrefix) normalized.pathPrefix = pathPrefix;
  if (extensions.length) normalized.extensions = [...new Set(extensions)];
  if (businessStatus) normalized.businessStatus = businessStatus;
  if (categoryIds.length) normalized.categoryIds = categoryIds;
  if (propertyId) {
    normalized.propertyId = propertyId;
    normalized.propertyOperator = propertyOperator;
    if (propertyValue) normalized.propertyValue = propertyValue;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function normalizePermissionActions(actions, fallback = ['visible']) {
  const input = Array.isArray(actions) ? actions : fallback;
  const normalized = [...new Set(input.map((item) => String(item || '').trim()).filter((item) => ACTIONS.includes(item)))];
  if (!normalized.length) throw createError(400, 'VALIDATION_ERROR', '请选择有效的权限动作');
  return normalized;
}

function normalizePermissionDefaults(input = {}, fallback = {}) {
  const effect = input.effect ?? fallback.effect ?? 'allow';
  const scope = input.scope ?? fallback.scope ?? 'all';
  return {
    actions: normalizePermissionActions(input.actions ?? fallback.actions),
    effect: ['allow', 'deny'].includes(effect) ? effect : 'allow',
    scope: ['all', 'self', 'children', 'self_and_files', 'children_folders', 'children_files', 'files'].includes(scope) ? scope : 'all',
    priority: Number(input.priority ?? fallback.priority ?? 100),
    condition: input.condition === undefined ? normalizeCondition(fallback.condition) : normalizeCondition(input.condition),
    inheritEnabled: input.inheritEnabled ?? fallback.inheritEnabled ?? true
  };
}

function publicPermissionTemplate(template) {
  return template ? { ...template } : null;
}

function normalizePermissionTemplate(body = {}, fallback = {}) {
  const name = String(body.name ?? fallback.name ?? '').trim();
  if (!name) throw createError(400, 'VALIDATION_ERROR', '模板名称不能为空');
  return {
    name,
    description: String(body.description ?? fallback.description ?? '').trim(),
    ...normalizePermissionDefaults(body, fallback)
  };
}

function ensureSubjectExists(db, subjectType, subjectId) {
  if (subjectType === 'all') return;
  if (!subjectId) throw createError(400, 'VALIDATION_ERROR', '请选择授权对象');
  if (subjectType === 'user' && !db.users.some((item) => item.id === subjectId)) throw createError(404, 'NOT_FOUND', '授权用户不存在');
  if (subjectType === 'department' && !db.departments.some((item) => item.id === subjectId)) throw createError(404, 'NOT_FOUND', '授权部门不存在');
  if (subjectType === 'role' && !db.roles.some((item) => item.id === subjectId)) throw createError(404, 'NOT_FOUND', '授权角色不存在');
}

function normalizePermissionSubjects(body = {}) {
  const subjectType = body.subjectType || 'role';
  if (!['all', 'user', 'department', 'role'].includes(subjectType)) throw createError(400, 'VALIDATION_ERROR', '授权类型无效');
  if (subjectType === 'all') return [{ subjectType: 'all', subjectId: null }];
  const subjectIds = Array.isArray(body.subjectIds) ? body.subjectIds : [body.subjectId];
  const normalizedIds = [...new Set(subjectIds.map((item) => String(item || '').trim()).filter(Boolean))];
  if (!normalizedIds.length) throw createError(400, 'VALIDATION_ERROR', '请选择授权对象');
  return normalizedIds.map((subjectId) => ({ subjectType, subjectId }));
}

function permissionRuleFromPayload(db, node, userId, payload) {
  ensureSubjectExists(db, payload.subjectType, payload.subjectId);
  return {
    id: newId('pr_'),
    nodeId: node.id,
    subjectType: payload.subjectType,
    subjectId: payload.subjectType === 'all' ? null : payload.subjectId,
    ...normalizePermissionDefaults(payload),
    createdBy: userId,
    createdAt: now(),
    updatedAt: now()
  };
}

function notifySubscribers(db, actorId, node, eventType, version = null) {
  const actor = db.users.find((item) => item.id === actorId);
  const subscribers = (db.subscriptions || [])
    .filter((item) => item.status === 'active')
    .filter((item) => (item.eventTypes || []).includes(eventType) || (item.eventTypes || []).includes('all'))
    .filter((item) => {
      if (item.nodeId === node.id) return true;
      return item.includeChildren && ancestors(db, node).some((parent) => parent.id === item.nodeId);
    });

  subscribers.forEach((subscription) => {
    if (subscription.userId === actorId) return;
    addMessage(
      db,
      subscription.userId,
      `subscription.${eventType}`,
      '订阅文件变更',
      `${actor?.displayName || '用户'} ${eventType === 'update' ? '更新了' : eventType === 'delete' ? '删除了' : '变更了'} ${node.fullPath}${version ? `，版本 ${version.versionNo}` : ''}`,
      node.id
    );
  });
}

function notifyRelatedFileUpdate(db, actorId, node, version) {
  const actor = db.users.find((item) => item.id === actorId);
  const relations = (db.fileRelations || []).filter((item) => item.nodeId === node.id || item.relatedNodeId === node.id);
  relations.forEach((relation) => {
    const otherNodeId = relation.nodeId === node.id ? relation.relatedNodeId : relation.nodeId;
    const otherNode = nodeById(db, otherNodeId);
    if (!otherNode) return;
    const receivers = new Set([otherNode.ownerId, otherNode.createdBy, relation.createdBy].filter(Boolean));
    (db.subscriptions || [])
      .filter((item) => item.nodeId === otherNode.id && item.status === 'active')
      .forEach((item) => receivers.add(item.userId));
    receivers.delete(actorId);
    receivers.forEach((userId) => addMessage(
      db,
      userId,
      'relation.updated',
      '关联文件已更新',
      `${actor?.displayName || actor?.username || '用户'} 更新了“${node.fullPath}”${version ? `（版本 ${version.versionNo}）` : ''}，该文件与“${otherNode.fullPath}”存在关联`,
      otherNode.id
    ));
  });
}

function publicShare(db, share) {
  const node = includeDeletedNodeById(db, share.nodeId);
  return {
    ...share,
    nodeName: node?.name || '',
    nodePath: node?.fullPath || ''
  };
}

function publicExternalLink(db, link, { includeToken = false } = {}) {
  const node = includeDeletedNodeById(db, link.nodeId);
  const result = {
    id: link.id,
    nodeId: link.nodeId,
    nodeName: node?.name || '',
    nodePath: node?.fullPath || '',
    description: link.description || '',
    allowPreview: link.allowPreview !== false,
    allowDownload: Boolean(link.allowDownload),
    hasPassword: Boolean(link.passwordHash),
    effectiveAt: link.effectiveAt || null,
    expiresAt: link.expiresAt || null,
    maxAccessCount: Number(link.maxAccessCount || 0),
    accessCount: Number(link.accessCount || 0),
    status: link.status || 'active',
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
  if (includeToken) {
    result.token = link.token;
    result.publicUrl = `/?externalLink=${encodeURIComponent(link.token)}`;
  }
  return result;
}

function validateExternalLink(db, token, { enforceAccessLimit = true } = {}) {
  const link = db.externalLinks.find((item) => item.token === token);
  if (!link || link.status !== 'active') throw createError(404, 'NOT_FOUND', '外链不存在或已撤销');
  if (link.effectiveAt && new Date(link.effectiveAt).getTime() > Date.now()) throw createError(403, 'NOT_EFFECTIVE', '外链尚未生效');
  if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) throw createError(410, 'EXPIRED', '外链已过期');
  if (enforceAccessLimit && Number(link.maxAccessCount || 0) > 0 && Number(link.accessCount || 0) >= Number(link.maxAccessCount)) {
    throw createError(410, 'ACCESS_LIMIT_REACHED', '外链访问次数已用完');
  }
  const node = nodeById(db, link.nodeId);
  if (!node || node.nodeType !== 'file') throw createError(404, 'NOT_FOUND', '外链文件不存在');
  return { link, node };
}

function externalLinkAccessFromRequest(req, link) {
  const token = String(req.headers['x-external-access-token'] || req.query.accessToken || '');
  const payload = verifyToken(token);
  if (!payload || payload.type !== 'external_link' || payload.externalLinkId !== link.id) {
    throw createError(401, 'UNAUTHORIZED', '外链访问凭证无效或已过期');
  }
  return payload;
}

function publicSubscription(db, subscription) {
  const node = includeDeletedNodeById(db, subscription.nodeId);
  return {
    ...subscription,
    nodeName: node?.name || '',
    nodePath: node?.fullPath || ''
  };
}

function publicReminder(db, reminder) {
  const node = includeDeletedNodeById(db, reminder.nodeId);
  return {
    ...reminder,
    nodeName: node?.name || '',
    nodePath: node?.fullPath || ''
  };
}

function publicAttachment(db, attachment) {
  const node = includeDeletedNodeById(db, attachment.nodeId);
  return {
    ...attachment,
    nodeName: node?.name || '',
    nodePath: node?.fullPath || ''
  };
}

function publicRelation(db, user, relation) {
  const source = includeDeletedNodeById(db, relation.nodeId);
  const related = includeDeletedNodeById(db, relation.relatedNodeId);
  return {
    ...relation,
    nodeName: source?.name || '',
    nodePath: source?.fullPath || '',
    relatedNodeName: related?.name || '',
    relatedNodePath: related?.fullPath || '',
    relatedNode: related && related.status !== 'deleted' && hasAction(db, user, related, 'visible') ? publicNode(db, user, related) : null
  };
}

function publicCredential(db, credential, secret = null) {
  const user = db.users.find((item) => item.id === credential.userId);
  const result = {
    id: credential.id,
    name: credential.name,
    accessKey: credential.accessKey,
    userId: credential.userId,
    userName: user?.displayName || user?.username || credential.userId,
    scopes: credential.scopes || [],
    status: credential.status,
    rateLimitPerMinute: Number(credential.rateLimitPerMinute || 120),
    expiresAt: credential.expiresAt || null,
    lastUsedAt: credential.lastUsedAt || null,
    callCount: Number(credential.callCount || 0),
    createdBy: credential.createdBy,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt
  };
  if (secret) result.secret = secret;
  return result;
}

function publicWebhookSubscription(subscription, secret = null) {
  const result = {
    id: subscription.id,
    name: subscription.name,
    url: subscription.url,
    eventPatterns: subscription.eventPatterns || ['*'],
    status: subscription.status || 'enabled',
    hasSecret: Boolean(subscription.secret),
    createdBy: subscription.createdBy,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    lastDeliveredAt: subscription.lastDeliveredAt || null,
    lastError: subscription.lastError || ''
  };
  if (secret) result.secret = secret;
  return result;
}

function webhookEventMatches(patterns, eventType) {
  return (patterns || ['*']).some((pattern) => pattern === '*' || pattern === eventType || (pattern.endsWith('.*') && eventType.startsWith(pattern.slice(0, -1))));
}

async function deliverWebhook(db, subscription, event) {
  const payload = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', subscription.secret).update(`${timestamp}.${payload}`).digest('hex');
  const delivery = {
    id: newId('whd_'), subscriptionId: subscription.id, eventId: event.id, eventType: event.type,
    status: 'pending', attempts: 1, responseStatus: null, lastError: '', createdAt: now(), updatedAt: now(), deliveredAt: null
  };
  db.webhookDeliveries.unshift(delivery);
  db.webhookDeliveries = db.webhookDeliveries.slice(0, 10000);
  try {
    const response = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Document-Event': event.type,
        'X-Document-Delivery': delivery.id,
        'X-Document-Timestamp': timestamp,
        'X-Document-Signature': `sha256=${signature}`
      },
      body: payload,
      signal: AbortSignal.timeout(10000)
    });
    delivery.responseStatus = response.status;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    delivery.status = 'delivered';
    delivery.deliveredAt = now();
    subscription.lastDeliveredAt = delivery.deliveredAt;
    subscription.lastError = '';
  } catch (error) {
    delivery.status = 'failed';
    delivery.lastError = error.message;
    subscription.lastError = error.message;
  }
  delivery.updatedAt = now();
  subscription.updatedAt = now();
  return delivery;
}

async function dispatchWebhookEvents(db, auditLogs) {
  const subscriptions = (db.webhookSubscriptions || []).filter((item) => item.status === 'enabled');
  for (const audit of auditLogs) {
    const event = {
      id: `evt_${audit.id}`,
      type: audit.action,
      occurredAt: audit.createdAt,
      data: {
        actorId: audit.actorId || null,
        targetType: audit.targetType,
        targetId: audit.targetId,
        targetPath: audit.targetPath || '',
        detail: audit.detail || {}
      }
    };
    for (const subscription of subscriptions.filter((item) => webhookEventMatches(item.eventPatterns, event.type))) {
      await deliverWebhook(db, subscription, event);
    }
  }
  if (auditLogs.length && subscriptions.length) await saveDb(db);
}

function attachWebhookDispatcher(req, res) {
  if (req.webhookDispatcherAttached || !req.db) return;
  req.webhookDispatcherAttached = true;
  const existingAuditIds = new Set((req.db.auditLogs || []).map((item) => item.id));
  res.once('finish', () => {
    const events = (req.db.auditLogs || []).filter((item) => !existingAuditIds.has(item.id));
    if (events.length) void dispatchWebhookEvents(req.db, events).catch((error) => console.error('webhook dispatch failed', error));
  });
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeAudience(input = {}) {
  const audience = typeof input === 'string' ? parseJsonField(input, {}) : input;
  return {
    all: audience.all !== false && !audience.userIds?.length && !audience.departmentIds?.length && !audience.roleIds?.length ? true : Boolean(audience.all),
    userIds: audience.userIds || [],
    departmentIds: audience.departmentIds || [],
    roleIds: audience.roleIds || []
  };
}

function viewAccessRules(db, nodeId) {
  return db.permissionRules.filter((rule) => rule.nodeId === nodeId && rule.managedBy === 'view_access');
}

function viewAccessSummary(db, node) {
  const rules = viewAccessRules(db, node.id);
  const denyAll = rules.some((rule) => rule.effect === 'deny' && rule.subjectType === 'all');
  const allowRules = rules.filter((rule) => rule.effect === 'allow');
  return {
    nodeId: node.id,
    restricted: denyAll,
    audience: {
      all: !denyAll,
      userIds: allowRules.filter((rule) => rule.subjectType === 'user').map((rule) => rule.subjectId),
      departmentIds: allowRules.filter((rule) => rule.subjectType === 'department').map((rule) => rule.subjectId),
      roleIds: allowRules.filter((rule) => rule.subjectType === 'role').map((rule) => rule.subjectId)
    },
    rules
  };
}

function replaceViewAccessRules(db, node, userId, restricted, audienceInput = {}) {
  db.permissionRules = db.permissionRules.filter((rule) => !(rule.nodeId === node.id && rule.managedBy === 'view_access'));
  const audience = normalizeAudience(audienceInput);
  if (!restricted || audience.all) return viewAccessSummary(db, node);
  const entries = [
    ...audience.userIds.map((subjectId) => ({ subjectType: 'user', subjectId })),
    ...audience.departmentIds.map((subjectId) => ({ subjectType: 'department', subjectId })),
    ...audience.roleIds.map((subjectId) => ({ subjectType: 'role', subjectId }))
  ];
  if (!entries.length) throw createError(400, 'VALIDATION_ERROR', '请选择允许查看的用户、部门或角色');
  const timestamp = now();
  db.permissionRules.push({
    id: newId('pr_'),
    nodeId: node.id,
    subjectType: 'all',
    subjectId: null,
    scope: 'all',
    actions: VIEW_ACCESS_ACTIONS,
    effect: 'deny',
    priority: 800,
    condition: null,
    inheritEnabled: true,
    managedBy: 'view_access',
    createdBy: userId,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  entries.forEach((entry) => {
    db.permissionRules.push({
      id: newId('pr_'),
      nodeId: node.id,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      scope: 'all',
      actions: VIEW_ACCESS_ACTIONS,
      effect: 'allow',
      priority: 900,
      condition: null,
      inheritEnabled: true,
      managedBy: 'view_access',
      createdBy: userId,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  });
  return viewAccessSummary(db, node);
}

function announcementVisibleToUser(announcement, user) {
  if (isAdmin(user)) return true;
  if (announcement.status !== 'published') return false;
  if (isNotYetEffective(announcement) || isExpired(announcement)) return false;
  return audienceMatches(announcement.audience, user);
}

function publicAnnouncement(db, user, announcement) {
  const creator = db.users.find((item) => item.id === announcement.createdBy);
  const attachments = announcement.attachments || (announcement.attachment ? [announcement.attachment] : []);
  return {
    ...announcement,
    createdByName: creator?.displayName || creator?.username || announcement.createdBy,
    canManage: isAdmin(user) || announcement.createdBy === user.id,
    attachment: attachments[0] ? { id: attachments[0].id, originalFilename: attachments[0].originalFilename, sizeBytes: attachments[0].sizeBytes, mimeType: attachments[0].mimeType } : null,
    attachments: attachments.map((item) => ({ id: item.id, originalFilename: item.originalFilename, sizeBytes: item.sizeBytes, mimeType: item.mimeType, createdAt: item.createdAt }))
  };
}

function publicMessage(db, user, message, options = {}) {
  const node = message.relatedNodeId ? nodeById(db, message.relatedNodeId) : null;
  return {
    ...message,
    relatedNode: node && hasAction(db, user, node, 'visible') ? publicNode(db, user, node, options) : null
  };
}

function ensureNotificationDeliveries(db) {
  db.notificationDeliveries = db.notificationDeliveries || [];
  const existingKeys = new Set(db.notificationDeliveries.map((item) => `${item.messageId}:${item.channel}`));
  const wecomEnabled = Boolean(db.settings?.wecom?.enabled && db.settings?.wecom?.pushMessages);
  (db.messages || []).forEach((message) => {
    const channels = ['system', ...(wecomEnabled ? ['wecom'] : [])];
    channels.forEach((channel) => {
      const key = `${message.id}:${channel}`;
      if (existingKeys.has(key)) return;
      existingKeys.add(key);
      db.notificationDeliveries.unshift({
        id: newId('nd_'),
        messageId: message.id,
        receiverId: message.receiverId,
        channel,
        status: channel === 'system' ? 'sent' : 'pending',
        attempts: channel === 'system' ? 1 : 0,
        lastError: '',
        nextRetryAt: channel === 'system' ? null : now(),
        sentAt: channel === 'system' ? message.createdAt : null,
        createdAt: message.createdAt,
        updatedAt: message.createdAt
      });
    });
  });
  db.notificationDeliveries = db.notificationDeliveries.slice(0, 10000);
}

function publicNotificationDelivery(db, delivery) {
  const message = db.messages.find((item) => item.id === delivery.messageId);
  return { ...delivery, title: message?.title || '', messageType: message?.messageType || '', content: message?.content || '' };
}

async function attemptNotificationDelivery(db, delivery) {
  if (delivery.channel === 'system') {
    delivery.status = 'sent';
    delivery.sentAt = delivery.sentAt || now();
    return delivery;
  }
  delivery.attempts = Number(delivery.attempts || 0) + 1;
  delivery.updatedAt = now();
  const settings = currentWecomSettings(db);
  if (!settings.enabled || !settings.pushMessages || !settings.corpId || !settings.agentId || !settings.secret) {
    delivery.status = 'failed';
    delivery.lastError = '企业微信推送配置不完整';
    delivery.nextRetryAt = new Date(Date.now() + Math.min(60, delivery.attempts * 5) * 60 * 1000).toISOString();
    return delivery;
  }
  const message = db.messages.find((item) => item.id === delivery.messageId);
  const receiver = db.users.find((item) => item.id === delivery.receiverId);
  try {
    const tokenResponse = await fetch(`${settings.apiBaseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(settings.corpId)}&corpsecret=${encodeURIComponent(settings.secret)}`, { signal: AbortSignal.timeout(8000) });
    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok || Number(tokenPayload.errcode || 0) !== 0 || !tokenPayload.access_token) throw new Error(tokenPayload.errmsg || `HTTP ${tokenResponse.status}`);
    const sendResponse = await fetch(`${settings.apiBaseUrl}/cgi-bin/message/send?access_token=${encodeURIComponent(tokenPayload.access_token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: receiver?.username || delivery.receiverId,
        msgtype: 'text',
        agentid: Number(settings.agentId) || settings.agentId,
        text: { content: `${message?.title || '文档管理平台'}\n${message?.content || ''}` },
        safe: 0
      }),
      signal: AbortSignal.timeout(8000)
    });
    const sendPayload = await sendResponse.json();
    if (!sendResponse.ok || Number(sendPayload.errcode || 0) !== 0) throw new Error(sendPayload.errmsg || `HTTP ${sendResponse.status}`);
    delivery.status = 'sent';
    delivery.sentAt = now();
    delivery.lastError = '';
    delivery.nextRetryAt = null;
  } catch (error) {
    delivery.status = 'failed';
    delivery.lastError = `企业微信推送失败：${error.message}`;
    delivery.nextRetryAt = new Date(Date.now() + Math.min(60, delivery.attempts * 5) * 60 * 1000).toISOString();
  }
  return delivery;
}

function publicRecentAccess(db, user, access) {
  const node = nodeById(db, access.nodeId);
  return {
    ...access,
    node: node && hasAction(db, user, node, 'visible') ? publicNode(db, user, node) : null
  };
}

function storageConsistencyReport(db) {
  const issues = [];
  const referencedStorageKeys = new Set();
  db.versions.forEach((version) => {
    const node = includeDeletedNodeById(db, version.nodeId);
    if (!node) issues.push({ type: 'orphan_version', severity: 'error', versionId: version.id, message: '版本关联文件不存在' });
    if (['local', 'nas', 's3'].includes(version.storageType || 'local')) {
      referencedStorageKeys.add(version.storageKey);
      const localExists = version.storageKey && fsSync.existsSync(path.join(config.uploadDir, version.storageKey));
      const nasExists = version.storageType === 'nas' && version.nasPath && fsSync.existsSync(version.nasPath);
      const s3Configured = version.storageType === 's3' && Boolean(version.s3Key && version.s3Bucket);
      if (!localExists && !nasExists && !s3Configured) issues.push({ type: 'missing_version_file', severity: 'error', versionId: version.id, nodeId: version.nodeId, message: '版本文件缺失' });
      else if (!localExists && (nasExists || s3Configured)) issues.push({ type: 'missing_local_cache', severity: 'warning', versionId: version.id, nodeId: version.nodeId, message: '远端版本存在，本地缓存缺失，将在读取时重建' });
    }
  });
  db.nodes.filter((node) => node.nodeType === 'file' && node.currentVersionId).forEach((node) => {
    if (!db.versions.some((version) => version.id === node.currentVersionId && version.nodeId === node.id)) issues.push({ type: 'invalid_current_version', severity: 'error', nodeId: node.id, message: '当前版本引用无效' });
  });
  (db.attachments || []).forEach((attachment) => {
    referencedStorageKeys.add(attachment.storageKey);
    if (!attachment.storageKey || !fsSync.existsSync(path.join(config.uploadDir, attachment.storageKey))) issues.push({ type: 'missing_attachment_file', severity: 'error', attachmentId: attachment.id, nodeId: attachment.nodeId, message: '文档附件文件缺失' });
  });
  (db.announcements || []).forEach((announcement) => {
    const attachments = announcement.attachments || (announcement.attachment ? [announcement.attachment] : []);
    attachments.forEach((attachment) => {
      referencedStorageKeys.add(attachment.storageKey);
      if (!attachment.storageKey || !fsSync.existsSync(path.join(config.uploadDir, attachment.storageKey))) issues.push({ type: 'missing_announcement_attachment', severity: 'error', announcementId: announcement.id, attachmentId: attachment.id, message: '公告附件文件缺失' });
    });
  });
  const uploadFiles = fsSync.existsSync(config.uploadDir) ? fsSync.readdirSync(config.uploadDir, { withFileTypes: true }).filter((item) => item.isFile()).map((item) => item.name) : [];
  uploadFiles.filter((name) => !referencedStorageKeys.has(name)).forEach((name) => issues.push({ type: 'orphan_upload', severity: 'warning', storageKey: name, message: '上传目录存在未引用文件' }));
  return {
    checkedAt: now(),
    healthy: !issues.some((item) => item.severity === 'error'),
    counts: {
      nodes: db.nodes.length,
      versions: db.versions.length,
      uploadFiles: uploadFiles.length,
      errors: issues.filter((item) => item.severity === 'error').length,
      warnings: issues.filter((item) => item.severity === 'warning').length
    },
    issues: issues.slice(0, 500)
  };
}

function evaluateSystemAlerts(db, consistency = storageConsistencyReport(db), runtime = null) {
  const nowValue = now();
  const candidates = [];
  if (!consistency.healthy) candidates.push({ key: 'storage_consistency', severity: 'critical', title: '存储一致性异常', detail: `发现 ${consistency.counts.errors} 个错误` });
  const failedSync = (db.externalSyncJobs || []).find((item) => item.status === 'failed');
  if (failedSync) candidates.push({ key: 'external_sync_failed', severity: 'warning', title: '目录同步失败', detail: failedSync.error || '最近目录同步任务失败' });
  const failedOffice = (db.officeEditSessions || []).filter((item) => item.status === 'failed').slice(0, 1)[0];
  if (failedOffice) candidates.push({ key: 'office_edit_failed', severity: 'warning', title: 'Office 在线编辑保存失败', detail: failedOffice.lastError || failedOffice.id });
  const failedDeliveries = (db.notificationDeliveries || []).filter((item) => item.status === 'failed').length;
  if (failedDeliveries) candidates.push({ key: 'notification_failed', severity: 'warning', title: '通知投递失败', detail: `${failedDeliveries} 条通知等待重试` });
  const recentLoginFailures = (db.auditLogs || []).filter((item) => item.action === 'auth.login_failed' && Date.now() - new Date(item.createdAt).getTime() <= 60 * 60 * 1000).length;
  if (recentLoginFailures >= 5) candidates.push({ key: 'login_failures', severity: 'critical', title: '异常登录告警', detail: `最近一小时登录失败 ${recentLoginFailures} 次` });
  const recentPreviewFailures = (db.auditLogs || []).filter((item) => item.action === 'file.preview_failed' && Date.now() - new Date(item.createdAt).getTime() <= 60 * 60 * 1000).length;
  if (recentPreviewFailures >= 3) candidates.push({ key: 'preview_failures', severity: 'warning', title: '连续预览失败', detail: `最近一小时预览失败 ${recentPreviewFailures} 次` });
  if (runtime?.disk?.warning) candidates.push({ key: 'disk_capacity_low', severity: 'critical', title: '磁盘可用空间不足', detail: `上传目录所在磁盘已使用 ${runtime.disk.usedPercent}%（阈值 ${runtime.disk.warningPercent}%）` });
  if (runtime?.health?.mysql?.status === 'down') candidates.push({ key: 'mysql_health_down', severity: 'critical', title: 'MySQL 健康检查失败', detail: runtime.health.mysql.message });
  if (runtime?.health?.onlyoffice?.status === 'down') candidates.push({ key: 'onlyoffice_health_down', severity: 'warning', title: 'ONLYOFFICE 健康检查失败', detail: runtime.health.onlyoffice.message });
  db.systemAlerts = db.systemAlerts || [];
  candidates.forEach((candidate) => {
    const existing = db.systemAlerts.find((item) => item.key === candidate.key && item.status === 'open');
    if (existing) {
      existing.detail = candidate.detail;
      existing.updatedAt = nowValue;
    } else {
      db.systemAlerts.unshift({ id: newId('alert_'), ...candidate, status: 'open', createdAt: nowValue, updatedAt: nowValue, resolvedAt: null, resolvedBy: null });
    }
  });
  return db.systemAlerts;
}

function backupSafeSnapshot(db) {
  const snapshot = structuredClone(db);
  if (snapshot.settings?.wecom) snapshot.settings.wecom.secret = '';
  if (snapshot.settings?.officePreview) snapshot.settings.officePreview.jwtSecret = '';
  if (snapshot.settings?.identity?.oidc) snapshot.settings.identity.oidc.clientSecret = '';
  if (snapshot.settings?.identity?.saml) snapshot.settings.identity.saml.idpCert = '';
  if (snapshot.settings?.identity?.ldap) snapshot.settings.identity.ldap.bindPassword = '';
  if (snapshot.settings?.identity?.hr) snapshot.settings.identity.hr.syncSecret = '';
  if (snapshot.settings?.fileStorage?.s3) {
    snapshot.settings.fileStorage.s3.accessKeyId = '';
    snapshot.settings.fileStorage.s3.secretAccessKey = '';
  }
  (snapshot.webhookSubscriptions || []).forEach((item) => { item.secret = ''; });
  (snapshot.apiCredentials || []).forEach((item) => {
    item.secretHash = '';
    item.secretSalt = '';
  });
  snapshot.loginTickets = [];
  return snapshot;
}

async function createSystemBackup(db, actorId) {
  const job = { id: newId('backup_'), status: 'running', filename: '', sizeBytes: 0, error: '', createdBy: actorId, createdAt: now(), completedAt: null, drill: null };
  db.backupJobs.unshift(job);
  db.backupJobs = db.backupJobs.slice(0, 100);
  const filename = `${job.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const backupPath = path.join(config.backupDir, filename);
  const snapshot = backupSafeSnapshot(db);
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(backupPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append(JSON.stringify(snapshot, null, 2), { name: 'db.json' });
    const storageKeys = new Set([
      ...db.versions.filter((version) => (version.storageType || 'local') === 'local').map((version) => version.storageKey),
      ...(db.attachments || []).map((attachment) => attachment.storageKey),
      ...(db.announcements || []).flatMap((announcement) => (announcement.attachments || (announcement.attachment ? [announcement.attachment] : [])).map((item) => item.storageKey))
    ].filter(Boolean));
    storageKeys.forEach((storageKey) => {
      const source = path.join(config.uploadDir, storageKey);
      if (fsSync.existsSync(source)) archive.file(source, { name: `uploads/${storageKey}` });
    });
    void archive.finalize();
  });
  const stats = await fs.stat(backupPath);
  job.status = 'completed';
  job.filename = filename;
  job.sizeBytes = stats.size;
  job.completedAt = now();
  return job;
}

async function runBackupRestoreDrill(job) {
  if (!job?.filename) throw createError(404, 'NOT_FOUND', '备份文件不存在');
  const backupPath = path.join(config.backupDir, path.basename(job.filename));
  if (!fsSync.existsSync(backupPath)) throw createError(404, 'NOT_FOUND', '备份文件不存在');
  const zip = new AdmZip(backupPath);
  const entries = zip.getEntries();
  const unsafeEntry = entries.find((entry) => entry.entryName.includes('..') || path.isAbsolute(entry.entryName));
  if (unsafeEntry) throw createError(400, 'BACKUP_INVALID', '备份包包含不安全路径');
  const dbEntry = entries.find((entry) => entry.entryName === 'db.json');
  if (!dbEntry) throw createError(400, 'BACKUP_INVALID', '备份包缺少账本快照');
  let snapshot;
  try {
    snapshot = JSON.parse(dbEntry.getData().toString('utf8'));
  } catch {
    throw createError(400, 'BACKUP_INVALID', '备份账本格式无效');
  }
  const expectedFiles = [
    ...(snapshot.versions || []).filter((version) => (version.storageType || 'local') === 'local').map((version) => ({ kind: 'version', id: version.id, storageKey: version.storageKey })),
    ...(snapshot.attachments || []).map((attachment) => ({ kind: 'attachment', id: attachment.id, storageKey: attachment.storageKey })),
    ...(snapshot.announcements || []).flatMap((announcement) => (announcement.attachments || (announcement.attachment ? [announcement.attachment] : [])).map((item) => ({ kind: 'announcement', id: announcement.id, storageKey: item.storageKey })))
  ].filter((item) => item.storageKey);
  const archivedFiles = new Set(entries.filter((entry) => entry.entryName.startsWith('uploads/') && !entry.isDirectory).map((entry) => entry.entryName.slice('uploads/'.length)));
  const missingFiles = expectedFiles.filter((item) => !archivedFiles.has(item.storageKey));
  const drill = { checkedAt: now(), valid: missingFiles.length === 0, nodeCount: (snapshot.nodes || []).length, versionCount: (snapshot.versions || []).length, attachmentCount: (snapshot.attachments || []).length, announcementAttachmentCount: (snapshot.announcements || []).reduce((sum, item) => sum + (item.attachments || (item.attachment ? [item.attachment] : [])).length, 0), archivedFileCount: archivedFiles.size, missingVersionIds: missingFiles.filter((item) => item.kind === 'version').map((item) => item.id).slice(0, 100), missingFiles: missingFiles.slice(0, 100) };
  job.drill = drill;
  return drill;
}

async function probeOnlyOfficeHealth(db) {
  const settings = currentOfficePreviewSettings(db);
  if (!settings.enabled || !settings.documentServerUrl) return { status: 'disabled', message: '未启用', checkedAt: now() };
  try {
    const response = await fetch(joinUrl(settings.documentServerUrl, '/healthcheck'), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { status: 'up', message: '服务可访问', checkedAt: now() };
  } catch (error) {
    return { status: 'down', message: `连接失败：${error.message}`, checkedAt: now() };
  }
}

async function probeMysqlHealth() {
  const storage = await readStorageConfig({ includePassword: true });
  if (storage.provider !== 'mysql') return { status: 'disabled', message: '当前使用 JSON 存储', checkedAt: now() };
  try {
    const result = await testMysqlConnection(storage.mysql);
    return { status: 'up', message: `MySQL ${result.version || ''}`.trim(), database: result.database, checkedAt: now() };
  } catch (error) {
    return { status: 'down', message: `连接失败：${error.message}`, checkedAt: now() };
  }
}

async function withHealthProbeTimeout(label, operation, timeoutMs = 4000) {
  try {
    return await Promise.race([
      operation(),
      new Promise((resolve) => setTimeout(() => resolve({ status: 'down', message: `${label}健康检查超时（${Math.round(timeoutMs / 1000)} 秒）`, checkedAt: now() }), timeoutMs))
    ]);
  } catch (error) {
    return { status: 'down', message: `${label}健康检查失败：${error.message}`, checkedAt: now() };
  }
}

async function diskRuntimeStatus() {
  try {
    const stats = await fs.statfs(config.uploadDir);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedPercent = totalBytes ? Number((((totalBytes - freeBytes) / totalBytes) * 100).toFixed(1)) : 0;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes, usedPercent, warningPercent: config.diskWarningPercent, warning: usedPercent >= config.diskWarningPercent };
  } catch (error) {
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0, usedPercent: 0, warningPercent: config.diskWarningPercent, warning: true, error: error.message };
  }
}

async function runtimeStatus(db) {
  const files = db.nodes.filter((item) => item.nodeType === 'file' && item.status !== 'deleted');
  const folders = db.nodes.filter((item) => item.nodeType === 'folder' && item.status !== 'deleted');
  const [mysqlHealth, onlyOfficeHealth, disk] = await Promise.all([
    withHealthProbeTimeout('MySQL', probeMysqlHealth),
    withHealthProbeTimeout('ONLYOFFICE', () => probeOnlyOfficeHealth(db)),
    diskRuntimeStatus()
  ]);
  const degraded = disk.warning || [mysqlHealth, onlyOfficeHealth].some((item) => item.status === 'down');
  return {
    status: degraded ? 'degraded' : 'up',
    time: now(),
    uptimeSeconds: Math.round(process.uptime()),
    dataDir: config.dataDir,
    uploadDir: config.uploadDir,
    tmpDir: config.tmpDir,
    backupDir: config.backupDir,
    dataDirExists: fsSync.existsSync(config.dataDir),
    uploadDirExists: fsSync.existsSync(config.uploadDir),
    tmpDirExists: fsSync.existsSync(config.tmpDir),
    backupItems: [
      { name: '账本数据目录', path: config.dataDir, exists: fsSync.existsSync(config.dataDir) },
      { name: '上传文件目录', path: config.uploadDir, exists: fsSync.existsSync(config.uploadDir) },
      { name: '临时文件目录', path: config.tmpDir, exists: fsSync.existsSync(config.tmpDir) }
    ],
    counts: {
      users: db.users.length,
      folders: folders.length,
      files: files.length,
      versions: db.versions.length,
      auditLogs: db.auditLogs.length,
      pendingApprovals: (db.documentApprovals || []).filter((item) => item.status === 'pending').length,
      openAlerts: (db.systemAlerts || []).filter((item) => item.status === 'open').length,
      failedNotifications: (db.notificationDeliveries || []).filter((item) => item.status === 'failed').length
    },
    storage: getStorageRuntimeInfo(),
    disk,
    health: { backend: { status: 'up', message: '服务正常', checkedAt: now() }, mysql: mysqlHealth, onlyoffice: onlyOfficeHealth },
    officePreview: sanitizeOfficePreviewSettings(currentOfficePreviewSettings(db)),
    lastSyncJob: db.externalSyncJobs?.[0] || null,
    lastBackupJob: db.backupJobs?.[0] || null
  };
}

function auditReport(db) {
  const logs = db.auditLogs || [];
  const byAction = new Map();
  const byActor = new Map();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daily = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (6 - index));
    return { date: date.toISOString().slice(0, 10), count: 0 };
  });
  const dailyMap = new Map(daily.map((item) => [item.date, item]));
  logs.forEach((log) => {
    byAction.set(log.action, (byAction.get(log.action) || 0) + 1);
    byActor.set(log.actorId || 'system', (byActor.get(log.actorId || 'system') || 0) + 1);
    const key = String(log.createdAt || '').slice(0, 10);
    if (dailyMap.has(key)) dailyMap.get(key).count += 1;
  });
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
  return {
    total: logs.length,
    sensitiveAccesses: logs.filter((item) => String(item.action || '').startsWith('sensitive.')).length,
    blockedDownloads: logs.filter((item) => item.action === 'sensitive.download.blocked').length,
    topActions: top(byAction),
    topActors: top(byActor),
    daily
  };
}

const WORKFLOW_ACTIONS = {
  publish: { status: 'effective', label: '发布' },
  invalidate: { status: 'invalid', label: '作废' },
  archive: { status: 'archived', label: '归档' },
  draft: { status: 'draft', label: '转草稿' }
};

const BUSINESS_STATUS_LABELS = {
  draft: '草稿',
  effective: '有效',
  invalid: '作废',
  archived: '归档'
};

function workflowActionConfig(action) {
  const configItem = WORKFLOW_ACTIONS[action];
  if (!configItem) throw createError(400, 'VALIDATION_ERROR', '流程动作不正确');
  return configItem;
}

function userDisplayName(db, userId) {
  const user = db.users.find((item) => item.id === userId);
  return user?.displayName || user?.username || userId || '-';
}

function addVersionChangeLog(db, node, version, actorId, action, detail = {}) {
  db.versionChangeLogs.unshift({
    id: newId('vlog_'),
    nodeId: node.id,
    versionId: version?.id || null,
    versionNo: version?.versionNo || null,
    action,
    description: detail.description || version?.description || '',
    fromVersionId: detail.fromVersionId || null,
    fromVersionNo: detail.fromVersionNo || null,
    toVersionId: detail.toVersionId || version?.id || null,
    toVersionNo: detail.toVersionNo || version?.versionNo || null,
    actorId,
    detail,
    createdAt: now()
  });
}

function publicVersionChangeLog(db, log) {
  return {
    ...log,
    actorName: userDisplayName(db, log.actorId)
  };
}

function publicApproval(db, user, approval) {
  const node = includeDeletedNodeById(db, approval.nodeId);
  const type = approval.type || 'workflow';
  const typeLabels = { workflow: '文档流程', download: '下载审批', permission: '权限申请', publish: '发布审批', borrow: '借阅审批', external: '外发审批' };
  const actionLabels = {
    download: '下载文件',
    permission: '申请权限',
    publish: '发布文件',
    borrow: '借阅文件',
    external: '外发文件'
  };
  const steps = approvalSteps(approval);
  const currentStep = steps[approval.currentStepIndex || 0] || null;
  const currentApproverIds = currentStep?.approverIds || [];
  const alreadyDecided = (currentStep?.decisions || []).some((item) => item.userId === user.id);
  return {
    ...approval,
    type,
    typeLabel: typeLabels[type] || type,
    actionLabel: WORKFLOW_ACTIONS[approval.action]?.label || actionLabels[type] || approval.action,
    requestedStatusLabel: BUSINESS_STATUS_LABELS[approval.requestedStatus] || approval.requestedStatus,
    requestedActionsLabel: (approval.requestedActions || []).join('、'),
    requesterName: userDisplayName(db, approval.requesterId),
    approverName: userDisplayName(db, approval.approverId),
    steps: steps.map((step, index) => ({
      ...step,
      index,
      approverNames: step.approverIds.map((id) => userDisplayName(db, id)),
      decisions: (step.decisions || []).map((item) => ({ ...item, userName: userDisplayName(db, item.userId) }))
    })),
    currentStepIndex: approval.currentStepIndex || 0,
    currentStepName: currentStep?.name || '',
    currentApproverNames: currentApproverIds.map((id) => userDisplayName(db, id)).join('、'),
    decidedByName: approval.decidedBy ? userDisplayName(db, approval.decidedBy) : '',
    nodeName: node?.name || approval.nodeId,
    nodePath: node?.fullPath || '',
    nodeType: node?.nodeType || '',
    nodeBusinessStatus: node?.businessStatus || '',
    nodeSecurityLevel: node?.securityLevel || '',
    nodeSensitive: Boolean(node?.sensitive),
    canDecide: approval.status === 'pending' && !alreadyDecided && (isAdmin(user) || currentApproverIds.includes(user.id)),
    canWithdraw: approval.status === 'pending' && approval.requesterId === user.id,
    canManageStep: approval.status === 'pending' && (isAdmin(user) || currentApproverIds.includes(user.id))
  };
}

function applyWorkflowAction(db, node, actorId, action, comment = '', req = null, approval = null) {
  const actionConfig = workflowActionConfig(action);
  const previousStatus = node.businessStatus || 'effective';
  node.businessStatus = actionConfig.status;
  node.updatedBy = actorId;
  node.updatedAt = now();
  const detail = {
    targetPath: node.fullPath,
    action,
    actionLabel: actionConfig.label,
    fromStatus: previousStatus,
    toStatus: actionConfig.status,
    comment,
    approvalId: approval?.id || null
  };
  addAudit(db, actorId, `workflow.${action}`, 'node', node.id, detail, req);
  return detail;
}

function defaultApprover(db, requestedApproverId = '') {
  const requested = requestedApproverId ? db.users.find((item) => item.id === requestedApproverId && item.status === 'enabled') : null;
  if (requested) return requested;
  return db.users.find((item) => item.status === 'enabled' && (item.roleIds || []).includes('r_admin'));
}

function approvalTypeLabel(type) {
  return {
    workflow: '文档流程',
    download: '下载审批',
    permission: '权限申请',
    publish: '发布审批',
    borrow: '借阅审批',
    external: '外发审批'
  }[type] || type;
}

function approvalActionLabel(approval) {
  const type = approval.type || 'workflow';
  if (type === 'workflow') return WORKFLOW_ACTIONS[approval.action]?.label || approval.action;
  if (type === 'download') return '下载文件';
  if (type === 'permission') return '申请权限';
  if (type === 'publish') return '发布文件';
  if (type === 'borrow') return '借阅文件';
  if (type === 'external') return '外发文件';
  return approval.action || type;
}

function approvalSteps(approval) {
  if (Array.isArray(approval.steps) && approval.steps.length) return approval.steps;
  return [{
    id: `step_${approval.id || 'legacy'}_1`,
    name: '审批',
    mode: 'all',
    approverIds: [approval.approverId].filter(Boolean),
    decisions: approval.decidedBy ? [{ userId: approval.decidedBy, decision: approval.status === 'approved' ? 'approve' : 'reject', comment: approval.decisionComment || '', decidedAt: approval.decidedAt }] : [],
    status: approval.status === 'approved' ? 'approved' : approval.status === 'rejected' ? 'rejected' : 'pending'
  }];
}

function approvalStepConditionMatches(db, node, condition = null) {
  if (!condition || !Object.keys(condition).length) return true;
  const version = currentVersion(db, node);
  if (condition.securityLevels?.length && !condition.securityLevels.includes(node.securityLevel)) return false;
  if (condition.sensitive !== undefined && Boolean(condition.sensitive) !== Boolean(node.sensitive)) return false;
  if (condition.extensions?.length && !condition.extensions.includes(node.extension)) return false;
  if (condition.minSizeBytes && Number(version?.sizeBytes || 0) < Number(condition.minSizeBytes)) return false;
  if (condition.maxSizeBytes && Number(version?.sizeBytes || 0) > Number(condition.maxSizeBytes)) return false;
  return true;
}

function normalizeApprovalStepCondition(condition = {}) {
  const normalized = {};
  const securityLevels = (condition.securityLevels || []).filter((item) => SECURITY_LEVELS.includes(item));
  const extensions = normalizeExtensions(condition.extensions || []);
  if (securityLevels.length) normalized.securityLevels = securityLevels;
  if (extensions.length) normalized.extensions = extensions;
  if (condition.sensitive !== undefined && condition.sensitive !== null) normalized.sensitive = Boolean(condition.sensitive);
  if (Number(condition.minSizeBytes) > 0) normalized.minSizeBytes = Number(condition.minSizeBytes);
  if (Number(condition.maxSizeBytes) > 0) normalized.maxSizeBytes = Number(condition.maxSizeBytes);
  return normalized;
}

function normalizeApprovalSteps(db, payload = {}, node = null) {
  const source = Array.isArray(payload.steps) && payload.steps.length
    ? payload.steps
    : [{ name: '审批', mode: 'all', approverIds: [payload.approverId] }];
  const normalized = source.map((step, index) => {
    const approverIds = [...new Set((step.approverIds || [step.approverId]).map(String).filter(Boolean))];
    if (!approverIds.length || approverIds.some((id) => !db.users.some((user) => user.id === id && user.status === 'enabled'))) {
      throw createError(400, 'VALIDATION_ERROR', `第 ${index + 1} 个审批步骤包含无效审批人`);
    }
    return {
      id: newId('apstep_'),
      name: String(step.name || `第 ${index + 1} 级审批`).trim(),
      mode: step.mode === 'any' ? 'any' : 'all',
      approverIds,
      condition: normalizeApprovalStepCondition(step.condition),
      decisions: [],
      status: index === 0 ? 'pending' : 'waiting'
    };
  });
  const applicable = node ? normalized.filter((step) => approvalStepConditionMatches(db, node, step.condition)) : normalized;
  if (!applicable.length) throw createError(400, 'VALIDATION_ERROR', '当前文件没有匹配的审批步骤');
  return applicable.map((step, index) => ({ ...step, status: index === 0 ? 'pending' : 'waiting' }));
}

function normalizeApprovalTemplate(db, payload = {}, existing = null) {
  const type = ['workflow', 'download', 'permission', 'publish', 'borrow', 'external'].includes(payload.type)
    ? payload.type
    : existing?.type || 'download';
  const name = String(payload.name ?? existing?.name ?? '').trim();
  if (!name) throw createError(400, 'VALIDATION_ERROR', '请输入审批模板名称');
  const normalizedSteps = normalizeApprovalSteps(db, {
    steps: payload.steps ?? existing?.steps,
    approverId: payload.approverId ?? existing?.approverId
  });
  const steps = normalizedSteps.map(({ name: stepName, mode, approverIds, condition }) => ({
    name: stepName,
    mode,
    approverIds,
    condition
  }));
  const ccUserIds = [...new Set((payload.ccUserIds ?? existing?.ccUserIds ?? []).map(String).filter((id) => (
    db.users.some((user) => user.id === id && user.status === 'enabled')
  )))];
  const requestedActions = type === 'permission'
    ? normalizePermissionActions(payload.requestedActions ?? existing?.requestedActions ?? ['visible', 'file:preview'], ['visible', 'file:preview'])
    : [];
  return {
    name,
    description: String(payload.description ?? existing?.description ?? '').trim(),
    type,
    status: (payload.status ?? existing?.status) === 'disabled' ? 'disabled' : 'enabled',
    steps,
    ccUserIds,
    requestedActions,
    approvalTimeoutHours: Math.max(0, Math.min(Number(payload.approvalTimeoutHours ?? existing?.approvalTimeoutHours ?? 0), 24 * 365))
  };
}

function publicApprovalTemplate(db, template) {
  return {
    ...template,
    typeLabel: approvalTypeLabel(template.type),
    steps: (template.steps || []).map((step) => ({
      ...step,
      approverNames: (step.approverIds || []).map((id) => userDisplayName(db, id))
    })),
    ccUserNames: (template.ccUserIds || []).map((id) => userDisplayName(db, id))
  };
}

function notifyApprovalStep(db, approval, node) {
  const step = approvalSteps(approval)[approval.currentStepIndex || 0];
  if (!step) return;
  approval.approverId = step.approverIds[0] || approval.approverId;
  step.approverIds.forEach((userId) => addMessage(
    db,
    userId,
    `${approval.type || 'workflow'}.approval.request`,
    `${approvalTypeLabel(approval.type || 'workflow')}待处理`,
    `${userDisplayName(db, approval.requesterId)} 提交了“${node.fullPath}”的${approvalActionLabel(approval)}申请，当前步骤：${step.name}`,
    node.id
  ));
  (approval.ccUserIds || []).forEach((userId) => addMessage(db, userId, 'approval.cc', '审批抄送', `“${node.fullPath}”的${approvalActionLabel(approval)}流程进入${step.name}`, node.id));
}

function createApprovalRecord(db, user, node, payload = {}, req = null) {
  const type = ['workflow', 'download', 'permission', 'publish', 'borrow', 'external'].includes(payload.type) ? payload.type : 'workflow';
  const template = payload.templateId ? db.approvalTemplates.find((item) => item.id === payload.templateId && item.status === 'enabled') : null;
  if (payload.templateId && !template) throw createError(404, 'NOT_FOUND', '审批模板不存在或已停用');
  if (template && template.type !== type) throw createError(400, 'VALIDATION_ERROR', '审批模板与申请类型不匹配');
  const effectivePayload = template ? { ...template, ...payload, steps: payload.steps || template.steps, ccUserIds: payload.ccUserIds || template.ccUserIds } : payload;
  const fallbackApprover = defaultApprover(db, effectivePayload.approverId);
  const steps = normalizeApprovalSteps(db, { ...effectivePayload, approverId: effectivePayload.approverId || fallbackApprover?.id }, node);
  const timestamp = now();
  let action = payload.action || type;
  let requestedStatus = payload.requestedStatus || '';
  let requestedActions = [];
  if (type === 'workflow' || type === 'publish') {
    action = type === 'publish' ? 'publish' : action;
    const actionConfig = workflowActionConfig(action);
    requestedStatus = actionConfig.status;
  }
  if (type === 'permission') {
    requestedActions = normalizePermissionActions(effectivePayload.requestedActions || effectivePayload.actions || ['visible', 'file:preview'], ['visible', 'file:preview']);
  }
  if (type === 'borrow') requestedActions = ['visible', 'file:preview', 'file:download'];
  if (type === 'external') requestedActions = ['file:share_external'];
  const approval = {
    id: newId('appr_'),
    type,
    nodeId: node.id,
    action,
    requestedStatus,
    requestedActions,
    requesterId: user.id,
    approverId: steps[0].approverIds[0],
    steps,
    currentStepIndex: 0,
    templateId: template?.id || null,
    ccUserIds: [...new Set((effectivePayload.ccUserIds || []).map(String).filter((id) => db.users.some((userItem) => userItem.id === id && userItem.status === 'enabled')))],
    events: [],
    requestComment: String(payload.reason ?? payload.comment ?? '').trim(),
    decisionComment: '',
    status: 'pending',
    expiresAt: payload.expiresAt || null,
    dueAt: payload.dueAt || (Number(effectivePayload.approvalTimeoutHours || 0) > 0 ? new Date(Date.now() + Number(effectivePayload.approvalTimeoutHours) * 60 * 60 * 1000).toISOString() : null),
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.documentApprovals.unshift(approval);
  notifyApprovalStep(db, approval, node);
  addAudit(db, user.id, `${type}.approval.submit`, 'document_approval', approval.id, {
    targetPath: node.fullPath,
    type,
    action: approval.action,
    requestedActions,
    approverId: approval.approverId,
    stepCount: steps.length
  }, req);
  return approval;
}

function approvalDecisionMessage(db, approval, node, actor, approved) {
  const resultText = approved ? '已通过' : '已驳回';
  return `${userDisplayName(db, actor.id)} ${resultText}“${node.fullPath}”的${approvalActionLabel(approval)}申请${approval.decisionComment ? `：${approval.decisionComment}` : ''}`;
}

function currentApprovalStep(approval) {
  return approvalSteps(approval)[approval.currentStepIndex || 0] || null;
}

function canManageCurrentApprovalStep(user, approval) {
  const step = currentApprovalStep(approval);
  return Boolean(step && (isAdmin(user) || step.approverIds.includes(user.id)));
}

function recordApprovalEvent(approval, type, actorId, detail = {}) {
  approval.events = approval.events || [];
  approval.events.push({ id: newId('apevt_'), type, actorId, detail, createdAt: now() });
}

function finalizeApprovedApproval(db, approval, node, actor, comment, req) {
  approval.status = 'approved';
  approval.decisionComment = comment;
  approval.decidedBy = actor.id;
  approval.decidedAt = now();
  approval.updatedAt = now();
  let detail = { actionLabel: approvalActionLabel(approval) };
  if (['workflow', 'publish'].includes(approval.type || 'workflow')) {
    detail = applyWorkflowAction(db, node, actor.id, approval.action, comment, req, approval);
  }
  addMessage(db, approval.requesterId, `${approval.type || 'workflow'}.approval.approved`, `${approvalTypeLabel(approval.type || 'workflow')}已通过`, approvalDecisionMessage(db, approval, node, actor, true), node.id);
  recordApprovalEvent(approval, 'approved', actor.id, { comment });
  return detail;
}

function decideApprovalStep(db, approval, node, actor, decision, comment = '', req = null) {
  if (approval.status !== 'pending') throw createError(409, 'CONFLICT', '审批已处理');
  const steps = approvalSteps(approval);
  approval.steps = steps;
  const stepIndex = approval.currentStepIndex || 0;
  const step = steps[stepIndex];
  if (!step || (!isAdmin(actor) && !step.approverIds.includes(actor.id))) throw createError(403, 'FORBIDDEN', '只有当前步骤审批人可以处理');
  if ((step.decisions || []).some((item) => item.userId === actor.id)) throw createError(409, 'CONFLICT', '当前步骤已处理');
  step.decisions = step.decisions || [];
  step.decisions.push({ userId: actor.id, decision, comment, decidedAt: now() });
  recordApprovalEvent(approval, decision, actor.id, { stepId: step.id, stepName: step.name, comment });
  if (decision === 'reject') {
    step.status = 'rejected';
    approval.status = 'rejected';
    approval.decisionComment = comment;
    approval.decidedBy = actor.id;
    approval.decidedAt = now();
    approval.updatedAt = now();
    addMessage(db, approval.requesterId, `${approval.type || 'workflow'}.approval.rejected`, `${approvalTypeLabel(approval.type || 'workflow')}已驳回`, approvalDecisionMessage(db, approval, node, actor, false), node.id);
    return { completed: true, approved: false, detail: {} };
  }
  const approvedIds = new Set(step.decisions.filter((item) => item.decision === 'approve').map((item) => item.userId));
  const stepComplete = isAdmin(actor) || step.mode === 'any' || step.approverIds.every((id) => approvedIds.has(id));
  if (!stepComplete) {
    approval.updatedAt = now();
    return { completed: false, approved: false, detail: {} };
  }
  step.status = 'approved';
  if (stepIndex < steps.length - 1) {
    approval.currentStepIndex = stepIndex + 1;
    steps[approval.currentStepIndex].status = 'pending';
    approval.updatedAt = now();
    notifyApprovalStep(db, approval, node);
    return { completed: false, approved: false, detail: {} };
  }
  return { completed: true, approved: true, detail: finalizeApprovedApproval(db, approval, node, actor, comment, req) };
}

async function announcementAttachmentFromUpload(file) {
  if (!file) return null;
  const id = newId('ann_att_');
  const storageName = `${id}-${safeFilename(file.originalname)}`;
  await fs.rename(file.path, path.join(config.uploadDir, storageName));
  return {
    id,
    originalFilename: file.originalname,
    storageKey: storageName,
    mimeType: file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream',
    sizeBytes: file.size,
    createdAt: now()
  };
}

async function announcementAttachmentsFromUploads(files = []) {
  return Promise.all((files || []).map((file) => announcementAttachmentFromUpload(file)));
}

function notifyAnnouncementAudience(db, actor, announcement) {
  if (announcement.status !== 'published' || announcement.notifiedAt) return;
  collectAudienceUsers(db, announcement.audience)
    .filter((userId) => userId !== actor.id)
    .forEach((userId) => {
      addMessage(
        db,
        userId,
        'announcement.publish',
        `公告：${announcement.title}`,
        announcement.content,
        null
      );
    });
  announcement.notifiedAt = now();
}

function topLevelSelectedNodes(db, ids) {
  const selected = [...new Set(ids || [])]
    .map((id) => nodeById(db, id))
    .filter(Boolean);
  const selectedIds = new Set(selected.map((item) => item.id));
  return selected.filter((node) => !ancestors(db, node).some((parent) => selectedIds.has(parent.id)));
}

function applyNodeSpaceFromParent(db, node) {
  const parent = includeDeletedNodeById(db, node.parentId);
  node.spaceType = parent?.spaceType || (node.id === 'n_root' ? 'enterprise' : node.spaceType || 'enterprise');
  node.personalOwnerId = node.spaceType === 'personal' ? (parent?.personalOwnerId || node.personalOwnerId || node.ownerId) : null;
  descendants(db, node.id).forEach((child) => applyNodeSpaceFromParent(db, child));
}

function ensurePersonalRoot(db, user) {
  let root = db.nodes.find((item) => item.spaceType === 'personal' && item.personalOwnerId === user.id && item.status !== 'deleted' && !item.parentId);
  if (root) return root;
  const timestamp = now();
  root = {
    id: `n_personal_${user.id}`,
    parentId: null,
    nodeType: 'folder',
    name: '我的网盘',
    fullPath: '/我的网盘',
    extension: '',
    currentVersionId: null,
    ownerId: user.id,
    personalOwnerId: user.id,
    spaceType: 'personal',
    createdBy: user.id,
    updatedBy: user.id,
    lockedBy: null,
    lockedAt: null,
    status: 'normal',
    businessStatus: 'effective',
    securityLevel: 'internal',
    sensitive: false,
    sensitiveReason: '',
    securityUpdatedBy: null,
    securityUpdatedAt: null,
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null
  };
  db.nodes.push(root);
  return root;
}

function propertyValueFor(db, nodeId, propertyId, categoryId = null) {
  return db.propertyValues.find((item) => item.nodeId === nodeId && item.propertyId === propertyId && (item.categoryId || null) === (categoryId || null));
}

function attachmentPurposes(db) {
  db.settings = db.settings || {};
  db.settings.attachmentPurposes = Array.isArray(db.settings.attachmentPurposes) && db.settings.attachmentPurposes.length
    ? db.settings.attachmentPurposes
    : DEFAULT_ATTACHMENT_PURPOSES.map((item) => ({ ...item }));
  return db.settings.attachmentPurposes;
}

function normalizeAttachmentPurposes(input) {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set();
  const normalized = rows.map((item) => {
    const code = String(item.code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40);
    const name = String(item.name || '').trim().slice(0, 40);
    if (!code || !name || seen.has(code)) throw createError(400, 'VALIDATION_ERROR', '附件用途编码和名称不能为空，编码不能重复');
    seen.add(code);
    return { code, name, enabled: item.enabled !== false };
  });
  if (!normalized.some((item) => item.enabled)) throw createError(400, 'VALIDATION_ERROR', '至少保留一个启用的附件用途');
  return normalized;
}

function normalizeIdentitySettings(input = {}, existing = DEFAULT_IDENTITY_SETTINGS) {
  const merge = (name) => ({ ...DEFAULT_IDENTITY_SETTINGS[name], ...(existing?.[name] || {}), ...(input?.[name] || {}) });
  const oidc = merge('oidc');
  const saml = merge('saml');
  const ldap = merge('ldap');
  const hr = merge('hr');
  return {
    oidc: {
      enabled: normalizeBoolean(oidc.enabled), issuer: String(oidc.issuer || '').trim().replace(/\/+$/, ''), clientId: String(oidc.clientId || '').trim(),
      clientSecret: String(input?.oidc?.clientSecret || '') || String(existing?.oidc?.clientSecret || ''), redirectUri: String(oidc.redirectUri || '').trim(), scopes: String(oidc.scopes || 'openid profile email').trim(),
      usernameClaim: String(oidc.usernameClaim || 'preferred_username').trim(), displayNameClaim: String(oidc.displayNameClaim || 'name').trim(), emailClaim: String(oidc.emailClaim || 'email').trim(), autoProvision: normalizeBoolean(oidc.autoProvision)
    },
    saml: {
      enabled: normalizeBoolean(saml.enabled), entryPoint: String(saml.entryPoint || '').trim(), issuer: String(saml.issuer || 'document-platform').trim(), callbackUrl: String(saml.callbackUrl || '').trim(),
      idpCert: String(input?.saml?.idpCert || '') || String(existing?.saml?.idpCert || ''), usernameAttribute: String(saml.usernameAttribute || 'nameID').trim(), displayNameAttribute: String(saml.displayNameAttribute || 'displayName').trim(),
      emailAttribute: String(saml.emailAttribute || 'email').trim(), autoProvision: normalizeBoolean(saml.autoProvision)
    },
    ldap: {
      enabled: normalizeBoolean(ldap.enabled), url: String(ldap.url || '').trim(), bindDn: String(ldap.bindDn || '').trim(), bindPassword: String(input?.ldap?.bindPassword || '') || String(existing?.ldap?.bindPassword || ''),
      baseDn: String(ldap.baseDn || '').trim(), userFilter: String(ldap.userFilter || '(objectClass=person)').trim(), usernameAttribute: String(ldap.usernameAttribute || 'sAMAccountName').trim(),
      displayNameAttribute: String(ldap.displayNameAttribute || 'displayName').trim(), emailAttribute: String(ldap.emailAttribute || 'mail').trim(), departmentAttribute: String(ldap.departmentAttribute || 'department').trim(), syncUsers: normalizeBoolean(ldap.syncUsers, true)
    },
    hr: { enabled: normalizeBoolean(hr.enabled), syncSecret: String(input?.hr?.syncSecret || '') || String(existing?.hr?.syncSecret || ''), autoDisableMissing: normalizeBoolean(hr.autoDisableMissing) }
  };
}

function sanitizeIdentitySettings(settings = {}) {
  const normalized = normalizeIdentitySettings(settings, settings);
  return {
    oidc: { ...normalized.oidc, clientSecret: undefined, hasClientSecret: Boolean(normalized.oidc.clientSecret) },
    saml: { ...normalized.saml, idpCert: undefined, hasIdpCert: Boolean(normalized.saml.idpCert) },
    ldap: { ...normalized.ldap, bindPassword: undefined, hasBindPassword: Boolean(normalized.ldap.bindPassword) },
    hr: { ...normalized.hr, syncSecret: undefined, hasSyncSecret: Boolean(normalized.hr.syncSecret) }
  };
}

function currentIdentitySettings(db) {
  db.settings = db.settings || {};
  db.settings.identity = normalizeIdentitySettings(db.settings.identity || {});
  return db.settings.identity;
}

function externalIdentityUser(db, { provider, externalId, username, displayName, email, autoProvision }) {
  const identityKey = `${provider}:${externalId}`;
  let user = db.users.find((item) => (item.externalIdentities || []).includes(identityKey));
  if (!user && username) user = db.users.find((item) => item.username === username);
  if (!user && !autoProvision) throw createError(403, 'EXTERNAL_USER_NOT_PROVISIONED', '外部身份尚未映射到平台用户');
  if (!user) {
    const hp = hashPassword(crypto.randomBytes(32).toString('base64url'));
    user = {
      id: newId('u_'), username: validateName(username || `${provider}_${externalId}`), displayName: displayName || username || externalId,
      passwordHash: hp.hash, passwordSalt: hp.salt, email: email || '', phone: '', avatarUrl: '', status: 'enabled', departmentIds: [], roleIds: ['r_employee'],
      sourceType: provider, externalIdentities: [identityKey], lastLoginAt: null, failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null, createdAt: now(), updatedAt: now()
    };
    db.users.push(user);
  } else {
    user.externalIdentities = [...new Set([...(user.externalIdentities || []), identityKey])];
    user.displayName = displayName || user.displayName;
    user.email = email || user.email;
    user.updatedAt = now();
  }
  if (user.status !== 'enabled') throw createError(403, 'FORBIDDEN', '账号已被禁用');
  return user;
}

function encodeIdentityState(provider, redirectUri = '') {
  const payload = Buffer.from(JSON.stringify({ provider, redirectUri, nonce: crypto.randomBytes(12).toString('hex'), expiresAt: Date.now() + 10 * 60 * 1000 })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('base64url')}`;
}

function verifyIdentityState(state, provider) {
  const [payload, signature] = String(state || '').split('.');
  if (!payload || !signature) throw createError(400, 'VALIDATION_ERROR', '身份登录 state 无效');
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw createError(400, 'VALIDATION_ERROR', '身份登录 state 校验失败');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (decoded.provider !== provider || decoded.expiresAt < Date.now()) throw createError(400, 'VALIDATION_ERROR', '身份登录请求无效或已过期');
  return decoded;
}

async function oidcDiscovery(settings) {
  const response = await fetch(`${settings.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw createError(502, 'OIDC_DISCOVERY_FAILED', `OIDC 发现失败（HTTP ${response.status}）`);
  return response.json();
}

function samlClient(settings) {
  return new SAML({
    entryPoint: settings.entryPoint, issuer: settings.issuer, callbackUrl: settings.callbackUrl,
    idpCert: settings.idpCert, wantAssertionsSigned: true, wantAuthnResponseSigned: true,
    disableRequestAcsUrl: false, acceptedClockSkewMs: 120000
  });
}

function normalizeFileStorageSettings(input = {}, existing = DEFAULT_FILE_STORAGE_SETTINGS) {
  const s3 = { ...DEFAULT_FILE_STORAGE_SETTINGS.s3, ...(existing.s3 || {}), ...(input.s3 || {}) };
  const quota = { ...DEFAULT_FILE_STORAGE_SETTINGS.quota, ...(existing.quota || {}), ...(input.quota || {}) };
  const lifecycle = { ...DEFAULT_FILE_STORAGE_SETTINGS.lifecycle, ...(existing.lifecycle || {}), ...(input.lifecycle || {}) };
  const provider = ['local', 'nas', 's3'].includes(input.provider ?? existing.provider) ? (input.provider ?? existing.provider) : 'local';
  return {
    provider,
    nasRoot: String(input.nasRoot ?? existing.nasRoot ?? '').trim(),
    s3: {
      endpoint: String(s3.endpoint || '').trim().replace(/\/+$/, ''), region: String(s3.region || 'us-east-1').trim(), bucket: String(s3.bucket || '').trim(),
      accessKeyId: String(input.s3?.accessKeyId || '') || String(existing.s3?.accessKeyId || ''),
      secretAccessKey: String(input.s3?.secretAccessKey || '') || String(existing.s3?.secretAccessKey || ''), forcePathStyle: normalizeBoolean(s3.forcePathStyle, true)
    },
    quota: {
      totalGb: Math.max(0, Number(quota.totalGb || 0)), defaultUserGb: Math.max(0, Number(quota.defaultUserGb || 0)),
      userLimitsGb: Object.fromEntries(Object.entries(quota.userLimitsGb || {}).map(([key, value]) => [key, Math.max(0, Number(value || 0))]))
    },
    lifecycle: {
      uploadSessionDays: Math.max(1, Number(lifecycle.uploadSessionDays || 7)), quarantineDays: Math.max(1, Number(lifecycle.quarantineDays || 30)),
      historicalVersionDays: Math.max(0, Number(lifecycle.historicalVersionDays || 0)), keepLatestVersions: Math.max(1, Number(lifecycle.keepLatestVersions || 3))
    },
    updatedAt: input.updatedAt ?? existing.updatedAt ?? null,
    updatedBy: input.updatedBy ?? existing.updatedBy ?? null
  };
}

function currentFileStorageSettings(db) {
  db.settings = db.settings || {};
  db.settings.fileStorage = normalizeFileStorageSettings(db.settings.fileStorage || {});
  return db.settings.fileStorage;
}

function sanitizeFileStorageSettings(settings = {}) {
  const normalized = normalizeFileStorageSettings(settings, settings);
  return { ...normalized, s3: { ...normalized.s3, accessKeyId: '', secretAccessKey: '', hasAccessKeyId: Boolean(normalized.s3.accessKeyId), hasSecretAccessKey: Boolean(normalized.s3.secretAccessKey) } };
}

function s3ClientFor(settings) {
  return new S3Client({ endpoint: settings.endpoint || undefined, region: settings.region, forcePathStyle: settings.forcePathStyle, credentials: settings.accessKeyId ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey } : undefined });
}

function storageUsage(db, userId = null) {
  const versions = db.versions.filter((item) => (item.storageType || 'local') !== 'external' && (!userId || item.createdBy === userId));
  return versions.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
}

function enforceStorageQuota(db, userId, incomingBytes) {
  const quota = currentFileStorageSettings(db).quota;
  const gib = 1024 ** 3;
  if (quota.totalGb > 0 && storageUsage(db) + incomingBytes > quota.totalGb * gib) throw createError(413, 'STORAGE_QUOTA_EXCEEDED', '平台总容量配额不足');
  const userLimitGb = Number(quota.userLimitsGb?.[userId] ?? quota.defaultUserGb ?? 0);
  if (userLimitGb > 0 && storageUsage(db, userId) + incomingBytes > userLimitGb * gib) throw createError(413, 'USER_STORAGE_QUOTA_EXCEEDED', '个人容量配额不足');
}

async function replicateVersionToConfiguredStorage(db, version, localPath) {
  const settings = currentFileStorageSettings(db);
  if (settings.provider === 'local') return version;
  if (settings.provider === 'nas') {
    if (!settings.nasRoot) throw createError(503, 'NAS_NOT_CONFIGURED', 'NAS 根目录未配置');
    await ensureDir(settings.nasRoot);
    const targetPath = path.join(path.resolve(settings.nasRoot), path.basename(version.storageKey));
    await fs.copyFile(localPath, targetPath);
    version.storageType = 'nas';
    version.nasPath = targetPath;
    return version;
  }
  if (!settings.s3.bucket) throw createError(503, 'S3_NOT_CONFIGURED', 'S3 Bucket 未配置');
  const key = `versions/${version.id}/${safeFilename(version.originalFilename)}`;
  await s3ClientFor(settings.s3).send(new PutObjectCommand({ Bucket: settings.s3.bucket, Key: key, Body: fsSync.createReadStream(localPath), ContentType: version.mimeType }));
  version.storageType = 's3';
  version.s3Bucket = settings.s3.bucket;
  version.s3Key = key;
  return version;
}

async function ensureVersionLocalPath(db, version, node = null) {
  const localPath = path.join(config.uploadDir, version.storageKey || '');
  if (fsSync.existsSync(localPath)) return localPath;
  if (version.storageType === 'nas' && version.nasPath && fsSync.existsSync(version.nasPath)) {
    await fs.copyFile(version.nasPath, localPath);
    return localPath;
  }
  if (version.storageType === 's3' && version.s3Key) {
    const settings = currentFileStorageSettings(db).s3;
    const response = await s3ClientFor(settings).send(new GetObjectCommand({ Bucket: version.s3Bucket || settings.bucket, Key: version.s3Key }));
    await ensureDir(path.dirname(localPath));
    const output = fsSync.createWriteStream(localPath);
    await new Promise((resolve, reject) => { response.Body.pipe(output).on('finish', resolve).on('error', reject); });
    return localPath;
  }
  return versionFilePath(version, node, db);
}

async function deleteVersionStorage(db, version) {
  await fs.rm(path.join(config.uploadDir, version.storageKey || ''), { force: true }).catch(() => {});
  if (version.storageType === 'nas' && version.nasPath) await fs.rm(version.nasPath, { force: true }).catch(() => {});
  if (version.storageType === 's3' && version.s3Key) {
    const settings = currentFileStorageSettings(db).s3;
    await s3ClientFor(settings).send(new DeleteObjectCommand({ Bucket: version.s3Bucket || settings.bucket, Key: version.s3Key })).catch(() => {});
  }
}

async function runStorageLifecycle(db, actorId, req = null) {
  const settings = currentFileStorageSettings(db).lifecycle;
  const current = Date.now();
  let expiredSessions = 0;
  let expiredQuarantine = 0;
  let expiredVersions = 0;
  for (const session of db.uploadSessions.filter((item) => item.status !== 'completed' && new Date(item.updatedAt || item.createdAt).getTime() < current - settings.uploadSessionDays * 86400000)) {
    session.status = 'expired';
    await fs.rm(path.join(config.tmpDir, session.id), { recursive: true, force: true });
    expiredSessions += 1;
  }
  for (const item of db.quarantineItems.filter((entry) => entry.status === 'quarantined' && new Date(entry.createdAt).getTime() < current - settings.quarantineDays * 86400000)) {
    await fs.rm(path.join(config.quarantineDir, item.storageKey), { force: true });
    item.status = 'expired_deleted';
    item.deletedAt = now();
    expiredQuarantine += 1;
  }
  if (settings.historicalVersionDays > 0) {
    for (const node of db.nodes.filter((item) => item.nodeType === 'file')) {
      const versions = db.versions.filter((item) => item.nodeId === node.id).sort((a, b) => b.versionNo - a.versionNo);
      for (const version of versions.slice(settings.keepLatestVersions).filter((item) => item.id !== node.currentVersionId && new Date(item.createdAt).getTime() < current - settings.historicalVersionDays * 86400000)) {
        await deleteVersionStorage(db, version);
        db.versions = db.versions.filter((item) => item.id !== version.id);
        expiredVersions += 1;
      }
    }
  }
  const result = { expiredSessions, expiredQuarantine, expiredVersions, completedAt: now() };
  addAudit(db, actorId, 'system.storage.lifecycle', 'system_setting', 'file_storage', result, req);
  return result;
}

function nextReminderTime(reminder) {
  const base = new Date(reminder.triggerAt).getTime();
  const intervalDays = Number(reminder.intervalDays || 0);
  if (intervalDays > 0) return new Date(base + intervalDays * 24 * 60 * 60 * 1000).toISOString();
  if (reminder.cycle === 'daily') return new Date(base + 24 * 60 * 60 * 1000).toISOString();
  if (reminder.cycle === 'weekly') return new Date(base + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (reminder.cycle === 'monthly') return new Date(base + 30 * 24 * 60 * 60 * 1000).toISOString();
  return null;
}

function dispatchDueReminders(db, userId) {
  const current = Date.now();
  (db.reminders || [])
    .filter((reminder) => reminder.userId === userId && reminder.status === 'active')
    .filter((reminder) => reminder.triggerAt && new Date(reminder.triggerAt).getTime() <= current)
    .forEach((reminder) => {
      const node = includeDeletedNodeById(db, reminder.nodeId);
      addMessage(
        db,
        userId,
        'reminder.due',
        '文件闹钟提醒',
        `${reminder.remark || '请处理文件'}：${node?.fullPath || reminder.nodeId}`,
        reminder.nodeId
      );
      reminder.lastTriggeredAt = now();
      const nextTime = nextReminderTime(reminder);
      if (nextTime && (!reminder.endAt || new Date(nextTime).getTime() <= new Date(reminder.endAt).getTime())) {
        reminder.triggerAt = nextTime;
      } else {
        reminder.status = 'done';
      }
      reminder.updatedAt = now();
    });
}

function dispatchOperationalReminders(db) {
  const current = Date.now();
  (db.documentApprovals || []).filter((approval) => approval.status === 'pending' && approval.dueAt).forEach((approval) => {
    const dueTime = new Date(approval.dueAt).getTime();
    if (!Number.isFinite(dueTime)) return;
    const step = currentApprovalStep(approval);
    const node = includeDeletedNodeById(db, approval.nodeId);
    if (dueTime <= current && !approval.overdueNotifiedAt) {
      (step?.approverIds || []).forEach((userId) => addMessage(db, userId, 'approval.overdue', '审批已超时', `“${node?.fullPath || approval.nodeId}”的${approvalActionLabel(approval)}申请已超过处理时限`, approval.nodeId));
      addMessage(db, approval.requesterId, 'approval.overdue.requester', '审批处理超时', `“${node?.fullPath || approval.nodeId}”的${approvalActionLabel(approval)}申请仍待处理`, approval.nodeId);
      approval.overdueNotifiedAt = now();
    } else if (dueTime > current && dueTime - current <= 24 * 60 * 60 * 1000 && !approval.dueSoonNotifiedAt) {
      (step?.approverIds || []).forEach((userId) => addMessage(db, userId, 'approval.due_soon', '审批即将超时', `请在 ${approval.dueAt.slice(0, 16).replace('T', ' ')} 前处理“${node?.fullPath || approval.nodeId}”`, approval.nodeId));
      approval.dueSoonNotifiedAt = now();
    }
  });
  (db.nodes || []).filter((node) => node.nodeType === 'file' && node.reviewEnabled && node.reviewOwnerId && node.nextReviewAt).forEach((node) => {
    const reviewTime = new Date(node.nextReviewAt).getTime();
    if (!Number.isFinite(reviewTime)) return;
    if (reviewTime <= current && !node.reviewOverdueNotifiedAt) {
      addMessage(db, node.reviewOwnerId, 'document.review.overdue', '文档复审已逾期', `“${node.fullPath}”的复审日期已过，请尽快处理`, node.id);
      node.reviewOverdueNotifiedAt = now();
    } else if (reviewTime > current && reviewTime - current <= 7 * 24 * 60 * 60 * 1000 && !node.reviewDueSoonNotifiedAt) {
      addMessage(db, node.reviewOwnerId, 'document.review.due_soon', '文档即将复审', `“${node.fullPath}”将在 ${node.nextReviewAt.slice(0, 10)} 到期复审`, node.id);
      node.reviewDueSoonNotifiedAt = now();
    }
  });
}

function openApiDocument() {
  const endpoint = (summary, method = 'get') => ({
    [method]: {
      summary,
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      responses: { 200: { description: 'OK' } }
    }
  });
  const document = {
    openapi: '3.0.3',
    info: {
      title: '文档管理平台 API',
      version: '1.0.0-rc.1',
      description: '文档管理平台 REST API，支持 JWT 和 AccessKey/Secret 鉴权。'
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Access-Key',
          description: '需同时传 X-Access-Secret'
        }
      },
      schemas: {
        ApiResponse: {
          type: 'object', required: ['code', 'message'],
          properties: { code: { type: 'string', example: 'OK' }, message: { type: 'string', example: 'success' }, data: { nullable: true } }
        },
        ApiError: {
          type: 'object', required: ['code', 'message'],
          properties: { code: { type: 'string', example: 'VALIDATION_ERROR' }, message: { type: 'string', example: '请求参数不正确' }, data: { nullable: true } }
        },
        User: {
          type: 'object', required: ['id', 'username', 'displayName', 'status'],
          properties: {
            id: { type: 'string', example: 'u_admin' }, username: { type: 'string', example: 'admin' }, displayName: { type: 'string', example: '系统管理员' },
            email: { type: 'string' }, phone: { type: 'string' }, status: { type: 'string', enum: ['enabled', 'disabled'] },
            departmentIds: { type: 'array', items: { type: 'string' } }, roleIds: { type: 'array', items: { type: 'string' } }, avatarUrl: { type: 'string' }, defaultWorkPathId: { type: 'string', nullable: true }
          }
        },
        Node: {
          type: 'object', required: ['id', 'nodeType', 'name', 'fullPath'],
          properties: {
            id: { type: 'string', example: 'n_root' }, parentId: { type: 'string', nullable: true }, nodeType: { type: 'string', enum: ['file', 'folder'] },
            name: { type: 'string' }, fullPath: { type: 'string' }, extension: { type: 'string' }, status: { type: 'string' }, businessStatus: { type: 'string' },
            permissions: { type: 'array', items: { type: 'string' } }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        Page: {
          type: 'object', required: ['items', 'page', 'pageSize', 'total'],
          properties: { items: { type: 'array', items: {} }, page: { type: 'integer', example: 1 }, pageSize: { type: 'integer', example: 20 }, total: { type: 'integer', example: 1 } }
        },
        WebhookEvent: {
          type: 'object', required: ['id', 'type', 'occurredAt', 'data'],
          properties: { id: { type: 'string' }, type: { type: 'string', example: 'file.upload' }, occurredAt: { type: 'string', format: 'date-time' }, data: { type: 'object' } },
          example: { id: 'evt_audit_123', type: 'file.upload', occurredAt: '2026-07-11T10:00:00.000Z', data: { actorId: 'u_admin', targetType: 'node', targetId: 'n_123', targetPath: '/质量手册.docx' } }
        }
      },
      responses: {
        Success: { description: '请求成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiResponse' } } } },
        BadRequest: { description: '请求参数错误', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        Unauthorized: { description: '未登录或凭证无效', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        Forbidden: { description: '权限不足', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        NotFound: { description: '资源不存在', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        Conflict: { description: '资源状态冲突', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } }
      }
    },
    paths: {
      '/auth/captcha': endpoint('获取登录验证码'),
      '/auth/login': endpoint('账号密码登录', 'post'),
      '/auth/me': endpoint('查询当前用户'),
      '/nodes/tree': endpoint('企业文档库目录树'),
      '/personal-drive/tree': endpoint('个人网盘目录树'),
      '/personal-drive/summary': endpoint('个人网盘空间概况'),
      '/personal-drive/trash': endpoint('个人网盘回收站'),
      '/personal-drive/logs': endpoint('个人网盘操作记录'),
      '/nodes/{id}/children': endpoint('查询目录子节点'),
      '/folders': endpoint('创建文件夹', 'post'),
      '/files': endpoint('上传文件', 'post'),
      '/files/office': endpoint('在线新建 Word/Excel/PPT', 'post'),
      '/files/{id}/export-pdf': endpoint('导出带水印 PDF'),
      '/files/{id}/print': endpoint('打印文件或历史版本'),
      '/profile': endpoint('个人资料'),
      '/profile/avatar': endpoint('上传个人头像', 'post'),
      '/public/avatars/{userId}': endpoint('读取用户头像'),
      '/nodes/{id}/external-links': endpoint('创建文件外链', 'post'),
      '/external-links': endpoint('外链管理'),
      '/external-links/{id}/revoke': endpoint('撤销外链', 'patch'),
      '/public/external-links/{token}': endpoint('外链公开信息'),
      '/public/external-links/{token}/access': endpoint('验证并访问外链', 'post'),
      '/public/external-links/{token}/content': endpoint('外链预览内容'),
      '/public/external-links/{token}/download': endpoint('外链下载'),
      '/files/{id}/versions': endpoint('版本列表/上传新版本'),
      '/files/{id}/versions/{versionId}': endpoint('删除非当前历史版本', 'delete'),
      '/files/{id}/version-logs': endpoint('版本变更记录'),
      '/files/{id}/download': endpoint('文件下载'),
      '/files/{id}/preview': endpoint('文件预览'),
      '/files/{id}/office-edit-session': endpoint('查询/发起 Office 在线编辑会话', 'post'),
      '/files/{id}/office-edit-session/close': endpoint('关闭 Office 在线编辑会话', 'post'),
      '/files/{id}/read-upload-messages': endpoint('标记文件上传消息已读', 'post'),
      '/files/batch-download': endpoint('批量打包下载', 'post'),
      '/nodes/batch-move': endpoint('批量移动', 'post'),
      '/nodes/batch-delete': endpoint('批量删除', 'post'),
      '/search/files': endpoint('文件搜索', 'post'),
      '/search/suggestions': endpoint('搜索建议'),
      '/search/recent': endpoint('个人最近搜索'),
      '/search/index/status': endpoint('全文检索索引状态'),
      '/search/index/rebuild': endpoint('重建全文检索索引', 'post'),
      '/governance/workspace': endpoint('知识治理聚合工作台'),
      '/governance/dashboard': endpoint('知识治理工作台'),
      '/governance/quality': endpoint('文档质量清单'),
      '/governance/duplicates': endpoint('重复文件检测'),
      '/governance/reviews': endpoint('文档复审清单'),
      '/governance/search-analytics': endpoint('搜索运营分析'),
      '/nodes/{id}/quality': endpoint('文档质量详情'),
      '/nodes/{id}/review': endpoint('文档复审配置'),
      '/nodes/{id}/review/complete': endpoint('完成文档复审', 'post'),
      '/nodes/{id}/review-history': endpoint('文档复审历史'),
      '/categories/tree': endpoint('分类树'),
      '/categories/{id}/files': endpoint('分类文件列表'),
      '/permission-templates': endpoint('权限模板列表/新增'),
      '/permission-templates/{id}': endpoint('权限模板修改/删除'),
      '/approval-templates': endpoint('审批模板列表/新增'),
      '/approval-templates/{id}': endpoint('审批模板修改/删除'),
      '/nodes/{id}/permission-rules': endpoint('权限规则列表/新增'),
      '/nodes/{id}/permission-rules/batch': endpoint('批量套用权限模板', 'post'),
      '/permission-rules/{id}': endpoint('权限规则修改/删除'),
      '/nodes/{id}/view-access': endpoint('可查看范围设置'),
      '/nodes/{id}/password': endpoint('文件或文件夹加密设置', 'put'),
      '/nodes/{id}/security': endpoint('文件安全信息设置', 'put'),
      '/nodes/batch-metadata': endpoint('批量属性编辑', 'put'),
      '/nodes/{id}/workflow': endpoint('文档流程概览'),
      '/nodes/{id}/workflow-actions': endpoint('执行发布/作废/归档', 'post'),
      '/nodes/{id}/approvals': endpoint('提交文档审批', 'post'),
      '/approvals': endpoint('审批列表'),
      '/approvals/{id}': endpoint('审批详情'),
      '/approvals/{id}/approve': endpoint('审批通过', 'post'),
      '/approvals/{id}/reject': endpoint('审批驳回', 'post'),
      '/external-library/sync': endpoint('同步服务器文档目录', 'post'),
      '/external-library/sync-status': endpoint('同步状态'),
      '/external-library/sync-jobs': endpoint('同步日志'),
      '/messages': endpoint('消息列表'),
      '/announcements': endpoint('公告列表/新增'),
      '/api-credentials': endpoint('API 凭证列表/新增'),
      '/api-call-logs': endpoint('API 调用日志'),
      '/sso/tickets': endpoint('创建一次性登录票据', 'post'),
      '/sso/consume': endpoint('消费一次性登录票据'),
      '/audit-logs': endpoint('审计日志'),
      '/audit-logs/report': endpoint('审计统计报表'),
      '/recent-access': endpoint('最近访问'),
      '/system/runtime-status': endpoint('系统运行与备份状态'),
      '/system/consistency': endpoint('数据与文件一致性检查'),
      '/system/backups': endpoint('备份任务列表/创建备份'),
      '/system/alerts': endpoint('系统告警列表'),
      '/notifications/deliveries': endpoint('通知投递记录'),
      '/system-settings/file-policy': endpoint('文件上传策略'),
      '/system-settings/security-policy': endpoint('文件安全策略'),
      '/system-settings/external-library': endpoint('服务器文档目录设置'),
      '/system-settings/office-preview': endpoint('Office 在线预览配置'),
      '/system-settings/office-preview/test': endpoint('测试 Office 在线预览配置', 'post'),
      '/system-settings/wecom': endpoint('企业微信配置'),
      '/system-settings/wecom/test': endpoint('测试企业微信配置', 'post'),
      '/system-settings/wecom/sync': endpoint('同步企业微信通讯录', 'post'),
      '/system-settings/wecom/sync-jobs': endpoint('企业微信同步日志'),
      '/system-settings/storage': endpoint('数据存储配置'),
      '/system-settings/storage/test': endpoint('测试 MySQL 连接', 'post'),
      '/system-settings/storage/sync': endpoint('同步当前账本到 MySQL', 'post'),
      '/wecom/auth/config': endpoint('企业微信登录公开配置'),
      '/wecom/auth/url': endpoint('生成企业微信 OAuth 地址'),
      '/wecom/auth/callback': endpoint('企业微信免登回调'),
      '/webhooks': endpoint('Webhook 订阅列表/新增'),
      '/webhooks/{id}': endpoint('Webhook 修改/停用'),
      '/webhook-deliveries': endpoint('Webhook 投递记录'),
      '/webhook-deliveries/{id}/retry': endpoint('重试 Webhook 投递', 'post')
    }
  };
  const publicPaths = new Set(['/health', '/openapi.json', '/auth/captcha', '/auth/login', '/sso/consume', '/wecom/auth/config', '/wecom/auth/url', '/wecom/auth/callback']);
  const existingSummaries = new Map(Object.entries(document.paths).flatMap(([pathName, operations]) => Object.entries(operations).map(([method, operation]) => [`${method}:${pathName}`, operation.summary])));
  const routeLayers = app?._router?.stack?.filter((layer) => layer.route && typeof layer.route.path === 'string') || [];
  routeLayers.forEach((layer) => {
    if (!layer.route.path.startsWith('/api/v1')) return;
    const pathName = layer.route.path.slice('/api/v1'.length).replace(/:([A-Za-z0-9_]+)/g, '{$1}') || '/';
    document.paths[pathName] = document.paths[pathName] || {};
    Object.keys(layer.route.methods).filter((method) => layer.route.methods[method]).forEach((method) => {
      const pathParameters = [...pathName.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }));
      const parameters = [...pathParameters];
      if (method === 'get') parameters.push(
        { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 20 } }
      );
      const operation = {
        summary: existingSummaries.get(`${method}:${pathName}`) || existingSummaries.get(`get:${pathName}`) || `${method.toUpperCase()} ${pathName}`,
        operationId: `${method}_${pathName.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'}`,
        tags: [pathName.split('/').filter(Boolean)[0] || 'system'],
        parameters,
        responses: {
          200: { $ref: '#/components/responses/Success' }, 400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' }, 409: { $ref: '#/components/responses/Conflict' }
        }
      };
      if (!publicPaths.has(pathName)) operation.security = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
      if (['post', 'put', 'patch'].includes(method)) {
        operation.requestBody = {
          required: false,
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: true }, example: {} },
            'multipart/form-data': { schema: { type: 'object', additionalProperties: true } }
          }
        };
      }
      document.paths[pathName][method] = operation;
    });
  });
  document['x-generated-from-express-routes'] = true;
  return document;
}

app.get('/api/v1/health', (_req, res) => {
  res.json(ok({ status: 'up', time: now() }));
});

app.get('/api/v1/openapi.json', (_req, res) => {
  res.json(openApiDocument());
});

app.post('/api/v1/dev/reset', asyncRoute(async (_req, res) => {
  const db = await resetDb();
  captchaStore.clear();
  apiRateBuckets.clear();
  res.json(ok({ users: db.users.length, nodes: db.nodes.length }));
}));

app.get('/api/v1/auth/captcha', (_req, res) => {
  res.json(ok(createCaptcha()));
});

app.post('/api/v1/auth/login', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const username = String(req.body.username || '').trim();
  const { password } = req.body;
  validateCaptcha(req.body.captchaId, req.body.captchaAnswer);
  const user = db.users.find((item) => item.username === username && item.status === 'enabled');
  if (!user) {
    addAudit(db, null, 'auth.login_failed', 'user', username || 'unknown', { username, reason: 'user_not_found' }, req);
    await saveDb(db);
    throw createError(401, 'UNAUTHORIZED', '用户名或密码错误');
  }
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    addAudit(db, user.id, 'auth.login_blocked', 'user', user.id, { username, lockedUntil: user.lockedUntil }, req);
    await saveDb(db);
    throw createError(423, 'ACCOUNT_LOCKED', `密码错误次数过多，账号已临时锁定至 ${new Date(user.lockedUntil).toLocaleString('zh-CN', { hour12: false })}`);
  }
  if (!verifyPassword(password, user)) {
    user.failedLoginCount = Number(user.failedLoginCount || 0) + 1;
    user.lastFailedLoginAt = now();
    if (user.failedLoginCount >= LOGIN_FAILURE_LIMIT) {
      user.lockedUntil = new Date(Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000).toISOString();
    }
    addAudit(db, user.id, 'auth.login_failed', 'user', user.id, {
      username,
      reason: 'bad_password',
      failedLoginCount: user.failedLoginCount,
      lockedUntil: user.lockedUntil || null
    }, req);
    await saveDb(db);
    if (user.lockedUntil) throw createError(423, 'ACCOUNT_LOCKED', `密码错误次数过多，账号已临时锁定 ${LOGIN_LOCK_MINUTES} 分钟`);
    throw createError(401, 'UNAUTHORIZED', '用户名或密码错误');
  }
  user.lastLoginAt = now();
  user.failedLoginCount = 0;
  user.lastFailedLoginAt = null;
  user.lockedUntil = null;
  addAudit(db, user.id, 'auth.login', 'user', user.id, { username }, req);
  await saveDb(db);
  res.json(ok({ token: signToken({ userId: user.id }), user: pickPublicUser(user) }));
}));

app.post('/api/v1/auth/logout', requireAuth, asyncRoute(async (req, res) => {
  addAudit(req.db, req.user.id, 'auth.logout', 'user', req.user.id, {}, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/auth/me', requireAuth, (req, res) => {
  res.json(ok({ user: pickPublicUser(req.user), actions: ACTIONS }));
});

app.post('/api/v1/auth/change-password', requireAuth, asyncRoute(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!verifyPassword(oldPassword, req.user)) throw createError(400, 'VALIDATION_ERROR', '旧密码不正确');
  const validPassword = validatePasswordPolicy(newPassword);
  const hp = hashPassword(validPassword);
  req.user.passwordHash = hp.hash;
  req.user.passwordSalt = hp.salt;
  req.user.updatedAt = now();
  addAudit(req.db, req.user.id, 'user.change_password', 'user', req.user.id, {}, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/profile', requireAuth, (req, res) => {
  res.json(ok(pickPublicUser(req.user)));
});

app.put('/api/v1/profile', requireAuth, asyncRoute(async (req, res) => {
  const displayName = String(req.body.displayName ?? req.user.displayName ?? '').trim();
  if (!displayName) throw createError(400, 'VALIDATION_ERROR', '姓名不能为空');
  const defaultWorkPathId = req.body.defaultWorkPathId || null;
  if (defaultWorkPathId) {
    const folder = nodeById(req.db, defaultWorkPathId);
    if (!folder || folder.nodeType !== 'folder' || !hasAction(req.db, req.user, folder, 'visible')) {
      throw createError(400, 'VALIDATION_ERROR', '默认工作目录不存在或无权访问');
    }
  }
  Object.assign(req.user, {
    displayName,
    email: String(req.body.email ?? req.user.email ?? '').trim(),
    phone: String(req.body.phone ?? req.user.phone ?? '').trim(),
    defaultWorkPathId,
    updatedAt: now()
  });
  addAudit(req.db, req.user.id, 'profile.update', 'user', req.user.id, { defaultWorkPathId }, req);
  await saveDb(req.db);
  res.json(ok(pickPublicUser(req.user)));
}));

app.post('/api/v1/profile/avatar', requireAuth, upload.single('avatar'), asyncRoute(async (req, res) => {
  if (!req.file) throw createError(400, 'VALIDATION_ERROR', '请选择头像文件');
  const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  if (!allowedMimeTypes.has(req.file.mimetype) || req.file.size > 2 * 1024 * 1024) {
    await fs.rm(req.file.path, { force: true });
    throw createError(400, 'VALIDATION_ERROR', '头像仅支持 PNG、JPG、WebP、GIF，且不能超过 2MB');
  }
  const extension = mime.extension(req.file.mimetype) || 'img';
  const storageKey = `avatar-${req.user.id}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
  const targetPath = path.join(config.uploadDir, storageKey);
  await fs.rename(req.file.path, targetPath);
  if (req.user.avatarStorageKey) await fs.rm(path.join(config.uploadDir, req.user.avatarStorageKey), { force: true }).catch(() => {});
  req.user.avatarStorageKey = storageKey;
  req.user.avatarMimeType = req.file.mimetype;
  req.user.avatarUrl = '';
  req.user.updatedAt = now();
  addAudit(req.db, req.user.id, 'profile.avatar.update', 'user', req.user.id, {}, req);
  await saveDb(req.db);
  res.json(ok(pickPublicUser(req.user)));
}));

app.get('/api/v1/public/avatars/:userId', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const user = db.users.find((item) => item.id === req.params.userId);
  if (!user?.avatarStorageKey) throw createError(404, 'NOT_FOUND', '头像不存在');
  const filePath = path.join(config.uploadDir, path.basename(user.avatarStorageKey));
  if (!fsSync.existsSync(filePath)) throw createError(404, 'NOT_FOUND', '头像文件不存在');
  res.setHeader('Content-Type', user.avatarMimeType || mime.lookup(filePath) || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fsSync.createReadStream(filePath).pipe(res);
}));

app.get('/api/v1/users', requireAuth, (req, res) => {
  sendPage(res, req.db.users.map(pickPublicUser), req.query.page, req.query.pageSize || 200);
});

app.post('/api/v1/users', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以创建用户');
  const username = validateName(req.body.username);
  if (req.db.users.some((item) => item.username === username)) throw createError(409, 'CONFLICT', '账号已存在');
  const hp = hashPassword(validatePasswordPolicy(req.body.password || 'User1234'));
  const user = {
    id: newId('u_'),
    username,
    displayName: req.body.displayName || username,
    passwordHash: hp.hash,
    passwordSalt: hp.salt,
    email: req.body.email || '',
    phone: req.body.phone || '',
    avatarUrl: '',
    status: req.body.status || 'enabled',
    departmentIds: req.body.departmentIds || [],
    roleIds: req.body.roleIds || ['r_employee'],
    lastLoginAt: null,
    failedLoginCount: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
    createdAt: now(),
    updatedAt: now()
  };
  req.db.users.push(user);
  addAudit(req.db, req.user.id, 'user.create', 'user', user.id, { username }, req);
  await saveDb(req.db);
  res.json(ok(pickPublicUser(user)));
}));

app.put('/api/v1/users/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以修改用户');
  const user = req.db.users.find((item) => item.id === req.params.id);
  if (!user) throw createError(404, 'NOT_FOUND', '用户不存在');
  Object.assign(user, {
    displayName: req.body.displayName ?? user.displayName,
    email: req.body.email ?? user.email,
    phone: req.body.phone ?? user.phone,
    status: req.body.status ?? user.status,
    departmentIds: req.body.departmentIds ?? user.departmentIds,
    roleIds: req.body.roleIds ?? user.roleIds,
    updatedAt: now()
  });
  addAudit(req.db, req.user.id, 'user.update', 'user', user.id, {}, req);
  await saveDb(req.db);
  res.json(ok(pickPublicUser(user)));
}));

app.post('/api/v1/users/:id/reset-password', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以重置密码');
  const user = req.db.users.find((item) => item.id === req.params.id);
  if (!user) throw createError(404, 'NOT_FOUND', '用户不存在');
  const hp = hashPassword(validatePasswordPolicy(req.body.password || 'User1234'));
  user.passwordHash = hp.hash;
  user.passwordSalt = hp.salt;
  user.updatedAt = now();
  addAudit(req.db, req.user.id, 'user.reset_password', 'user', user.id, {}, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/departments/tree', requireAuth, (req, res) => {
  res.json(ok(buildTree(req.db.departments.map((item) => ({ ...item })))));
});

app.post('/api/v1/departments', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以创建部门');
  const parentId = req.body.parentId || null;
  validateParentChange(req.db.departments, '', parentId, '部门');
  const dep = {
    id: newId('d_'),
    parentId,
    name: validateName(req.body.name),
    code: req.body.code || '',
    sortOrder: Number(req.body.sortOrder || 100),
    status: req.body.status || 'enabled',
    createdAt: now(),
    updatedAt: now()
  };
  req.db.departments.push(dep);
  addAudit(req.db, req.user.id, 'department.create', 'department', dep.id, { name: dep.name }, req);
  await saveDb(req.db);
  res.json(ok(dep));
}));

app.put('/api/v1/departments/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以修改部门');
  const dep = req.db.departments.find((item) => item.id === req.params.id);
  if (!dep) throw createError(404, 'NOT_FOUND', '部门不存在');
  const parentId = req.body.parentId === undefined ? dep.parentId : (req.body.parentId || null);
  validateParentChange(req.db.departments, dep.id, parentId, '部门');
  dep.name = req.body.name ? validateName(req.body.name) : dep.name;
  dep.parentId = parentId;
  dep.code = req.body.code ?? dep.code;
  dep.sortOrder = req.body.sortOrder ?? dep.sortOrder;
  dep.status = req.body.status ?? dep.status;
  dep.updatedAt = now();
  addAudit(req.db, req.user.id, 'department.update', 'department', dep.id, {}, req);
  await saveDb(req.db);
  res.json(ok(dep));
}));

app.delete('/api/v1/departments/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以删除部门');
  const dep = req.db.departments.find((item) => item.id === req.params.id);
  if (!dep) throw createError(404, 'NOT_FOUND', '部门不存在');
  const userReferences = req.db.users.filter((user) => (user.departmentIds || []).includes(dep.id)).length;
  const permissionReferences = req.db.permissionRules.filter((rule) => rule.subjectType === 'department' && rule.subjectId === dep.id).length;
  if (userReferences || permissionReferences) {
    throw createError(409, 'REFERENCE_CONFLICT', `部门仍被 ${userReferences} 个用户和 ${permissionReferences} 条权限规则引用，请先解除引用`);
  }
  req.db.departments.filter((item) => item.parentId === dep.id).forEach((child) => {
    child.parentId = dep.parentId || null;
    child.updatedAt = now();
  });
  req.db.departments = req.db.departments.filter((item) => item.id !== req.params.id);
  addAudit(req.db, req.user.id, 'department.delete', 'department', req.params.id, {}, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/roles/tree', requireAuth, (req, res) => {
  res.json(ok(buildTree(req.db.roles.map((item) => ({ ...item })))));
});

app.post('/api/v1/roles', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以创建角色');
  const parentId = req.body.parentId || null;
  validateParentChange(req.db.roles, '', parentId, '角色');
  const role = {
    id: newId('r_'),
    parentId,
    name: validateName(req.body.name),
    code: req.body.code || '',
    description: req.body.description || '',
    status: req.body.status || 'enabled',
    createdAt: now(),
    updatedAt: now()
  };
  req.db.roles.push(role);
  addAudit(req.db, req.user.id, 'role.create', 'role', role.id, { name: role.name }, req);
  await saveDb(req.db);
  res.json(ok(role));
}));

app.put('/api/v1/roles/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以修改角色');
  const role = req.db.roles.find((item) => item.id === req.params.id);
  if (!role) throw createError(404, 'NOT_FOUND', '角色不存在');
  const parentId = req.body.parentId === undefined ? role.parentId : (req.body.parentId || null);
  validateParentChange(req.db.roles, role.id, parentId, '角色');
  role.name = req.body.name ? validateName(req.body.name) : role.name;
  role.parentId = parentId;
  role.code = req.body.code ?? role.code;
  role.description = req.body.description ?? role.description;
  role.status = req.body.status ?? role.status;
  role.updatedAt = now();
  addAudit(req.db, req.user.id, 'role.update', 'role', role.id, {}, req);
  await saveDb(req.db);
  res.json(ok(role));
}));

app.delete('/api/v1/roles/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以删除角色');
  if (req.params.id === 'r_admin') throw createError(409, 'CONFLICT', '系统管理员角色不能删除');
  const role = req.db.roles.find((item) => item.id === req.params.id);
  if (!role) throw createError(404, 'NOT_FOUND', '角色不存在');
  const userReferences = req.db.users.filter((user) => (user.roleIds || []).includes(role.id)).length;
  const permissionReferences = req.db.permissionRules.filter((rule) => rule.subjectType === 'role' && rule.subjectId === role.id).length;
  if (userReferences || permissionReferences) {
    throw createError(409, 'REFERENCE_CONFLICT', `角色仍被 ${userReferences} 个用户和 ${permissionReferences} 条权限规则引用，请先解除引用`);
  }
  req.db.roles.filter((item) => item.parentId === role.id).forEach((child) => {
    child.parentId = role.parentId || null;
    child.updatedAt = now();
  });
  req.db.roles = req.db.roles.filter((item) => item.id !== req.params.id);
  addAudit(req.db, req.user.id, 'role.delete', 'role', req.params.id, {}, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/nodes/root', requireAuth, (req, res) => {
  const root = nodeById(req.db, 'n_root');
  requireNodeAction(req, root, 'visible');
  res.json(ok(publicNode(req.db, req.user, root, { unreadUploadCounts: unreadUploadCountsByNode(req.db, req.user) })));
});

app.get('/api/v1/nodes/tree', requireAuth, (req, res) => {
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  const folders = listVisibleDescendants(req.db, req.user)
    .filter((item) => item.nodeType === 'folder')
    .filter((item) => (item.spaceType || 'enterprise') !== 'personal')
    .filter((item) => ancestors(req.db, item).every((parent) => !nodePasswordProtected(req.db, parent) || isNodePasswordAccessible(req, parent)))
    .map((item) => publicNode(req.db, req.user, item, { unreadUploadCounts }));
  res.json(ok(buildTree(folders)));
});

app.get('/api/v1/personal-drive/root', requireAuth, asyncRoute(async (req, res) => {
  const root = ensurePersonalRoot(req.db, req.user);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, root)));
}));

app.get('/api/v1/personal-drive/tree', requireAuth, asyncRoute(async (req, res) => {
  const root = ensurePersonalRoot(req.db, req.user);
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  const rootAndDescendants = [root, ...descendants(req.db, root.id)]
    .filter((item) => item.nodeType === 'folder')
    .filter((item) => hasAction(req.db, req.user, item, 'visible'))
    .filter((item) => ancestors(req.db, item).every((parent) => !nodePasswordProtected(req.db, parent) || isNodePasswordAccessible(req, parent)))
    .map((item) => publicNode(req.db, req.user, item, { unreadUploadCounts }));
  await saveDb(req.db);
  res.json(ok(buildTree(rootAndDescendants)));
}));

app.get('/api/v1/personal-drive/summary', requireAuth, asyncRoute(async (req, res) => {
  const root = ensurePersonalRoot(req.db, req.user);
  const nodes = [root, ...descendants(req.db, root.id)];
  const files = nodes.filter((item) => item.nodeType === 'file');
  const versions = req.db.versions.filter((item) => files.some((file) => file.id === item.nodeId));
  const currentSizeBytes = files.reduce((sum, file) => sum + Number(currentVersion(req.db, file)?.sizeBytes || 0), 0);
  await saveDb(req.db);
  res.json(ok({
    rootId: root.id,
    folders: nodes.filter((item) => item.nodeType === 'folder').length,
    files: files.length,
    versions: versions.length,
    sizeBytes: currentSizeBytes
  }));
}));

app.get('/api/v1/personal-drive/trash', requireAuth, asyncRoute(async (req, res) => {
  const root = ensurePersonalRoot(req.db, req.user);
  const deleted = req.db.nodes
    .filter((node) => node.status === 'deleted' && node.spaceType === 'personal' && node.personalOwnerId === req.user.id)
    .filter((node) => !node.parentId || includeDeletedNodeById(req.db, node.parentId)?.status !== 'deleted')
    .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')))
    .map((node) => publicNode(req.db, req.user, node));
  await saveDb(req.db);
  sendPage(res, deleted, req.query.page, req.query.pageSize || 100);
}));

app.get('/api/v1/personal-drive/logs', requireAuth, asyncRoute(async (req, res) => {
  const root = ensurePersonalRoot(req.db, req.user);
  const personalNodeIds = new Set(req.db.nodes.filter((node) => node.spaceType === 'personal' && node.personalOwnerId === req.user.id).map((node) => node.id));
  const rootPath = `${root.fullPath.replace(/\/$/, '')}/`;
  const logs = req.db.auditLogs
    .filter((item) => item.actorId === req.user.id)
    .filter((item) => personalNodeIds.has(item.targetId) || item.targetPath === root.fullPath || String(item.targetPath || '').startsWith(rootPath))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  await saveDb(req.db);
  sendPage(res, logs, req.query.page, req.query.pageSize || 100);
}));

app.get('/api/v1/nodes/:id/children', requireAuth, (req, res) => {
  const parent = nodeById(req.db, req.params.id);
  requireNodeAction(req, parent, 'visible');
  requireNodePasswordAccess(req, parent);
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  const items = req.db.nodes
    .filter((item) => item.parentId === parent.id && item.status !== 'deleted')
    .filter((item) => hasAction(req.db, req.user, item, 'visible'))
    .sort((a, b) => (a.nodeType === b.nodeType ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.nodeType === 'folder' ? -1 : 1))
    .map((item) => publicNode(req.db, req.user, item, { unreadUploadCounts }));
  res.json(ok(items));
});

app.get('/api/v1/nodes/:id', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  res.json(ok(publicNode(req.db, req.user, node)));
});

app.post('/api/v1/folders', requireAuth, asyncRoute(async (req, res) => {
  const parent = nodeById(req.db, req.body.parentId || 'n_root');
  requireNodeAction(req, parent, 'folder:create');
  requireNodePasswordAccess(req, parent);
  if (parent.nodeType !== 'folder') throw createError(400, 'VALIDATION_ERROR', '只能在文件夹下创建文件夹');
  const name = validateName(req.body.name);
  ensureSiblingNameAvailable(req.db, parent.id, name);
  const folder = {
    id: newId('n_'),
    parentId: parent.id,
    nodeType: 'folder',
    name,
    fullPath: childPath(parent, name),
    extension: '',
    currentVersionId: null,
    ownerId: req.user.id,
    spaceType: parent.spaceType || 'enterprise',
    personalOwnerId: parent.spaceType === 'personal' ? parent.personalOwnerId : null,
    createdBy: req.user.id,
    updatedBy: req.user.id,
    lockedBy: null,
    lockedAt: null,
    status: 'normal',
    businessStatus: 'effective',
    securityLevel: parent.securityLevel || 'internal',
    sensitive: false,
    sensitiveReason: '',
    securityUpdatedBy: null,
    securityUpdatedAt: null,
    tags: [],
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null
  };
  req.db.nodes.push(folder);
  addAudit(req.db, req.user.id, 'folder.create', 'node', folder.id, { targetPath: folder.fullPath }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, folder)));
}));

app.put('/api/v1/nodes/:id/rename', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
  requireNodePasswordAccess(req, node);
  const name = validateName(req.body.name);
  ensureSiblingNameAvailable(req.db, node.parentId, name, node.id);
  node.name = name;
  node.updatedBy = req.user.id;
  node.updatedAt = now();
  refreshPathRecursive(req.db, node);
  addAudit(req.db, req.user.id, 'node.rename', 'node', node.id, { targetPath: node.fullPath, name }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.patch('/api/v1/nodes/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
  requireNodePasswordAccess(req, node);
  const allowed = ['draft', 'effective', 'invalid', 'archived'];
  const businessStatus = req.body.businessStatus || node.businessStatus || 'effective';
  if (!allowed.includes(businessStatus)) throw createError(400, 'VALIDATION_ERROR', '业务状态不正确');
  node.businessStatus = businessStatus;
  node.updatedBy = req.user.id;
  node.updatedAt = now();
  addAudit(req.db, req.user.id, 'node.status.update', 'node', node.id, { targetPath: node.fullPath, businessStatus }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.put('/api/v1/nodes/:id/security', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
  requireNodePasswordAccess(req, node);
  const beforeSensitive = Boolean(node.sensitive);
  node.securityLevel = normalizeSecurityLevel(req.body.securityLevel, node.securityLevel || 'internal');
  node.sensitive = Boolean(req.body.sensitive);
  node.sensitiveReason = String(req.body.sensitiveReason || '').trim();
  node.securityUpdatedBy = req.user.id;
  node.securityUpdatedAt = now();
  node.updatedBy = req.user.id;
  node.updatedAt = now();
  const action = !beforeSensitive && node.sensitive ? 'sensitive.mark' : beforeSensitive && !node.sensitive ? 'sensitive.unmark' : 'node.security.update';
  addAudit(req.db, req.user.id, action, 'node', node.id, {
    targetPath: node.fullPath,
    securityLevel: node.securityLevel,
    sensitive: node.sensitive,
    sensitiveReason: node.sensitiveReason
  }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.get('/api/v1/nodes/:id/workflow', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const approvals = (req.db.documentApprovals || [])
    .filter((item) => item.nodeId === node.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((item) => publicApproval(req.db, req.user, item));
  res.json(ok({
    node: publicNode(req.db, req.user, node),
    approvals,
    actions: Object.entries(WORKFLOW_ACTIONS).map(([value, item]) => ({ value, label: item.label, status: item.status }))
  }));
});

app.post('/api/v1/nodes/:id/workflow-actions', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
  requireNodePasswordAccess(req, node);
  const detail = applyWorkflowAction(req.db, node, req.user.id, req.body.action, String(req.body.comment || '').trim(), req);
  await saveDb(req.db);
  res.json(ok({ node: publicNode(req.db, req.user, node), detail }));
}));

app.post('/api/v1/nodes/:id/approvals', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
  requireNodePasswordAccess(req, node);
  const action = req.body.action || 'publish';
  const pendingExists = (req.db.documentApprovals || []).some((item) => item.nodeId === node.id && item.status === 'pending' && (item.type || 'workflow') === 'workflow' && item.action === action);
  if (pendingExists) throw createError(409, 'CONFLICT', '该流程动作已有待审批记录');
  const approval = createApprovalRecord(req.db, req.user, node, { ...req.body, type: 'workflow', action }, req);
  await saveDb(req.db);
  res.json(ok(publicApproval(req.db, req.user, approval)));
}));

app.post('/api/v1/nodes/:id/move', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
  requireNodePasswordAccess(req, node);
  const targetParent = nodeById(req.db, req.body.targetParentId);
  requireNodeAction(req, targetParent, node.nodeType === 'folder' ? 'folder:create' : 'file:create');
  ensureNodeMoveAllowed(req.db, node, targetParent);
  node.parentId = targetParent.id;
  node.updatedBy = req.user.id;
  node.updatedAt = now();
  refreshPathRecursive(req.db, node);
  applyNodeSpaceFromParent(req.db, node);
  addAudit(req.db, req.user.id, 'node.move', 'node', node.id, { targetPath: node.fullPath }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.post('/api/v1/nodes/:id/copy', requireAuth, asyncRoute(async (req, res) => {
  const source = nodeById(req.db, req.params.id);
  requireNodeAction(req, source, 'visible');
  requireNodePasswordAccess(req, source);
  const targetParent = nodeById(req.db, req.body.targetParentId);
  requireNodeAction(req, targetParent, source.nodeType === 'folder' ? 'folder:create' : 'file:create');
  const copyMap = new Map();
  const cloneNode = (node, parentId) => {
    let name = node.name;
    if (parentId === targetParent.id) {
      const base = name;
      let index = 1;
      while (req.db.nodes.some((item) => item.parentId === parentId && item.name === name && item.status !== 'deleted')) {
        name = `${base} 副本${index > 1 ? index : ''}`;
        index += 1;
      }
    }
    const id = newId('n_');
    const parent = includeDeletedNodeById(req.db, parentId);
    const clone = {
      ...node,
      id,
      parentId,
      name,
      fullPath: childPath(parent, name),
      spaceType: parent?.spaceType || 'enterprise',
      personalOwnerId: parent?.spaceType === 'personal' ? parent.personalOwnerId : null,
      ownerId: req.user.id,
      createdBy: req.user.id,
      updatedBy: req.user.id,
      lockedBy: null,
      lockedAt: null,
      createdAt: now(),
      updatedAt: now()
    };
    copyMap.set(node.id, id);
    req.db.nodes.push(clone);
    if (node.nodeType === 'file') {
      const versions = req.db.versions.filter((item) => item.nodeId === node.id);
      versions.forEach((version) => {
        const copiedVersion = { ...version, id: newId('ver_'), nodeId: id, createdBy: req.user.id, createdAt: now() };
        req.db.versions.push(copiedVersion);
        if (node.currentVersionId === version.id) clone.currentVersionId = copiedVersion.id;
      });
    }
    req.db.nodes.filter((item) => item.parentId === node.id && item.status !== 'deleted').forEach((child) => cloneNode(child, id));
    return clone;
  };
  const copied = cloneNode(source, targetParent.id);
  addAudit(req.db, req.user.id, 'node.copy', 'node', source.id, { copiedTo: copied.fullPath }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, copied)));
}));

app.delete('/api/v1/nodes/:id', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:delete');
  requireNodePasswordAccess(req, node);
  const affected = [node, ...descendants(req.db, node.id)];
  affected.forEach((item) => {
    item.status = 'deleted';
    item.deletedAt = now();
    item.deletedBy = req.user.id;
    item.updatedBy = req.user.id;
    item.updatedAt = now();
  });
  addAudit(req.db, req.user.id, 'node.delete', 'node', node.id, { targetPath: node.fullPath, count: affected.length }, req);
  notifySubscribers(req.db, req.user.id, node, 'delete');
  await saveDb(req.db);
  res.json(ok(true));
}));

app.post('/api/v1/nodes/batch-move', requireAuth, asyncRoute(async (req, res) => {
  const nodeIds = req.body.nodeIds || [];
  const nodes = topLevelSelectedNodes(req.db, nodeIds);
  if (!nodes.length) throw createError(400, 'VALIDATION_ERROR', '请选择要移动的文件或文件夹');
  const targetParent = nodeById(req.db, req.body.targetParentId);
  if (!targetParent) throw createError(404, 'NOT_FOUND', '目标文件夹不存在');
  const targetNames = new Set();
  nodes.forEach((node) => {
    requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
    requireNodePasswordAccess(req, node);
    requireNodeAction(req, targetParent, node.nodeType === 'folder' ? 'folder:create' : 'file:create');
    ensureNodeMoveAllowed(req.db, node, targetParent);
    if (targetNames.has(node.name)) throw createError(409, 'CONFLICT', `批量移动中存在重名项目：${node.name}`);
    targetNames.add(node.name);
  });
  nodes.forEach((node) => {
    node.parentId = targetParent.id;
    node.updatedBy = req.user.id;
    node.updatedAt = now();
    refreshPathRecursive(req.db, node);
    applyNodeSpaceFromParent(req.db, node);
  });
  addAudit(req.db, req.user.id, 'node.batch_move', 'node', 'batch', { targetPath: targetParent.fullPath, nodeIds: nodes.map((item) => item.id) }, req);
  await saveDb(req.db);
  res.json(ok(nodes.map((node) => publicNode(req.db, req.user, node))));
}));

app.post('/api/v1/nodes/batch-delete', requireAuth, asyncRoute(async (req, res) => {
  const nodes = topLevelSelectedNodes(req.db, req.body.nodeIds || []).filter((node) => node.id !== 'n_root');
  if (!nodes.length) throw createError(400, 'VALIDATION_ERROR', '请选择要删除的文件或文件夹');
  const affectedMap = new Map();
  nodes.forEach((node) => {
    requireNodeAction(req, node, 'file:delete');
    requireNodePasswordAccess(req, node);
    [node, ...descendants(req.db, node.id)].forEach((item) => affectedMap.set(item.id, item));
  });
  const timestamp = now();
  affectedMap.forEach((item) => {
    item.status = 'deleted';
    item.deletedAt = timestamp;
    item.deletedBy = req.user.id;
    item.updatedBy = req.user.id;
    item.updatedAt = timestamp;
  });
  nodes.forEach((node) => notifySubscribers(req.db, req.user.id, node, 'delete'));
  addAudit(req.db, req.user.id, 'node.batch_delete', 'node', 'batch', { nodeIds: nodes.map((item) => item.id), count: affectedMap.size }, req);
  await saveDb(req.db);
  res.json(ok({ count: affectedMap.size }));
}));

app.get('/api/v1/trash', requireAuth, (req, res) => {
  const deleted = req.db.nodes
    .filter((node) => node.status === 'deleted')
    .filter((node) => !node.parentId || includeDeletedNodeById(req.db, node.parentId)?.status !== 'deleted')
    .filter((node) => isAdmin(req.user) || node.deletedBy === req.user.id || node.ownerId === req.user.id || node.createdBy === req.user.id)
    .sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''))
    .map((node) => publicNode(req.db, req.user, node));
  sendPage(res, deleted, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/trash/:id/restore', requireAuth, asyncRoute(async (req, res) => {
  const node = includeDeletedNodeById(req.db, req.params.id);
  if (!node || node.status !== 'deleted') throw createError(404, 'NOT_FOUND', '回收站中不存在该项目');
  if (!isAdmin(req.user) && node.deletedBy !== req.user.id && node.ownerId !== req.user.id && node.createdBy !== req.user.id) {
    throw createError(403, 'FORBIDDEN', '没有权限恢复该项目');
  }
  const parent = includeDeletedNodeById(req.db, node.parentId);
  if (parent && parent.status === 'deleted') throw createError(409, 'CONFLICT', '请先恢复上级文件夹');
  ensureSiblingNameAvailable(req.db, node.parentId, node.name, node.id);
  const affected = [node, ...descendantsIncludingDeleted(req.db, node.id)];
  affected.forEach((item) => {
    item.status = 'normal';
    item.deletedAt = null;
    item.deletedBy = null;
    item.updatedBy = req.user.id;
    item.updatedAt = now();
  });
  refreshPathRecursive(req.db, node);
  addAudit(req.db, req.user.id, 'node.restore', 'node', node.id, { targetPath: node.fullPath, count: affected.length }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.delete('/api/v1/trash/:id', requireAuth, asyncRoute(async (req, res) => {
  const node = includeDeletedNodeById(req.db, req.params.id);
  if (!node || node.status !== 'deleted') throw createError(404, 'NOT_FOUND', '回收站中不存在该项目');
  if (!isAdmin(req.user) && node.deletedBy !== req.user.id && node.ownerId !== req.user.id && node.createdBy !== req.user.id) {
    throw createError(403, 'FORBIDDEN', '没有权限彻底删除该项目');
  }
  const affectedIds = new Set([node.id, ...descendantsIncludingDeleted(req.db, node.id).map((item) => item.id)]);
  const storageKeys = [
    ...req.db.versions
      .filter((item) => affectedIds.has(item.nodeId) && (item.storageType || 'local') === 'local')
      .map((item) => item.storageKey),
    ...req.db.attachments
      .filter((item) => affectedIds.has(item.nodeId))
      .map((item) => item.storageKey)
  ].filter((storageKey) => storageKey && path.basename(storageKey) === storageKey);
  await Promise.all([...new Set(storageKeys)].map((storageKey) => fs.rm(path.join(config.uploadDir, storageKey), { force: true })));
  req.db.nodes = req.db.nodes.filter((item) => !affectedIds.has(item.id));
  req.db.versions = req.db.versions.filter((item) => !affectedIds.has(item.nodeId));
  req.db.permissionRules = req.db.permissionRules.filter((item) => !affectedIds.has(item.nodeId));
  req.db.favorites = req.db.favorites.filter((item) => !affectedIds.has(item.nodeId));
  req.db.documentCategories = req.db.documentCategories.filter((item) => !affectedIds.has(item.nodeId));
  req.db.propertyValues = req.db.propertyValues.filter((item) => !affectedIds.has(item.nodeId));
  req.db.comments = req.db.comments.filter((item) => !affectedIds.has(item.nodeId));
  req.db.ratings = req.db.ratings.filter((item) => !affectedIds.has(item.nodeId));
  req.db.attachments = req.db.attachments.filter((item) => !affectedIds.has(item.nodeId));
  req.db.fileRelations = req.db.fileRelations.filter((item) => !affectedIds.has(item.nodeId) && !affectedIds.has(item.relatedNodeId));
  req.db.documentApprovals = req.db.documentApprovals.filter((item) => !affectedIds.has(item.nodeId));
  req.db.documentReviews = req.db.documentReviews.filter((item) => !affectedIds.has(item.nodeId));
  req.db.versionChangeLogs = req.db.versionChangeLogs.filter((item) => !affectedIds.has(item.nodeId));
  addAudit(req.db, req.user.id, 'node.destroy', 'node', node.id, { targetPath: node.fullPath, count: affectedIds.size }, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/nodes/:id/permissions/effective', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  if (!node) throw createError(404, 'NOT_FOUND', '文件或文件夹不存在');
  const targetUserId = req.query.userId && isAdmin(req.user) ? req.query.userId : req.user.id;
  const targetUser = req.db.users.find((item) => item.id === targetUserId && item.status === 'enabled');
  if (!targetUser) throw createError(404, 'NOT_FOUND', '用户不存在');
  res.json(ok({ nodeId: node.id, user: pickPublicUser(targetUser), actions: effectiveActions(req.db, targetUser, node) }));
});

app.post('/api/v1/files/office', requireAuth, asyncRoute(async (req, res) => {
  const parent = nodeById(req.db, req.body.parentId || 'n_root');
  requireNodeAction(req, parent, 'file:create');
  requireNodePasswordAccess(req, parent);
  const officeType = String(req.body.officeType || '').replace(/^\./, '').toLowerCase();
  if (!OFFICE_EDIT_EXTENSIONS.has(officeType)) throw createError(400, 'VALIDATION_ERROR', '在线新建仅支持 docx、xlsx、pptx');
  const inputName = String(req.body.name || '').trim();
  const defaultNames = { docx: '新建文档.docx', xlsx: '新建表格.xlsx', pptx: '新建演示文稿.pptx' };
  const name = validateName(inputName || defaultNames[officeType]);
  if (extname(name) !== officeType) throw createError(400, 'VALIDATION_ERROR', `文件名必须使用 .${officeType} 扩展名`);
  ensureSiblingNameAvailable(req.db, parent.id, name);
  const node = createFileNode(req.db, parent, name, req.user.id, req.body.businessStatus || 'draft');
  const tempPath = path.join(config.tmpDir, `${node.id}-${Date.now()}.${officeType}`);
  try {
    const buffer = await createBlankOfficeBuffer(officeType);
    await fs.writeFile(tempPath, buffer);
    const version = await createVersionFromFile(req.db, node, tempPath, name, req.user.id, req.body.description || '在线新建');
    addVersionChangeLog(req.db, node, version, req.user.id, 'create', { description: version.description, source: 'office_template' });
    addAudit(req.db, req.user.id, 'file.office_create', 'node', node.id, { targetPath: node.fullPath, officeType, versionNo: version.versionNo }, req);
    notifyVisibleUsersAboutNewFile(req.db, req.user.id, node);
    await saveDb(req.db);
    res.json(ok(publicNode(req.db, req.user, node)));
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    req.db.nodes = req.db.nodes.filter((item) => item.id !== node.id);
    req.db.versions = req.db.versions.filter((item) => item.nodeId !== node.id);
    throw error;
  }
}));

app.post('/api/v1/uploads/chunked/init', requireAuth, asyncRoute(async (req, res) => {
  const parent = nodeById(req.db, req.body.parentId || 'n_root');
  requireNodeAction(req, parent, 'file:create');
  requireNodePasswordAccess(req, parent);
  const filename = validateName(req.body.filename);
  const sizeBytes = Math.max(0, Number(req.body.sizeBytes || 0));
  const totalChunks = Math.max(1, Math.min(Number(req.body.totalChunks || 1), 100000));
  const fileMd5 = String(req.body.md5 || '').trim().toLowerCase();
  const policy = currentFilePolicy(req.db);
  if (sizeBytes > Number(policy.maxSizeMb) * 1024 * 1024) throw createError(413, 'FILE_TOO_LARGE', `文件大小不能超过 ${policy.maxSizeMb} MB`);
  if (fileMd5 && !/^[a-f0-9]{32}$/.test(fileMd5)) throw createError(400, 'VALIDATION_ERROR', 'MD5 格式不正确');
  const existingVersion = fileMd5 ? req.db.versions.find((item) => item.md5 === fileMd5 && Number(item.sizeBytes || 0) === sizeBytes && (item.storageType || 'local') === 'local' && fsSync.existsSync(path.join(config.uploadDir, item.storageKey || ''))) : null;
  const existing = req.db.uploadSessions.find((item) => item.userId === req.user.id && item.parentId === parent.id && item.filename === filename && item.md5 === fileMd5 && item.status === 'uploading');
  if (existing) return res.json(ok({ ...existing, uploadedChunks: [...(existing.uploadedChunks || [])], instantAvailable: Boolean(existingVersion) }));
  ensureSiblingNameAvailable(req.db, parent.id, filename);
  const session = {
    id: newId('upl_'), userId: req.user.id, parentId: parent.id, filename, sizeBytes, md5: fileMd5, totalChunks,
    uploadedChunks: [], status: existingVersion ? 'instant_ready' : 'uploading', sourceVersionId: existingVersion?.id || null,
    description: String(req.body.description || '分片上传'), createdAt: now(), updatedAt: now(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString()
  };
  req.db.uploadSessions.unshift(session);
  await ensureDir(path.join(config.tmpDir, session.id));
  await saveDb(req.db);
  res.json(ok({ ...session, instantAvailable: Boolean(existingVersion) }));
}));

app.get('/api/v1/uploads/chunked/:id', requireAuth, (req, res) => {
  const session = req.db.uploadSessions.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!session) throw createError(404, 'NOT_FOUND', '上传会话不存在');
  res.json(ok({ ...session, uploadedChunks: [...(session.uploadedChunks || [])] }));
});

app.put('/api/v1/uploads/chunked/:id/chunks/:index', requireAuth, upload.single('chunk'), asyncRoute(async (req, res) => {
  const session = req.db.uploadSessions.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!session || session.status !== 'uploading') throw createError(404, 'NOT_FOUND', '上传会话不存在或已结束');
  if (!req.file) throw createError(400, 'VALIDATION_ERROR', '缺少分片内容');
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) { await fs.rm(req.file.path, { force: true }); throw createError(400, 'VALIDATION_ERROR', '分片序号无效'); }
  const chunkDir = path.join(config.tmpDir, session.id);
  await ensureDir(chunkDir);
  const targetPath = path.join(chunkDir, String(index).padStart(8, '0'));
  await fs.rename(req.file.path, targetPath);
  session.uploadedChunks = [...new Set([...(session.uploadedChunks || []), index])].sort((a, b) => a - b);
  session.updatedAt = now();
  await saveDb(req.db);
  res.json(ok({ index, uploadedChunks: session.uploadedChunks, received: session.uploadedChunks.length, totalChunks: session.totalChunks }));
}));

app.post('/api/v1/uploads/chunked/:id/complete', requireAuth, asyncRoute(async (req, res) => {
  const session = req.db.uploadSessions.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!session) throw createError(404, 'NOT_FOUND', '上传会话不存在');
  if (session.status === 'completed' && session.nodeId) {
    const completedNode = nodeById(req.db, session.nodeId);
    if (completedNode) return res.json(ok(publicNode(req.db, req.user, completedNode)));
  }
  const parent = nodeById(req.db, session.parentId);
  requireNodeAction(req, parent, 'file:create');
  ensureSiblingNameAvailable(req.db, parent.id, session.filename);
  const assembledPath = path.join(config.tmpDir, `${session.id}-${safeFilename(session.filename)}`);
  try {
    if (session.sourceVersionId) {
      const source = versionById(req.db, session.sourceVersionId);
      if (!source) throw createError(409, 'CONFLICT', '秒传源文件已失效，请重新上传');
      await fs.copyFile(path.join(config.uploadDir, source.storageKey), assembledPath);
    } else {
      if ((session.uploadedChunks || []).length !== session.totalChunks) throw createError(409, 'UPLOAD_INCOMPLETE', `仍有 ${session.totalChunks - (session.uploadedChunks || []).length} 个分片未上传`);
      const output = await fs.open(assembledPath, 'w');
      try {
        for (let index = 0; index < session.totalChunks; index += 1) {
          const bytes = await fs.readFile(path.join(config.tmpDir, session.id, String(index).padStart(8, '0')));
          await output.write(bytes);
        }
      } finally { await output.close(); }
    }
    const stats = await fs.stat(assembledPath);
    if (Number(session.sizeBytes || 0) && stats.size !== Number(session.sizeBytes)) throw createError(409, 'UPLOAD_SIZE_MISMATCH', '合并后的文件大小与声明不一致');
    const assembledMd5 = await fileMd5FromPath(assembledPath);
    if (session.md5 && assembledMd5 !== session.md5) throw createError(409, 'UPLOAD_MD5_MISMATCH', '合并后的文件 MD5 校验失败');
    await scanIncomingFile(req.db, assembledPath, session.filename, req.user.id);
    const node = createFileNode(req.db, parent, session.filename, req.user.id, 'effective');
    const version = await createVersionFromFile(req.db, node, assembledPath, session.filename, req.user.id, session.description);
    addVersionChangeLog(req.db, node, version, req.user.id, 'create', { description: version.description, source: session.sourceVersionId ? 'instant_upload' : 'chunked_upload' });
    session.status = 'completed';
    session.nodeId = node.id;
    session.completedAt = now();
    session.updatedAt = now();
    addAudit(req.db, req.user.id, 'file.chunked_upload', 'node', node.id, { targetPath: node.fullPath, totalChunks: session.totalChunks, instant: Boolean(session.sourceVersionId) }, req);
    notifyVisibleUsersAboutNewFile(req.db, req.user.id, node);
    await fs.rm(path.join(config.tmpDir, session.id), { recursive: true, force: true });
    await saveDb(req.db);
    res.json(ok(publicNode(req.db, req.user, node)));
  } catch (error) {
    if (error.code !== 'FILE_QUARANTINED') await fs.rm(assembledPath, { force: true }).catch(() => {});
    throw error;
  }
}));

app.delete('/api/v1/uploads/chunked/:id', requireAuth, asyncRoute(async (req, res) => {
  const session = req.db.uploadSessions.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!session) throw createError(404, 'NOT_FOUND', '上传会话不存在');
  session.status = 'cancelled';
  session.updatedAt = now();
  await fs.rm(path.join(config.tmpDir, session.id), { recursive: true, force: true });
  await saveDb(req.db);
  res.json(ok(true));
}));

app.post('/api/v1/files', requireAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw createError(400, 'VALIDATION_ERROR', '请选择要上传的文件');
  const originalFilename = req.body.originalFilename ? validateName(req.body.originalFilename) : req.file.originalname;
  const uploadedFile = { ...req.file, originalname: originalFilename };
  await validateUploadedFileByPolicy(req.db, uploadedFile);
  await scanIncomingFile(req.db, uploadedFile.path, originalFilename, req.user.id);
  const parent = nodeById(req.db, req.body.parentId || 'n_root');
  requireNodeAction(req, parent, 'file:create');
  requireNodePasswordAccess(req, parent);
  const name = validateName(req.body.name || originalFilename);
  ensureSiblingNameAvailable(req.db, parent.id, name);
  const node = createFileNode(req.db, parent, name, req.user.id, req.body.businessStatus || 'effective');
  const version = await createVersionFromUpload(req.db, node, uploadedFile, req.user.id, req.body.description || '初始版本');
  addVersionChangeLog(req.db, node, version, req.user.id, 'create', { description: version.description });
  addAudit(req.db, req.user.id, 'file.upload', 'node', node.id, { targetPath: node.fullPath, versionNo: version.versionNo }, req);
  notifyVisibleUsersAboutNewFile(req.db, req.user.id, node);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.post('/api/v1/files/:id/versions', requireAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw createError(400, 'VALIDATION_ERROR', '请选择要上传的文件');
  const originalFilename = req.body.originalFilename ? validateName(req.body.originalFilename) : req.file.originalname;
  const uploadedFile = { ...req.file, originalname: originalFilename };
  await validateUploadedFileByPolicy(req.db, uploadedFile);
  await scanIncomingFile(req.db, uploadedFile.path, originalFilename, req.user.id);
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能更新文件');
  if (node.lockedBy && node.lockedBy !== req.user.id && !isAdmin(req.user)) throw createError(409, 'CONFLICT', '文件已被其他用户锁定');
  const previousVersion = currentVersion(req.db, node);
  const version = await createVersionFromUpload(req.db, node, uploadedFile, req.user.id, req.body.description || '上传更新');
  addVersionChangeLog(req.db, node, version, req.user.id, 'upload', {
    description: version.description,
    fromVersionId: previousVersion?.id || null,
    fromVersionNo: previousVersion?.versionNo || null
  });
  if (req.body.unlock === 'true') {
    node.lockedBy = null;
    node.lockedAt = null;
  }
  addAudit(req.db, req.user.id, 'file.version.create', 'node', node.id, { targetPath: node.fullPath, versionNo: version.versionNo }, req);
  notifySubscribers(req.db, req.user.id, node, 'update', version);
  notifyRelatedFileUpdate(req.db, req.user.id, node, version);
  await saveDb(req.db);
  res.json(ok(publicVersion(version)));
}));

app.get('/api/v1/files/:id/versions', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const versions = req.db.versions.filter((item) => item.nodeId === node.id).sort((a, b) => b.versionNo - a.versionNo).map(publicVersion);
  res.json(ok(versions));
});

app.get('/api/v1/files/:id/version-logs', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能查看文件版本记录');
  const logs = (req.db.versionChangeLogs || [])
    .filter((item) => item.nodeId === node.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((item) => publicVersionChangeLog(req.db, item));
  res.json(ok(logs));
});

app.get('/api/v1/files/:id/version-diff', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:preview');
  requireNodePasswordAccess(req, node);
  const from = req.db.versions.find((item) => item.id === req.query.fromVersionId && item.nodeId === node.id);
  const to = req.db.versions.find((item) => item.id === req.query.toVersionId && item.nodeId === node.id);
  if (!from || !to) throw createError(404, 'NOT_FOUND', '请选择有效的两个版本');
  const [before, after] = await Promise.all([versionComparableText(req.db, node, from), versionComparableText(req.db, node, to)]);
  const rows = lineDiff(before, after);
  res.json(ok({
    from: publicVersion(from), to: publicVersion(to), rows,
    summary: { added: rows.filter((item) => item.type === 'added').length, removed: rows.filter((item) => item.type === 'removed').length, unchanged: rows.filter((item) => item.type === 'unchanged').length }
  }));
}));

app.post('/api/v1/files/:id/versions/:versionId/rollback', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  const version = req.db.versions.find((item) => item.id === req.params.versionId && item.nodeId === node.id);
  if (!version) throw createError(404, 'NOT_FOUND', '版本不存在');
  const previousVersion = currentVersion(req.db, node);
  node.currentVersionId = version.id;
  node.updatedBy = req.user.id;
  node.updatedAt = now();
  addVersionChangeLog(req.db, node, version, req.user.id, 'rollback', {
    description: `回滚到版本 ${version.versionNo}`,
    fromVersionId: previousVersion?.id || null,
    fromVersionNo: previousVersion?.versionNo || null
  });
  addAudit(req.db, req.user.id, 'file.version.rollback', 'node', node.id, { targetPath: node.fullPath, versionNo: version.versionNo }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.delete('/api/v1/files/:id/versions/:versionId', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以删除历史版本');
  const node = nodeById(req.db, req.params.id);
  requireNodePasswordAccess(req, node);
  const version = req.db.versions.find((item) => item.id === req.params.versionId && item.nodeId === node.id);
  if (!version) throw createError(404, 'NOT_FOUND', '版本不存在');
  if (node.currentVersionId === version.id) throw createError(409, 'CONFLICT', '当前版本不能删除');
  const nodeVersions = req.db.versions.filter((item) => item.nodeId === node.id);
  if (nodeVersions.length <= 1) throw createError(409, 'CONFLICT', '文件至少需要保留一个版本');

  const originalPath = ['local', 'nas', 's3'].includes(version.storageType || 'local') ? path.join(config.uploadDir, version.storageKey || '') : '';
  const quarantinePath = originalPath && fsSync.existsSync(originalPath)
    ? path.join(config.tmpDir, `${version.id}-${Date.now()}.deleted`)
    : '';
  const previousVersions = req.db.versions;
  const previousLogs = [...req.db.versionChangeLogs];
  const previousAudits = [...req.db.auditLogs];
  let saved = false;
  try {
    if (quarantinePath) await fs.rename(originalPath, quarantinePath);
    req.db.versions = req.db.versions.filter((item) => item.id !== version.id);
    addVersionChangeLog(req.db, node, version, req.user.id, 'delete', {
      description: `删除历史版本 ${version.versionNo}`,
      deletedVersionId: version.id,
      deletedVersionNo: version.versionNo
    });
    addAudit(req.db, req.user.id, 'file.version.delete', 'node', node.id, {
      targetPath: node.fullPath,
      versionId: version.id,
      versionNo: version.versionNo
    }, req);
    await saveDb(req.db);
    saved = true;
    if (version.storageType === 'nas' && version.nasPath) await fs.rm(version.nasPath, { force: true }).catch((error) => console.error('failed to remove NAS version', error));
    if (version.storageType === 's3' && version.s3Key) {
      const settings = currentFileStorageSettings(req.db).s3;
      await s3ClientFor(settings).send(new DeleteObjectCommand({ Bucket: version.s3Bucket || settings.bucket, Key: version.s3Key })).catch((error) => console.error('failed to remove S3 version', error));
    }
    if (quarantinePath) await fs.rm(quarantinePath, { force: true }).catch((error) => console.error('failed to remove deleted version quarantine', error));
    res.json(ok(true));
  } catch (error) {
    if (!saved) {
      req.db.versions = previousVersions;
      req.db.versionChangeLogs = previousLogs;
      req.db.auditLogs = previousAudits;
      if (quarantinePath && fsSync.existsSync(quarantinePath) && !fsSync.existsSync(originalPath)) {
        await fs.rename(quarantinePath, originalPath).catch(() => {});
      }
    }
    throw error;
  }
}));

app.get('/api/v1/files/:id/office-edit-session', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  res.json(ok(publicOfficeEditSession(req.db, activeOfficeEditSession(req.db, node.id))));
});

app.post('/api/v1/files/:id/office-edit-session', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能在线编辑文件');
  if ((node.sourceType || 'local') === 'external') throw createError(409, 'CONFLICT', '同步目录文件由管理员维护源文件，暂不支持在线编辑');
  const version = currentVersion(req.db, node);
  if (!version) throw createError(404, 'NOT_FOUND', '当前版本不存在');
  const extension = extname(version.originalFilename || node.name);
  if (!OFFICE_EDIT_EXTENSIONS.has(extension)) throw createError(400, 'VALIDATION_ERROR', '在线编辑仅支持 docx、xlsx、pptx');
  const settings = currentOfficePreviewSettings(req.db);
  const configurationIssue = officePreviewConfigurationIssue(req, settings);
  if (configurationIssue) throw createError(503, 'OFFICE_EDIT_UNAVAILABLE', configurationIssue);
  if (!settings.enabled || !settings.documentServerUrl) throw createError(503, 'OFFICE_EDIT_UNAVAILABLE', '请先配置并启用 ONLYOFFICE Document Server');
  let activeSession = activeOfficeEditSession(req.db, node.id);
  if (activeSession && Date.now() - new Date(activeSession.startedAt).getTime() > 12 * 60 * 60 * 1000) {
    finishOfficeEditSession(req.db, activeSession, 'failed');
    activeSession.lastError = '在线编辑会话超时，已自动释放';
    activeSession = null;
  }
  if (activeSession && activeSession.userId !== req.user.id) {
    throw createError(409, 'OFFICE_EDIT_LOCKED', `文件正在由 ${userDisplayName(req.db, activeSession.userId)} 在线编辑`);
  }
  if (node.lockedBy && node.lockedBy !== req.user.id && !isAdmin(req.user)) throw createError(409, 'CONFLICT', '文件已被其他用户锁定');
  let session = activeSession;
  if (!session || session.baseVersionId !== version.id) {
    if (session) finishOfficeEditSession(req.db, session, 'closed');
    session = {
      id: newId('oes_'),
      nodeId: node.id,
      baseVersionId: version.id,
      userId: req.user.id,
      documentKey: `${officeDocumentKey(version)}-${crypto.randomBytes(6).toString('hex')}`.slice(0, 80),
      status: 'active',
      savedVersionId: null,
      startedAt: now(),
      completedAt: null,
      lastCallbackStatus: null,
      lastError: ''
    };
    req.db.officeEditSessions.push(session);
  }
  node.lockedBy = req.user.id;
  node.lockedAt = node.lockedAt || now();
  const editor = buildOnlyOfficeEditor(req, node, version, extension, session);
  if (!editor) throw createError(503, 'OFFICE_EDIT_UNAVAILABLE', '当前文件无法生成在线编辑配置');
  addAudit(req.db, req.user.id, 'file.office_edit.start', 'node', node.id, {
    targetPath: node.fullPath,
    sessionId: session.id,
    versionNo: version.versionNo
  }, req);
  await saveDb(req.db);
  res.json(ok({ session: publicOfficeEditSession(req.db, session), editor }));
}));

app.post('/api/v1/files/:id/office-edit-session/close', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  const session = activeOfficeEditSession(req.db, node.id);
  if (!session) return res.json(ok(null));
  if (session.userId !== req.user.id && !isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只能关闭自己的在线编辑会话');
  finishOfficeEditSession(req.db, session, 'closed');
  addAudit(req.db, req.user.id, 'file.office_edit.close', 'node', node.id, { targetPath: node.fullPath, sessionId: session.id }, req);
  await saveDb(req.db);
  res.json(ok(publicOfficeEditSession(req.db, session)));
}));

app.post('/api/v1/office-edit/callback', asyncRoute(async (req, res) => {
  const ticket = verifyToken(String(req.query.ticket || ''));
  if (ticket?.kind !== 'office_edit_callback') return res.status(401).json({ error: 1 });
  const db = await loadDb();
  const session = officeEditSessionById(db, ticket.sessionId);
  if (!session || session.nodeId !== ticket.nodeId || session.baseVersionId !== ticket.versionId || session.userId !== ticket.userId) {
    return res.status(404).json({ error: 1 });
  }
  const callbackStatus = Number(req.body?.status || 0);
  session.lastCallbackStatus = callbackStatus;
  if (session.savedVersionId || session.status === 'saved') return res.json({ error: 0 });
  const node = nodeById(db, session.nodeId);
  const user = db.users.find((item) => item.id === session.userId && item.status === 'enabled');
  if (!node || !user) {
    session.lastError = '在线编辑关联的文件或用户不存在';
    finishOfficeEditSession(db, session, 'failed');
    await saveDb(db);
    return res.status(404).json({ error: 1 });
  }
  if (callbackStatus === 1) {
    await saveDb(db);
    return res.json({ error: 0 });
  }
  if ([3, 7].includes(callbackStatus)) {
    session.lastError = 'ONLYOFFICE 报告保存失败';
    if (callbackStatus === 3) finishOfficeEditSession(db, session, 'failed');
    await saveDb(db);
    return res.json({ error: 0 });
  }
  if (callbackStatus === 4) {
    finishOfficeEditSession(db, session, 'closed');
    addAudit(db, user.id, 'file.office_edit.no_changes', 'node', node.id, { targetPath: node.fullPath, sessionId: session.id });
    await saveDb(db);
    return res.json({ error: 0 });
  }
  if (![2, 6].includes(callbackStatus) || !req.body?.url) return res.json({ error: 0 });
  const baseVersion = versionById(db, session.baseVersionId);
  const extension = extname(baseVersion?.originalFilename || node.name);
  let tempPath = '';
  try {
    const settings = currentOfficePreviewSettings(db);
    tempPath = await downloadOfficeEditedFile(db, settings, req.body.url, session, extension);
    const previousVersion = currentVersion(db, node);
    const version = await createVersionFromFile(
      db,
      node,
      tempPath,
      baseVersion?.originalFilename || node.name,
      user.id,
      'ONLYOFFICE 在线编辑'
    );
    tempPath = '';
    addVersionChangeLog(db, node, version, user.id, 'office_edit', {
      description: version.description,
      sessionId: session.id,
      fromVersionId: previousVersion?.id || null,
      fromVersionNo: previousVersion?.versionNo || null
    });
    session.savedVersionId = version.id;
    session.lastError = '';
    finishOfficeEditSession(db, session, 'saved');
    addAudit(db, user.id, 'file.office_edit.save', 'node', node.id, {
      targetPath: node.fullPath,
      sessionId: session.id,
      versionNo: version.versionNo
    });
    notifySubscribers(db, user.id, node, 'update', version);
    notifyRelatedFileUpdate(db, user.id, node, version);
    await saveDb(db);
    return res.json({ error: 0 });
  } catch (error) {
    if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => {});
    session.lastError = error.message || '在线编辑结果保存失败';
    if (callbackStatus === 2) finishOfficeEditSession(db, session, 'failed');
    await saveDbBestEffort(db, 'office edit callback');
    return res.status(502).json({ error: 1 });
  }
}));

app.post('/api/v1/files/:id/lock', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  if (node.lockedBy && node.lockedBy !== req.user.id && !isAdmin(req.user)) throw createError(409, 'CONFLICT', '文件已被其他用户锁定');
  node.lockedBy = req.user.id;
  node.lockedAt = now();
  addAudit(req.db, req.user.id, 'file.lock', 'node', node.id, { targetPath: node.fullPath }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.post('/api/v1/files/:id/unlock', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  if (node.lockedBy && node.lockedBy !== req.user.id && !isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只能由锁定人或管理员解锁');
  node.lockedBy = null;
  node.lockedAt = null;
  addAudit(req.db, req.user.id, 'file.unlock', 'node', node.id, { targetPath: node.fullPath }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.get('/api/v1/files/:id/download', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:download');
  requireNodePasswordAccess(req, node);
  const version = req.query.versionId ? versionById(req.db, req.query.versionId) : currentVersion(req.db, node);
  if (!version || version.nodeId !== node.id) throw createError(404, 'NOT_FOUND', '版本不存在');
  if (sensitiveDownloadBlocked(req.db, req.user, node)) {
    addAudit(req.db, req.user.id, 'sensitive.download.blocked', 'node', node.id, {
      targetPath: node.fullPath,
      versionNo: version.versionNo,
      securityLevel: node.securityLevel,
      sensitive: Boolean(node.sensitive)
    }, req);
    await saveDb(req.db);
    throw sensitiveDownloadBlockError(node);
  }
  const securityPolicy = currentSecurityPolicy(req.db);
  const downloadExtension = extname(version.originalFilename || node.name);
  if (securityPolicy.enableDownloadWatermark && (downloadExtension === 'pdf' || OFFICE_PREVIEW_EXTENSIONS.has(downloadExtension))) {
    const converted = await convertVersionToPdf(req, node, version);
    const output = await addPdfWatermark(converted, pdfWatermarkText(req.db, req.user, node));
    const baseName = String(version.originalFilename || node.name).replace(/\.[^.]+$/, '');
    addAudit(req.db, req.user.id, 'file.download.watermarked', 'node', node.id, {
      targetPath: node.fullPath, versionNo: version.versionNo, securityLevel: node.securityLevel, sensitive: Boolean(node.sensitive)
    }, req);
    recordRecentAccess(req.db, req.user, node, 'download');
    await saveDb(req.db);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', output.length);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}-watermarked.pdf`)}`);
    res.end(output);
    return;
  }
  const action = node.sensitive ? 'sensitive.download' : 'file.download';
  addAudit(req.db, req.user.id, action, 'node', node.id, {
    targetPath: node.fullPath,
    versionNo: version.versionNo,
    securityLevel: node.securityLevel,
    sensitive: Boolean(node.sensitive)
  }, req);
  recordRecentAccess(req.db, req.user, node, 'download');
  void saveDbBestEffort(req.db, 'download access log');
  await streamVersion(res, version, version.originalFilename || node.name, { db: req.db, node });
}));

app.get('/api/v1/files/:id/export-pdf', requireAuth, asyncRoute(async (req, res) => {
  await controlledPdfOutput(req, res, { action: 'file:export_pdf', inline: false });
}));

app.get('/api/v1/files/:id/print', requireAuth, asyncRoute(async (req, res) => {
  await controlledPdfOutput(req, res, { action: 'file:print', inline: true });
}));

app.get('/storage/raw/:versionId', requireAuth, asyncRoute(async (req, res) => {
  const version = versionById(req.db, req.params.versionId);
  if (!version) throw createError(404, 'NOT_FOUND', '版本不存在');
  const node = nodeById(req.db, version.nodeId);
  requireNodeAction(req, node, 'file:preview');
  requireNodePasswordAccess(req, node);
  await streamVersion(res, version, null, { db: req.db, node });
}));

app.get('/api/v1/files/:id/preview', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:preview');
  requireNodePasswordAccess(req, node);
  const version = req.query.versionId ? versionById(req.db, req.query.versionId) : currentVersion(req.db, node);
  if (!version) throw createError(404, 'NOT_FOUND', '版本不存在');
  if (version.nodeId !== node.id) throw createError(404, 'NOT_FOUND', '版本不存在');
  const extension = node.extension || extname(version.originalFilename);
  const filename = String(version.originalFilename || node.name || '').toLowerCase();
  const token = encodeURIComponent(getBearer(req));
  const unlockTokenValue = unlockTokensFromRequest(req).join(',');
  const unlockToken = unlockTokenValue ? `&unlockToken=${encodeURIComponent(unlockTokenValue)}` : '';
  const rawUrl = `/storage/raw/${version.id}?token=${token}${unlockToken}`;
  let previewType = 'unsupported';
  let content = '';
  let officePreview = null;
  if (version.mimeType === 'application/pdf' || extension === 'pdf') previewType = 'pdf';
  else if (version.mimeType?.startsWith('image/')) previewType = 'image';
  else if (OFFICE_PREVIEW_EXTENSIONS.has(extension)) {
    previewType = 'office';
    const officeText = await extractSearchText(versionFilePath(version, node, req.db), extension, version.mimeType, version.originalFilename).catch(() => '');
    content = trimPreviewContent(officeText || version.searchText);
    const officeSettings = currentOfficePreviewSettings(req.db);
    const configurationIssue = officePreviewConfigurationIssue(req, officeSettings);
    const nativePreview = configurationIssue ? null : buildOnlyOfficePreview(req, node, version, extension);
    officePreview = {
      status: configurationIssue ? 'configuration_error' : (nativePreview ? 'native_ready' : 'text_fallback'),
      provider: 'ONLYOFFICE Docs',
      message: configurationIssue || (nativePreview
        ? '正在使用 ONLYOFFICE 原版预览；加载失败时可查看提取文本。'
        : '当前展示提取文本；原版排版预览需要在系统管理中配置 ONLYOFFICE Document Server。'),
      extension,
      native: nativePreview
    };
  } else if (JSON_PREVIEW_EXTENSIONS.has(extension)) {
    previewType = 'json';
    content = formatJsonPreview(await readPreviewText(version, node, req.db));
  } else if (version.mimeType?.startsWith('text/') || TEXT_PREVIEW_EXTENSIONS.has(extension) || TEXT_PREVIEW_FILENAMES.has(filename)) {
    previewType = 'text';
    content = await readPreviewText(version, node, req.db);
  }
  const policy = currentSecurityPolicy(req.db);
  if (node.sensitive && policy.logSensitiveAccess) {
    addAudit(req.db, req.user.id, 'sensitive.preview', 'node', node.id, {
      targetPath: node.fullPath,
      versionNo: version.versionNo,
      securityLevel: node.securityLevel,
      sensitive: true
    }, req);
  }
  recordRecentAccess(req.db, req.user, node, 'preview');
  void saveDbBestEffort(req.db, 'preview access log');
  res.json(ok({
    previewType,
    rawUrl,
    content,
    version: publicVersion(version),
    node: publicNode(req.db, req.user, node),
    watermark: {
      enabled: Boolean(policy.enablePreviewWatermark && (node.sensitive || node.securityLevel !== 'public')),
      text: watermarkTextFor(req.db, req.user, node),
      securityLevel: node.securityLevel,
      securityLevelLabel: SECURITY_LEVEL_LABELS[node.securityLevel] || node.securityLevel,
      sensitive: Boolean(node.sensitive)
    },
    officePreview
  }));
}));

app.post('/api/v1/files/:id/read-upload-messages', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能标记文件为已读');
  const readAt = now();
  let readCount = 0;
  req.db.messages
    .filter((item) => item.receiverId === req.user.id && !item.readAt && item.messageType === 'file.upload' && item.relatedNodeId === node.id)
    .forEach((item) => {
      item.readAt = readAt;
      readCount += 1;
    });
  if (readCount) void saveDbBestEffort(req.db, 'upload message read state');
  res.json(ok({ readCount, persisted: true }));
}));

app.post('/api/v1/files/batch-download', requireAuth, asyncRoute(async (req, res) => {
  const ids = req.body.nodeIds || [];
  const nodes = ids.map((id) => nodeById(req.db, id)).filter(Boolean);
  nodes.forEach((node) => requireNodeAction(req, node, node.nodeType === 'file' ? 'file:download' : 'visible'));
  nodes.forEach((node) => requireNodePasswordAccess(req, node));
  const blocked = nodes.flatMap((node) => blockedSensitiveDownloadNodes(req.db, req.user, node));
  if (blocked.length) {
    blocked.slice(0, 20).forEach((node) => {
      addAudit(req.db, req.user.id, 'sensitive.download.blocked', 'node', node.id, {
        targetPath: node.fullPath,
        securityLevel: node.securityLevel,
        sensitive: Boolean(node.sensitive),
        source: 'batch'
      }, req);
    });
    await saveDb(req.db);
    throw createError(403, 'SENSITIVE_DOWNLOAD_BLOCKED', `批量下载中包含 ${blocked.length} 个受控敏感文件，请先申请下载审批或移除后重试`);
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('文档打包下载.zip')}`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  await Promise.all(nodes.map((node) => recursiveZipNodes(req.db, archive, node, req.user, req)));
  addAudit(req.db, req.user.id, 'file.batch_download', 'node', 'batch', { count: nodes.length }, req);
  await saveDb(req.db);
  await archive.finalize();
}));

app.get('/api/v1/approvals', requireAuth, (req, res) => {
  const scope = req.query.scope || 'todo';
  let approvals = req.db.documentApprovals || [];
  if (scope === 'todo') approvals = approvals.filter((item) => item.status === 'pending' && (isAdmin(req.user) || currentApprovalStep(item)?.approverIds?.includes(req.user.id)));
  else if (scope === 'mine') approvals = approvals.filter((item) => item.requesterId === req.user.id);
  else if (scope === 'all') {
    if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看全部审批');
  } else {
    throw createError(400, 'VALIDATION_ERROR', '审批范围不正确');
  }
  if (req.query.status) approvals = approvals.filter((item) => item.status === req.query.status);
  if (req.query.type) approvals = approvals.filter((item) => (item.type || 'workflow') === req.query.type);
  const visibleApprovals = approvals
    .filter((item) => {
      const node = nodeById(req.db, item.nodeId);
      return node && hasAction(req.db, req.user, node, 'visible');
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((item) => publicApproval(req.db, req.user, item));
  sendPage(res, visibleApprovals, req.query.page, req.query.pageSize || 50);
});

app.get('/api/v1/approval-templates', requireAuth, (req, res) => {
  let items = req.db.approvalTemplates || [];
  if (!isAdmin(req.user)) items = items.filter((item) => item.status === 'enabled');
  if (req.query.type) items = items.filter((item) => item.type === req.query.type);
  res.json(ok(items
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map((item) => publicApprovalTemplate(req.db, item))));
});

app.post('/api/v1/approval-templates', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护审批模板');
  const timestamp = now();
  const template = {
    id: newId('apt_'),
    ...normalizeApprovalTemplate(req.db, req.body),
    createdBy: req.user.id,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  req.db.approvalTemplates.unshift(template);
  addAudit(req.db, req.user.id, 'approval_template.create', 'approval_template', template.id, { name: template.name, type: template.type, stepCount: template.steps.length }, req);
  await saveDb(req.db);
  res.json(ok(publicApprovalTemplate(req.db, template)));
}));

app.put('/api/v1/approval-templates/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护审批模板');
  const template = req.db.approvalTemplates.find((item) => item.id === req.params.id);
  if (!template) throw createError(404, 'NOT_FOUND', '审批模板不存在');
  Object.assign(template, normalizeApprovalTemplate(req.db, req.body, template), { updatedAt: now() });
  addAudit(req.db, req.user.id, 'approval_template.update', 'approval_template', template.id, { name: template.name, type: template.type, stepCount: template.steps.length }, req);
  await saveDb(req.db);
  res.json(ok(publicApprovalTemplate(req.db, template)));
}));

app.delete('/api/v1/approval-templates/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护审批模板');
  const template = req.db.approvalTemplates.find((item) => item.id === req.params.id);
  if (!template) throw createError(404, 'NOT_FOUND', '审批模板不存在');
  if ((req.db.documentApprovals || []).some((item) => item.templateId === template.id && item.status === 'pending')) {
    throw createError(409, 'CONFLICT', '该模板存在待处理审批，暂不能删除');
  }
  req.db.approvalTemplates = req.db.approvalTemplates.filter((item) => item.id !== template.id);
  addAudit(req.db, req.user.id, 'approval_template.delete', 'approval_template', template.id, { name: template.name, type: template.type }, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.post('/api/v1/approvals', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.body.nodeId);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const type = ['workflow', 'download', 'permission', 'publish', 'borrow', 'external'].includes(req.body.type) ? req.body.type : 'download';
  if (type === 'download' || type === 'borrow') {
    if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能对文件提交下载审批');
  }
  if (type === 'external' && node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能对文件提交外发审批');
  if (type === 'permission') {
    if (!Array.isArray(req.body.requestedActions) && !Array.isArray(req.body.actions)) throw createError(400, 'VALIDATION_ERROR', '请选择要申请的权限');
  }
  if (type === 'workflow' || type === 'publish') {
    requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
  }
  const pendingExists = (req.db.documentApprovals || []).some((item) => {
    if (item.status !== 'pending') return false;
    if (item.nodeId !== node.id || item.requesterId !== req.user.id) return false;
    if ((item.type || 'workflow') !== type) return false;
    if (type === 'workflow' || type === 'publish') return item.action === (type === 'publish' ? 'publish' : req.body.action);
    return true;
  });
  if (pendingExists) throw createError(409, 'CONFLICT', '已有待处理的同类审批申请');
  const approval = createApprovalRecord(req.db, req.user, node, { ...req.body, type }, req);
  await saveDb(req.db);
  res.json(ok(publicApproval(req.db, req.user, approval)));
}));

app.get('/api/v1/approvals/:id', requireAuth, (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  const node = nodeById(req.db, approval.nodeId);
  if (!node) throw createError(404, 'NOT_FOUND', '审批关联文件不存在');
  if (!isAdmin(req.user) && approval.requesterId !== req.user.id && !currentApprovalStep(approval)?.approverIds?.includes(req.user.id) && !(approval.ccUserIds || []).includes(req.user.id)) requireNodeAction(req, node, 'visible');
  res.json(ok(publicApproval(req.db, req.user, approval)));
});

app.post('/api/v1/approvals/:id/approve', requireAuth, asyncRoute(async (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  const node = nodeById(req.db, approval.nodeId);
  if (!node) throw createError(404, 'NOT_FOUND', '审批关联文件不存在');
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const result = decideApprovalStep(req.db, approval, node, req.user, 'approve', String(req.body.comment || '').trim(), req);
  addAudit(req.db, req.user.id, `${approval.type || 'workflow'}.approval.approve`, 'document_approval', approval.id, {
    targetPath: node.fullPath,
    type: approval.type || 'workflow',
    action: approval.action,
    requestedActions: approval.requestedActions || []
  }, req);
  await saveDb(req.db);
  res.json(ok({ approval: publicApproval(req.db, req.user, approval), node: publicNode(req.db, req.user, node), completed: result.completed }));
}));

app.post('/api/v1/approvals/:id/reject', requireAuth, asyncRoute(async (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  const node = nodeById(req.db, approval.nodeId);
  if (!node) throw createError(404, 'NOT_FOUND', '审批关联文件不存在');
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  decideApprovalStep(req.db, approval, node, req.user, 'reject', String(req.body.comment || '').trim(), req);
  addAudit(req.db, req.user.id, `${approval.type || 'workflow'}.approval.reject`, 'document_approval', approval.id, {
    targetPath: node.fullPath,
    type: approval.type || 'workflow',
    action: approval.action,
    requestedActions: approval.requestedActions || []
  }, req);
  await saveDb(req.db);
  res.json(ok(publicApproval(req.db, req.user, approval)));
}));

app.post('/api/v1/approvals/:id/withdraw', requireAuth, asyncRoute(async (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  if (approval.status !== 'pending') throw createError(409, 'CONFLICT', '只能撤回待处理审批');
  if (approval.requesterId !== req.user.id && !isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只能撤回自己的审批');
  approval.status = 'cancelled';
  approval.updatedAt = now();
  approval.decisionComment = String(req.body.comment || '申请人撤回').trim();
  recordApprovalEvent(approval, 'withdraw', req.user.id, { comment: approval.decisionComment });
  addAudit(req.db, req.user.id, 'approval.withdraw', 'document_approval', approval.id, { nodeId: approval.nodeId }, req);
  await saveDb(req.db);
  res.json(ok(publicApproval(req.db, req.user, approval)));
}));

app.post('/api/v1/approvals/:id/transfer', requireAuth, asyncRoute(async (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  if (!canManageCurrentApprovalStep(req.user, approval)) throw createError(403, 'FORBIDDEN', '只有当前审批人可以转交');
  const target = req.db.users.find((item) => item.id === req.body.userId && item.status === 'enabled');
  if (!target) throw createError(400, 'VALIDATION_ERROR', '请选择有效转交人');
  const step = currentApprovalStep(approval);
  step.approverIds = isAdmin(req.user) && !step.approverIds.includes(req.user.id)
    ? [target.id]
    : step.approverIds.map((id) => id === req.user.id ? target.id : id);
  if (!step.approverIds.includes(target.id)) step.approverIds.push(target.id);
  approval.approverId = step.approverIds[0];
  approval.updatedAt = now();
  recordApprovalEvent(approval, 'transfer', req.user.id, { toUserId: target.id, comment: String(req.body.comment || '').trim() });
  addMessage(req.db, target.id, 'approval.transfer', '审批已转交给你', `请处理${approvalActionLabel(approval)}申请`, approval.nodeId);
  addAudit(req.db, req.user.id, 'approval.transfer', 'document_approval', approval.id, { toUserId: target.id }, req);
  await saveDb(req.db);
  res.json(ok(publicApproval(req.db, req.user, approval)));
}));

app.post('/api/v1/approvals/:id/add-step', requireAuth, asyncRoute(async (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  if (!canManageCurrentApprovalStep(req.user, approval)) throw createError(403, 'FORBIDDEN', '只有当前审批人可以加签');
  const [step] = normalizeApprovalSteps(req.db, { steps: [{ name: req.body.name || '加签审批', mode: req.body.mode, approverIds: req.body.approverIds || [req.body.userId] }] });
  step.status = 'waiting';
  const insertAt = req.body.position === 'before' ? approval.currentStepIndex || 0 : (approval.currentStepIndex || 0) + 1;
  approval.steps = approvalSteps(approval);
  approval.steps.splice(insertAt, 0, step);
  if (req.body.position === 'before') {
    approval.steps[insertAt + 1].status = 'waiting';
    step.status = 'pending';
    approval.currentStepIndex = insertAt;
    notifyApprovalStep(req.db, approval, nodeById(req.db, approval.nodeId));
  }
  approval.updatedAt = now();
  recordApprovalEvent(approval, 'add_step', req.user.id, { stepId: step.id, position: req.body.position === 'before' ? 'before' : 'after' });
  addAudit(req.db, req.user.id, 'approval.add_step', 'document_approval', approval.id, { stepId: step.id }, req);
  await saveDb(req.db);
  res.json(ok(publicApproval(req.db, req.user, approval)));
}));

app.post('/api/v1/approvals/:id/remind', requireAuth, asyncRoute(async (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  if (approval.status !== 'pending') throw createError(409, 'CONFLICT', '审批已结束');
  if (approval.requesterId !== req.user.id && !isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有申请人可以催办');
  if (approval.lastRemindedAt && Date.now() - new Date(approval.lastRemindedAt).getTime() < 10 * 60 * 1000) throw createError(429, 'RATE_LIMITED', '请勿频繁催办');
  const step = currentApprovalStep(approval);
  step.approverIds.forEach((userId) => addMessage(req.db, userId, 'approval.remind', '审批催办', `${userDisplayName(req.db, req.user.id)} 催办${approvalActionLabel(approval)}申请`, approval.nodeId));
  approval.lastRemindedAt = now();
  approval.updatedAt = now();
  recordApprovalEvent(approval, 'remind', req.user.id);
  addAudit(req.db, req.user.id, 'approval.remind', 'document_approval', approval.id, { stepId: step.id }, req);
  await saveDb(req.db);
  res.json(ok(publicApproval(req.db, req.user, approval)));
}));

app.get('/api/v1/nodes/:id/attachments', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const items = req.db.attachments
    .filter((item) => item.nodeId === node.id)
    .filter((item) => !req.query.purpose || item.purposeCode === req.query.purpose)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => publicAttachment(req.db, item));
  res.json(ok(items));
});

app.post('/api/v1/nodes/:id/attachments', requireAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw createError(400, 'VALIDATION_ERROR', '请选择附件文件');
  await validateUploadedFileByPolicy(req.db, req.file);
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  const attachmentId = newId('att_');
  const purposeCode = String(req.body.purposeCode || '').trim();
  const purpose = attachmentPurposes(req.db).find((item) => item.code === purposeCode && item.enabled);
  if (!purpose) {
    await fs.rm(req.file.path, { force: true });
    throw createError(400, 'VALIDATION_ERROR', '请选择有效的附件用途');
  }
  const storageName = `${attachmentId}-${safeFilename(req.file.originalname)}`;
  const storageKey = path.join(config.uploadDir, storageName);
  await fs.rename(req.file.path, storageKey);
  const attachment = {
    id: attachmentId,
    nodeId: node.id,
    name: validateName(req.body.name || req.file.originalname),
    originalFilename: req.file.originalname,
    storageKey: storageName,
    sizeBytes: req.file.size,
    mimeType: req.file.mimetype || mime.lookup(req.file.originalname) || 'application/octet-stream',
    description: req.body.description || '',
    purposeCode: purpose.code,
    purposeName: purpose.name,
    createdBy: req.user.id,
    createdAt: now()
  };
  req.db.attachments.unshift(attachment);
  addAudit(req.db, req.user.id, 'attachment.create', 'node', node.id, { targetPath: node.fullPath, attachmentId }, req);
  await saveDb(req.db);
  res.json(ok(publicAttachment(req.db, attachment)));
}));

app.get('/api/v1/attachment-purposes', requireAuth, (req, res) => {
  res.json(ok(attachmentPurposes(req.db).filter((item) => item.enabled)));
});

app.get('/api/v1/system-settings/attachment-purposes', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护附件用途');
  res.json(ok(attachmentPurposes(req.db)));
});

app.put('/api/v1/system-settings/attachment-purposes', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护附件用途');
  req.db.settings.attachmentPurposes = normalizeAttachmentPurposes(req.body.purposes);
  addAudit(req.db, req.user.id, 'system.attachment_purposes.update', 'system_setting', 'attachment_purposes', { count: req.db.settings.attachmentPurposes.length }, req);
  await saveDb(req.db);
  res.json(ok(req.db.settings.attachmentPurposes));
}));

app.get('/api/v1/attachments/:id/download', requireAuth, asyncRoute(async (req, res) => {
  const attachment = req.db.attachments.find((item) => item.id === req.params.id);
  if (!attachment) throw createError(404, 'NOT_FOUND', '附件不存在');
  const node = nodeById(req.db, attachment.nodeId);
  requireNodeAction(req, node, 'file:download');
  requireNodePasswordAccess(req, node);
  const filePath = path.join(config.uploadDir, attachment.storageKey);
  if (!fsSync.existsSync(filePath)) throw createError(404, 'NOT_FOUND', '附件内容不存在');
  res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalFilename || attachment.name)}`);
  addAudit(req.db, req.user.id, 'attachment.download', 'attachment', attachment.id, { targetPath: node.fullPath }, req);
  await saveDb(req.db);
  fsSync.createReadStream(filePath).pipe(res);
}));

app.delete('/api/v1/attachments/:id', requireAuth, asyncRoute(async (req, res) => {
  const attachment = req.db.attachments.find((item) => item.id === req.params.id);
  if (!attachment) throw createError(404, 'NOT_FOUND', '附件不存在');
  const node = nodeById(req.db, attachment.nodeId);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  req.db.attachments = req.db.attachments.filter((item) => item.id !== attachment.id);
  const filePath = path.join(config.uploadDir, attachment.storageKey);
  if (fsSync.existsSync(filePath)) await fs.unlink(filePath);
  addAudit(req.db, req.user.id, 'attachment.delete', 'attachment', attachment.id, { targetPath: node.fullPath }, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/nodes/:id/relations', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const relations = req.db.fileRelations
    .filter((item) => item.nodeId === node.id || item.relatedNodeId === node.id)
    .filter((item) => {
      const otherId = item.nodeId === node.id ? item.relatedNodeId : item.nodeId;
      const other = nodeById(req.db, otherId);
      return other && hasAction(req.db, req.user, other, 'visible');
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => publicRelation(req.db, req.user, item));
  res.json(ok(relations));
});

app.post('/api/v1/nodes/:id/relations', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  const related = nodeById(req.db, req.body.relatedNodeId);
  requireNodeAction(req, related, 'visible');
  requireNodePasswordAccess(req, related);
  if (node.id === related.id) throw createError(400, 'VALIDATION_ERROR', '不能关联自身');
  const exists = req.db.fileRelations.some((item) => (
    (item.nodeId === node.id && item.relatedNodeId === related.id) ||
    (item.nodeId === related.id && item.relatedNodeId === node.id)
  ));
  if (exists) throw createError(409, 'CONFLICT', '关联关系已存在');
  const relation = {
    id: newId('rel_'),
    nodeId: node.id,
    relatedNodeId: related.id,
    relationType: req.body.relationType || 'related',
    description: req.body.description || '',
    createdBy: req.user.id,
    createdAt: now()
  };
  req.db.fileRelations.unshift(relation);
  addAudit(req.db, req.user.id, 'relation.create', 'node', node.id, { targetPath: node.fullPath, relatedNodeId: related.id }, req);
  await saveDb(req.db);
  res.json(ok(publicRelation(req.db, req.user, relation)));
}));

app.delete('/api/v1/relations/:id', requireAuth, asyncRoute(async (req, res) => {
  const relation = req.db.fileRelations.find((item) => item.id === req.params.id);
  if (!relation) throw createError(404, 'NOT_FOUND', '关联关系不存在');
  const node = nodeById(req.db, relation.nodeId);
  const related = nodeById(req.db, relation.relatedNodeId);
  if (!node && !related) throw createError(404, 'NOT_FOUND', '关联文件不存在');
  if (!isAdmin(req.user) && ![relation.createdBy, node?.createdBy, node?.ownerId, related?.createdBy, related?.ownerId].includes(req.user.id)) {
    if (!node || !hasAction(req.db, req.user, node, 'file:update')) throw createError(403, 'FORBIDDEN', '没有权限删除该关联');
  }
  req.db.fileRelations = req.db.fileRelations.filter((item) => item.id !== relation.id);
  addAudit(req.db, req.user.id, 'relation.delete', 'relation', relation.id, { nodeId: relation.nodeId, relatedNodeId: relation.relatedNodeId }, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/nodes/:id/permission-rules', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'permission:manage');
  res.json(ok(req.db.permissionRules.filter((item) => item.nodeId === node.id)));
});

app.get('/api/v1/permission-templates', requireAuth, (req, res) => {
  const items = (req.db.permissionTemplates || [])
    .map(publicPermissionTemplate)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  res.json(ok(items));
});

app.post('/api/v1/permission-templates', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护权限模板');
  const values = normalizePermissionTemplate(req.body);
  const timestamp = now();
  const template = {
    id: newId('pt_'),
    ...values,
    systemBuiltIn: false,
    createdBy: req.user.id,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  req.db.permissionTemplates.push(template);
  addAudit(req.db, req.user.id, 'permission_template.create', 'permission_template', template.id, template, req);
  await saveDb(req.db);
  res.json(ok(publicPermissionTemplate(template)));
}));

app.put('/api/v1/permission-templates/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护权限模板');
  const template = req.db.permissionTemplates.find((item) => item.id === req.params.id);
  if (!template) throw createError(404, 'NOT_FOUND', '权限模板不存在');
  Object.assign(template, normalizePermissionTemplate(req.body, template), { updatedAt: now() });
  addAudit(req.db, req.user.id, 'permission_template.update', 'permission_template', template.id, template, req);
  await saveDb(req.db);
  res.json(ok(publicPermissionTemplate(template)));
}));

app.delete('/api/v1/permission-templates/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护权限模板');
  const template = req.db.permissionTemplates.find((item) => item.id === req.params.id);
  if (!template) throw createError(404, 'NOT_FOUND', '权限模板不存在');
  req.db.permissionTemplates = req.db.permissionTemplates.filter((item) => item.id !== template.id);
  addAudit(req.db, req.user.id, 'permission_template.delete', 'permission_template', template.id, { name: template.name }, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.post('/api/v1/nodes/:id/permission-rules', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'permission:manage');
  const [subject] = normalizePermissionSubjects(req.body);
  const rule = permissionRuleFromPayload(req.db, node, req.user.id, { ...req.body, ...subject });
  req.db.permissionRules.push(rule);
  addAudit(req.db, req.user.id, 'permission.create', 'permission_rule', rule.id, { targetPath: node.fullPath, rule }, req);
  await saveDb(req.db);
  res.json(ok(rule));
}));

app.post('/api/v1/nodes/:id/permission-rules/batch', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'permission:manage');
  const template = req.body.templateId
    ? req.db.permissionTemplates.find((item) => item.id === req.body.templateId)
    : null;
  if (req.body.templateId && !template) throw createError(404, 'NOT_FOUND', '权限模板不存在');
  const subjects = normalizePermissionSubjects(req.body);
  const base = template ? normalizePermissionDefaults(template) : {};
  const defaults = normalizePermissionDefaults(req.body, base);
  let removed = 0;
  if (req.body.replaceExisting) {
    const targetKeys = new Set(subjects.map((item) => `${item.subjectType}:${item.subjectId || ''}`));
    const before = req.db.permissionRules.length;
    req.db.permissionRules = req.db.permissionRules.filter((rule) => {
      if (rule.nodeId !== node.id) return true;
      return !targetKeys.has(`${rule.subjectType}:${rule.subjectId || ''}`);
    });
    removed = before - req.db.permissionRules.length;
  }
  const created = subjects.map((subject) => permissionRuleFromPayload(req.db, node, req.user.id, { ...defaults, ...subject }));
  req.db.permissionRules.push(...created);
  addAudit(req.db, req.user.id, 'permission.batch_create', 'permission_rule', node.id, {
    targetPath: node.fullPath,
    templateId: template?.id || null,
    subjectCount: subjects.length,
    created: created.length,
    removed
  }, req);
  await saveDb(req.db);
  res.json(ok({ created, removed, template: publicPermissionTemplate(template) }));
}));

app.put('/api/v1/permission-rules/:id', requireAuth, asyncRoute(async (req, res) => {
  const rule = req.db.permissionRules.find((item) => item.id === req.params.id);
  if (!rule) throw createError(404, 'NOT_FOUND', '权限规则不存在');
  const node = nodeById(req.db, rule.nodeId);
  requireNodeAction(req, node, 'permission:manage');
  const subjectType = req.body.subjectType ?? rule.subjectType;
  const subjectId = subjectType === 'all' ? null : req.body.subjectId ?? rule.subjectId;
  ensureSubjectExists(req.db, subjectType, subjectId);
  const defaults = normalizePermissionDefaults(req.body, rule);
  Object.assign(rule, {
    subjectType,
    subjectId,
    ...defaults,
    updatedAt: now()
  });
  addAudit(req.db, req.user.id, 'permission.update', 'permission_rule', rule.id, { targetPath: node.fullPath }, req);
  await saveDb(req.db);
  res.json(ok(rule));
}));

app.delete('/api/v1/permission-rules/:id', requireAuth, asyncRoute(async (req, res) => {
  const rule = req.db.permissionRules.find((item) => item.id === req.params.id);
  if (!rule) throw createError(404, 'NOT_FOUND', '权限规则不存在');
  const node = nodeById(req.db, rule.nodeId);
  requireNodeAction(req, node, 'permission:manage');
  req.db.permissionRules = req.db.permissionRules.filter((item) => item.id !== req.params.id);
  addAudit(req.db, req.user.id, 'permission.delete', 'permission_rule', rule.id, { targetPath: node.fullPath }, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/nodes/:id/view-access', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'permission:manage');
  res.json(ok(viewAccessSummary(req.db, node)));
});

app.put('/api/v1/nodes/:id/view-access', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'permission:manage');
  const summary = replaceViewAccessRules(req.db, node, req.user.id, Boolean(req.body.restricted), req.body.audience || {});
  addAudit(req.db, req.user.id, 'permission.view_access.update', 'node', node.id, { targetPath: node.fullPath, restricted: summary.restricted, audience: summary.audience }, req);
  await saveDb(req.db);
  res.json(ok(summary));
}));

app.put('/api/v1/nodes/:id/password', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'permission:manage');
  const enabled = Boolean(req.body.enabled);
  if (enabled) {
    const password = String(req.body.password || '');
    if (password.length < 4) throw createError(400, 'VALIDATION_ERROR', '加密密码至少 4 位');
    const hp = hashPassword(password);
    node.passwordEnabled = true;
    node.passwordHash = hp.hash;
    node.passwordSalt = hp.salt;
    node.passwordUpdatedAt = now();
  } else {
    node.passwordEnabled = false;
    node.passwordHash = '';
    node.passwordSalt = '';
    node.passwordUpdatedAt = now();
  }
  node.updatedBy = req.user.id;
  node.updatedAt = now();
  addAudit(req.db, req.user.id, 'node.password.update', 'node', node.id, { targetPath: node.fullPath, enabled }, req);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.post('/api/v1/nodes/:id/password/verify', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  const protectedNode = passwordProtectedNodes(req.db, node).find((item) => !hasUnlockForNode(req, item)) || passwordProtectedNodes(req.db, node)[0];
  if (!protectedNode) throw createError(400, 'VALIDATION_ERROR', '该文件或文件夹未启用密码加密');
  if (!verifyPassword(String(req.body.password || ''), { passwordHash: protectedNode.passwordHash, passwordSalt: protectedNode.passwordSalt })) {
    addAudit(req.db, req.user.id, 'node.password.verify_failed', 'node', protectedNode.id, { targetPath: protectedNode.fullPath }, req);
    await saveDb(req.db);
    throw createError(400, 'VALIDATION_ERROR', '密码错误');
  }
  const unlockToken = signToken({ kind: 'node_unlock', userId: req.user.id, nodeId: protectedNode.id }, NODE_PASSWORD_UNLOCK_MS);
  addAudit(req.db, req.user.id, 'node.password.verify', 'node', protectedNode.id, { targetPath: protectedNode.fullPath }, req);
  await saveDb(req.db);
  res.json(ok({ unlockToken, nodeId: protectedNode.id, expiresInSeconds: Math.floor(NODE_PASSWORD_UNLOCK_MS / 1000) }));
}));

function searchCategoryText(db, node) {
  return db.documentCategories
    .filter((item) => item.nodeId === node.id)
    .map((item) => db.categories.find((category) => category.id === item.categoryId)?.name || '')
    .filter(Boolean)
    .join(' ');
}

function searchPropertyText(db, node) {
  return db.propertyValues
    .filter((item) => item.nodeId === node.id)
    .map((item) => item.value)
    .filter(Boolean)
    .join(' ');
}

function textSnippet(content, keyword, radius = 72) {
  const source = String(content || '').replace(/\s+/g, ' ').trim();
  const needle = String(keyword || '').trim();
  if (!source || !needle) return '';
  const index = source.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return source.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + needle.length + radius);
  return `${start > 0 ? '...' : ''}${source.slice(start, end)}${end < source.length ? '...' : ''}`;
}

function buildSearchMatch(req, db, node, version, keyword, cached = {}) {
  const needle = String(keyword || '').trim();
  if (!needle) return null;
  const lowered = needle.toLowerCase();
  const searchableContent = cached.searchableContent ?? (isNodePasswordAccessible(req, node) ? (version?.searchText || '') : '');
  const categoryNames = cached.categoryNames ?? searchCategoryText(db, node);
  const propertyText = cached.propertyText ?? searchPropertyText(db, node);
  const tags = (node.tags || []).join(' ');
  const checks = [
    ['name', '文件名', node.name],
    ['tag', '标签', tags],
    ['category', '知识分类', categoryNames],
    ['content', '正文内容', searchableContent],
    ['path', '路径', node.fullPath],
    ['property', '扩展属性', propertyText]
  ];
  const matched = checks.find(([, , value]) => String(value || '').toLowerCase().includes(lowered));
  if (!matched) return null;
  const [source, sourceLabel, value] = matched;
  const score = searchRelevanceScore(req, node, version, needle, { searchableContent, categoryNames, propertyText, tags });
  return {
    keyword: needle,
    source,
    sourceLabel,
    snippet: textSnippet(value, needle),
    indexStatus: version?.indexStatus || '',
    indexedChars: String(version?.searchText || '').length,
    score
  };
}

function searchRelevanceScore(req, node, version, keyword, cached = {}) {
  const needle = String(keyword || '').trim().toLowerCase();
  if (!needle) return 0;
  const name = String(node.name || '').toLowerCase();
  const fullPath = String(node.fullPath || '').toLowerCase();
  const tags = String(cached.tags ?? (node.tags || []).join(' ')).toLowerCase();
  const categoryNames = String(cached.categoryNames ?? searchCategoryText(req.db, node)).toLowerCase();
  const propertyText = String(cached.propertyText ?? searchPropertyText(req.db, node)).toLowerCase();
  const content = String(cached.searchableContent ?? (isNodePasswordAccessible(req, node) ? (version?.searchText || '') : '')).toLowerCase();
  let score = 0;
  if (name === needle) score += 220;
  else if (name.startsWith(needle)) score += 180;
  else if (name.includes(needle)) score += 145;
  if (tags.includes(needle)) score += 120;
  if (categoryNames.includes(needle)) score += 105;
  if (content.includes(needle)) {
    const firstIndex = content.indexOf(needle);
    const occurrences = content.split(needle).length - 1;
    score += 90 + Math.min(35, occurrences * 4);
    if (firstIndex >= 0 && firstIndex < 500) score += 12;
  }
  if (fullPath.includes(needle)) score += 60;
  if (propertyText.includes(needle)) score += 55;
  const updatedAt = new Date(node.updatedAt || node.createdAt || 0).getTime();
  if (updatedAt) {
    const ageDays = Math.max(0, (Date.now() - updatedAt) / (24 * 60 * 60 * 1000));
    score += Math.max(0, 24 - Math.min(24, ageDays / 7));
  }
  const recentAccess = (req.db.recentAccesses || []).find((item) => item.userId === req.user.id && item.nodeId === node.id);
  if (recentAccess) score += 18;
  const favorite = (req.db.favorites || []).find((item) => item.userId === req.user.id && item.nodeId === node.id);
  if (favorite) score += 15;
  if ((node.sourceType || 'local') === 'external') score += 2;
  return Math.round(score);
}

function buildSearchSuggestions(req, keyword, pathPrefix = '', limit = 8) {
  const normalizedKeyword = String(keyword || '').trim().toLowerCase();
  if (!normalizedKeyword) return [];
  const suggestions = [];
  const seen = new Set();
  const addSuggestion = (value, type, typeLabel, node, detail = '') => {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) return;
    const key = `${type}:${normalizedValue.toLowerCase()}:${node?.id || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push({
      value: normalizedValue,
      type,
      typeLabel,
      nodeId: node?.id || '',
      nodeName: node?.name || '',
      fullPath: node?.fullPath || '',
      detail: textSnippet(detail || node?.fullPath || node?.name || normalizedValue, normalizedKeyword, 42)
    });
  };
  listVisibleDescendants(req.db, req.user)
    .filter((node) => node.nodeType === 'file')
    .filter((node) => !pathPrefix || node.fullPath.startsWith(pathPrefix))
    .some((node) => {
      const version = currentVersion(req.db, node);
      const categoryNames = searchCategoryText(req.db, node);
      const propertyText = searchPropertyText(req.db, node);
      const searchableContent = isNodePasswordAccessible(req, node) ? (version?.searchText || '') : '';
      if (String(node.name || '').toLowerCase().includes(normalizedKeyword)) addSuggestion(node.name, 'name', '文件名', node);
      (node.tags || [])
        .filter((tag) => String(tag || '').toLowerCase().includes(normalizedKeyword))
        .forEach((tag) => addSuggestion(tag, 'tag', '标签', node));
      categoryNames
        .split(/\s+/)
        .filter((name) => name.toLowerCase().includes(normalizedKeyword))
        .forEach((name) => addSuggestion(name, 'category', '知识分类', node));
      if (String(node.fullPath || '').toLowerCase().includes(normalizedKeyword)) addSuggestion(normalizedKeyword, 'path', '路径', node, node.fullPath);
      if (propertyText.toLowerCase().includes(normalizedKeyword)) addSuggestion(normalizedKeyword, 'property', '扩展属性', node, propertyText);
      if (searchableContent.toLowerCase().includes(normalizedKeyword)) addSuggestion(normalizedKeyword, 'content', '正文内容', node, searchableContent);
      return suggestions.length >= limit * 2;
    });
  return suggestions
    .sort((a, b) => {
      const rank = { name: 1, content: 2, tag: 3, category: 4, path: 5, property: 6 };
      return (rank[a.type] || 99) - (rank[b.type] || 99);
    })
    .slice(0, limit);
}

function searchIndexStatus(db) {
  const counts = { ready: 0, empty: 0, unsupported: 0, failed: 0, pending: 0 };
  let indexedChars = 0;
  let lastIndexedAt = null;
  const files = db.nodes.filter((node) => node.nodeType === 'file' && node.status !== 'deleted');
  files.forEach((node) => {
    const version = currentVersion(db, node);
    if (!version) {
      counts.pending += 1;
      return;
    }
    const status = version.indexStatus || (version.searchText ? 'ready' : 'pending');
    counts[status] = (counts[status] || 0) + 1;
    indexedChars += String(version.searchText || '').length;
    if (version.indexedAt && (!lastIndexedAt || new Date(version.indexedAt).getTime() > new Date(lastIndexedAt).getTime())) {
      lastIndexedAt = version.indexedAt;
    }
  });
  return {
    total: files.length,
    indexed: counts.ready,
    indexedChars,
    lastIndexedAt,
    counts
  };
}

const QUALITY_LEVEL_LABELS = {
  excellent: '优秀',
  good: '良好',
  fair: '待完善',
  poor: '较差'
};

const REVIEW_STATUS_LABELS = {
  not_scheduled: '未设置',
  normal: '正常',
  due_soon: '即将到期',
  overdue: '已逾期'
};

function qualityLevel(score) {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

function documentQuality(db, node) {
  const version = currentVersion(db, node);
  const dimensions = [];
  const suggestions = [];
  const addDimension = (key, label, score, maxScore, detail, suggestion = '') => {
    dimensions.push({ key, label, score, maxScore, detail });
    if (score < maxScore && suggestion) suggestions.push({ key, label, priority: maxScore - score, suggestion });
  };

  const nameStem = path.parse(String(node.name || '')).name.trim();
  const weakName = !nameStem || nameStem.length < 3 || /^(?:新建|未命名|副本|copy|document|file|文档|文件)?[\s_-]*\d*$/i.test(nameStem);
  addDimension('name', '文件名称', weakName ? 0 : 15, 15, weakName ? '名称过短或属于默认名称' : '名称清晰', '使用能表达资料主题的文件名称');

  const description = String(version?.description || '').trim();
  const genericDescription = /^(?:初始版本|上传更新|服务器目录同步|服务器文件变更同步)$/i.test(description);
  const descriptionScore = !description ? 0 : (genericDescription || description.length < 6 ? 8 : 15);
  addDimension('version_description', '版本说明', descriptionScore, 15, descriptionScore === 15 ? '当前版本说明完整' : (description ? '当前说明较简单' : '当前版本没有说明'), '补充本次版本的变更内容或用途');

  const tags = (node.tags || []).map((item) => String(item || '').trim()).filter(Boolean);
  const tagScore = tags.length >= 2 ? 15 : (tags.length === 1 ? 8 : 0);
  addDimension('tags', '标签', tagScore, 15, tags.length ? `已维护 ${tags.length} 个标签` : '未维护标签', '至少维护两个便于检索的业务标签');

  const categoryCount = db.documentCategories.filter((item) => item.nodeId === node.id).length;
  addDimension('category', '知识分类', categoryCount ? 15 : 0, 15, categoryCount ? `已关联 ${categoryCount} 个分类` : '未关联知识分类', '关联一个合适的知识分类');

  const propertyCount = db.propertyValues.filter((item) => item.nodeId === node.id && String(item.value ?? '').trim()).length;
  addDimension('properties', '扩展属性', propertyCount ? 10 : 0, 10, propertyCount ? `已维护 ${propertyCount} 个属性` : '未维护扩展属性', '补充适合该资料类型的扩展属性');

  ensureNodeSecurityShape(db, node);
  const securityScore = node.securityLevel && (!node.sensitive || String(node.sensitiveReason || '').trim()) ? 10 : 5;
  addDimension('security', '安全信息', securityScore, 10, securityScore === 10 ? '密级和敏感信息完整' : '敏感文件缺少敏感原因', '补充敏感原因，便于审计和审批判断');

  const indexReady = version?.indexStatus === 'ready';
  addDimension('search_index', '可检索内容', indexReady ? 10 : 0, 10, indexReady ? '正文索引可用' : `索引状态：${version?.indexStatus || '未建立'}`, '重建全文索引或检查文件格式');

  ensureNodeGovernanceShape(node);
  const reviewReady = Boolean(node.reviewEnabled && node.reviewOwnerId && node.nextReviewAt);
  addDimension('review_plan', '复审计划', reviewReady ? 10 : 0, 10, reviewReady ? '已设置负责人和复审时间' : '未设置完整复审计划', '为重要资料设置复审负责人和周期');

  const score = dimensions.reduce((sum, item) => sum + item.score, 0);
  const level = qualityLevel(score);
  return {
    nodeId: node.id,
    score,
    level,
    levelLabel: QUALITY_LEVEL_LABELS[level],
    dimensions,
    suggestions: suggestions.sort((a, b) => b.priority - a.priority),
    evaluatedAt: now()
  };
}

function normalizeDuplicateName(filename) {
  const stem = path.parse(String(filename || '').normalize('NFKC')).name.toLowerCase();
  return stem
    .replace(/(?:副本|copy)(?:\s*\d+)?/gi, '')
    .replace(/[\s._\-—–()（）\[\]【】]+/g, '')
    .trim();
}

function duplicateGroupId(type, key) {
  return `dup_${type}_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

function duplicateFileGroups(db, user, unreadUploadCounts = unreadUploadCountsByNode(db, user)) {
  const files = db.nodes
    .filter((node) => node.nodeType === 'file' && node.status !== 'deleted')
    .map((node) => ({ node, version: currentVersion(db, node) }))
    .filter((item) => item.version);
  const exactBuckets = new Map();
  files.forEach((item) => {
    const md5 = String(item.version.md5 || '').trim();
    if (!md5) return;
    if (!exactBuckets.has(md5)) exactBuckets.set(md5, []);
    exactBuckets.get(md5).push(item);
  });
  const exactNodeIds = new Set();
  const exact = [...exactBuckets.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([md5, items]) => {
      items.forEach((item) => exactNodeIds.add(item.node.id));
      const sizes = items.map((item) => Number(item.version.sizeBytes || 0));
      return {
        id: duplicateGroupId('exact', md5),
        type: 'exact',
        typeLabel: '完全重复',
        confidence: 100,
        fileCount: items.length,
        wastedBytes: Math.max(0, sizes.reduce((sum, value) => sum + value, 0) - Math.max(...sizes)),
        files: items.map(({ node, version }) => ({ ...publicNode(db, user, node, { unreadUploadCounts }), duplicateVersion: publicVersion(version) }))
      };
    });

  const probableBuckets = new Map();
  files.filter((item) => !exactNodeIds.has(item.node.id)).forEach((item) => {
    const normalizedName = normalizeDuplicateName(item.node.name);
    if (!normalizedName) return;
    const key = `${normalizedName}|${item.node.extension || ''}`;
    if (!probableBuckets.has(key)) probableBuckets.set(key, []);
    probableBuckets.get(key).push(item);
  });
  const probable = [...probableBuckets.entries()]
    .filter(([, items]) => items.length > 1)
    .filter(([, items]) => {
      const sizes = items.map((item) => Number(item.version.sizeBytes || 0));
      const min = Math.min(...sizes);
      const max = Math.max(...sizes);
      return max - min <= Math.max(4096, max * 0.02);
    })
    .map(([key, items]) => {
      const sizes = items.map((item) => Number(item.version.sizeBytes || 0));
      return {
        id: duplicateGroupId('probable', key),
        type: 'probable',
        typeLabel: '疑似重复',
        confidence: 80,
        fileCount: items.length,
        wastedBytes: Math.max(0, sizes.reduce((sum, value) => sum + value, 0) - Math.max(...sizes)),
        files: items.map(({ node, version }) => ({ ...publicNode(db, user, node, { unreadUploadCounts }), duplicateVersion: publicVersion(version) }))
      };
    });
  return [...exact, ...probable].sort((a, b) => b.wastedBytes - a.wastedBytes || b.fileCount - a.fileCount);
}

function searchAnalytics(db, days = 30) {
  const normalizedDays = Math.max(1, Math.min(365, Number(days || 30)));
  const from = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
  const events = (db.searchEvents || []).filter((item) => new Date(item.createdAt).getTime() >= from);
  const keywordMap = new Map();
  events.forEach((item) => {
    const key = item.normalizedKeyword || String(item.keyword || '').trim().toLowerCase();
    if (!key) return;
    const current = keywordMap.get(key) || { keyword: item.keyword, count: 0, zeroResultCount: 0, totalResults: 0, lastSearchedAt: item.createdAt };
    current.count += 1;
    current.totalResults += Number(item.resultCount || 0);
    if (!item.resultCount) current.zeroResultCount += 1;
    if (String(item.createdAt || '') > String(current.lastSearchedAt || '')) {
      current.keyword = item.keyword;
      current.lastSearchedAt = item.createdAt;
    }
    keywordMap.set(key, current);
  });
  const popularKeywords = [...keywordMap.values()]
    .map((item) => ({ ...item, averageResults: item.count ? Math.round(item.totalResults / item.count) : 0 }))
    .sort((a, b) => b.count - a.count || b.lastSearchedAt.localeCompare(a.lastSearchedAt))
    .slice(0, 12);
  const zeroResultKeywords = [...keywordMap.values()]
    .filter((item) => item.zeroResultCount > 0)
    .sort((a, b) => b.zeroResultCount - a.zeroResultCount || b.count - a.count)
    .slice(0, 12);
  const zeroResultSearches = events.filter((item) => !item.resultCount).length;
  return {
    days: normalizedDays,
    stats: {
      totalSearches: events.length,
      uniqueKeywords: keywordMap.size,
      zeroResultSearches,
      zeroResultRate: events.length ? Math.round((zeroResultSearches / events.length) * 1000) / 10 : 0
    },
    popularKeywords,
    zeroResultKeywords,
    recentSearches: events.slice(0, 20).map((item) => ({
      ...item,
      user: pickPublicUser(db.users.find((user) => user.id === item.userId))
    }))
  };
}

function governanceReviewCounts(files) {
  return files.reduce((counts, node) => {
    const status = reviewStatusForNode(node);
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, { not_scheduled: 0, normal: 0, due_soon: 0, overdue: 0 });
}

function governanceQualityCounts(qualities) {
  return qualities.reduce((counts, quality) => {
    counts[quality.level] = (counts[quality.level] || 0) + 1;
    return counts;
  }, { excellent: 0, good: 0, fair: 0, poor: 0 });
}

function governanceAnalysis(req) {
  const files = req.db.nodes.filter((node) => node.nodeType === 'file' && node.status !== 'deleted');
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  return {
    files,
    qualityRows: files.map((node) => ({ node, quality: documentQuality(req.db, node) })),
    duplicateGroups: duplicateFileGroups(req.db, req.user, unreadUploadCounts),
    unreadUploadCounts
  };
}

function governanceDashboard(req, analysis = governanceAnalysis(req), analytics = searchAnalytics(req.db, 30)) {
  const { files, qualityRows, duplicateGroups, unreadUploadCounts } = analysis;
  const duplicateNodeIds = new Set(duplicateGroups.flatMap((group) => group.files.map((file) => file.id)));
  const reviews = governanceReviewCounts(files);
  const qualityDistribution = governanceQualityCounts(qualityRows.map((item) => item.quality));
  const averageQualityScore = qualityRows.length
    ? Math.round(qualityRows.reduce((sum, item) => sum + item.quality.score, 0) / qualityRows.length)
    : 0;
  const issueRows = qualityRows
    .map(({ node, quality }) => {
      const reviewStatus = reviewStatusForNode(node);
      const issueTypes = [];
      if (quality.score < 70) issueTypes.push('quality');
      if (reviewStatus === 'due_soon') issueTypes.push('review_due_soon');
      if (reviewStatus === 'overdue') issueTypes.push('review_overdue');
      if (duplicateNodeIds.has(node.id)) issueTypes.push('duplicate');
      return { node, quality, reviewStatus, issueTypes };
    })
    .filter((item) => item.issueTypes.length)
    .sort((a, b) => {
      const severity = (item) => (item.issueTypes.includes('review_overdue') ? 1000 : 0) + (item.issueTypes.includes('duplicate') ? 300 : 0) + (100 - item.quality.score);
      return severity(b) - severity(a);
    })
    .slice(0, 40)
    .map((item) => ({
      ...publicNode(req.db, req.user, item.node, { unreadUploadCounts }),
      quality: item.quality,
      reviewStatus: item.reviewStatus,
      reviewStatusLabel: REVIEW_STATUS_LABELS[item.reviewStatus],
      issueTypes: item.issueTypes
    }));

  const accessCounts = new Map();
  (req.db.recentAccesses || []).forEach((item) => accessCounts.set(item.nodeId, (accessCounts.get(item.nodeId) || 0) + 1));
  const popularDocuments = [...accessCounts.entries()]
    .map(([nodeId, accessCount]) => ({ node: nodeById(req.db, nodeId), accessCount }))
    .filter((item) => item.node?.nodeType === 'file')
    .sort((a, b) => b.accessCount - a.accessCount)
    .slice(0, 10)
    .map((item) => ({ ...publicNode(req.db, req.user, item.node, { unreadUploadCounts }), accessCount: item.accessCount }));
  return {
    stats: {
      files: files.length,
      averageQualityScore,
      lowQualityFiles: qualityRows.filter((item) => item.quality.score < 70).length,
      dueSoonReviews: reviews.due_soon,
      overdueReviews: reviews.overdue,
      duplicateGroups: duplicateGroups.length,
      duplicateFiles: duplicateNodeIds.size,
      duplicateWastedBytes: duplicateGroups.reduce((sum, group) => sum + group.wastedBytes, 0),
      zeroResultSearches: analytics.stats.zeroResultSearches,
      zeroResultRate: analytics.stats.zeroResultRate
    },
    qualityDistribution,
    reviewDistribution: reviews,
    issues: issueRows,
    popularKeywords: analytics.popularKeywords,
    zeroResultKeywords: analytics.zeroResultKeywords,
    popularDocuments,
    generatedAt: now()
  };
}

async function rebuildSearchIndexForNode(db, node) {
  const version = currentVersion(db, node);
  if (!version) return { status: 'failed', error: '当前版本不存在' };
  const extension = node.extension || extname(version.originalFilename || node.name || '');
  const filename = version.originalFilename || node.name || '';
  const mimeType = version.mimeType || mime.lookup(filename) || 'application/octet-stream';
  version.indexedAt = now();
  if (!supportsSearchText(extension, mimeType, filename)) {
    version.searchText = '';
    version.indexStatus = 'unsupported';
    version.indexError = '';
    return { status: 'unsupported' };
  }
  const filePath = versionFilePath(version, node, db);
  if (!filePath || !fsSync.existsSync(filePath)) {
    version.indexStatus = 'failed';
    version.indexError = '文件不存在';
    return { status: 'failed', error: version.indexError };
  }
  try {
    const searchText = await extractSearchText(filePath, extension, mimeType, filename);
    version.searchText = searchText;
    version.indexStatus = indexStatusForSearchText(searchText, extension, mimeType, filename);
    version.indexError = '';
    return { status: version.indexStatus };
  } catch (error) {
    version.indexStatus = 'failed';
    version.indexError = error.message || '索引失败';
    return { status: 'failed', error: version.indexError };
  }
}

app.post('/api/v1/search/files', requireAuth, asyncRoute(async (req, res) => {
  const keyword = String(req.body.keyword || '').trim();
  const normalizedKeyword = keyword.toLowerCase();
  const fileTypes = req.body.fileTypes || [];
  const securityLevels = Array.isArray(req.body.securityLevels) ? req.body.securityLevels.filter((item) => SECURITY_LEVELS.includes(item)) : [];
  const categoryIds = Array.isArray(req.body.categoryIds) ? req.body.categoryIds.map(String).filter(Boolean) : [];
  const tags = Array.isArray(req.body.tags) ? req.body.tags.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : [];
  const pathPrefix = req.body.pathPrefix || '';
  const creatorId = req.body.creatorId || '';
  const updatedFrom = req.body.updatedFrom ? new Date(req.body.updatedFrom).getTime() : null;
  const updatedTo = req.body.updatedTo ? new Date(req.body.updatedTo).getTime() : null;
  const requestedSortBy = String(req.body.sortBy || '').trim();
  const sortBy = ['relevance', 'name', 'fullPath', 'createdAt', 'updatedAt', 'extension', 'sizeBytes'].includes(requestedSortBy)
    ? requestedSortBy
    : (normalizedKeyword ? 'relevance' : 'updatedAt');
  const sortDir = req.body.sortDir === 'asc' ? 'asc' : 'desc';
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  const results = listVisibleDescendants(req.db, req.user)
    .filter((node) => node.nodeType === 'file')
    .filter((node) => !pathPrefix || node.fullPath.startsWith(pathPrefix))
    .filter((node) => !fileTypes.length || fileTypes.includes(node.extension))
    .filter((node) => !securityLevels.length || securityLevels.includes(node.securityLevel))
    .filter((node) => !categoryIds.length || categoryIds.every((categoryId) => req.db.documentCategories.some((item) => item.nodeId === node.id && item.categoryId === categoryId)))
    .filter((node) => !tags.length || tags.every((tag) => (node.tags || []).some((item) => String(item).toLowerCase() === tag)))
    .filter((node) => !creatorId || node.createdBy === creatorId)
    .filter((node) => !updatedFrom || new Date(node.updatedAt).getTime() >= updatedFrom)
    .filter((node) => !updatedTo || new Date(node.updatedAt).getTime() <= updatedTo)
    .map((node) => {
      const version = currentVersion(req.db, node);
      const categoryNames = searchCategoryText(req.db, node);
      const propertyText = searchPropertyText(req.db, node);
      const searchableContent = isNodePasswordAccessible(req, node) ? (version?.searchText || '') : '';
      const searchMatch = buildSearchMatch(req, req.db, node, version, keyword, { categoryNames, propertyText, searchableContent });
      return { node, version, categoryNames, propertyText, searchableContent, searchMatch };
    })
    .filter(({ node, version, categoryNames, propertyText, searchableContent }) => {
      if (!normalizedKeyword) return true;
      const haystack = `${node.name} ${node.fullPath} ${(node.tags || []).join(' ')} ${categoryNames} ${propertyText} ${searchableContent}`.toLowerCase();
      return haystack.includes(normalizedKeyword);
    })
    .sort((a, b) => {
      if (sortBy === 'relevance') {
        const scoreDiff = Number(a.searchMatch?.score || 0) - Number(b.searchMatch?.score || 0);
        if (scoreDiff !== 0) return sortDir === 'asc' ? scoreDiff : -scoreDiff;
        const updatedDiff = new Date(a.node.updatedAt || 0).getTime() - new Date(b.node.updatedAt || 0).getTime();
        if (updatedDiff !== 0) return -updatedDiff;
        return String(a.node.name || '').localeCompare(String(b.node.name || ''), 'zh-Hans-CN');
      }
      const left = sortBy === 'sizeBytes' ? Number(a.version?.sizeBytes || 0) : String(a.node[sortBy] || '');
      const right = sortBy === 'sizeBytes' ? Number(b.version?.sizeBytes || 0) : String(b.node[sortBy] || '');
      const result = typeof left === 'number' ? left - right : left.localeCompare(right, 'zh-Hans-CN');
      return sortDir === 'asc' ? result : -result;
    })
    .map(({ node, searchMatch }) => ({
      ...publicNode(req.db, req.user, node, { unreadUploadCounts }),
      matchedKeyword: keyword,
      highlight: searchMatch?.source === 'content' ? keyword : '',
      searchMatch
    }));
  if (keyword || fileTypes.length || securityLevels.length || categoryIds.length || tags.length || creatorId || updatedFrom || updatedTo) {
    req.db.searchEvents.unshift({
      id: newId('search_'),
      userId: req.user.id,
      keyword,
      normalizedKeyword,
      resultCount: results.length,
      pathPrefix,
      filters: {
        fileTypes,
        securityLevels,
        categoryIds,
        tags,
        creatorId,
        updatedFrom: req.body.updatedFrom || null,
        updatedTo: req.body.updatedTo || null,
        sortBy,
        sortDir
      },
      createdAt: now()
    });
    req.db.searchEvents = req.db.searchEvents.slice(0, 5000);
    void saveDbBestEffort(req.db, 'search event');
  }
  sendPage(res, results, req.body.page, req.body.pageSize);
}));

app.get('/api/v1/search/suggestions', requireAuth, (req, res) => {
  const keyword = String(req.query.keyword || req.query.q || '').trim();
  const pathPrefix = String(req.query.pathPrefix || '');
  const limit = Math.max(1, Math.min(20, Number(req.query.limit || 8)));
  res.json(ok(buildSearchSuggestions(req, keyword, pathPrefix, limit)));
});

app.get('/api/v1/search/recent', requireAuth, (req, res) => {
  const limit = Math.max(1, Math.min(30, Number(req.query.limit || 10)));
  const seen = new Set();
  const items = (req.db.searchEvents || [])
    .filter((item) => item.userId === req.user.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .filter((item) => {
      const key = JSON.stringify({ keyword: item.keyword || '', pathPrefix: item.pathPrefix || '', filters: item.filters || {} });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      keyword: item.keyword || '',
      resultCount: item.resultCount,
      pathPrefix: item.pathPrefix || '',
      filters: item.filters || {},
      createdAt: item.createdAt
    }));
  res.json(ok(items));
});

app.delete('/api/v1/search/recent', requireAuth, asyncRoute(async (req, res) => {
  const before = req.db.searchEvents.length;
  req.db.searchEvents = req.db.searchEvents.filter((item) => item.userId !== req.user.id);
  await saveDb(req.db);
  res.json(ok({ deleted: before - req.db.searchEvents.length }));
}));

app.get('/api/v1/search/index/status', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看全文索引状态');
  res.json(ok(searchIndexStatus(req.db)));
});

app.post('/api/v1/search/index/rebuild', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以重建全文索引');
  const files = req.db.nodes.filter((node) => node.nodeType === 'file' && node.status !== 'deleted');
  const summary = { total: files.length, rebuilt: 0, failed: 0, empty: 0, unsupported: 0 };
  for (const node of files) {
    const result = await rebuildSearchIndexForNode(req.db, node);
    if (result.status === 'ready') summary.rebuilt += 1;
    else if (result.status === 'empty') summary.empty += 1;
    else if (result.status === 'unsupported') summary.unsupported += 1;
    else summary.failed += 1;
  }
  addAudit(req.db, req.user.id, 'search.index.rebuild', 'system_setting', 'search_index', summary, req);
  await saveDb(req.db);
  res.json(ok({ ...summary, status: searchIndexStatus(req.db) }));
}));

app.get('/api/v1/governance/dashboard', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看知识治理工作台');
  res.json(ok(governanceDashboard(req)));
});

function governanceQualityRows(req, query = req.query, analysis = null) {
  const level = String(query.level || '');
  const maxScore = query.maxScore === undefined ? null : Number(query.maxScore);
  const keyword = String(query.keyword || '').trim().toLowerCase();
  const qualityRows = analysis?.qualityRows || req.db.nodes
    .filter((node) => node.nodeType === 'file' && node.status !== 'deleted')
    .map((node) => ({ node, quality: documentQuality(req.db, node) }));
  const unreadUploadCounts = analysis?.unreadUploadCounts || unreadUploadCountsByNode(req.db, req.user);
  return qualityRows
    .map(({ node, quality }) => ({ ...publicNode(req.db, req.user, node, { unreadUploadCounts }), quality }))
    .filter((item) => !level || item.quality.level === level)
    .filter((item) => maxScore === null || item.quality.score <= maxScore)
    .filter((item) => !keyword || `${item.name} ${item.fullPath}`.toLowerCase().includes(keyword))
    .sort((a, b) => a.quality.score - b.quality.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

app.get('/api/v1/governance/quality', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看全库质量清单');
  sendPage(res, governanceQualityRows(req), req.query.page, req.query.pageSize || 100);
});

function governanceDuplicateData(req, type = '', analysis = null) {
  const groups = (analysis?.duplicateGroups || duplicateFileGroups(req.db, req.user))
    .filter((item) => !type || item.type === type);
  return {
    groups,
    summary: {
      groupCount: groups.length,
      fileCount: new Set(groups.flatMap((group) => group.files.map((file) => file.id))).size,
      exactGroups: groups.filter((item) => item.type === 'exact').length,
      probableGroups: groups.filter((item) => item.type === 'probable').length,
      wastedBytes: groups.reduce((sum, group) => sum + group.wastedBytes, 0)
    }
  };
}

app.get('/api/v1/governance/duplicates', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看重复文件检测结果');
  const type = String(req.query.type || '');
  res.json(ok(governanceDuplicateData(req, type)));
});

function governanceReviewRows(req, query = req.query, analysis = null) {
  const status = String(query.status || '');
  const ownerId = String(query.ownerId || '');
  const keyword = String(query.keyword || '').trim().toLowerCase();
  const files = analysis?.files || req.db.nodes.filter((node) => node.nodeType === 'file' && node.status !== 'deleted');
  const unreadUploadCounts = analysis?.unreadUploadCounts || unreadUploadCountsByNode(req.db, req.user);
  return files
    .map((node) => ({ ...publicNode(req.db, req.user, node, { unreadUploadCounts }), reviewStatus: reviewStatusForNode(node), reviewStatusLabel: REVIEW_STATUS_LABELS[reviewStatusForNode(node)] }))
    .filter((item) => !status || item.reviewStatus === status)
    .filter((item) => !ownerId || item.review.ownerId === ownerId)
    .filter((item) => !keyword || `${item.name} ${item.fullPath}`.toLowerCase().includes(keyword))
    .sort((a, b) => {
      const rank = { overdue: 0, due_soon: 1, normal: 2, not_scheduled: 3 };
      return (rank[a.reviewStatus] ?? 9) - (rank[b.reviewStatus] ?? 9) || String(a.review.nextReviewAt || '9999').localeCompare(String(b.review.nextReviewAt || '9999'));
    });
}

app.get('/api/v1/governance/reviews', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看全库复审清单');
  sendPage(res, governanceReviewRows(req), req.query.page, req.query.pageSize || 100);
});

app.get('/api/v1/governance/search-analytics', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看搜索运营分析');
  res.json(ok(searchAnalytics(req.db, req.query.days || 30)));
});

app.get('/api/v1/governance/workspace', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看知识治理工作台');
  const analysis = governanceAnalysis(req);
  const analytics = searchAnalytics(req.db, req.query.days || 30);
  res.json(ok({
    dashboard: governanceDashboard(req, analysis, analytics),
    quality: pageData(governanceQualityRows(req, req.query, analysis), req.query.page, req.query.pageSize || 100),
    duplicates: governanceDuplicateData(req, String(req.query.type || ''), analysis),
    reviews: pageData(governanceReviewRows(req, req.query, analysis), req.query.page, req.query.pageSize || 100),
    searchAnalytics: analytics
  }));
});

app.get('/api/v1/nodes/:id/quality', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只有文件可以进行质量评估');
  res.json(ok({ node: publicNode(req.db, req.user, node), quality: documentQuality(req.db, node) }));
});

app.get('/api/v1/nodes/:id/review', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只有文件可以设置复审');
  res.json(ok({
    node: publicNode(req.db, req.user, node),
    review: publicReviewSettings(req.db, node),
    canConfigure: isAdmin(req.user) || hasAction(req.db, req.user, node, 'file:update'),
    canComplete: isAdmin(req.user) || node.reviewOwnerId === req.user.id
  }));
});

app.put('/api/v1/nodes/:id/review', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只有文件可以设置复审');
  const enabled = Boolean(req.body.enabled);
  const cycleDays = Math.max(1, Math.min(3650, Number(req.body.cycleDays || req.body.reviewCycleDays || node.reviewCycleDays || 365)));
  const ownerId = enabled ? String(req.body.ownerId || req.body.reviewOwnerId || '').trim() : null;
  const owner = ownerId ? req.db.users.find((item) => item.id === ownerId && item.status === 'enabled') : null;
  if (enabled && !owner) throw createError(400, 'VALIDATION_ERROR', '启用复审时请选择有效的复审负责人');
  let nextReviewAt = enabled ? String(req.body.nextReviewAt || '').trim() : null;
  if (enabled && !nextReviewAt) nextReviewAt = new Date(Date.now() + cycleDays * 24 * 60 * 60 * 1000).toISOString();
  if (nextReviewAt && !Number.isFinite(new Date(nextReviewAt).getTime())) throw createError(400, 'VALIDATION_ERROR', '下次复审时间格式无效');
  node.reviewEnabled = enabled;
  node.reviewCycleDays = cycleDays;
  node.reviewOwnerId = ownerId;
  node.nextReviewAt = nextReviewAt ? new Date(nextReviewAt).toISOString() : null;
  node.reviewDueSoonNotifiedAt = null;
  node.reviewOverdueNotifiedAt = null;
  node.updatedBy = req.user.id;
  node.updatedAt = now();
  addAudit(req.db, req.user.id, 'node.review.update', 'node', node.id, {
    targetPath: node.fullPath,
    enabled,
    cycleDays,
    ownerId,
    nextReviewAt: node.nextReviewAt
  }, req);
  if (enabled && ownerId && ownerId !== req.user.id) {
    addMessage(req.db, ownerId, 'document.review.assigned', '文档复审任务', `请在 ${node.nextReviewAt.slice(0, 10)} 前复审 ${node.fullPath}`, node.id);
  }
  await saveDb(req.db);
  res.json(ok({ node: publicNode(req.db, req.user, node), review: publicReviewSettings(req.db, node) }));
}));

app.post('/api/v1/nodes/:id/review/complete', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只有文件可以完成复审');
  ensureNodeGovernanceShape(node);
  if (!node.reviewEnabled) throw createError(409, 'CONFLICT', '该文件尚未启用复审计划');
  if (!isAdmin(req.user) && node.reviewOwnerId !== req.user.id) throw createError(403, 'FORBIDDEN', '只有复审负责人或管理员可以完成复审');
  const conclusion = String(req.body.conclusion || 'valid').trim();
  if (!['valid', 'needs_update', 'retire'].includes(conclusion)) throw createError(400, 'VALIDATION_ERROR', '复审结论无效');
  const note = String(req.body.note || '').trim();
  const reviewedAt = now();
  let nextReviewAt = String(req.body.nextReviewAt || '').trim();
  if (!nextReviewAt) nextReviewAt = new Date(Date.now() + node.reviewCycleDays * 24 * 60 * 60 * 1000).toISOString();
  if (!Number.isFinite(new Date(nextReviewAt).getTime())) throw createError(400, 'VALIDATION_ERROR', '下次复审时间格式无效');
  const review = {
    id: newId('review_'),
    nodeId: node.id,
    reviewerId: req.user.id,
    conclusion,
    note,
    previousReviewAt: node.nextReviewAt,
    nextReviewAt: new Date(nextReviewAt).toISOString(),
    createdAt: reviewedAt
  };
  req.db.documentReviews.unshift(review);
  node.lastReviewedAt = reviewedAt;
  node.lastReviewedBy = req.user.id;
  node.lastReviewConclusion = conclusion;
  node.lastReviewNote = note;
  node.nextReviewAt = review.nextReviewAt;
  node.reviewDueSoonNotifiedAt = null;
  node.reviewOverdueNotifiedAt = null;
  node.updatedBy = req.user.id;
  node.updatedAt = reviewedAt;
  addAudit(req.db, req.user.id, 'node.review.complete', 'node', node.id, {
    targetPath: node.fullPath,
    conclusion,
    nextReviewAt: node.nextReviewAt
  }, req);
  await saveDb(req.db);
  res.json(ok({ review, settings: publicReviewSettings(req.db, node), quality: documentQuality(req.db, node) }));
}));

app.get('/api/v1/nodes/:id/review-history', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const rows = req.db.documentReviews
    .filter((item) => item.nodeId === node.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((item) => ({ ...item, reviewer: pickPublicUser(req.db.users.find((user) => user.id === item.reviewerId)) }));
  sendPage(res, rows, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/search/folders', requireAuth, (req, res) => {
  const keyword = String(req.body.keyword || '').trim().toLowerCase();
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  const results = listVisibleDescendants(req.db, req.user)
    .filter((node) => node.nodeType === 'folder')
    .filter((node) => !keyword || `${node.name} ${node.fullPath}`.toLowerCase().includes(keyword))
    .map((node) => publicNode(req.db, req.user, node, { unreadUploadCounts }));
  sendPage(res, results, req.body.page, req.body.pageSize);
});

app.get('/api/v1/messages', requireAuth, asyncRoute(async (req, res) => {
  dispatchDueReminders(req.db, req.user.id);
  dispatchOperationalReminders(req.db);
  ensureNotificationDeliveries(req.db);
  await saveDb(req.db);
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  const unreadOnly = String(req.query.unread || '').toLowerCase() === 'true';
  const messageType = String(req.query.type || '').trim();
  const archived = String(req.query.archived || 'false').toLowerCase();
  const messages = req.db.messages
    .filter((item) => item.receiverId === req.user.id)
    .filter((item) => !item.deletedAt)
    .filter((item) => archived === 'all' || (archived === 'true' ? Boolean(item.archivedAt) : !item.archivedAt))
    .filter((item) => !unreadOnly || !item.readAt)
    .filter((item) => !messageType || item.messageType === messageType || item.messageType.startsWith(`${messageType}.`))
    .map((item) => publicMessage(req.db, req.user, item, { unreadUploadCounts }));
  sendPage(res, messages, req.query.page, req.query.pageSize || 50);
}));

app.get('/api/v1/messages/unread-count', requireAuth, asyncRoute(async (req, res) => {
  dispatchDueReminders(req.db, req.user.id);
  dispatchOperationalReminders(req.db);
  await saveDb(req.db);
  res.json(ok(req.db.messages.filter((item) => item.receiverId === req.user.id && !item.readAt && !item.archivedAt && !item.deletedAt).length));
}));

app.post('/api/v1/messages/:id/read', requireAuth, asyncRoute(async (req, res) => {
  const message = req.db.messages.find((item) => item.id === req.params.id && item.receiverId === req.user.id && !item.deletedAt);
  if (!message) throw createError(404, 'NOT_FOUND', '消息不存在');
  message.readAt = now();
  await saveDb(req.db);
  res.json(ok(publicMessage(req.db, req.user, message, { unreadUploadCounts: unreadUploadCountsByNode(req.db, req.user) })));
}));

app.post('/api/v1/messages/:id/unread', requireAuth, asyncRoute(async (req, res) => {
  const message = req.db.messages.find((item) => item.id === req.params.id && item.receiverId === req.user.id && !item.deletedAt);
  if (!message) throw createError(404, 'NOT_FOUND', '消息不存在');
  message.readAt = null;
  await saveDb(req.db);
  res.json(ok(publicMessage(req.db, req.user, message, { unreadUploadCounts: unreadUploadCountsByNode(req.db, req.user) })));
}));

app.patch('/api/v1/messages/:id/archive', requireAuth, asyncRoute(async (req, res) => {
  const message = req.db.messages.find((item) => item.id === req.params.id && item.receiverId === req.user.id && !item.deletedAt);
  if (!message) throw createError(404, 'NOT_FOUND', '消息不存在');
  message.archivedAt = req.body.archived === false ? null : now();
  await saveDb(req.db);
  res.json(ok(publicMessage(req.db, req.user, message, { unreadUploadCounts: unreadUploadCountsByNode(req.db, req.user) })));
}));

app.delete('/api/v1/messages/:id', requireAuth, asyncRoute(async (req, res) => {
  const message = req.db.messages.find((item) => item.id === req.params.id && item.receiverId === req.user.id && !item.deletedAt);
  if (!message) throw createError(404, 'NOT_FOUND', '消息不存在');
  message.deletedAt = now();
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/messages/:id', requireAuth, (req, res) => {
  const message = req.db.messages.find((item) => item.id === req.params.id && item.receiverId === req.user.id && !item.deletedAt);
  if (!message) throw createError(404, 'NOT_FOUND', '消息不存在');
  res.json(ok(publicMessage(req.db, req.user, message, { unreadUploadCounts: unreadUploadCountsByNode(req.db, req.user) })));
});

app.post('/api/v1/messages/read-all', requireAuth, asyncRoute(async (req, res) => {
  const messageType = String(req.body.type || '').trim();
  req.db.messages.filter((item) => item.receiverId === req.user.id && !item.deletedAt && !item.archivedAt && (!messageType || item.messageType === messageType || item.messageType.startsWith(`${messageType}.`))).forEach((item) => {
    item.readAt = item.readAt || now();
  });
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/notifications/deliveries', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看通知投递');
  ensureNotificationDeliveries(req.db);
  let items = req.db.notificationDeliveries;
  if (req.query.status) items = items.filter((item) => item.status === req.query.status);
  if (req.query.channel) items = items.filter((item) => item.channel === req.query.channel);
  sendPage(res, items.map((item) => publicNotificationDelivery(req.db, item)), req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/notifications/deliveries/:id/retry', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以重试通知投递');
  const delivery = req.db.notificationDeliveries.find((item) => item.id === req.params.id);
  if (!delivery) throw createError(404, 'NOT_FOUND', '通知投递记录不存在');
  await attemptNotificationDelivery(req.db, delivery);
  addAudit(req.db, req.user.id, 'notification.retry', 'notification_delivery', delivery.id, { channel: delivery.channel, status: delivery.status }, req);
  await saveDb(req.db);
  res.json(ok(publicNotificationDelivery(req.db, delivery)));
}));

app.post('/api/v1/notifications/process', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以执行通知投递');
  ensureNotificationDeliveries(req.db);
  const due = req.db.notificationDeliveries
    .filter((item) => ['pending', 'failed'].includes(item.status))
    .filter((item) => !item.nextRetryAt || new Date(item.nextRetryAt).getTime() <= Date.now())
    .slice(0, 100);
  for (const delivery of due) await attemptNotificationDelivery(req.db, delivery);
  await saveDb(req.db);
  res.json(ok({ processed: due.length, sent: due.filter((item) => item.status === 'sent').length, failed: due.filter((item) => item.status === 'failed').length }));
}));

app.get('/api/v1/announcements', requireAuth, (req, res) => {
  const items = req.db.announcements
    .filter((item) => announcementVisibleToUser(item, req.user))
    .sort((a, b) => (b.publishedAt || b.createdAt).localeCompare(a.publishedAt || a.createdAt))
    .map((item) => publicAnnouncement(req.db, req.user, item));
  sendPage(res, items, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/announcements', requireAuth, upload.array('files', 10), asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以发布公告');
  for (const file of req.files || []) { await validateUploadedFileByPolicy(req.db, file); await scanIncomingFile(req.db, file.path, file.originalname, req.user.id); }
  const status = req.body.status === 'draft' ? 'draft' : 'published';
  const announcement = {
    id: newId('ann_'),
    title: validateName(req.body.title),
    content: String(req.body.content || '').trim(),
    audience: normalizeAudience(req.body.audience),
    status,
    effectiveAt: req.body.effectiveAt || now(),
    expiresAt: req.body.expiresAt || null,
    attachments: await announcementAttachmentsFromUploads(req.files),
    createdBy: req.user.id,
    createdAt: now(),
    updatedAt: now(),
    publishedAt: status === 'published' ? now() : null,
    notifiedAt: null
  };
  if (!announcement.content) throw createError(400, 'VALIDATION_ERROR', '公告内容不能为空');
  req.db.announcements.unshift(announcement);
  notifyAnnouncementAudience(req.db, req.user, announcement);
  addAudit(req.db, req.user.id, 'announcement.create', 'announcement', announcement.id, { title: announcement.title, status }, req);
  await saveDb(req.db);
  res.json(ok(publicAnnouncement(req.db, req.user, announcement)));
}));

app.put('/api/v1/announcements/:id', requireAuth, upload.array('files', 10), asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护公告');
  for (const file of req.files || []) { await validateUploadedFileByPolicy(req.db, file); await scanIncomingFile(req.db, file.path, file.originalname, req.user.id); }
  const announcement = req.db.announcements.find((item) => item.id === req.params.id);
  if (!announcement) throw createError(404, 'NOT_FOUND', '公告不存在');
  const previousStatus = announcement.status;
  announcement.title = req.body.title ? validateName(req.body.title) : announcement.title;
  announcement.content = req.body.content === undefined ? announcement.content : String(req.body.content || '').trim();
  announcement.audience = req.body.audience === undefined ? announcement.audience : normalizeAudience(req.body.audience);
  announcement.status = req.body.status || announcement.status;
  announcement.effectiveAt = req.body.effectiveAt === undefined ? announcement.effectiveAt : (req.body.effectiveAt || now());
  announcement.expiresAt = req.body.expiresAt === undefined ? announcement.expiresAt : (req.body.expiresAt || null);
  const existingAttachments = announcement.attachments || (announcement.attachment ? [announcement.attachment] : []);
  const removedAttachmentIds = new Set(parseJsonField(req.body.removeAttachmentIds, []));
  for (const attachment of existingAttachments.filter((item) => removedAttachmentIds.has(item.id))) await fs.rm(path.join(config.uploadDir, attachment.storageKey), { force: true });
  announcement.attachments = [...existingAttachments.filter((item) => !removedAttachmentIds.has(item.id)), ...await announcementAttachmentsFromUploads(req.files)];
  announcement.attachment = null;
  if (!announcement.content) throw createError(400, 'VALIDATION_ERROR', '公告内容不能为空');
  if (announcement.status === 'published' && previousStatus !== 'published') {
    announcement.publishedAt = now();
    announcement.notifiedAt = null;
    notifyAnnouncementAudience(req.db, req.user, announcement);
  }
  announcement.updatedAt = now();
  addAudit(req.db, req.user.id, 'announcement.update', 'announcement', announcement.id, { title: announcement.title, status: announcement.status }, req);
  await saveDb(req.db);
  res.json(ok(publicAnnouncement(req.db, req.user, announcement)));
}));

app.patch('/api/v1/announcements/:id/publish', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以发布公告');
  const announcement = req.db.announcements.find((item) => item.id === req.params.id);
  if (!announcement) throw createError(404, 'NOT_FOUND', '公告不存在');
  announcement.status = 'published';
  announcement.effectiveAt = req.body.effectiveAt || announcement.effectiveAt || now();
  announcement.expiresAt = req.body.expiresAt === undefined ? announcement.expiresAt : (req.body.expiresAt || null);
  announcement.publishedAt = announcement.publishedAt || now();
  announcement.notifiedAt = null;
  announcement.updatedAt = now();
  notifyAnnouncementAudience(req.db, req.user, announcement);
  addAudit(req.db, req.user.id, 'announcement.publish', 'announcement', announcement.id, { title: announcement.title }, req);
  await saveDb(req.db);
  res.json(ok(publicAnnouncement(req.db, req.user, announcement)));
}));

app.patch('/api/v1/announcements/:id/revoke', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以撤销公告');
  const announcement = req.db.announcements.find((item) => item.id === req.params.id);
  if (!announcement) throw createError(404, 'NOT_FOUND', '公告不存在');
  announcement.status = 'revoked';
  announcement.updatedAt = now();
  addAudit(req.db, req.user.id, 'announcement.revoke', 'announcement', announcement.id, { title: announcement.title }, req);
  await saveDb(req.db);
  res.json(ok(publicAnnouncement(req.db, req.user, announcement)));
}));

app.delete('/api/v1/announcements/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以删除公告');
  const announcement = req.db.announcements.find((item) => item.id === req.params.id);
  if (!announcement) throw createError(404, 'NOT_FOUND', '公告不存在');
  const attachments = announcement.attachments || (announcement.attachment ? [announcement.attachment] : []);
  await Promise.all(attachments.map((item) => fs.rm(path.join(config.uploadDir, item.storageKey), { force: true })));
  req.db.announcements = req.db.announcements.filter((item) => item.id !== announcement.id);
  addAudit(req.db, req.user.id, 'announcement.delete', 'announcement', announcement.id, { title: announcement.title }, req);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/announcements/:id/attachment', requireAuth, asyncRoute(async (req, res) => {
  const announcement = req.db.announcements.find((item) => item.id === req.params.id);
  if (!announcement || !announcementVisibleToUser(announcement, req.user)) throw createError(404, 'NOT_FOUND', '公告不存在');
  if (!announcement.attachment) throw createError(404, 'NOT_FOUND', '公告附件不存在');
  const filePath = path.join(config.uploadDir, announcement.attachment.storageKey);
  if (!fsSync.existsSync(filePath)) throw createError(404, 'NOT_FOUND', '公告附件内容不存在');
  res.setHeader('Content-Type', announcement.attachment.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(announcement.attachment.originalFilename)}`);
  fsSync.createReadStream(filePath).pipe(res);
}));

app.get('/api/v1/announcements/:id/attachments/:attachmentId', requireAuth, asyncRoute(async (req, res) => {
  const announcement = req.db.announcements.find((item) => item.id === req.params.id);
  if (!announcement || !announcementVisibleToUser(announcement, req.user)) throw createError(404, 'NOT_FOUND', '公告不存在');
  const attachments = announcement.attachments || (announcement.attachment ? [announcement.attachment] : []);
  const attachment = attachments.find((item) => item.id === req.params.attachmentId);
  if (!attachment) throw createError(404, 'NOT_FOUND', '公告附件不存在');
  const filePath = path.join(config.uploadDir, attachment.storageKey);
  if (!fsSync.existsSync(filePath)) throw createError(404, 'NOT_FOUND', '公告附件内容不存在');
  res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.originalFilename)}`);
  fsSync.createReadStream(filePath).pipe(res);
}));

app.get('/api/v1/favorites', requireAuth, (req, res) => {
  const items = req.db.favorites
    .filter((item) => item.userId === req.user.id)
    .map((fav) => {
      const folder = req.db.favoriteFolders.find((item) => item.id === fav.folderId && item.userId === req.user.id);
      return { ...fav, folderId: folder?.id || null, folderName: folder?.name || fav.folderName || '默认收藏夹', node: nodeById(req.db, fav.nodeId) ? publicNode(req.db, req.user, nodeById(req.db, fav.nodeId)) : null };
    })
    .filter((item) => item.node);
  res.json(ok(items));
});

app.get('/api/v1/favorite-folders', requireAuth, (req, res) => {
  const folders = [{ id: null, name: '默认收藏夹', system: true, userId: req.user.id }, ...req.db.favoriteFolders.filter((item) => item.userId === req.user.id)];
  res.json(ok(folders.map((folder) => ({ ...folder, itemCount: req.db.favorites.filter((item) => item.userId === req.user.id && (item.folderId || null) === folder.id).length }))));
});

app.post('/api/v1/favorite-folders', requireAuth, asyncRoute(async (req, res) => {
  const name = validateName(req.body.name);
  if (req.db.favoriteFolders.some((item) => item.userId === req.user.id && item.name === name)) throw createError(409, 'CONFLICT', '收藏夹名称已存在');
  const folder = { id: newId('favf_'), userId: req.user.id, name, createdAt: now(), updatedAt: now() };
  req.db.favoriteFolders.push(folder);
  await saveDb(req.db);
  res.json(ok(folder));
}));

app.put('/api/v1/favorite-folders/:id', requireAuth, asyncRoute(async (req, res) => {
  const folder = req.db.favoriteFolders.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!folder) throw createError(404, 'NOT_FOUND', '收藏夹不存在');
  const name = validateName(req.body.name);
  if (req.db.favoriteFolders.some((item) => item.userId === req.user.id && item.id !== folder.id && item.name === name)) throw createError(409, 'CONFLICT', '收藏夹名称已存在');
  folder.name = name;
  folder.updatedAt = now();
  req.db.favorites.filter((item) => item.userId === req.user.id && item.folderId === folder.id).forEach((item) => { item.folderName = name; });
  await saveDb(req.db);
  res.json(ok(folder));
}));

app.delete('/api/v1/favorite-folders/:id', requireAuth, asyncRoute(async (req, res) => {
  const folder = req.db.favoriteFolders.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!folder) throw createError(404, 'NOT_FOUND', '收藏夹不存在');
  req.db.favoriteFolders = req.db.favoriteFolders.filter((item) => item.id !== folder.id);
  req.db.favorites.filter((item) => item.userId === req.user.id && item.folderId === folder.id).forEach((item) => {
    item.folderId = null;
    item.folderName = '默认收藏夹';
  });
  await saveDb(req.db);
  res.json(ok(true));
}));

app.post('/api/v1/favorites', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.body.nodeId);
  requireNodeAction(req, node, 'visible');
  let fav = req.db.favorites.find((item) => item.userId === req.user.id && item.nodeId === node.id);
  const folderId = req.body.folderId || null;
  const folder = folderId ? req.db.favoriteFolders.find((item) => item.id === folderId && item.userId === req.user.id) : null;
  if (folderId && !folder) throw createError(404, 'NOT_FOUND', '收藏夹不存在');
  if (!fav) {
    fav = { id: newId('fav_'), userId: req.user.id, nodeId: node.id, folderId: folder?.id || null, folderName: folder?.name || '默认收藏夹', createdAt: now() };
    req.db.favorites.push(fav);
    addAudit(req.db, req.user.id, 'favorite.create', 'node', node.id, { targetPath: node.fullPath }, req);
    await saveDb(req.db);
  }
  res.json(ok(fav));
}));

app.put('/api/v1/favorites/:id', requireAuth, asyncRoute(async (req, res) => {
  const favorite = req.db.favorites.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!favorite) throw createError(404, 'NOT_FOUND', '收藏记录不存在');
  const folderId = req.body.folderId || null;
  const folder = folderId ? req.db.favoriteFolders.find((item) => item.id === folderId && item.userId === req.user.id) : null;
  if (folderId && !folder) throw createError(404, 'NOT_FOUND', '收藏夹不存在');
  favorite.folderId = folder?.id || null;
  favorite.folderName = folder?.name || '默认收藏夹';
  favorite.updatedAt = now();
  await saveDb(req.db);
  res.json(ok(favorite));
}));

app.delete('/api/v1/favorites/:id', requireAuth, asyncRoute(async (req, res) => {
  req.db.favorites = req.db.favorites.filter((item) => !(item.id === req.params.id && item.userId === req.user.id));
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/shares', requireAuth, (req, res) => {
  const shares = req.db.shares
    .filter((share) => isAdmin(req.user) || share.createdBy === req.user.id || audienceMatches(share.audience, req.user))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((share) => publicShare(req.db, share));
  sendPage(res, shares, req.query.page, req.query.pageSize || 100);
});

app.get('/api/v1/external-links', requireAuth, (req, res) => {
  const items = req.db.externalLinks
    .filter((item) => isAdmin(req.user) || item.createdBy === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => publicExternalLink(req.db, item, { includeToken: true }));
  sendPage(res, items, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/nodes/:id/external-links', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:share_external');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能为文件创建外链');
  const password = String(req.body.password || '');
  if (password && (password.length < 4 || password.length > 64)) throw createError(400, 'VALIDATION_ERROR', '提取码长度应为 4-64 个字符');
  const passwordData = password ? hashPassword(password) : { hash: '', salt: '' };
  const maxAccessCount = Math.max(0, Math.min(Number(req.body.maxAccessCount || 0), 1000000));
  const link = {
    id: newId('ext_'),
    token: crypto.randomBytes(24).toString('base64url'),
    nodeId: node.id,
    description: String(req.body.description || '').trim(),
    allowPreview: req.body.allowPreview !== false,
    allowDownload: Boolean(req.body.allowDownload),
    passwordHash: passwordData.hash,
    passwordSalt: passwordData.salt,
    effectiveAt: req.body.effectiveAt || now(),
    expiresAt: req.body.expiresAt || null,
    maxAccessCount,
    accessCount: 0,
    status: 'active',
    createdBy: req.user.id,
    createdAt: now(),
    updatedAt: now()
  };
  if (!link.allowPreview && !link.allowDownload) throw createError(400, 'VALIDATION_ERROR', '外链至少需要允许预览或下载');
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= new Date(link.effectiveAt).getTime()) {
    throw createError(400, 'VALIDATION_ERROR', '失效时间必须晚于生效时间');
  }
  req.db.externalLinks.unshift(link);
  addAudit(req.db, req.user.id, 'external_link.create', 'external_link', link.id, {
    nodeId: node.id, targetPath: node.fullPath, allowPreview: link.allowPreview, allowDownload: link.allowDownload,
    hasPassword: Boolean(link.passwordHash), expiresAt: link.expiresAt, maxAccessCount
  }, req);
  await saveDb(req.db);
  res.json(ok(publicExternalLink(req.db, link, { includeToken: true })));
}));

app.patch('/api/v1/external-links/:id/revoke', requireAuth, asyncRoute(async (req, res) => {
  const link = req.db.externalLinks.find((item) => item.id === req.params.id);
  if (!link) throw createError(404, 'NOT_FOUND', '外链不存在');
  if (!isAdmin(req.user) && link.createdBy !== req.user.id) throw createError(403, 'FORBIDDEN', '没有权限撤销该外链');
  link.status = 'revoked';
  link.updatedAt = now();
  addAudit(req.db, req.user.id, 'external_link.revoke', 'external_link', link.id, { nodeId: link.nodeId }, req);
  await saveDb(req.db);
  res.json(ok(publicExternalLink(req.db, link, { includeToken: true })));
}));

app.get('/api/v1/public/external-links/:token', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const { link, node } = validateExternalLink(db, req.params.token);
  const version = currentVersion(db, node);
  res.json(ok({
    name: node.name,
    description: link.description,
    extension: node.extension,
    sizeBytes: Number(version?.sizeBytes || 0),
    allowPreview: link.allowPreview !== false,
    allowDownload: Boolean(link.allowDownload),
    hasPassword: Boolean(link.passwordHash),
    expiresAt: link.expiresAt,
    maxAccessCount: Number(link.maxAccessCount || 0),
    remainingAccessCount: Number(link.maxAccessCount || 0) > 0 ? Math.max(Number(link.maxAccessCount) - Number(link.accessCount || 0), 0) : null
  }));
}));

app.post('/api/v1/public/external-links/:token/access', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const { link, node } = validateExternalLink(db, req.params.token);
  if (link.passwordHash && !verifyPassword(String(req.body.password || ''), { passwordHash: link.passwordHash, passwordSalt: link.passwordSalt })) {
    db.externalLinkAccessLogs.unshift({ id: newId('ela_'), linkId: link.id, action: 'password_failed', ip: req.ip || '', userAgent: req.headers['user-agent'] || '', createdAt: now() });
    db.externalLinkAccessLogs = db.externalLinkAccessLogs.slice(0, 10000);
    await saveDb(db);
    throw createError(401, 'INVALID_PASSWORD', '提取码错误');
  }
  link.accessCount = Number(link.accessCount || 0) + 1;
  link.lastAccessAt = now();
  link.updatedAt = now();
  db.externalLinkAccessLogs.unshift({ id: newId('ela_'), linkId: link.id, action: 'access', ip: req.ip || '', userAgent: req.headers['user-agent'] || '', createdAt: now() });
  db.externalLinkAccessLogs = db.externalLinkAccessLogs.slice(0, 10000);
  addAudit(db, null, 'external_link.access', 'external_link', link.id, { nodeId: node.id, ip: req.ip || '' }, req);
  await saveDb(db);
  res.json(ok({
    accessToken: signToken({ type: 'external_link', externalLinkId: link.id }, 30 * 60 * 1000),
    expiresInSeconds: 1800,
    name: node.name,
    allowPreview: link.allowPreview !== false,
    allowDownload: Boolean(link.allowDownload)
  }));
}));

app.get('/api/v1/public/external-links/:token/content', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const { link, node } = validateExternalLink(db, req.params.token, { enforceAccessLimit: false });
  externalLinkAccessFromRequest(req, link);
  if (link.allowPreview === false) throw createError(403, 'FORBIDDEN', '该外链不允许预览');
  const version = currentVersion(db, node);
  if (!version) throw createError(404, 'NOT_FOUND', '文件版本不存在');
  const filePath = versionFilePath(version, node, db);
  if (!fsSync.existsSync(filePath)) throw createError(404, 'NOT_FOUND', '文件内容不存在');
  db.externalLinkAccessLogs.unshift({ id: newId('ela_'), linkId: link.id, action: 'preview', ip: req.ip || '', userAgent: req.headers['user-agent'] || '', createdAt: now() });
  await saveDb(db);
  res.setHeader('Content-Type', version.mimeType || mime.lookup(node.name) || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(node.name)}`);
  fsSync.createReadStream(filePath).pipe(res);
}));

app.get('/api/v1/public/external-links/:token/download', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const { link, node } = validateExternalLink(db, req.params.token, { enforceAccessLimit: false });
  externalLinkAccessFromRequest(req, link);
  if (!link.allowDownload) throw createError(403, 'FORBIDDEN', '该外链不允许下载');
  const version = currentVersion(db, node);
  if (!version) throw createError(404, 'NOT_FOUND', '文件版本不存在');
  const filePath = versionFilePath(version, node, db);
  if (!fsSync.existsSync(filePath)) throw createError(404, 'NOT_FOUND', '文件内容不存在');
  db.externalLinkAccessLogs.unshift({ id: newId('ela_'), linkId: link.id, action: 'download', ip: req.ip || '', userAgent: req.headers['user-agent'] || '', createdAt: now() });
  addAudit(db, null, 'external_link.download', 'external_link', link.id, { nodeId: node.id, ip: req.ip || '' }, req);
  await saveDb(db);
  res.setHeader('Content-Type', version.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(node.name)}`);
  fsSync.createReadStream(filePath).pipe(res);
}));

app.post('/api/v1/nodes/:id/share', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const type = req.body.type === 'publish' ? 'publish' : 'share';
  const actions = req.body.actions?.length ? req.body.actions : ['visible', 'file:preview', 'file:download'];
  const audience = {
    all: Boolean(req.body.audience?.all),
    userIds: req.body.audience?.userIds || [],
    departmentIds: req.body.audience?.departmentIds || [],
    roleIds: req.body.audience?.roleIds || []
  };
  if (!audience.all && !audience.userIds.length && !audience.departmentIds.length && !audience.roleIds.length) {
    throw createError(400, 'VALIDATION_ERROR', '请选择分享接收范围');
  }
  const share = {
    id: newId(type === 'publish' ? 'pub_' : 'shr_'),
    type,
    nodeId: node.id,
    description: req.body.description || '',
    actions,
    audience,
    includeChildren: req.body.includeChildren !== false,
    effectiveAt: req.body.effectiveAt || now(),
    expiresAt: req.body.expiresAt || null,
    status: 'active',
    createdBy: req.user.id,
    createdAt: now(),
    updatedAt: now()
  };
  req.db.shares.push(share);
  collectAudienceUsers(req.db, audience)
    .filter((userId) => userId !== req.user.id)
    .forEach((userId) => {
      addMessage(
        req.db,
        userId,
        `node.${type}`,
        type === 'publish' ? '收到文件发布' : '收到文件分享',
        `${req.user.displayName} ${type === 'publish' ? '发布了' : '分享了'} ${node.fullPath}${share.description ? `：${share.description}` : ''}`,
        node.id
      );
    });
  addAudit(req.db, req.user.id, `node.${type}`, 'node', node.id, { targetPath: node.fullPath, share }, req);
  await saveDb(req.db);
  res.json(ok(publicShare(req.db, share)));
}));

app.patch('/api/v1/shares/:id/revoke', requireAuth, asyncRoute(async (req, res) => {
  const share = req.db.shares.find((item) => item.id === req.params.id);
  if (!share) throw createError(404, 'NOT_FOUND', '分享记录不存在');
  if (!isAdmin(req.user) && share.createdBy !== req.user.id) throw createError(403, 'FORBIDDEN', '没有权限撤销该分享');
  share.status = 'revoked';
  share.updatedAt = now();
  addAudit(req.db, req.user.id, 'share.revoke', 'share', share.id, { nodeId: share.nodeId }, req);
  await saveDb(req.db);
  res.json(ok(publicShare(req.db, share)));
}));

app.get('/api/v1/subscriptions', requireAuth, (req, res) => {
  const items = req.db.subscriptions
    .filter((item) => item.userId === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => publicSubscription(req.db, item));
  res.json(ok(items));
});

app.post('/api/v1/nodes/:id/subscriptions', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  let subscription = req.db.subscriptions.find((item) => item.userId === req.user.id && item.nodeId === node.id && item.status === 'active');
  if (!subscription) {
    subscription = {
      id: newId('sub_'),
      userId: req.user.id,
      nodeId: node.id,
      includeChildren: req.body.includeChildren !== false,
      eventTypes: req.body.eventTypes?.length ? req.body.eventTypes : ['update', 'delete'],
      status: 'active',
      createdAt: now(),
      updatedAt: now()
    };
    req.db.subscriptions.push(subscription);
    addAudit(req.db, req.user.id, 'subscription.create', 'node', node.id, { targetPath: node.fullPath }, req);
    await saveDb(req.db);
  }
  res.json(ok(publicSubscription(req.db, subscription)));
}));

app.delete('/api/v1/subscriptions/:id', requireAuth, asyncRoute(async (req, res) => {
  const subscription = req.db.subscriptions.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!subscription) throw createError(404, 'NOT_FOUND', '订阅不存在');
  subscription.status = 'cancelled';
  subscription.updatedAt = now();
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/reminders', requireAuth, asyncRoute(async (req, res) => {
  dispatchDueReminders(req.db, req.user.id);
  await saveDb(req.db);
  const items = req.db.reminders
    .filter((item) => item.userId === req.user.id)
    .sort((a, b) => (a.triggerAt || '').localeCompare(b.triggerAt || ''))
    .map((item) => publicReminder(req.db, item));
  res.json(ok(items));
}));

app.post('/api/v1/nodes/:id/reminders', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const triggerAt = req.body.triggerAt || now();
  const endAt = req.body.endAt || null;
  if (endAt && new Date(endAt).getTime() < new Date(triggerAt).getTime()) {
    throw createError(400, 'VALIDATION_ERROR', '结束时间不能早于触发时间');
  }
  const reminder = {
    id: newId('rem_'),
    userId: req.user.id,
    nodeId: node.id,
    remindBy: Array.isArray(req.body.remindBy) && req.body.remindBy.length ? req.body.remindBy : (req.body.remindBy || ['system']),
    cycle: req.body.cycle || 'none',
    intervalDays: Number(req.body.intervalDays || 0),
    triggerAt,
    startAt: req.body.startAt || triggerAt,
    endAt,
    remark: req.body.remark || '',
    status: 'active',
    lastTriggeredAt: null,
    createdAt: now(),
    updatedAt: now()
  };
  req.db.reminders.push(reminder);
  addAudit(req.db, req.user.id, 'reminder.create', 'node', node.id, { targetPath: node.fullPath, triggerAt }, req);
  await saveDb(req.db);
  res.json(ok(publicReminder(req.db, reminder)));
}));

app.put('/api/v1/reminders/:id', requireAuth, asyncRoute(async (req, res) => {
  const reminder = req.db.reminders.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!reminder) throw createError(404, 'NOT_FOUND', '提醒不存在');
  const triggerAt = req.body.triggerAt ?? reminder.triggerAt;
  const endAt = req.body.endAt === undefined ? reminder.endAt : (req.body.endAt || null);
  if (endAt && new Date(endAt).getTime() < new Date(triggerAt).getTime()) {
    throw createError(400, 'VALIDATION_ERROR', '结束时间不能早于触发时间');
  }
  Object.assign(reminder, {
    remindBy: req.body.remindBy ?? reminder.remindBy,
    cycle: req.body.cycle ?? reminder.cycle,
    intervalDays: req.body.intervalDays === undefined ? reminder.intervalDays : Number(req.body.intervalDays || 0),
    triggerAt,
    startAt: req.body.startAt ?? reminder.startAt,
    endAt,
    remark: req.body.remark ?? reminder.remark,
    status: req.body.status || 'active',
    updatedAt: now()
  });
  await saveDb(req.db);
  res.json(ok(publicReminder(req.db, reminder)));
}));

app.delete('/api/v1/reminders/:id', requireAuth, asyncRoute(async (req, res) => {
  const reminder = req.db.reminders.find((item) => item.id === req.params.id && item.userId === req.user.id);
  if (!reminder) throw createError(404, 'NOT_FOUND', '提醒不存在');
  reminder.status = 'cancelled';
  reminder.updatedAt = now();
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/categories/tree', requireAuth, (req, res) => {
  res.json(ok(buildTree(req.db.categories.map((item) => ({ ...item })))));
});

app.get('/api/v1/categories/:id/files', requireAuth, (req, res) => {
  const category = req.db.categories.find((item) => item.id === req.params.id);
  if (!category) throw createError(404, 'NOT_FOUND', '分类不存在');
  const ids = new Set([category.id]);
  if (req.query.includeChildren !== 'false') {
    collectionDescendants(req.db.categories, category.id).forEach((item) => ids.add(item.id));
  }
  const nodeIds = new Set(req.db.documentCategories.filter((item) => ids.has(item.categoryId)).map((item) => item.nodeId));
  const files = req.db.nodes
    .filter((node) => nodeIds.has(node.id) && node.status !== 'deleted' && node.nodeType === 'file')
    .filter((node) => hasAction(req.db, req.user, node, 'visible'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((node) => publicNode(req.db, req.user, node));
  sendPage(res, files, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/categories', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护分类');
  const parent = req.body.parentId ? req.db.categories.find((item) => item.id === req.body.parentId) : null;
  if (req.body.parentId && !parent) throw createError(404, 'NOT_FOUND', '上级分类不存在');
  const name = validateName(req.body.name);
  const category = {
    id: newId('c_'),
    parentId: parent?.id || null,
    name,
    fullPath: parent ? `${parent.fullPath}/${name}` : `/${name}`,
    sortOrder: Number(req.body.sortOrder || 100),
    status: req.body.status || 'enabled'
  };
  req.db.categories.push(category);
  await saveDb(req.db);
  res.json(ok(category));
}));

app.put('/api/v1/categories/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护分类');
  const category = req.db.categories.find((item) => item.id === req.params.id);
  if (!category) throw createError(404, 'NOT_FOUND', '分类不存在');
  const parentId = req.body.parentId === undefined ? category.parentId : (req.body.parentId || null);
  validateParentChange(req.db.categories, category.id, parentId, '分类');
  category.name = req.body.name ? validateName(req.body.name) : category.name;
  category.parentId = parentId;
  category.sortOrder = req.body.sortOrder ?? category.sortOrder;
  category.status = req.body.status ?? category.status;
  refreshCategoryPathRecursive(req.db, category);
  await saveDb(req.db);
  res.json(ok(category));
}));

app.delete('/api/v1/categories/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护分类');
  const ids = new Set([req.params.id]);
  let changed = true;
  while (changed) {
    changed = false;
    req.db.categories.forEach((item) => {
      if (ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id);
        changed = true;
      }
    });
  }
  req.db.categories = req.db.categories.filter((item) => !ids.has(item.id));
  req.db.documentCategories = req.db.documentCategories.filter((item) => !ids.has(item.categoryId));
  req.db.propertyValues = req.db.propertyValues.filter((item) => !ids.has(item.categoryId));
  req.db.propertyDefinitions.forEach((item) => {
    item.categoryIds = (item.categoryIds || []).filter((categoryId) => !ids.has(categoryId));
  });
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/nodes/:id/categories', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const ids = req.db.documentCategories.filter((item) => item.nodeId === node.id).map((item) => item.categoryId);
  res.json(ok(req.db.categories.filter((item) => ids.includes(item.id))));
});

app.put('/api/v1/nodes/:id/categories', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  const categoryIds = req.body.categoryIds || [];
  req.db.documentCategories = req.db.documentCategories.filter((item) => item.nodeId !== node.id);
  categoryIds.forEach((categoryId) => req.db.documentCategories.push({ nodeId: node.id, categoryId }));
  addAudit(req.db, req.user.id, 'node.categories.update', 'node', node.id, { targetPath: node.fullPath, categoryIds }, req);
  await saveDb(req.db);
  res.json(ok(req.db.categories.filter((item) => categoryIds.includes(item.id))));
}));

app.get('/api/v1/property-definitions', requireAuth, (req, res) => {
  res.json(ok(req.db.propertyDefinitions));
});

app.post('/api/v1/property-definitions', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护属性定义');
  const categoryIds = [...new Set((req.body.categoryIds || []).map(String))];
  if (categoryIds.some((id) => !req.db.categories.some((item) => item.id === id))) throw createError(400, 'VALIDATION_ERROR', '绑定分类不存在');
  const definition = {
    id: newId('prop_'),
    targetType: req.body.targetType || 'file',
    name: validateName(req.body.name),
    dataType: req.body.dataType || 'string',
    required: Boolean(req.body.required),
    options: normalizeOptions(req.body.options),
    categoryIds,
    createdAt: now(),
    updatedAt: now()
  };
  req.db.propertyDefinitions.push(definition);
  await saveDb(req.db);
  res.json(ok(definition));
}));

app.put('/api/v1/property-definitions/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护属性定义');
  const definition = req.db.propertyDefinitions.find((item) => item.id === req.params.id);
  if (!definition) throw createError(404, 'NOT_FOUND', '属性定义不存在');
  definition.name = req.body.name ? validateName(req.body.name) : definition.name;
  definition.targetType = req.body.targetType ?? definition.targetType;
  definition.dataType = req.body.dataType ?? definition.dataType;
  definition.required = req.body.required ?? definition.required;
  definition.options = req.body.options === undefined ? definition.options : normalizeOptions(req.body.options);
  if (req.body.categoryIds !== undefined) {
    const categoryIds = [...new Set((req.body.categoryIds || []).map(String))];
    if (categoryIds.some((id) => !req.db.categories.some((item) => item.id === id))) throw createError(400, 'VALIDATION_ERROR', '绑定分类不存在');
    definition.categoryIds = categoryIds;
  }
  definition.updatedAt = now();
  await saveDb(req.db);
  res.json(ok(definition));
}));

app.delete('/api/v1/property-definitions/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护属性定义');
  req.db.propertyDefinitions = req.db.propertyDefinitions.filter((item) => item.id !== req.params.id);
  req.db.propertyValues = req.db.propertyValues.filter((item) => item.propertyId !== req.params.id);
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/nodes/:id/properties', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const categories = req.db.documentCategories.filter((item) => item.nodeId === node.id).map((item) => item.categoryId);
  const values = [];
  req.db.propertyDefinitions.forEach((definition) => {
    const boundCategoryIds = definition.categoryIds || [];
    if (!boundCategoryIds.length) {
      values.push({ key: definition.id, definition, categoryId: null, categoryName: '', value: propertyValueFor(req.db, node.id, definition.id, null)?.value || '' });
      return;
    }
    categories.filter((categoryId) => boundCategoryIds.includes(categoryId)).forEach((categoryId) => {
      values.push({
        key: `${categoryId}:${definition.id}`,
        definition,
        categoryId,
        categoryName: req.db.categories.find((item) => item.id === categoryId)?.name || categoryId,
        value: propertyValueFor(req.db, node.id, definition.id, categoryId)?.value || ''
      });
    });
  });
  res.json(ok({ tags: node.tags || [], categories, values }));
});

app.put('/api/v1/nodes/:id/properties', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  node.tags = req.body.tags || [];
  const categoryIds = req.body.categoryIds || [];
  if (categoryIds.some((id) => !req.db.categories.some((item) => item.id === id))) throw createError(400, 'VALIDATION_ERROR', '分类不存在');
  req.db.documentCategories = req.db.documentCategories.filter((item) => item.nodeId !== node.id);
  categoryIds.forEach((categoryId) => req.db.documentCategories.push({ nodeId: node.id, categoryId }));
  const applicable = [];
  req.db.propertyDefinitions.forEach((definition) => {
    const boundCategoryIds = definition.categoryIds || [];
    if (!boundCategoryIds.length) applicable.push({ key: definition.id, definition, categoryId: null });
    else categoryIds.filter((id) => boundCategoryIds.includes(id)).forEach((categoryId) => applicable.push({ key: `${categoryId}:${definition.id}`, definition, categoryId }));
  });
  const values = req.body.values || {};
  applicable.forEach(({ key, definition, categoryId }) => {
    const value = values[key] ?? '';
    if (definition.required && String(value ?? '').trim() === '') throw createError(400, 'VALIDATION_ERROR', `${definition.name}为必填属性`);
    let existing = propertyValueFor(req.db, node.id, definition.id, categoryId);
    if (!existing) {
      existing = { nodeId: node.id, propertyId: definition.id, categoryId, value: '' };
      req.db.propertyValues.push(existing);
    }
    existing.value = String(value ?? '');
  });
  node.updatedBy = req.user.id;
  node.updatedAt = now();
  addAudit(req.db, req.user.id, 'node.properties.update', 'node', node.id, { targetPath: node.fullPath }, req);
  await saveDb(req.db);
  res.json(ok({ tags: node.tags, categories: categoryIds }));
}));

app.put('/api/v1/nodes/batch-metadata', requireAuth, asyncRoute(async (req, res) => {
  const nodes = (req.body.nodeIds || []).map((id) => nodeById(req.db, id)).filter(Boolean);
  if (!nodes.length) throw createError(400, 'VALIDATION_ERROR', '请选择要批量编辑的文件或文件夹');
  const tags = req.body.tags === undefined ? null : (Array.isArray(req.body.tags) ? req.body.tags : normalizeOptions(req.body.tags));
  const businessStatus = req.body.businessStatus || '';
  const securityLevel = req.body.securityLevel ? normalizeSecurityLevel(req.body.securityLevel) : '';
  const sensitiveProvided = req.body.sensitive !== undefined;
  const sensitive = Boolean(req.body.sensitive);
  const sensitiveReason = req.body.sensitiveReason === undefined ? null : String(req.body.sensitiveReason || '').trim();
  const allowedStatuses = ['draft', 'effective', 'invalid', 'archived'];
  if (businessStatus && !allowedStatuses.includes(businessStatus)) throw createError(400, 'VALIDATION_ERROR', '业务状态不正确');
  nodes.forEach((node) => {
    requireNodeAction(req, node, node.nodeType === 'folder' ? 'folder:create' : 'file:update');
    requireNodePasswordAccess(req, node);
  });
  nodes.forEach((node) => {
    if (tags) node.tags = tags;
    if (businessStatus) node.businessStatus = businessStatus;
    if (securityLevel) node.securityLevel = securityLevel;
    if (sensitiveProvided) node.sensitive = sensitive;
    if (sensitiveReason !== null) node.sensitiveReason = sensitiveReason;
    if (securityLevel || sensitiveProvided || sensitiveReason !== null) {
      node.securityUpdatedBy = req.user.id;
      node.securityUpdatedAt = now();
    }
    node.updatedBy = req.user.id;
    node.updatedAt = now();
  });
  addAudit(req.db, req.user.id, 'node.batch_metadata.update', 'node', 'batch', {
    nodeIds: nodes.map((item) => item.id),
    count: nodes.length,
    businessStatus,
    securityLevel,
    sensitive: sensitiveProvided ? sensitive : undefined
  }, req);
  await saveDb(req.db);
  res.json(ok({ count: nodes.length, nodes: nodes.map((node) => publicNode(req.db, req.user, node)) }));
}));

app.get('/api/v1/nodes/:id/comments', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  res.json(ok(req.db.comments.filter((item) => item.nodeId === node.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
});

app.post('/api/v1/nodes/:id/comments', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const comment = {
    id: newId('com_'),
    nodeId: node.id,
    userId: req.user.id,
    content: String(req.body.content || '').trim(),
    createdAt: now()
  };
  if (!comment.content) throw createError(400, 'VALIDATION_ERROR', '评论内容不能为空');
  req.db.comments.unshift(comment);
  if (node.ownerId && node.ownerId !== req.user.id) {
    addMessage(req.db, node.ownerId, 'comment.created', '文档收到新评论', `${userDisplayName(req.db, req.user.id)} 评论了“${node.fullPath}”：${comment.content}`, node.id);
  }
  await saveDb(req.db);
  res.json(ok(comment));
}));

app.post('/api/v1/nodes/:id/rating', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const score = Math.max(1, Math.min(5, Number(req.body.score || 5)));
  let rating = req.db.ratings.find((item) => item.nodeId === node.id && item.userId === req.user.id);
  if (!rating) {
    rating = { id: newId('rate_'), nodeId: node.id, userId: req.user.id, score, createdAt: now(), updatedAt: now() };
    req.db.ratings.push(rating);
  } else {
    rating.score = score;
    rating.updatedAt = now();
  }
  await saveDb(req.db);
  res.json(ok(rating));
}));

function filterAuditLogs(items, filters = {}) {
  let logs = items;
  if (filters.actorId) logs = logs.filter((item) => item.actorId === filters.actorId);
  if (filters.action) logs = logs.filter((item) => String(item.action || '').includes(String(filters.action)));
  if (filters.targetPath) logs = logs.filter((item) => String(item.targetPath || '').includes(String(filters.targetPath)));
  if (filters.startAt) logs = logs.filter((item) => new Date(item.createdAt).getTime() >= new Date(filters.startAt).getTime());
  if (filters.endAt) logs = logs.filter((item) => new Date(item.createdAt).getTime() <= new Date(filters.endAt).getTime());
  return logs;
}

app.get('/api/v1/audit-logs', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看审计日志');
  let logs = filterAuditLogs(req.db.auditLogs, req.query);
  sendPage(res, logs, req.query.page, req.query.pageSize || 100);
});

app.get('/api/v1/recent-access', requireAuth, (req, res) => {
  const items = (req.db.recentAccesses || [])
    .filter((item) => item.userId === req.user.id)
    .map((item) => publicRecentAccess(req.db, req.user, item))
    .filter((item) => item.node)
    .sort((a, b) => String(b.accessedAt || '').localeCompare(String(a.accessedAt || '')));
  sendPage(res, items, req.query.page, req.query.pageSize || 20);
});

app.get('/api/v1/audit-logs/report', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看审计报表');
  res.json(ok(auditReport(req.db)));
});

app.get('/api/v1/system/runtime-status', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统运行状态');
  const runtime = await runtimeStatus(req.db);
  evaluateSystemAlerts(req.db, storageConsistencyReport(req.db), runtime);
  void saveDbBestEffort(req.db, 'runtime health alerts');
  res.json(ok(runtime));
}));

app.get('/api/v1/system/consistency', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以执行一致性检查');
  const report = storageConsistencyReport(req.db);
  evaluateSystemAlerts(req.db, report);
  addAudit(req.db, req.user.id, 'system.consistency.check', 'system', 'storage', report.counts, req);
  await saveDb(req.db);
  res.json(ok(report));
}));

app.get('/api/v1/system/backups', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看备份');
  sendPage(res, req.db.backupJobs || [], req.query.page, req.query.pageSize || 50);
});

app.post('/api/v1/system/backups', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以创建备份');
  let job;
  try {
    job = await createSystemBackup(req.db, req.user.id);
    addAudit(req.db, req.user.id, 'system.backup.create', 'backup_job', job.id, { filename: job.filename, sizeBytes: job.sizeBytes }, req);
  } catch (error) {
    const running = req.db.backupJobs.find((item) => item.status === 'running' && item.createdBy === req.user.id);
    if (running) Object.assign(running, { status: 'failed', error: error.message, completedAt: now() });
    await saveDbBestEffort(req.db, 'backup job');
    throw error;
  }
  await saveDb(req.db);
  res.json(ok(job));
}));

app.post('/api/v1/system/backups/:id/drill', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以执行恢复演练');
  const job = req.db.backupJobs.find((item) => item.id === req.params.id);
  if (!job) throw createError(404, 'NOT_FOUND', '备份任务不存在');
  const drill = await runBackupRestoreDrill(job);
  addAudit(req.db, req.user.id, 'system.backup.drill', 'backup_job', job.id, drill, req);
  await saveDb(req.db);
  res.json(ok(drill));
}));

app.get('/api/v1/system/backups/:id/download', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以下载备份');
  const job = req.db.backupJobs.find((item) => item.id === req.params.id && item.status === 'completed');
  if (!job) throw createError(404, 'NOT_FOUND', '备份任务不存在');
  const backupPath = path.join(config.backupDir, path.basename(job.filename));
  if (!fsSync.existsSync(backupPath)) throw createError(404, 'NOT_FOUND', '备份文件不存在');
  res.download(backupPath, job.filename);
});

app.get('/api/v1/system/alerts', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统告警');
  evaluateSystemAlerts(req.db, storageConsistencyReport(req.db));
  let alerts = req.db.systemAlerts || [];
  if (req.query.status) alerts = alerts.filter((item) => item.status === req.query.status);
  sendPage(res, alerts, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/system/alerts/:id/resolve', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以处理系统告警');
  const alert = req.db.systemAlerts.find((item) => item.id === req.params.id);
  if (!alert) throw createError(404, 'NOT_FOUND', '系统告警不存在');
  Object.assign(alert, { status: 'resolved', resolvedAt: now(), resolvedBy: req.user.id, resolution: String(req.body.resolution || '').trim(), updatedAt: now() });
  addAudit(req.db, req.user.id, 'system.alert.resolve', 'system_alert', alert.id, { resolution: alert.resolution }, req);
  await saveDb(req.db);
  res.json(ok(alert));
}));

app.post('/api/v1/audit-logs/export', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以导出审计日志');
  const logs = filterAuditLogs(req.db.auditLogs, req.body || {});
  const rows = [
    ['时间', '操作者', '动作', '目标类型', '目标ID', '对象路径', 'IP', '浏览器'],
    ...logs.map((item) => [
      item.createdAt,
      item.actorId,
      item.action,
      item.targetType,
      item.targetId,
      item.targetPath,
      item.ip,
      item.userAgent
    ])
  ];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  addAudit(req.db, req.user.id, 'audit.export', 'audit_log', 'export', { count: logs.length }, req);
  await saveDb(req.db);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('审计日志.csv')}`);
  res.send(`\uFEFF${csv}`);
}));

app.get('/api/v1/system-settings/file-policy', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统设置');
  res.json(ok(currentFilePolicy(req.db)));
});

app.put('/api/v1/system-settings/file-policy', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护系统设置');
  const allowedExtensions = normalizeExtensions(req.body.allowedExtensions || DEFAULT_FILE_POLICY.allowedExtensions);
  const maxSizeMb = Math.max(1, Math.min(Number(req.body.maxSizeMb || DEFAULT_FILE_POLICY.maxSizeMb), 10240));
  const chunkSizeMb = Math.max(1, Math.min(Number(req.body.chunkSizeMb || DEFAULT_FILE_POLICY.chunkSizeMb), 64));
  const enableVirusScan = normalizeBoolean(req.body.enableVirusScan, false);
  const rejectExecutableFiles = normalizeBoolean(req.body.rejectExecutableFiles, true);
  req.db.settings.filePolicy = { allowedExtensions, maxSizeMb, chunkSizeMb, enableVirusScan, rejectExecutableFiles };
  addAudit(req.db, req.user.id, 'system.file_policy.update', 'system_setting', 'file_policy', req.db.settings.filePolicy, req);
  await saveDb(req.db);
  res.json(ok(currentFilePolicy(req.db)));
}));

app.get('/api/v1/system-settings/file-storage', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看文件存储配置');
  const settings = currentFileStorageSettings(req.db);
  res.json(ok({ ...sanitizeFileStorageSettings(settings), usage: { totalBytes: storageUsage(req.db), userBytes: storageUsage(req.db, req.user.id) } }));
});

app.put('/api/v1/system-settings/file-storage', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护文件存储配置');
  const next = normalizeFileStorageSettings(req.body || {}, currentFileStorageSettings(req.db));
  if (next.provider === 'nas') {
    if (!next.nasRoot) throw createError(400, 'VALIDATION_ERROR', '请填写 NAS 根目录');
    await ensureDir(next.nasRoot);
    const probe = path.join(next.nasRoot, `.document-platform-${crypto.randomBytes(6).toString('hex')}`);
    await fs.writeFile(probe, 'storage-test');
    await fs.rm(probe, { force: true });
  }
  if (next.provider === 's3') {
    if (!next.s3.bucket) throw createError(400, 'VALIDATION_ERROR', '请填写 S3 Bucket');
    await s3ClientFor(next.s3).send(new HeadBucketCommand({ Bucket: next.s3.bucket }));
  }
  next.updatedBy = req.user.id;
  next.updatedAt = now();
  req.db.settings.fileStorage = next;
  addAudit(req.db, req.user.id, 'system.file_storage.update', 'system_setting', 'file_storage', sanitizeFileStorageSettings(next), req);
  await saveDb(req.db);
  res.json(ok({ ...sanitizeFileStorageSettings(next), usage: { totalBytes: storageUsage(req.db), userBytes: storageUsage(req.db, req.user.id) } }));
}));

app.post('/api/v1/system-settings/file-storage/test', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以测试文件存储');
  const settings = normalizeFileStorageSettings(req.body || {}, currentFileStorageSettings(req.db));
  if (settings.provider === 'local') return res.json(ok({ provider: 'local', connected: true, path: config.uploadDir }));
  if (settings.provider === 'nas') {
    await ensureDir(settings.nasRoot);
    const probe = path.join(settings.nasRoot, `.document-platform-${crypto.randomBytes(6).toString('hex')}`);
    await fs.writeFile(probe, 'storage-test');
    await fs.rm(probe, { force: true });
    return res.json(ok({ provider: 'nas', connected: true, path: settings.nasRoot }));
  }
  await s3ClientFor(settings.s3).send(new HeadBucketCommand({ Bucket: settings.s3.bucket }));
  res.json(ok({ provider: 's3', connected: true, bucket: settings.s3.bucket }));
}));

app.get('/api/v1/storage/usage', requireAuth, (req, res) => {
  const settings = currentFileStorageSettings(req.db);
  const totalBytes = storageUsage(req.db);
  const userBytes = storageUsage(req.db, req.user.id);
  const userLimitGb = Number(settings.quota.userLimitsGb?.[req.user.id] ?? settings.quota.defaultUserGb ?? 0);
  res.json(ok({ provider: settings.provider, totalBytes, totalLimitBytes: settings.quota.totalGb > 0 ? settings.quota.totalGb * 1024 ** 3 : null, userBytes, userLimitBytes: userLimitGb > 0 ? userLimitGb * 1024 ** 3 : null }));
});

app.post('/api/v1/system/storage/lifecycle/run', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以执行存储生命周期任务');
  const result = await runStorageLifecycle(req.db, req.user.id, req);
  await saveDb(req.db);
  res.json(ok(result));
}));

app.get('/api/v1/system-settings/security-policy', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统设置');
  res.json(ok(currentSecurityPolicy(req.db)));
});

app.put('/api/v1/system-settings/security-policy', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护系统设置');
  req.db.settings.securityPolicy = {
    ...normalizeSecurityPolicy(req.body || {}),
    updatedBy: req.user.id,
    updatedAt: now()
  };
  addAudit(req.db, req.user.id, 'security-policy.update', 'system_setting', 'security_policy', req.db.settings.securityPolicy, req);
  await saveDb(req.db);
  res.json(ok(currentSecurityPolicy(req.db)));
}));

app.get('/api/v1/system-settings/external-library', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统设置');
  const settings = currentExternalLibrarySettings(req.db);
  res.json(ok({ ...settings, envRootPath: config.externalLibraryRoot || '' }));
});

app.put('/api/v1/system-settings/external-library', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护系统设置');
  const rootPath = String(req.body.rootPath || '').trim();
  req.db.settings.externalLibrary = {
    ...currentExternalLibrarySettings(req.db),
    rootPath,
    includePaths: normalizeOptions(req.body.includePaths || []),
    excludePatterns: normalizeOptions(req.body.excludePatterns || [])
  };
  addAudit(req.db, req.user.id, 'system.external_library.update', 'system_setting', 'external_library', req.db.settings.externalLibrary, req);
  await saveDb(req.db);
  res.json(ok(req.db.settings.externalLibrary));
}));

app.get('/api/v1/system-settings/office-preview', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统设置');
  res.json(ok(sanitizeOfficePreviewSettings(req.db.settings.officePreview || {})));
});

app.put('/api/v1/system-settings/office-preview', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护系统设置');
  const existing = normalizeOfficePreviewSettings(req.db.settings.officePreview || {});
  const incoming = { ...req.body };
  if (!String(incoming.jwtSecret || '').trim()) incoming.jwtSecret = existing.jwtSecret;
  const normalized = normalizeOfficePreviewSettings(incoming, existing);
  if (normalized.enabled && !normalized.documentServerUrl) {
    throw createError(400, 'VALIDATION_ERROR', '启用 Office 原版预览前，请填写 Document Server 地址');
  }
  req.db.settings.officePreview = normalized;
  addAudit(req.db, req.user.id, 'system.office_preview.update', 'system_setting', 'office_preview', sanitizeOfficePreviewSettings(normalized), req);
  await saveDb(req.db);
  res.json(ok(sanitizeOfficePreviewSettings(req.db.settings.officePreview)));
}));

app.post('/api/v1/system-settings/office-preview/test', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以测试 Office 在线预览配置');
  const existing = normalizeOfficePreviewSettings(req.db.settings.officePreview || {});
  const incoming = req.body && Object.keys(req.body).length ? { ...req.body } : null;
  if (incoming && !String(incoming.jwtSecret || '').trim()) incoming.jwtSecret = existing.jwtSecret;
  const settings = incoming ? normalizeOfficePreviewSettings(incoming, existing) : existing;
  const missing = [];
  if (!settings.enabled) missing.push('启用状态');
  if (!settings.documentServerUrl) missing.push('Document Server 地址');
  const configurationIssue = missing.length ? '' : officePreviewConfigurationIssue(req, settings);
  const result = {
    ok: missing.length === 0 && !configurationIssue,
    message: missing.length ? `缺少 ${missing.join('、')}` : (configurationIssue || '配置项完整，等待 Document Server 联通验证'),
    checkedAt: now(),
    scriptUrl: settings.documentServerUrl ? joinUrl(settings.documentServerUrl, '/web-apps/apps/api/documents/api.js') : ''
  };
  if (!missing.length && !configurationIssue) {
    try {
      const response = await fetch(result.scriptUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
      result.ok = response.ok;
      result.message = response.ok ? 'Document Server API 可访问' : `Document Server API 返回 HTTP ${response.status}`;
    } catch (error) {
      result.ok = false;
      result.message = `Document Server API 不可访问：${error.message}`;
    }
  }
  req.db.settings.officePreview = { ...existing, lastTestAt: result.checkedAt, lastTestResult: result };
  addAudit(req.db, req.user.id, 'system.office_preview.test', 'system_setting', 'office_preview', result, req);
  await saveDb(req.db);
  res.json(ok(result));
}));

app.get('/api/v1/system-settings/wecom', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统设置');
  res.json(ok(sanitizeWecomSettings(req.db.settings.wecom || {})));
});

app.put('/api/v1/system-settings/wecom', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护系统设置');
  const existing = normalizeWecomSettings(req.db.settings.wecom || {});
  const incoming = { ...req.body };
  if (!String(incoming.secret || '').trim()) incoming.secret = existing.secret;
  req.db.settings.wecom = normalizeWecomSettings(incoming, existing);
  addAudit(req.db, req.user.id, 'system.wecom.update', 'system_setting', 'wecom', sanitizeWecomSettings(req.db.settings.wecom), req);
  await saveDb(req.db);
  res.json(ok(sanitizeWecomSettings(req.db.settings.wecom)));
}));

app.post('/api/v1/system-settings/wecom/test', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以测试企业微信配置');
  const settings = normalizeWecomSettings(req.db.settings.wecom || {});
  const missing = [];
  if (!settings.corpId) missing.push('CorpID');
  if (!settings.agentId) missing.push('AgentID');
  if (!settings.secret) missing.push('Secret');
  let result;
  if (missing.length) {
    result = { ok: false, message: `缺少 ${missing.join('、')}`, checkedAt: now() };
  } else {
    await getWecomAccessToken(settings);
    result = { ok: true, message: '企业微信连接成功，凭据有效', checkedAt: now() };
  }
  req.db.settings.wecom = { ...settings, lastTestAt: result.checkedAt, lastTestResult: result };
  addAudit(req.db, req.user.id, 'system.wecom.test', 'system_setting', 'wecom', result, req);
  await saveDb(req.db);
  res.json(ok(result));
}));

app.post('/api/v1/system-settings/wecom/sync', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以同步企业微信通讯录');
  try {
    const job = await syncWecomDirectory(req.db, req.user.id, req);
    await saveDb(req.db);
    res.json(ok(job));
  } catch (error) {
    await saveDb(req.db);
    throw error;
  }
}));

app.get('/api/v1/system-settings/wecom/sync-jobs', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看企业微信同步日志');
  sendPage(res, req.db.wecomSyncJobs || [], req.query.page, req.query.pageSize || 20);
});

app.get('/api/v1/wecom/auth/config', asyncRoute(async (_req, res) => {
  const db = ensureDbShape(await loadDb());
  const settings = currentWecomSettings(db);
  res.json(ok({ enabled: Boolean(settings.enabled && settings.corpId && settings.secret), corpId: settings.corpId, agentId: settings.agentId }));
}));

app.get('/api/v1/wecom/auth/url', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const settings = currentWecomSettings(db);
  if (!settings.enabled || !settings.corpId || !settings.secret) throw createError(400, 'WECOM_NOT_CONFIGURED', '企业微信免登尚未启用');
  const redirectUri = String(req.query.redirectUri || '').trim();
  if (!/^https?:\/\//i.test(redirectUri)) throw createError(400, 'VALIDATION_ERROR', 'redirectUri 必须是 HTTP(S) 地址');
  const state = encodeWecomState(redirectUri);
  const authorizeUrl = new URL('https://open.weixin.qq.com/connect/oauth2/authorize');
  authorizeUrl.searchParams.set('appid', settings.corpId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'snsapi_base');
  authorizeUrl.searchParams.set('state', state);
  res.json(ok({ authorizeUrl: `${authorizeUrl.toString()}#wechat_redirect`, stateExpiresInSeconds: 600 }));
}));

app.get('/api/v1/wecom/auth/callback', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const settings = currentWecomSettings(db);
  const code = String(req.query.code || '').trim();
  if (!code) throw createError(400, 'VALIDATION_ERROR', '缺少企业微信授权 code');
  if (req.query.state) verifyWecomState(req.query.state);
  const accessToken = await getWecomAccessToken(settings);
  const identity = await requestWecomJson(settings, '/cgi-bin/auth/getuserinfo', { access_token: accessToken, code });
  const wecomUserId = String(identity.UserId || identity.userid || '').trim();
  if (!wecomUserId) throw createError(403, 'WECOM_USER_NOT_FOUND', '当前企业微信身份不是企业成员');
  const user = db.users.find((item) => item.wecomUserId === wecomUserId || item.username === wecomUserId);
  if (!user) throw createError(403, 'WECOM_USER_NOT_SYNCED', '企业微信用户尚未同步到文档平台，请联系管理员同步通讯录');
  if (user.status !== 'enabled') throw createError(403, 'FORBIDDEN', '账号已被禁用');
  user.wecomUserId = wecomUserId;
  user.lastLoginAt = now();
  user.updatedAt = now();
  addAudit(db, user.id, 'auth.wecom_login', 'user', user.id, { wecomUserId }, req);
  await saveDb(db);
  res.json(ok({ token: signToken({ userId: user.id }), user: pickPublicUser(user) }));
}));

app.get('/api/v1/auth/providers', asyncRoute(async (_req, res) => {
  const db = ensureDbShape(await loadDb());
  const settings = currentIdentitySettings(db);
  res.json(ok({ oidc: { enabled: settings.oidc.enabled, issuer: settings.oidc.issuer }, saml: { enabled: settings.saml.enabled, issuer: settings.saml.issuer } }));
}));

app.get('/api/v1/auth/oidc/url', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const settings = currentIdentitySettings(db).oidc;
  if (!settings.enabled || !settings.issuer || !settings.clientId || !settings.clientSecret || !settings.redirectUri) throw createError(400, 'OIDC_NOT_CONFIGURED', 'OIDC 配置不完整');
  const discovery = await oidcDiscovery(settings);
  const state = encodeIdentityState('oidc', String(req.query.redirectUri || ''));
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('scope', settings.scopes);
  url.searchParams.set('state', state);
  res.json(ok({ authorizeUrl: url.toString() }));
}));

app.get('/api/v1/auth/oidc/callback', asyncRoute(async (req, res) => {
  const state = verifyIdentityState(req.query.state, 'oidc');
  const db = ensureDbShape(await loadDb());
  const settings = currentIdentitySettings(db).oidc;
  const discovery = await oidcDiscovery(settings);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code || ''), redirect_uri: settings.redirectUri, client_id: settings.clientId, client_secret: settings.clientSecret });
  const tokenResponse = await fetch(discovery.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.id_token) throw createError(502, 'OIDC_TOKEN_FAILED', tokens.error_description || tokens.error || 'OIDC 换取令牌失败');
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: settings.issuer, audience: settings.clientId });
  const externalId = String(payload.sub || '');
  const username = String(payload[settings.usernameClaim] || payload.preferred_username || payload.email || externalId);
  const user = externalIdentityUser(db, { provider: 'oidc', externalId, username, displayName: String(payload[settings.displayNameClaim] || payload.name || username), email: String(payload[settings.emailClaim] || payload.email || ''), autoProvision: settings.autoProvision });
  user.lastLoginAt = now();
  addAudit(db, user.id, 'auth.oidc_login', 'user', user.id, { issuer: settings.issuer, subject: externalId }, req);
  await saveDb(db);
  res.json(ok({ token: signToken({ userId: user.id }), user: pickPublicUser(user), redirectUri: state.redirectUri || '' }));
}));

app.get('/api/v1/auth/saml/url', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const settings = currentIdentitySettings(db).saml;
  if (!settings.enabled || !settings.entryPoint || !settings.callbackUrl || !settings.idpCert) throw createError(400, 'SAML_NOT_CONFIGURED', 'SAML 配置不完整');
  const relayState = encodeIdentityState('saml', String(req.query.redirectUri || ''));
  res.json(ok({ authorizeUrl: await samlClient(settings).getAuthorizeUrlAsync(relayState, req.hostname, {}) }));
}));

app.post('/api/v1/auth/saml/callback', express.urlencoded({ extended: false, limit: '2mb' }), asyncRoute(async (req, res) => {
  const state = verifyIdentityState(req.body.RelayState, 'saml');
  const db = ensureDbShape(await loadDb());
  const settings = currentIdentitySettings(db).saml;
  const { profile } = await samlClient(settings).validatePostResponseAsync({ SAMLResponse: String(req.body.SAMLResponse || '') });
  if (!profile) throw createError(401, 'SAML_LOGIN_FAILED', 'SAML 响应未包含用户身份');
  const externalId = String(profile.nameID || profile[settings.usernameAttribute] || '');
  const username = String(profile[settings.usernameAttribute] || profile.nameID || '');
  const user = externalIdentityUser(db, { provider: 'saml', externalId, username, displayName: String(profile[settings.displayNameAttribute] || profile.displayName || username), email: String(profile[settings.emailAttribute] || profile.email || ''), autoProvision: settings.autoProvision });
  user.lastLoginAt = now();
  const ticket = {
    id: newId('sso_'), userId: user.id, createdBy: user.id, createdAt: now(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), consumedAt: null, consumedByIp: ''
  };
  db.loginTickets.unshift(ticket);
  addAudit(db, user.id, 'auth.saml_login', 'user', user.id, { issuer: profile.issuer || '', nameID: profile.nameID || '' }, req);
  await saveDb(db);
  const redirectUrl = new URL(state.redirectUri || requestPublicBaseUrl(req, {}));
  redirectUrl.searchParams.set('ssoTicket', ticket.id);
  res.redirect(303, redirectUrl.toString());
}));

app.get('/api/v1/system-settings/identity', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看身份源配置');
  res.json(ok(sanitizeIdentitySettings(currentIdentitySettings(req.db))));
});

app.put('/api/v1/system-settings/identity', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护身份源配置');
  req.db.settings.identity = normalizeIdentitySettings(req.body || {}, currentIdentitySettings(req.db));
  addAudit(req.db, req.user.id, 'system.identity.update', 'system_setting', 'identity', sanitizeIdentitySettings(req.db.settings.identity), req);
  await saveDb(req.db);
  res.json(ok(sanitizeIdentitySettings(req.db.settings.identity)));
}));

app.post('/api/v1/system-settings/identity/ldap/test', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以测试 LDAP');
  const settings = currentIdentitySettings(req.db).ldap;
  const client = new LdapClient({ url: settings.url, timeout: 10000, connectTimeout: 10000, strictDN: false });
  try {
    await client.bind(settings.bindDn, settings.bindPassword);
    const result = await client.search(settings.baseDn, { scope: 'sub', filter: settings.userFilter, sizeLimit: 1, attributes: [settings.usernameAttribute] });
    res.json(ok({ connected: true, sampleCount: result.searchEntries.length }));
  } finally { await client.unbind().catch(() => {}); }
}));

app.post('/api/v1/system-settings/identity/ldap/sync', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以同步 LDAP');
  const settings = currentIdentitySettings(req.db).ldap;
  if (!settings.enabled || !settings.url || !settings.bindDn || !settings.baseDn) throw createError(400, 'LDAP_NOT_CONFIGURED', 'LDAP 配置不完整');
  const client = new LdapClient({ url: settings.url, timeout: 20000, connectTimeout: 10000, strictDN: false });
  let created = 0;
  let updated = 0;
  try {
    await client.bind(settings.bindDn, settings.bindPassword);
    const attributes = [settings.usernameAttribute, settings.displayNameAttribute, settings.emailAttribute, settings.departmentAttribute].filter(Boolean);
    const result = await client.search(settings.baseDn, { scope: 'sub', filter: settings.userFilter, attributes });
    result.searchEntries.forEach((entry) => {
      const username = String(entry[settings.usernameAttribute] || '').trim();
      if (!username) return;
      const existed = req.db.users.some((item) => item.username === username || (item.externalIdentities || []).includes(`ldap:${entry.dn}`));
      const user = externalIdentityUser(req.db, { provider: 'ldap', externalId: entry.dn, username, displayName: String(entry[settings.displayNameAttribute] || username), email: String(entry[settings.emailAttribute] || ''), autoProvision: true });
      const departmentName = String(entry[settings.departmentAttribute] || '').trim();
      if (departmentName) {
        let department = req.db.departments.find((item) => item.name === departmentName && item.sourceType === 'ldap');
        if (!department) { department = { id: newId('d_'), parentId: null, name: departmentName, code: `ldap:${departmentName}`, sortOrder: 100, status: 'enabled', sourceType: 'ldap', createdAt: now(), updatedAt: now() }; req.db.departments.push(department); }
        user.departmentIds = [department.id];
      }
      existed ? updated += 1 : created += 1;
    });
  } finally { await client.unbind().catch(() => {}); }
  addAudit(req.db, req.user.id, 'system.ldap.sync', 'system_setting', 'ldap', { created, updated }, req);
  await saveDb(req.db);
  res.json(ok({ created, updated }));
}));

app.post('/api/v1/hr/sync', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const settings = currentIdentitySettings(db).hr;
  const incomingSecret = String(req.headers['x-hr-sync-secret'] || '');
  if (!settings.enabled || !settings.syncSecret || incomingSecret.length !== settings.syncSecret.length || !crypto.timingSafeEqual(Buffer.from(incomingSecret), Buffer.from(settings.syncSecret))) throw createError(401, 'UNAUTHORIZED', 'HR 同步密钥无效');
  const incomingDepartments = Array.isArray(req.body.departments) ? req.body.departments : [];
  const incomingUsers = Array.isArray(req.body.users) ? req.body.users : [];
  const departmentMap = new Map();
  incomingDepartments.forEach((item) => {
    const externalId = String(item.id || item.code || '').trim();
    if (!externalId) return;
    let department = db.departments.find((entry) => entry.hrDepartmentId === externalId);
    if (!department) { department = { id: newId('d_'), createdAt: now() }; db.departments.push(department); }
    Object.assign(department, { parentId: null, name: String(item.name || externalId), code: String(item.code || `hr:${externalId}`), sortOrder: Number(item.sortOrder || 100), status: item.status === 'disabled' ? 'disabled' : 'enabled', sourceType: 'hr', hrDepartmentId: externalId, updatedAt: now() });
    departmentMap.set(externalId, department);
  });
  incomingDepartments.forEach((item) => {
    const dep = departmentMap.get(String(item.id || item.code || ''));
    if (dep) dep.parentId = departmentMap.get(String(item.parentId || ''))?.id || null;
  });
  const syncedIds = new Set();
  incomingUsers.forEach((item) => {
    const externalId = String(item.id || item.username || '').trim();
    const username = String(item.username || externalId).trim();
    if (!externalId || !username) return;
    const user = externalIdentityUser(db, { provider: 'hr', externalId, username, displayName: String(item.displayName || item.name || username), email: String(item.email || ''), autoProvision: true });
    user.phone = String(item.phone || user.phone || '');
    user.departmentIds = (item.departmentIds || [item.departmentId]).map((id) => departmentMap.get(String(id))?.id).filter(Boolean);
    user.status = item.status === 'disabled' ? 'disabled' : 'enabled';
    syncedIds.add(externalId);
  });
  if (settings.autoDisableMissing) db.users.filter((item) => item.sourceType === 'hr').forEach((item) => { const id = (item.externalIdentities || []).find((entry) => entry.startsWith('hr:'))?.slice(3); if (id && !syncedIds.has(id)) item.status = 'disabled'; });
  addAudit(db, null, 'system.hr.sync', 'system_setting', 'hr', { departments: incomingDepartments.length, users: incomingUsers.length }, req);
  await saveDb(db);
  res.json(ok({ departments: incomingDepartments.length, users: incomingUsers.length }));
}));

app.get('/api/v1/system-settings/storage', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统设置');
  const storage = await readStorageConfig();
  res.json(ok({ ...storage, runtime: getStorageRuntimeInfo() }));
}));

app.post('/api/v1/system-settings/storage/test', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以测试数据库连接');
  const existing = await readStorageConfig({ includePassword: true });
  const candidate = normalizeStorageConfig(req.body || {}, existing);
  try {
    const result = await testMysqlConnection(candidate.mysql);
    await ensureMysqlStore(candidate.mysql);
    res.json(ok(result));
  } catch (error) {
    throw createError(error.status || 400, 'MYSQL_CONNECTION_FAILED', `MySQL 连接失败：${error.message}`);
  }
}));

app.put('/api/v1/system-settings/storage', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护系统设置');
  const existing = await readStorageConfig({ includePassword: true });
  const candidate = normalizeStorageConfig(req.body || {}, existing);
  if (candidate.provider === 'mysql') {
    try {
      await testMysqlConnection(candidate.mysql);
      await ensureMysqlStore(candidate.mysql);
    } catch (error) {
      throw createError(error.status || 400, 'MYSQL_CONNECTION_FAILED', `MySQL 连接失败：${error.message}`);
    }
  }
  const saved = await writeStorageConfig(candidate);
  addAudit(req.db, req.user.id, 'system.storage.update', 'system_setting', 'storage', {
    provider: saved.provider,
    mysql: sanitizeStorageConfig(saved).mysql
  }, req);
  await saveDb(req.db);
  await reloadDb();
  res.json(ok({ ...sanitizeStorageConfig(saved), runtime: getStorageRuntimeInfo() }));
}));

app.post('/api/v1/system-settings/storage/sync', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以同步数据库账本');
  const storage = await readStorageConfig({ includePassword: true });
  if (storage.provider !== 'mysql') throw createError(400, 'VALIDATION_ERROR', '当前未启用 MySQL 存储');
  try {
    await saveMysqlSnapshot(req.db, storage);
  } catch (error) {
    throw createError(error.status || 400, 'MYSQL_CONNECTION_FAILED', `MySQL 同步失败：${error.message}`);
  }
  addAudit(req.db, req.user.id, 'system.storage.sync', 'system_setting', 'storage', {
    provider: storage.provider,
    mysql: sanitizeStorageConfig(storage).mysql
  }, req);
  await saveDb(req.db);
  res.json(ok({ synced: true, storage: { ...sanitizeStorageConfig(storage), runtime: getStorageRuntimeInfo() } }));
}));

app.post('/api/v1/external-library/sync', requireAuth, asyncRoute(async (req, res) => {
  const explicitRootPath = isAdmin(req.user) ? req.body.rootPath || null : null;
  const rootPath = resolveExternalRootPath(req.db, explicitRootPath);
  const settings = currentExternalLibrarySettings(req.db);
  const syncOptions = isAdmin(req.user)
    ? {
      includePaths: req.body.includePaths === undefined ? settings.includePaths : req.body.includePaths,
      excludePatterns: req.body.excludePatterns === undefined ? settings.excludePatterns : req.body.excludePatterns
    }
    : { includePaths: settings.includePaths, excludePatterns: settings.excludePatterns };
  try {
    const summary = await syncExternalDirectory(req.db, rootPath, req.user.id, req, syncOptions);
    await saveDb(req.db);
    res.json(ok(summary));
  } catch (error) {
    await saveDb(req.db);
    throw error;
  }
}));

app.get('/api/v1/external-library/sync-status', requireAuth, (req, res) => {
  const settings = currentExternalLibrarySettings(req.db);
  res.json(ok({
    rootPath: isAdmin(req.user) ? settings.rootPath : '',
    includePaths: isAdmin(req.user) ? settings.includePaths : [],
    excludePatterns: isAdmin(req.user) ? settings.excludePatterns : [],
    lastSyncedAt: settings.lastSyncedAt,
    lastSyncSummary: settings.lastSyncSummary,
    lastSyncJob: publicExternalSyncJob(settings.lastSyncJob)
  }));
});

app.get('/api/v1/external-library/sync-jobs', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看同步日志');
  const jobs = (req.db.externalSyncJobs || []).map(publicExternalSyncJob);
  sendPage(res, jobs, req.query.page, req.query.pageSize || 20);
});

app.get('/api/v1/api-credentials', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以管理 API 凭证');
  const items = req.db.apiCredentials
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((item) => publicCredential(req.db, item));
  sendPage(res, items, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/api-credentials', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以创建 API 凭证');
  const userId = req.body.userId || req.user.id;
  const owner = req.db.users.find((item) => item.id === userId && item.status === 'enabled');
  if (!owner) throw createError(404, 'NOT_FOUND', '凭证关联用户不存在');
  const accessKey = newId('ak_');
  const secret = `${newId('sk_')}${newId('')}`;
  const hp = hashPassword(secret);
  const credential = {
    id: newId('cred_'),
    name: validateName(req.body.name || 'API 凭证'),
    accessKey,
    secretHash: hp.hash,
    secretSalt: hp.salt,
    userId,
    scopes: Array.isArray(req.body.scopes) && req.body.scopes.length ? req.body.scopes : ['files:read'],
    status: req.body.status || 'enabled',
    rateLimitPerMinute: Math.max(1, Math.min(Number(req.body.rateLimitPerMinute || 120), 10000)),
    expiresAt: req.body.expiresAt || null,
    lastUsedAt: null,
    callCount: 0,
    createdBy: req.user.id,
    createdAt: now(),
    updatedAt: now()
  };
  req.db.apiCredentials.unshift(credential);
  addAudit(req.db, req.user.id, 'api_credential.create', 'api_credential', credential.id, { name: credential.name, userId }, req);
  await saveDb(req.db);
  res.json(ok(publicCredential(req.db, credential, secret)));
}));

app.put('/api/v1/api-credentials/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护 API 凭证');
  const credential = req.db.apiCredentials.find((item) => item.id === req.params.id);
  if (!credential) throw createError(404, 'NOT_FOUND', 'API 凭证不存在');
  if (req.body.userId !== undefined) {
    const owner = req.db.users.find((item) => item.id === req.body.userId && item.status === 'enabled');
    if (!owner) throw createError(404, 'NOT_FOUND', '凭证关联用户不存在');
    credential.userId = req.body.userId;
  }
  credential.name = req.body.name ? validateName(req.body.name) : credential.name;
  credential.scopes = req.body.scopes === undefined ? credential.scopes : (Array.isArray(req.body.scopes) ? req.body.scopes : []);
  credential.status = req.body.status || credential.status;
  credential.rateLimitPerMinute = req.body.rateLimitPerMinute === undefined ? credential.rateLimitPerMinute : Math.max(1, Math.min(Number(req.body.rateLimitPerMinute || 120), 10000));
  credential.expiresAt = req.body.expiresAt === undefined ? credential.expiresAt : (req.body.expiresAt || null);
  credential.updatedAt = now();
  addAudit(req.db, req.user.id, 'api_credential.update', 'api_credential', credential.id, { name: credential.name, status: credential.status }, req);
  await saveDb(req.db);
  res.json(ok(publicCredential(req.db, credential)));
}));

app.post('/api/v1/api-credentials/:id/rotate-secret', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护 API 凭证');
  const credential = req.db.apiCredentials.find((item) => item.id === req.params.id);
  if (!credential) throw createError(404, 'NOT_FOUND', 'API 凭证不存在');
  const secret = `${newId('sk_')}${newId('')}`;
  const hp = hashPassword(secret);
  credential.secretHash = hp.hash;
  credential.secretSalt = hp.salt;
  credential.status = 'enabled';
  credential.updatedAt = now();
  addAudit(req.db, req.user.id, 'api_credential.rotate_secret', 'api_credential', credential.id, { name: credential.name }, req);
  await saveDb(req.db);
  res.json(ok(publicCredential(req.db, credential, secret)));
}));

app.delete('/api/v1/api-credentials/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以删除 API 凭证');
  const credential = req.db.apiCredentials.find((item) => item.id === req.params.id);
  if (!credential) throw createError(404, 'NOT_FOUND', 'API 凭证不存在');
  credential.status = 'disabled';
  credential.updatedAt = now();
  addAudit(req.db, req.user.id, 'api_credential.disable', 'api_credential', credential.id, { name: credential.name }, req);
  await saveDb(req.db);
  res.json(ok(publicCredential(req.db, credential)));
}));

app.get('/api/v1/api-call-logs', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看 API 调用日志');
  let logs = req.db.apiCallLogs;
  if (req.query.credentialId) logs = logs.filter((item) => item.credentialId === req.query.credentialId);
  if (req.query.userId) logs = logs.filter((item) => item.userId === req.query.userId);
  logs = logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  sendPage(res, logs, req.query.page, req.query.pageSize || 100);
});

app.get('/api/v1/webhooks', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以管理 Webhook');
  sendPage(res, req.db.webhookSubscriptions.map((item) => publicWebhookSubscription(item)), req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/webhooks', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以创建 Webhook');
  let url;
  try { url = new URL(String(req.body.url || '')); } catch { throw createError(400, 'VALIDATION_ERROR', 'Webhook URL 格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw createError(400, 'VALIDATION_ERROR', 'Webhook URL 必须是 HTTP(S) 地址');
  const secret = crypto.randomBytes(32).toString('base64url');
  const subscription = {
    id: newId('wh_'), name: validateName(req.body.name || 'Webhook'), url: url.toString(),
    eventPatterns: normalizeOptions(req.body.eventPatterns || ['*']), status: req.body.status === 'disabled' ? 'disabled' : 'enabled',
    secret, createdBy: req.user.id, createdAt: now(), updatedAt: now(), lastDeliveredAt: null, lastError: ''
  };
  req.db.webhookSubscriptions.unshift(subscription);
  addAudit(req.db, req.user.id, 'webhook.create', 'webhook', subscription.id, { name: subscription.name, url: subscription.url, eventPatterns: subscription.eventPatterns }, req);
  await saveDb(req.db);
  res.json(ok(publicWebhookSubscription(subscription, secret)));
}));

app.put('/api/v1/webhooks/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护 Webhook');
  const subscription = req.db.webhookSubscriptions.find((item) => item.id === req.params.id);
  if (!subscription) throw createError(404, 'NOT_FOUND', 'Webhook 不存在');
  if (req.body.url !== undefined) {
    let url;
    try { url = new URL(String(req.body.url || '')); } catch { throw createError(400, 'VALIDATION_ERROR', 'Webhook URL 格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw createError(400, 'VALIDATION_ERROR', 'Webhook URL 必须是 HTTP(S) 地址');
    subscription.url = url.toString();
  }
  subscription.name = req.body.name ? validateName(req.body.name) : subscription.name;
  subscription.eventPatterns = req.body.eventPatterns === undefined ? subscription.eventPatterns : normalizeOptions(req.body.eventPatterns || ['*']);
  subscription.status = req.body.status || subscription.status;
  subscription.updatedAt = now();
  addAudit(req.db, req.user.id, 'webhook.update', 'webhook', subscription.id, { status: subscription.status }, req);
  await saveDb(req.db);
  res.json(ok(publicWebhookSubscription(subscription)));
}));

app.delete('/api/v1/webhooks/:id', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以删除 Webhook');
  const subscription = req.db.webhookSubscriptions.find((item) => item.id === req.params.id);
  if (!subscription) throw createError(404, 'NOT_FOUND', 'Webhook 不存在');
  subscription.status = 'disabled';
  subscription.updatedAt = now();
  await saveDb(req.db);
  res.json(ok(publicWebhookSubscription(subscription)));
}));

app.get('/api/v1/webhook-deliveries', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看 Webhook 投递');
  let items = req.db.webhookDeliveries;
  if (req.query.subscriptionId) items = items.filter((item) => item.subscriptionId === req.query.subscriptionId);
  if (req.query.status) items = items.filter((item) => item.status === req.query.status);
  sendPage(res, items, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/webhook-deliveries/:id/retry', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以重试 Webhook');
  const existing = req.db.webhookDeliveries.find((item) => item.id === req.params.id);
  if (!existing) throw createError(404, 'NOT_FOUND', 'Webhook 投递记录不存在');
  const subscription = req.db.webhookSubscriptions.find((item) => item.id === existing.subscriptionId);
  if (!subscription) throw createError(404, 'NOT_FOUND', 'Webhook 配置不存在');
  const audit = req.db.auditLogs.find((item) => `evt_${item.id}` === existing.eventId);
  if (!audit) throw createError(404, 'NOT_FOUND', 'Webhook 原始事件不存在');
  const event = { id: existing.eventId, type: audit.action, occurredAt: audit.createdAt, data: { actorId: audit.actorId || null, targetType: audit.targetType, targetId: audit.targetId, targetPath: audit.targetPath || '', detail: audit.detail || {} } };
  const delivery = await deliverWebhook(req.db, subscription, event);
  delivery.attempts = Number(existing.attempts || 0) + 1;
  await saveDb(req.db);
  res.json(ok(delivery));
}));

app.post('/api/v1/sso/tickets', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以创建单点登录票据');
  const userId = req.body.userId;
  const targetUser = req.db.users.find((item) => item.id === userId && item.status === 'enabled');
  if (!targetUser) throw createError(404, 'NOT_FOUND', '用户不存在或已禁用');
  const expiresInMinutes = Math.max(1, Math.min(Number(req.body.expiresInMinutes || 5), 60));
  const ticket = {
    id: newId('sso_'),
    userId: targetUser.id,
    createdBy: req.user.id,
    createdAt: now(),
    expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
    consumedAt: null,
    consumedByIp: ''
  };
  req.db.loginTickets.unshift(ticket);
  addAudit(req.db, req.user.id, 'sso.ticket.create', 'login_ticket', ticket.id, { userId: targetUser.id, expiresAt: ticket.expiresAt }, req);
  await saveDb(req.db);
  res.json(ok({
    ...ticket,
    loginUrl: `/api/v1/sso/consume?ticket=${encodeURIComponent(ticket.id)}`,
    frontendLoginUrl: `?ssoTicket=${encodeURIComponent(ticket.id)}`
  }));
}));

app.get('/api/v1/sso/tickets/:id/user', requireAuth, (req, res) => {
  if (!isAdmin(req.user) && !req.apiCredential) throw createError(403, 'FORBIDDEN', '只有管理员或 API 凭证可以反查登录票据');
  const ticket = req.db.loginTickets.find((item) => item.id === req.params.id);
  if (!ticket) throw createError(404, 'NOT_FOUND', '登录票据不存在');
  const user = req.db.users.find((item) => item.id === ticket.userId);
  if (!user) throw createError(404, 'NOT_FOUND', '票据关联用户不存在');
  res.json(ok({ ticketId: ticket.id, user: pickPublicUser(user), expiresAt: ticket.expiresAt, expired: new Date(ticket.expiresAt).getTime() < Date.now(), consumedAt: ticket.consumedAt || null }));
});

app.get('/api/v1/sso/consume', asyncRoute(async (req, res) => {
  const db = ensureDbShape(await loadDb());
  const ticket = db.loginTickets.find((item) => item.id === req.query.ticket);
  if (!ticket || ticket.consumedAt) throw createError(401, 'UNAUTHORIZED', '登录票据无效');
  if (new Date(ticket.expiresAt).getTime() < Date.now()) throw createError(401, 'UNAUTHORIZED', '登录票据已过期');
  const user = db.users.find((item) => item.id === ticket.userId && item.status === 'enabled');
  if (!user) throw createError(401, 'UNAUTHORIZED', '票据关联用户不存在或已禁用');
  ticket.consumedAt = now();
  ticket.consumedByIp = req.ip || '';
  user.lastLoginAt = now();
  addAudit(db, user.id, 'auth.sso_login', 'user', user.id, { ticketId: ticket.id }, req);
  await saveDb(db);
  res.json(ok({ token: signToken({ userId: user.id }), user: pickPublicUser(user) }));
}));

app.get('/api/v1/dashboard', requireAuth, asyncRoute(async (req, res) => {
  dispatchDueReminders(req.db, req.user.id);
  dispatchOperationalReminders(req.db);
  await saveDb(req.db);
  const visible = listVisibleDescendants(req.db, req.user);
  const files = visible.filter((item) => item.nodeType === 'file');
  const latestFiles = files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((item) => publicNode(req.db, req.user, item));
  const favorites = req.db.favorites
    .filter((item) => item.userId === req.user.id)
    .map((item) => ({ ...item, node: nodeById(req.db, item.nodeId) }))
    .filter((item) => item.node && hasAction(req.db, req.user, item.node, 'visible'))
    .slice(0, 20)
    .map((item) => ({ ...item, node: publicNode(req.db, req.user, item.node) }));
  const pendingApprovals = (req.db.documentApprovals || [])
    .filter((item) => item.status === 'pending' && (isAdmin(req.user) || currentApprovalStep(item)?.approverIds?.includes(req.user.id)))
    .filter((item) => {
      const node = nodeById(req.db, item.nodeId);
      return node && hasAction(req.db, req.user, node, 'visible');
    })
    .slice(0, 20)
    .map((item) => publicApproval(req.db, req.user, item));
  const myShares = (req.db.shares || []).filter((item) => item.createdBy === req.user.id).slice(0, 20).map((item) => publicShare(req.db, item));
  const mySubscriptions = (req.db.subscriptions || []).filter((item) => item.userId === req.user.id && item.status === 'active').slice(0, 20).map((item) => publicSubscription(req.db, item));
  const lockedFiles = files.filter((item) => item.lockedBy).slice(0, 20).map((item) => publicNode(req.db, req.user, item));
  const fileIds = new Set(files.map((item) => item.id));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const growthTrend = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (6 - index));
    const dateKey = date.toISOString().slice(0, 10);
    const fileCount = files.filter((item) => String(item.createdAt || '').slice(0, 10) === dateKey).length;
    const versionCount = req.db.versions.filter((item) => fileIds.has(item.nodeId) && String(item.createdAt || '').slice(0, 10) === dateKey).length;
    return { date: dateKey, files: fileCount, versions: versionCount };
  });
  res.json(ok({
    stats: {
      folders: visible.filter((item) => item.nodeType === 'folder').length,
      files: files.length,
      versions: req.db.versions.filter((version) => fileIds.has(version.nodeId)).length,
      unreadMessages: req.db.messages.filter((item) => item.receiverId === req.user.id && !item.readAt && !item.archivedAt && !item.deletedAt).length,
      pendingApprovals: pendingApprovals.length,
      lockedFiles: lockedFiles.length
    },
    growthTrend,
    latestFiles,
    favorites,
    pendingApprovals,
    myShares,
    mySubscriptions,
    lockedFiles,
    reminders: req.db.reminders.filter((item) => item.userId === req.user.id && item.status === 'active').slice(0, 8).map((item) => publicReminder(req.db, item)),
    recentAudits: req.db.auditLogs.filter((item) => item.actorId === req.user.id).slice(0, 8)
  }));
}));

if (fsSync.existsSync(config.frontendDist)) {
  app.use(express.static(config.frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/storage')) return next();
    res.sendFile(path.join(config.frontendDist, 'index.html'));
  });
}

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  if (/^\/api\/v1\/files\/[^/]+\/preview(?:\?|$)/.test(req.originalUrl || '') && req.db) {
    addAudit(req.db, req.user?.id || null, 'file.preview_failed', 'node', req.params?.id || 'unknown', { status, code, message: err.message || '服务异常' }, req);
    evaluateSystemAlerts(req.db);
    void saveDbBestEffort(req.db, 'preview failure audit');
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ code, message: err.message || '服务异常', data: err.data ?? null });
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const prefixed = String(req.url || '').startsWith('/onlyoffice/');
  if (!prefixed && !isOnlyOfficeRootPath(req.url)) {
    socket.destroy();
    return;
  }
  Promise.resolve(loadDb())
    .then((db) => {
      const target = onlyOfficeProxyTarget(db);
      if (prefixed) req.url = String(req.url || '').slice('/onlyoffice'.length) || '/';
      onlyOfficeProxy.ws(req, socket, head, {
        target,
        headers: onlyOfficeProxyHeaders(req, prefixed ? '/onlyoffice' : '')
      }, () => socket.destroy());
    })
    .catch(() => socket.destroy());
});

server.listen(config.port, () => {
  console.log(`Document platform API running at http://localhost:${config.port}`);
  if (config.nodeEnv !== 'production') console.log('Development accounts: admin/admin123, demo/user123');
});
