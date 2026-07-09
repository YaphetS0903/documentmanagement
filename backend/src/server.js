import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
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
const captchaStore = new Map();
const apiRateBuckets = new Map();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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
  'versionChangeLogs',
  'subscriptions',
  'shares',
  'announcements',
  'auditLogs',
  'apiCredentials',
  'apiCallLogs',
  'loginTickets',
  'externalSyncJobs'
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
  const version = currentVersion(db, node);
  const unreadCount = nodeUnreadUploadCount(db, user, node, options.unreadUploadCounts);
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
    passwordEnabled: Boolean(node.passwordEnabled),
    passwordProtected: nodePasswordProtected(db, node),
    tags: node.tags || [],
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    deletedAt: node.deletedAt || null,
    deletedBy: node.deletedBy || null,
    pendingApprovalCount: (db.documentApprovals || []).filter((item) => item.nodeId === node.id && item.status === 'pending').length,
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

function currentFilePolicy(db) {
  return {
    ...DEFAULT_FILE_POLICY,
    ...(db.settings?.filePolicy || {}),
    allowedExtensions: normalizeExtensions(db.settings?.filePolicy?.allowedExtensions || DEFAULT_FILE_POLICY.allowedExtensions),
    maxSizeMb: Number(db.settings?.filePolicy?.maxSizeMb || DEFAULT_FILE_POLICY.maxSizeMb)
  };
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
  const searchText = await extractSearchText(entry.externalPath, extension, mimeType);
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
    indexStatus: 'ready',
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

async function extractSearchText(filePath, extension, mimeType) {
  const textLike = ['txt', 'md', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'log'];
  if (mimeType?.startsWith('text/') || textLike.includes(extension)) {
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
        .map((entry) => entry.getData().toString('utf8'))
        .join('\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      return text.slice(0, 200000);
    } catch {
      return '';
    }
  }
  return '';
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
  const searchText = await extractSearchText(storageKey, extension, mimeType);
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
    indexStatus: 'ready',
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
  return {
    ...approval,
    actionLabel: WORKFLOW_ACTIONS[approval.action]?.label || approval.action,
    requestedStatusLabel: BUSINESS_STATUS_LABELS[approval.requestedStatus] || approval.requestedStatus,
    requesterName: userDisplayName(db, approval.requesterId),
    approverName: userDisplayName(db, approval.approverId),
    decidedByName: approval.decidedBy ? userDisplayName(db, approval.decidedBy) : '',
    nodeName: node?.name || approval.nodeId,
    nodePath: node?.fullPath || '',
    nodeType: node?.nodeType || '',
    nodeBusinessStatus: node?.businessStatus || '',
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
      description: '一期开发版 REST API 文档，支持 JWT 和 AccessKey/Secret 鉴权。'
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
      '/categories/tree': endpoint('分类树'),
      '/categories/{id}/files': endpoint('分类文件列表'),
      '/permission-templates': endpoint('权限模板列表/新增'),
      '/permission-templates/{id}': endpoint('权限模板修改/删除'),
      '/nodes/{id}/permission-rules': endpoint('权限规则列表/新增'),
      '/nodes/{id}/permission-rules/batch': endpoint('批量套用权限模板', 'post'),
      '/permission-rules/{id}': endpoint('权限规则修改/删除'),
      '/nodes/{id}/view-access': endpoint('可查看范围设置'),
      '/nodes/{id}/password': endpoint('文件或文件夹加密设置', 'put'),
      '/nodes/{id}/workflow': endpoint('文档流程概览'),
      '/nodes/{id}/workflow-actions': endpoint('执行发布/作废/归档', 'post'),
      '/nodes/{id}/approvals': endpoint('提交文档审批', 'post'),
      '/approvals': endpoint('审批列表'),
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
      '/system-settings/file-policy': endpoint('文件上传策略'),
      '/system-settings/external-library': endpoint('服务器文档目录设置'),
      '/system-settings/storage': endpoint('数据存储配置'),
      '/system-settings/storage/test': endpoint('测试 MySQL 连接', 'post'),
      '/system-settings/storage/sync': endpoint('同步当前账本到 MySQL', 'post')
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
  const actionConfig = workflowActionConfig(req.body.action);
  const approver = req.db.users.find((item) => item.id === req.body.approverId && item.status === 'enabled');
  if (!approver) throw createError(404, 'NOT_FOUND', '审批人不存在或已禁用');
  const pendingExists = (req.db.documentApprovals || []).some((item) => item.nodeId === node.id && item.status === 'pending' && item.action === req.body.action);
  if (pendingExists) throw createError(409, 'CONFLICT', '该流程动作已有待审批记录');
  const approval = {
    id: newId('apv_'),
    nodeId: node.id,
    action: req.body.action,
    requestedStatus: actionConfig.status,
    status: 'pending',
    requesterId: req.user.id,
    approverId: approver.id,
    requestComment: String(req.body.comment || '').trim(),
    decisionComment: '',
    decidedBy: null,
    decidedAt: null,
    createdAt: now(),
    updatedAt: now()
  };
  req.db.documentApprovals.unshift(approval);
  addMessage(
    req.db,
    approver.id,
    'workflow.approval.request',
    '文档审批待处理',
    `${req.user.displayName || req.user.username} 提交了“${node.fullPath}”的${actionConfig.label}审批${approval.requestComment ? `：${approval.requestComment}` : ''}`,
    node.id
  );
  addAudit(req.db, req.user.id, 'workflow.approval.submit', 'document_approval', approval.id, { targetPath: node.fullPath, action: approval.action, approverId: approver.id }, req);
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
  addAudit(req.db, req.user.id, 'file.download', 'node', node.id, { targetPath: node.fullPath, versionNo: version.versionNo }, req);
  await saveDb(req.db);
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

app.get('/api/v1/files/:id/preview', requireAuth, (req, res) => {
  const node = nodeById(req.db, req.params.id);
  requireNodeAction(req, node, 'file:preview');
  requireNodePasswordAccess(req, node);
  const version = req.query.versionId ? versionById(req.db, req.query.versionId) : currentVersion(req.db, node);
  if (!version) throw createError(404, 'NOT_FOUND', '版本不存在');
  if (version.nodeId !== node.id) throw createError(404, 'NOT_FOUND', '版本不存在');
  const extension = node.extension || extname(version.originalFilename);
  const token = encodeURIComponent(getBearer(req));
  const unlockTokenValue = unlockTokensFromRequest(req).join(',');
  const unlockToken = unlockTokenValue ? `&unlockToken=${encodeURIComponent(unlockTokenValue)}` : '';
  const rawUrl = `/storage/raw/${version.id}?token=${token}${unlockToken}`;
  let previewType = 'unsupported';
  if (version.mimeType === 'application/pdf' || extension === 'pdf') previewType = 'pdf';
  else if (version.mimeType?.startsWith('image/')) previewType = 'image';
  else if (version.mimeType?.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'xml', 'html', 'log', 'docx', 'xlsx', 'pptx'].includes(extension)) previewType = 'text';
  res.json(ok({ previewType, rawUrl, content: previewType === 'text' ? version.searchText || '' : '', version: publicVersion(version) }));
});

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
  if (readCount) await saveDb(req.db);
  res.json(ok({ readCount }));
}));

