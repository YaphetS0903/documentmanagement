import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mime from 'mime-types';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
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
await loadDb();

const upload = multer({ dest: config.tmpDir, limits: { fileSize: 1024 * 1024 * 300 } });
const app = express();
const DEFAULT_FILE_POLICY = {
  allowedExtensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'csv', 'json', 'xml', 'html', 'png', 'jpg', 'jpeg', 'gif', 'zip'],
  maxSizeMb: 300
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
const DEFAULT_WECOM_SETTINGS = {
  enabled: false,
  corpId: '',
  agentId: '',
  secret: '',
  callbackUrl: '',
  syncDepartments: true,
  syncUsers: true,
  pushMessages: false,
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
const SEARCH_OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const captchaStore = new Map();
const apiRateBuckets = new Map();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return req.query.token || null;
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
  'favorites',
  'comments',
  'ratings',
  'attachments',
  'fileRelations',
  'reminders',
  'documentApprovals',
  'documentReviews',
  'versionChangeLogs',
  'subscriptions',
  'shares',
  'announcements',
  'auditLogs',
  'apiCredentials',
  'apiCallLogs',
  'loginTickets',
  'externalSyncJobs',
  'recentAccesses',
  'searchEvents'
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
  db.settings.filePolicy = {
    ...DEFAULT_FILE_POLICY,
    ...(db.settings.filePolicy || {})
  };
  db.settings.securityPolicy = normalizeSecurityPolicy(db.settings.securityPolicy || {});
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

function conditionMatches(rule, node) {
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
  return true;
}

function ruleApplies(db, rule, node) {
  if (!conditionMatches(rule, node)) return false;
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
    .filter((approval) => (approval.type || 'workflow') === 'permission')
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
    lastTestAt: input.lastTestAt ?? fallback.lastTestAt ?? null,
    lastTestResult: input.lastTestResult ?? fallback.lastTestResult ?? null
  };
}

function sanitizeWecomSettings(settings = {}) {
  const normalized = normalizeWecomSettings(settings);
  const { secret: _secret, ...safe } = normalized;
  return {
    ...safe,
    hasSecret: Boolean(normalized.secret)
  };
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

function officeDocumentKey(version) {
  return String(`${version.id}-${version.md5 || version.createdAt || version.versionNo || ''}`)
    .replace(/[^A-Za-z0-9_.=-]/g, '_')
    .slice(0, 80);
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
      key: officeDocumentKey(version),
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
    scriptUrl: joinUrl(settings.documentServerUrl, '/web-apps/apps/api/documents/api.js'),
    config: editorConfig
  };
}