app.post('/api/v1/files/batch-download', requireAuth, asyncRoute(async (req, res) => {
  const ids = req.body.nodeIds || [];
  const nodes = ids.map((id) => nodeById(req.db, id)).filter(Boolean);
  nodes.forEach((node) => requireNodeAction(req, node, node.nodeType === 'file' ? 'file:download' : 'visible'));
  nodes.forEach((node) => requireNodePasswordAccess(req, node));
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
  const visibleApprovals = approvals
    .filter((item) => {
      const node = nodeById(req.db, item.nodeId);
      return node && hasAction(req.db, req.user, node, 'visible');
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map((item) => publicApproval(req.db, req.user, item));
  sendPage(res, visibleApprovals, req.query.page, req.query.pageSize || 50);
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
  const detail = applyWorkflowAction(req.db, node, req.user.id, approval.action, approval.decisionComment, req, approval);
  addMessage(
    req.db,
    approval.requesterId,
    'workflow.approval.approved',
    '文档审批已通过',
    `${userDisplayName(req.db, req.user.id)} 已通过“${node.fullPath}”的${detail.actionLabel}审批${approval.decisionComment ? `：${approval.decisionComment}` : ''}`,
    node.id
  );
  addAudit(req.db, req.user.id, 'workflow.approval.approve', 'document_approval', approval.id, { targetPath: node.fullPath, action: approval.action }, req);
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
    'workflow.approval.rejected',
    '文档审批已驳回',
    `${userDisplayName(req.db, req.user.id)} 驳回了“${node.fullPath}”的${WORKFLOW_ACTIONS[approval.action]?.label || approval.action}审批${approval.decisionComment ? `：${approval.decisionComment}` : ''}`,
    node.id
  );
  addAudit(req.db, req.user.id, 'workflow.approval.reject', 'document_approval', approval.id, { targetPath: node.fullPath, action: approval.action }, req);
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

app.post('/api/v1/search/files', requireAuth, (req, res) => {
  const keyword = String(req.body.keyword || '').trim().toLowerCase();
  const fileTypes = req.body.fileTypes || [];
  const pathPrefix = req.body.pathPrefix || '';
  const creatorId = req.body.creatorId || '';
  const updatedFrom = req.body.updatedFrom ? new Date(req.body.updatedFrom).getTime() : null;
  const updatedTo = req.body.updatedTo ? new Date(req.body.updatedTo).getTime() : null;
  const sortBy = ['name', 'fullPath', 'createdAt', 'updatedAt', 'extension', 'sizeBytes'].includes(req.body.sortBy) ? req.body.sortBy : 'updatedAt';
  const sortDir = req.body.sortDir === 'asc' ? 'asc' : 'desc';
  const unreadUploadCounts = unreadUploadCountsByNode(req.db, req.user);
  const results = listVisibleDescendants(req.db, req.user)
    .filter((node) => node.nodeType === 'file')
    .filter((node) => !pathPrefix || node.fullPath.startsWith(pathPrefix))
    .filter((node) => !fileTypes.length || fileTypes.includes(node.extension))
    .filter((node) => !creatorId || node.createdBy === creatorId)
    .filter((node) => !updatedFrom || new Date(node.updatedAt).getTime() >= updatedFrom)
    .filter((node) => !updatedTo || new Date(node.updatedAt).getTime() <= updatedTo)
    .map((node) => ({ node, version: currentVersion(req.db, node) }))
    .filter(({ node, version }) => {
      if (!keyword) return true;
      const categoryNames = req.db.documentCategories
        .filter((item) => item.nodeId === node.id)
        .map((item) => req.db.categories.find((category) => category.id === item.categoryId)?.name || '')
        .join(' ');
      const propertyText = req.db.propertyValues.filter((item) => item.nodeId === node.id).map((item) => item.value).join(' ');
      const searchableContent = isNodePasswordAccessible(req, node) ? (version?.searchText || '') : '';
      const haystack = `${node.name} ${node.fullPath} ${(node.tags || []).join(' ')} ${categoryNames} ${propertyText} ${searchableContent}`.toLowerCase();
      return haystack.includes(keyword);
    })
    .sort((a, b) => {
      const left = sortBy === 'sizeBytes' ? Number(a.version?.sizeBytes || 0) : String(a.node[sortBy] || '');
      const right = sortBy === 'sizeBytes' ? Number(b.version?.sizeBytes || 0) : String(b.node[sortBy] || '');
      const result = typeof left === 'number' ? left - right : left.localeCompare(right, 'zh-Hans-CN');
      return sortDir === 'asc' ? result : -result;
    })
    .map(({ node, version }) => ({
      ...publicNode(req.db, req.user, node, { unreadUploadCounts }),
      matchedKeyword: keyword,
      highlight: keyword && isNodePasswordAccessible(req, node) && (version?.searchText || '').toLowerCase().includes(keyword) ? keyword : ''
    }));
  sendPage(res, results, req.body.page, req.body.pageSize);
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
  res.json(ok({ ...ticket, loginUrl: `/api/v1/sso/consume?ticket=${encodeURIComponent(ticket.id)}` }));
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