function currentFilePolicy(db) {
  return {
    ...DEFAULT_FILE_POLICY,
    ...(db.settings?.filePolicy || {}),
    allowedExtensions: normalizeExtensions(db.settings?.filePolicy?.allowedExtensions || DEFAULT_FILE_POLICY.allowedExtensions),
    maxSizeMb: Number(db.settings?.filePolicy?.maxSizeMb || DEFAULT_FILE_POLICY.maxSizeMb)
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
  node.currentVersionId = version.id;
  node.extension = extension;
  node.updatedBy = userId;
  node.updatedAt = now();
  return version;
}

function streamVersion(res, version, downloadName = null, options = {}) {
  const filePath = versionFilePath(version, options.node, options.db);
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

function recursiveZipNodes(db, archive, node, user, req = null) {
  if (req && !isNodePasswordAccessible(req, node)) return;
  if (node.nodeType === 'file') {
    if (!hasAction(db, user, node, 'file:download')) return;
    if (sensitiveDownloadBlocked(db, user, node)) return;
    const version = currentVersion(db, node);
    if (version) {
      const filePath = versionFilePath(version, node, db);
      if (fsSync.existsSync(filePath)) archive.file(filePath, { name: node.fullPath.replace(/^\//, '') });
    }
    return;
  }
  if (!hasAction(db, user, node, 'visible')) return;
  const children = db.nodes.filter((item) => item.parentId === node.id && item.status !== 'deleted');
  if (!children.length) archive.append('', { name: `${node.fullPath.replace(/^\//, '')}/` });
  children.forEach((child) => recursiveZipNodes(db, archive, child, user, req));
}

function blockedSensitiveDownloadNodes(db, user, node) {
  const candidates = node.nodeType === 'file' ? [node] : descendants(db, node.id).filter((item) => item.nodeType === 'file');
  return candidates.filter((item) => hasAction(db, user, item, 'file:download') && sensitiveDownloadBlocked(db, user, item));
}

function listVisibleDescendants(db, user) {
  return db.nodes.filter((node) => node.status !== 'deleted' && hasAction(db, user, node, 'visible'));
}

function sendPage(res, items, page = 1, pageSize = 20) {
  const p = Math.max(Number(page) || 1, 1);
  const ps = Math.max(Number(pageSize) || 20, 1);
  const start = (p - 1) * ps;
  res.json(ok({ items: items.slice(start, start + ps), page: p, pageSize: ps, total: items.length }));
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

function publicShare(db, share) {
  const node = includeDeletedNodeById(db, share.nodeId);
  return {
    ...share,
    nodeName: node?.name || '',
    nodePath: node?.fullPath || ''
  };
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
  return {
    ...announcement,
    createdByName: creator?.displayName || creator?.username || announcement.createdBy,
    canManage: isAdmin(user) || announcement.createdBy === user.id,
    attachment: announcement.attachment ? {
      originalFilename: announcement.attachment.originalFilename,
      sizeBytes: announcement.attachment.sizeBytes,
      mimeType: announcement.attachment.mimeType
    } : null
  };
}

function publicMessage(db, user, message, options = {}) {
  const node = message.relatedNodeId ? nodeById(db, message.relatedNodeId) : null;
  return {
    ...message,
    relatedNode: node && hasAction(db, user, node, 'visible') ? publicNode(db, user, node, options) : null
  };
}

function publicRecentAccess(db, user, access) {
  const node = nodeById(db, access.nodeId);
  return {
    ...access,
    node: node && hasAction(db, user, node, 'visible') ? publicNode(db, user, node) : null
  };
}

function runtimeStatus(db) {
  const files = db.nodes.filter((item) => item.nodeType === 'file' && item.status !== 'deleted');
  const folders = db.nodes.filter((item) => item.nodeType === 'folder' && item.status !== 'deleted');
  return {
    status: 'up',
    time: now(),
    uptimeSeconds: Math.round(process.uptime()),
    dataDir: config.dataDir,
    uploadDir: config.uploadDir,
    tmpDir: config.tmpDir,
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
      pendingApprovals: (db.documentApprovals || []).filter((item) => item.status === 'pending').length
    }
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
  const typeLabels = { workflow: '文档流程', download: '下载审批', permission: '权限申请', publish: '发布审批' };
  const actionLabels = {
    download: '下载文件',
    permission: '申请权限',
    publish: '发布文件'
  };
  return {
    ...approval,
    type,
    typeLabel: typeLabels[type] || type,
    actionLabel: WORKFLOW_ACTIONS[approval.action]?.label || actionLabels[type] || approval.action,
    requestedStatusLabel: BUSINESS_STATUS_LABELS[approval.requestedStatus] || approval.requestedStatus,
    requestedActionsLabel: (approval.requestedActions || []).join('、'),
    requesterName: userDisplayName(db, approval.requesterId),
    approverName: userDisplayName(db, approval.approverId),
    decidedByName: approval.decidedBy ? userDisplayName(db, approval.decidedBy) : '',
    nodeName: node?.name || approval.nodeId,
    nodePath: node?.fullPath || '',
    nodeType: node?.nodeType || '',
    nodeBusinessStatus: node?.businessStatus || '',
    nodeSecurityLevel: node?.securityLevel || '',
    nodeSensitive: Boolean(node?.sensitive),
    canDecide: approval.status === 'pending' && (isAdmin(user) || approval.approverId === user.id)
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
    publish: '发布审批'
  }[type] || type;
}

function approvalActionLabel(approval) {
  const type = approval.type || 'workflow';
  if (type === 'workflow') return WORKFLOW_ACTIONS[approval.action]?.label || approval.action;
  if (type === 'download') return '下载文件';
  if (type === 'permission') return '申请权限';
  if (type === 'publish') return '发布文件';
  return approval.action || type;
}

function createApprovalRecord(db, user, node, payload = {}, req = null) {
  const type = ['workflow', 'download', 'permission', 'publish'].includes(payload.type) ? payload.type : 'workflow';
  const approver = defaultApprover(db, payload.approverId);
  if (!approver) throw createError(400, 'VALIDATION_ERROR', '请选择有效审批人');
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
    requestedActions = normalizePermissionActions(payload.requestedActions || payload.actions || ['visible', 'file:preview'], ['visible', 'file:preview']);
  }
  const approval = {
    id: newId('appr_'),
    type,
    nodeId: node.id,
    action,
    requestedStatus,
    requestedActions,
    requesterId: user.id,
    approverId: approver.id,
    requestComment: String(payload.reason ?? payload.comment ?? '').trim(),
    decisionComment: '',
    status: 'pending',
    expiresAt: payload.expiresAt || null,
    decidedBy: null,
    decidedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.documentApprovals.unshift(approval);
  addMessage(
    db,
    approver.id,
    `${type}.approval.request`,
    `${approvalTypeLabel(type)}待处理`,
    `${userDisplayName(db, user.id)} 提交了“${node.fullPath}”的${approvalActionLabel(approval)}申请${approval.requestComment ? `：${approval.requestComment}` : ''}`,
    node.id
  );
  addAudit(db, user.id, `${type}.approval.submit`, 'document_approval', approval.id, {
    targetPath: node.fullPath,
    type,
    action: approval.action,
    requestedActions,
    approverId: approver.id
  }, req);
  return approval;
}

function approvalDecisionMessage(db, approval, node, actor, approved) {
  const resultText = approved ? '已通过' : '已驳回';
  return `${userDisplayName(db, actor.id)} ${resultText}“${node.fullPath}”的${approvalActionLabel(approval)}申请${approval.decisionComment ? `：${approval.decisionComment}` : ''}`;
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

function propertyValueFor(db, nodeId, propertyId) {
  return db.propertyValues.find((item) => item.nodeId === nodeId && item.propertyId === propertyId);
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

function openApiDocument() {
  const endpoint = (summary, method = 'get') => ({
    [method]: {
      summary,
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      responses: { 200: { description: 'OK' } }
    }
  });
  return {
    openapi: '3.0.3',
    info: {
      title: '文档管理平台 API',
      version: '0.1.0',
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
      }
    },
    paths: {
      '/auth/captcha': endpoint('获取登录验证码'),
      '/auth/login': endpoint('账号密码登录', 'post'),
      '/auth/me': endpoint('查询当前用户'),
      '/nodes/tree': endpoint('企业文档库目录树'),
      '/personal-drive/tree': endpoint('个人网盘目录树'),
      '/personal-drive/summary': endpoint('个人网盘空间概况'),
      '/nodes/{id}/children': endpoint('查询目录子节点'),
      '/folders': endpoint('创建文件夹', 'post'),
      '/files': endpoint('上传文件', 'post'),
      '/files/{id}/versions': endpoint('版本列表/上传新版本'),
      '/files/{id}/version-logs': endpoint('版本变更记录'),
      '/files/{id}/download': endpoint('文件下载'),
      '/files/{id}/preview': endpoint('文件预览'),
      '/files/{id}/read-upload-messages': endpoint('标记文件上传消息已读', 'post'),
      '/files/batch-download': endpoint('批量打包下载', 'post'),
      '/nodes/batch-move': endpoint('批量移动', 'post'),
      '/nodes/batch-delete': endpoint('批量删除', 'post'),
      '/search/files': endpoint('文件搜索', 'post'),
      '/search/suggestions': endpoint('搜索建议'),
      '/search/index/status': endpoint('全文检索索引状态'),
      '/search/index/rebuild': endpoint('重建全文检索索引', 'post'),
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
      '/system-settings/file-policy': endpoint('文件上传策略'),
      '/system-settings/security-policy': endpoint('文件安全策略'),
      '/system-settings/external-library': endpoint('服务器文档目录设置'),
      '/system-settings/office-preview': endpoint('Office 在线预览配置'),
      '/system-settings/office-preview/test': endpoint('测试 Office 在线预览配置', 'post'),
      '/system-settings/wecom': endpoint('企业微信配置'),
      '/system-settings/wecom/test': endpoint('测试企业微信配置', 'post'),
      '/system-settings/storage': endpoint('数据存储配置'),
      '/system-settings/storage/test': endpoint('测试 MySQL 连接', 'post'),
      '/system-settings/storage/sync': endpoint('同步当前账本到 MySQL', 'post'),
      '/wecom/auth/callback': endpoint('企业微信免登回调预留')
    }
  };
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
  req.db.departments.filter((item) => item.parentId === dep.id).forEach((child) => {
    child.parentId = dep.parentId || null;
    child.updatedAt = now();
  });
  req.db.departments = req.db.departments.filter((item) => item.id !== req.params.id);
  req.db.users.forEach((user) => {
    user.departmentIds = (user.departmentIds || []).filter((id) => id !== req.params.id);
  });
  req.db.permissionRules = req.db.permissionRules.filter((rule) => !(rule.subjectType === 'department' && rule.subjectId === req.params.id));
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
  req.db.roles.filter((item) => item.parentId === role.id).forEach((child) => {
    child.parentId = role.parentId || null;
    child.updatedAt = now();
  });
  req.db.roles = req.db.roles.filter((item) => item.id !== req.params.id);
  req.db.users.forEach((user) => {
    user.roleIds = (user.roleIds || []).filter((id) => id !== req.params.id);
  });
  req.db.permissionRules = req.db.permissionRules.filter((rule) => !(rule.subjectType === 'role' && rule.subjectId === req.params.id));
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

app.post('/api/v1/files', requireAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw createError(400, 'VALIDATION_ERROR', '请选择要上传的文件');
  await validateUploadedFileByPolicy(req.db, req.file);
  const parent = nodeById(req.db, req.body.parentId || 'n_root');
  requireNodeAction(req, parent, 'file:create');
  requireNodePasswordAccess(req, parent);
  const name = validateName(req.body.name || req.file.originalname);
  ensureSiblingNameAvailable(req.db, parent.id, name);
  const node = {
    id: newId('n_'),
    parentId: parent.id,
    nodeType: 'file',
    name,
    fullPath: childPath(parent, name),
    extension: extname(name),
    currentVersionId: null,
    ownerId: req.user.id,
    spaceType: parent.spaceType || 'enterprise',
    personalOwnerId: parent.spaceType === 'personal' ? parent.personalOwnerId : null,
    createdBy: req.user.id,
    updatedBy: req.user.id,
    lockedBy: null,
    lockedAt: null,
    status: 'normal',
    businessStatus: req.body.businessStatus || 'effective',
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
  req.db.nodes.push(node);
  const version = await createVersionFromUpload(req.db, node, req.file, req.user.id, req.body.description || '初始版本');
  addVersionChangeLog(req.db, node, version, req.user.id, 'create', { description: version.description });
  addAudit(req.db, req.user.id, 'file.upload', 'node', node.id, { targetPath: node.fullPath, versionNo: version.versionNo }, req);
  notifyVisibleUsersAboutNewFile(req.db, req.user.id, node);
  await saveDb(req.db);
  res.json(ok(publicNode(req.db, req.user, node)));
}));

app.post('/api/v1/files/:id/versions', requireAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw createError(400, 'VALIDATION_ERROR', '请选择要上传的文件');
  await validateUploadedFileByPolicy(req.db, req.file);
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能更新文件');
  if (node.lockedBy && node.lockedBy !== req.user.id && !isAdmin(req.user)) throw createError(409, 'CONFLICT', '文件已被其他用户锁定');
  const previousVersion = currentVersion(req.db, node);
  const version = await createVersionFromUpload(req.db, node, req.file, req.user.id, req.body.description || '上传更新');
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
  const action = node.sensitive ? 'sensitive.download' : 'file.download';
  addAudit(req.db, req.user.id, action, 'node', node.id, {
    targetPath: node.fullPath,
    versionNo: version.versionNo,
    securityLevel: node.securityLevel,
    sensitive: Boolean(node.sensitive)
  }, req);
  recordRecentAccess(req.db, req.user, node, 'download');
  void saveDbBestEffort(req.db, 'download access log');
  streamVersion(res, version, version.originalFilename || node.name, { db: req.db, node });
}));

app.get('/storage/raw/:versionId', requireAuth, asyncRoute(async (req, res) => {
  const version = versionById(req.db, req.params.versionId);
  if (!version) throw createError(404, 'NOT_FOUND', '版本不存在');
  const node = nodeById(req.db, version.nodeId);
  requireNodeAction(req, node, 'file:preview');
  requireNodePasswordAccess(req, node);
  streamVersion(res, version, null, { db: req.db, node });
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
    const nativePreview = buildOnlyOfficePreview(req, node, version, extension);
    officePreview = {
      status: nativePreview ? 'native_ready' : 'text_fallback',
      provider: 'ONLYOFFICE Docs',
      message: nativePreview
        ? '正在使用 ONLYOFFICE 原版预览；加载失败时可查看提取文本。'
        : '当前展示提取文本；原版排版预览需要在系统管理中配置 ONLYOFFICE Document Server。',
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
  nodes.forEach((node) => recursiveZipNodes(req.db, archive, node, req.user, req));
  addAudit(req.db, req.user.id, 'file.batch_download', 'node', 'batch', { count: nodes.length }, req);
  await saveDb(req.db);
  await archive.finalize();
}));

app.get('/api/v1/approvals', requireAuth, (req, res) => {
  const scope = req.query.scope || 'todo';
  let approvals = req.db.documentApprovals || [];
  if (scope === 'todo') approvals = approvals.filter((item) => item.approverId === req.user.id && item.status === 'pending');
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

app.post('/api/v1/approvals', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.body.nodeId);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const type = ['workflow', 'download', 'permission', 'publish'].includes(req.body.type) ? req.body.type : 'download';
  if (type === 'download') {
    requireNodeAction(req, node, 'file:download');
    if (node.nodeType !== 'file') throw createError(400, 'VALIDATION_ERROR', '只能对文件提交下载审批');
  }
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
  if (!isAdmin(req.user) && approval.requesterId !== req.user.id && approval.approverId !== req.user.id) requireNodeAction(req, node, 'visible');
  res.json(ok(publicApproval(req.db, req.user, approval)));
});

app.post('/api/v1/approvals/:id/approve', requireAuth, asyncRoute(async (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  if (approval.status !== 'pending') throw createError(409, 'CONFLICT', '审批已处理');
  if (!isAdmin(req.user) && approval.approverId !== req.user.id) throw createError(403, 'FORBIDDEN', '只有审批人可以处理');
  const node = nodeById(req.db, approval.nodeId);
  if (!node) throw createError(404, 'NOT_FOUND', '审批关联文件不存在');
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  approval.status = 'approved';
  approval.decisionComment = String(req.body.comment || '').trim();
  approval.decidedBy = req.user.id;
  approval.decidedAt = now();
  approval.updatedAt = now();
  let detail = { actionLabel: approvalActionLabel(approval) };
  if ((approval.type || 'workflow') === 'workflow' || (approval.type || 'workflow') === 'publish') {
    detail = applyWorkflowAction(req.db, node, req.user.id, approval.action, approval.decisionComment, req, approval);
  }
  addMessage(
    req.db,
    approval.requesterId,
    `${approval.type || 'workflow'}.approval.approved`,
    `${approvalTypeLabel(approval.type || 'workflow')}已通过`,
    approvalDecisionMessage(req.db, approval, node, req.user, true),
    node.id
  );
  addAudit(req.db, req.user.id, `${approval.type || 'workflow'}.approval.approve`, 'document_approval', approval.id, {
    targetPath: node.fullPath,
    type: approval.type || 'workflow',
    action: approval.action,
    requestedActions: approval.requestedActions || []
  }, req);
  await saveDb(req.db);
  res.json(ok({ approval: publicApproval(req.db, req.user, approval), node: publicNode(req.db, req.user, node) }));
}));

app.post('/api/v1/approvals/:id/reject', requireAuth, asyncRoute(async (req, res) => {
  const approval = req.db.documentApprovals.find((item) => item.id === req.params.id);
  if (!approval) throw createError(404, 'NOT_FOUND', '审批记录不存在');
  if (approval.status !== 'pending') throw createError(409, 'CONFLICT', '审批已处理');
  if (!isAdmin(req.user) && approval.approverId !== req.user.id) throw createError(403, 'FORBIDDEN', '只有审批人可以处理');
  const node = nodeById(req.db, approval.nodeId);
  if (!node) throw createError(404, 'NOT_FOUND', '审批关联文件不存在');
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  approval.status = 'rejected';
  approval.decisionComment = String(req.body.comment || '').trim();
  approval.decidedBy = req.user.id;
  approval.decidedAt = now();
  approval.updatedAt = now();
  addMessage(
    req.db,
    approval.requesterId,
    `${approval.type || 'workflow'}.approval.rejected`,
    `${approvalTypeLabel(approval.type || 'workflow')}已驳回`,
    approvalDecisionMessage(req.db, approval, node, req.user, false),
    node.id
  );
  addAudit(req.db, req.user.id, `${approval.type || 'workflow'}.approval.reject`, 'document_approval', approval.id, {
    targetPath: node.fullPath,
    type: approval.type || 'workflow',
    action: approval.action,
    requestedActions: approval.requestedActions || []
  }, req);
  await saveDb(req.db);
  res.json(ok(publicApproval(req.db, req.user, approval)));
}));

app.get('/api/v1/nodes/:id/attachments', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'visible');
  requireNodePasswordAccess(req, node);
  const items = req.db.attachments
    .filter((item) => item.nodeId === node.id)
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
    createdBy: req.user.id,
    createdAt: now()
  };
  req.db.attachments.unshift(attachment);
  addAudit(req.db, req.user.id, 'attachment.create', 'node', node.id, { targetPath: node.fullPath, attachmentId }, req);
  await saveDb(req.db);
  res.json(ok(publicAttachment(req.db, attachment)));
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

function duplicateFileGroups(db, user) {
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
        files: items.map(({ node, version }) => ({ ...publicNode(db, user, node), duplicateVersion: publicVersion(version) }))
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
        files: items.map(({ node, version }) => ({ ...publicNode(db, user, node), duplicateVersion: publicVersion(version) }))
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

function governanceDashboard(req) {
  const files = req.db.nodes.filter((node) => node.nodeType === 'file' && node.status !== 'deleted');
  const qualityRows = files.map((node) => ({ node, quality: documentQuality(req.db, node) }));
  const duplicateGroups = duplicateFileGroups(req.db, req.user);
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
      ...publicNode(req.db, req.user, item.node),
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
    .map((item) => ({ ...publicNode(req.db, req.user, item.node), accessCount: item.accessCount }));
  const analytics = searchAnalytics(req.db, 30);
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
  if (keyword) {
    req.db.searchEvents.unshift({
      id: newId('search_'),
      userId: req.user.id,
      keyword,
      normalizedKeyword,
      resultCount: results.length,
      pathPrefix,
      filters: {
        fileTypes,
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

app.get('/api/v1/governance/quality', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看全库质量清单');
  const level = String(req.query.level || '');
  const maxScore = req.query.maxScore === undefined ? null : Number(req.query.maxScore);
  const keyword = String(req.query.keyword || '').trim().toLowerCase();
  let rows = req.db.nodes
    .filter((node) => node.nodeType === 'file' && node.status !== 'deleted')
    .map((node) => ({ ...publicNode(req.db, req.user, node), quality: documentQuality(req.db, node) }))
    .filter((item) => !level || item.quality.level === level)
    .filter((item) => maxScore === null || item.quality.score <= maxScore)
    .filter((item) => !keyword || `${item.name} ${item.fullPath}`.toLowerCase().includes(keyword))
    .sort((a, b) => a.quality.score - b.quality.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  sendPage(res, rows, req.query.page, req.query.pageSize || 100);
});

app.get('/api/v1/governance/duplicates', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看重复文件检测结果');
  const type = String(req.query.type || '');
  const groups = duplicateFileGroups(req.db, req.user).filter((item) => !type || item.type === type);
  res.json(ok({
    groups,
    summary: {
      groupCount: groups.length,
      fileCount: new Set(groups.flatMap((group) => group.files.map((file) => file.id))).size,
      exactGroups: groups.filter((item) => item.type === 'exact').length,
      probableGroups: groups.filter((item) => item.type === 'probable').length,
      wastedBytes: groups.reduce((sum, group) => sum + group.wastedBytes, 0)
    }
  }));
});

app.get('/api/v1/governance/reviews', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看全库复审清单');
  const status = String(req.query.status || '');
  const ownerId = String(req.query.ownerId || '');
  const keyword = String(req.query.keyword || '').trim().toLowerCase();
  const rows = req.db.nodes
    .filter((node) => node.nodeType === 'file' && node.status !== 'deleted')
    .map((node) => ({ ...publicNode(req.db, req.user, node), reviewStatus: reviewStatusForNode(node), reviewStatusLabel: REVIEW_STATUS_LABELS[reviewStatusForNode(node)] }))
    .filter((item) => !status || item.reviewStatus === status)
    .filter((item) => !ownerId || item.review.ownerId === ownerId)
    .filter((item) => !keyword || `${item.name} ${item.fullPath}`.toLowerCase().includes(keyword))
    .sort((a, b) => {
      const rank = { overdue: 0, due_soon: 1, normal: 2, not_scheduled: 3 };
      return (rank[a.reviewStatus] ?? 9) - (rank[b.reviewStatus] ?? 9) || String(a.review.nextReviewAt || '9999').localeCompare(String(b.review.nextReviewAt || '9999'));
    });
  sendPage(res, rows, req.query.page, req.query.pageSize || 100);
});

app.get('/api/v1/governance/search-analytics', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看搜索运营分析');
  res.json(ok(searchAnalytics(req.db, req.query.days || 30)));
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
  await saveDb(req.db);
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  const unreadOnly = String(req.query.unread || '').toLowerCase() === 'true';
  const messages = req.db.messages
    .filter((item) => item.receiverId === req.user.id)
    .filter((item) => !unreadOnly || !item.readAt)
    .map((item) => publicMessage(req.db, req.user, item, { unreadUploadCounts }));
  sendPage(res, messages, req.query.page, req.query.pageSize || 50);
}));

app.get('/api/v1/messages/unread-count', requireAuth, asyncRoute(async (req, res) => {
  dispatchDueReminders(req.db, req.user.id);
  await saveDb(req.db);
  res.json(ok(req.db.messages.filter((item) => item.receiverId === req.user.id && !item.readAt).length));
}));

app.post('/api/v1/messages/:id/read', requireAuth, asyncRoute(async (req, res) => {
  const message = req.db.messages.find((item) => item.id === req.params.id && item.receiverId === req.user.id);
  if (!message) throw createError(404, 'NOT_FOUND', '消息不存在');
  message.readAt = now();
  await saveDb(req.db);
  res.json(ok(publicMessage(req.db, req.user, message, { unreadUploadCounts: unreadUploadCountsByNode(req.db, req.user) })));
}));

app.get('/api/v1/messages/:id', requireAuth, (req, res) => {
  const message = req.db.messages.find((item) => item.id === req.params.id && item.receiverId === req.user.id);
  if (!message) throw createError(404, 'NOT_FOUND', '消息不存在');
  res.json(ok(publicMessage(req.db, req.user, message, { unreadUploadCounts: unreadUploadCountsByNode(req.db, req.user) })));
});

app.post('/api/v1/messages/read-all', requireAuth, asyncRoute(async (req, res) => {
  req.db.messages.filter((item) => item.receiverId === req.user.id).forEach((item) => {
    item.readAt = item.readAt || now();
  });
  await saveDb(req.db);
  res.json(ok(true));
}));

app.get('/api/v1/announcements', requireAuth, (req, res) => {
  const items = req.db.announcements
    .filter((item) => announcementVisibleToUser(item, req.user))
    .sort((a, b) => (b.publishedAt || b.createdAt).localeCompare(a.publishedAt || a.createdAt))
    .map((item) => publicAnnouncement(req.db, req.user, item));
  sendPage(res, items, req.query.page, req.query.pageSize || 100);
});

app.post('/api/v1/announcements', requireAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以发布公告');
  await validateUploadedFileByPolicy(req.db, req.file);
  const status = req.body.status === 'draft' ? 'draft' : 'published';
  const announcement = {
    id: newId('ann_'),
    title: validateName(req.body.title),
    content: String(req.body.content || '').trim(),
    audience: normalizeAudience(req.body.audience),
    status,
    effectiveAt: req.body.effectiveAt || now(),
    expiresAt: req.body.expiresAt || null,
    attachment: await announcementAttachmentFromUpload(req.file),
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

app.put('/api/v1/announcements/:id', requireAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以维护公告');
  await validateUploadedFileByPolicy(req.db, req.file);
  const announcement = req.db.announcements.find((item) => item.id === req.params.id);
  if (!announcement) throw createError(404, 'NOT_FOUND', '公告不存在');
  const previousStatus = announcement.status;
  announcement.title = req.body.title ? validateName(req.body.title) : announcement.title;
  announcement.content = req.body.content === undefined ? announcement.content : String(req.body.content || '').trim();
  announcement.audience = req.body.audience === undefined ? announcement.audience : normalizeAudience(req.body.audience);
  announcement.status = req.body.status || announcement.status;
  announcement.effectiveAt = req.body.effectiveAt === undefined ? announcement.effectiveAt : (req.body.effectiveAt || now());
  announcement.expiresAt = req.body.expiresAt === undefined ? announcement.expiresAt : (req.body.expiresAt || null);
  if (req.file) {
    if (announcement.attachment?.storageKey) {
      const oldPath = path.join(config.uploadDir, announcement.attachment.storageKey);
      if (fsSync.existsSync(oldPath)) await fs.unlink(oldPath);
    }
    announcement.attachment = await announcementAttachmentFromUpload(req.file);
  }
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
  if (announcement.attachment?.storageKey) {
    const filePath = path.join(config.uploadDir, announcement.attachment.storageKey);
    if (fsSync.existsSync(filePath)) await fs.unlink(filePath);
  }
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

app.get('/api/v1/favorites', requireAuth, (req, res) => {
  const items = req.db.favorites
    .filter((item) => item.userId === req.user.id)
    .map((fav) => ({ ...fav, node: nodeById(req.db, fav.nodeId) ? publicNode(req.db, req.user, nodeById(req.db, fav.nodeId)) : null }))
    .filter((item) => item.node);
  res.json(ok(items));
});

app.post('/api/v1/favorites', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.body.nodeId);
  requireNodeAction(req, node, 'visible');
  let fav = req.db.favorites.find((item) => item.userId === req.user.id && item.nodeId === node.id);
  if (!fav) {
    fav = { id: newId('fav_'), userId: req.user.id, nodeId: node.id, folderName: req.body.folderName || '默认收藏夹', createdAt: now() };
    req.db.favorites.push(fav);
    addAudit(req.db, req.user.id, 'favorite.create', 'node', node.id, { targetPath: node.fullPath }, req);
    await saveDb(req.db);
  }
  res.json(ok(fav));
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
  const definition = {
    id: newId('prop_'),
    targetType: req.body.targetType || 'file',
    name: validateName(req.body.name),
    dataType: req.body.dataType || 'string',
    required: Boolean(req.body.required),
    options: normalizeOptions(req.body.options),
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
  const values = req.db.propertyDefinitions.map((definition) => ({
    definition,
    value: propertyValueFor(req.db, node.id, definition.id)?.value || ''
  }));
  res.json(ok({ tags: node.tags || [], categories, values }));
});

app.put('/api/v1/nodes/:id/properties', requireAuth, asyncRoute(async (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:update');
  requireNodePasswordAccess(req, node);
  node.tags = req.body.tags || [];
  const categoryIds = req.body.categoryIds || [];
  req.db.documentCategories = req.db.documentCategories.filter((item) => item.nodeId !== node.id);
  categoryIds.forEach((categoryId) => req.db.documentCategories.push({ nodeId: node.id, categoryId }));
  Object.entries(req.body.values || {}).forEach(([propertyId, value]) => {
    let existing = propertyValueFor(req.db, node.id, propertyId);
    if (!existing) {
      existing = { nodeId: node.id, propertyId, categoryId: null, value: '' };
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

app.get('/api/v1/audit-logs', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看审计日志');
  let logs = req.db.auditLogs;
  if (req.query.actorId) logs = logs.filter((item) => item.actorId === req.query.actorId);
  if (req.query.action) logs = logs.filter((item) => item.action.includes(req.query.action));
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

app.get('/api/v1/system/runtime-status', requireAuth, (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以查看系统运行状态');
  res.json(ok(runtimeStatus(req.db)));
});

app.post('/api/v1/audit-logs/export', requireAuth, asyncRoute(async (req, res) => {
  if (!isAdmin(req.user)) throw createError(403, 'FORBIDDEN', '只有管理员可以导出审计日志');
  let logs = req.db.auditLogs;
  if (req.body.actorId) logs = logs.filter((item) => item.actorId === req.body.actorId);
  if (req.body.action) logs = logs.filter((item) => item.action.includes(req.body.action));
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
  const maxSizeMb = Math.max(1, Math.min(Number(req.body.maxSizeMb || DEFAULT_FILE_POLICY.maxSizeMb), 300));
  req.db.settings.filePolicy = { allowedExtensions, maxSizeMb };
  addAudit(req.db, req.user.id, 'system.file_policy.update', 'system_setting', 'file_policy', { allowedExtensions, maxSizeMb }, req);
  await saveDb(req.db);
  res.json(ok(currentFilePolicy(req.db)));
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
  const result = {
    ok: missing.length === 0,
    message: missing.length ? `缺少 ${missing.join('、')}` : '配置项完整，等待 Document Server 联通验证',
    checkedAt: now(),
    scriptUrl: settings.documentServerUrl ? joinUrl(settings.documentServerUrl, '/web-apps/apps/api/documents/api.js') : ''
  };
  if (!missing.length) {
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
  const result = {
    ok: missing.length === 0,
    message: missing.length ? `缺少 ${missing.join('、')}` : '配置项完整，等待企业微信真实应用联调',
    checkedAt: now()
  };
  req.db.settings.wecom = { ...settings, lastTestAt: result.checkedAt, lastTestResult: result };
  addAudit(req.db, req.user.id, 'system.wecom.test', 'system_setting', 'wecom', result, req);
  await saveDb(req.db);
  res.json(ok(result));
}));

app.get('/api/v1/wecom/auth/callback', (req, res) => {
  res.json(ok({
    status: 'reserved',
    message: '企业微信免登录回调接口已预留，正式联调时根据 code 换取用户身份',
    codeReceived: Boolean(req.query.code)
  }));
});

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
  await saveDb(req.db);
  const visible = listVisibleDescendants(req.db, req.user);
  const files = visible.filter((item) => item.nodeType === 'file');
  const latestFiles = files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((item) => publicNode(req.db, req.user, item));
  const favorites = req.db.favorites.filter((item) => item.userId === req.user.id).slice(0, 8);
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
      unreadMessages: req.db.messages.filter((item) => item.receiverId === req.user.id && !item.readAt).length
    },
    growthTrend,
    latestFiles,
    favorites,
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

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  if (status >= 500) console.error(err);
  res.status(status).json({ code, message: err.message || '服务异常', data: err.data ?? null });
});

app.listen(config.port, () => {
  console.log(`Document platform API running at http://localhost:${config.port}`);
  console.log('Default accounts: admin/admin123, demo/user123');
});
