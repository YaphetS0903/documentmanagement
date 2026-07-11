import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from './config.js';
import {
  getStorageRuntimeInfo,
  hasCompleteMysqlConfig,
  loadMysqlSnapshot,
  markStorageRuntime,
  readStorageConfig,
  saveMysqlSnapshot
} from './storage.js';
import { ensureDir, hashPassword, newId, now } from './utils.js';

export const ACTIONS = [
  'visible',
  'folder:create',
  'file:create',
  'file:preview',
  'file:print',
  'file:export_pdf',
  'file:download',
  'file:update',
  'file:delete',
  'file:share_external',
  'permission:manage',
  'full_control'
];

export function fullActions() {
  return [...ACTIONS];
}

function rootFolder(id, name, parentId = null, createdBy = 'u_admin') {
  const timestamp = now();
  return {
    id,
    parentId,
    nodeType: 'folder',
    name,
    fullPath: parentId ? '' : '/',
    extension: '',
    currentVersionId: null,
    ownerId: createdBy,
    createdBy,
    updatedBy: createdBy,
    lockedBy: null,
    lockedAt: null,
    status: 'normal',
    businessStatus: 'effective',
    securityLevel: 'internal',
    sensitive: false,
    sensitiveReason: '',
    securityUpdatedBy: null,
    securityUpdatedAt: null,
    reviewEnabled: false,
    reviewCycleDays: 365,
    reviewOwnerId: null,
    nextReviewAt: null,
    lastReviewedAt: null,
    lastReviewedBy: null,
    lastReviewConclusion: '',
    lastReviewNote: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null
  };
}

function childFolder(id, parentId, name, path, createdBy = 'u_admin') {
  return {
    ...rootFolder(id, name, parentId, createdBy),
    fullPath: path
  };
}

export function createInitialDb() {
  const initialAdminPassword = String(process.env.INITIAL_ADMIN_PASSWORD || (config.nodeEnv === 'production' ? '' : 'admin123'));
  const initialDemoPassword = String(process.env.INITIAL_DEMO_PASSWORD || (config.nodeEnv === 'production' ? '' : 'user123'));
  if (!initialAdminPassword) throw new Error('首次生产初始化必须配置 INITIAL_ADMIN_PASSWORD');
  if (config.nodeEnv === 'production' && initialAdminPassword.length < 12) throw new Error('INITIAL_ADMIN_PASSWORD 至少需要 12 个字符');
  const adminPass = hashPassword(initialAdminPassword);
  const userPass = hashPassword(initialDemoPassword || crypto.randomBytes(24).toString('base64url'));
  const timestamp = now();
  const nodes = [rootFolder('n_root', '企业文档库')];

  return {
    meta: { version: 1, createdAt: timestamp },
    users: [
      {
        id: 'u_admin',
        username: 'admin',
        displayName: '系统管理员',
        passwordHash: adminPass.hash,
        passwordSalt: adminPass.salt,
        email: 'admin@example.com',
        phone: '',
        avatarUrl: '',
        status: 'enabled',
        departmentIds: ['d_center'],
        roleIds: ['r_admin'],
        lastLoginAt: null,
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: 'u_demo',
        username: 'demo',
        displayName: '演示用户',
        passwordHash: userPass.hash,
        passwordSalt: userPass.salt,
        email: 'demo@example.com',
        phone: '',
        avatarUrl: '',
        status: 'enabled',
        departmentIds: ['d_quality'],
        roleIds: ['r_employee'],
        lastLoginAt: null,
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    departments: [
      { id: 'd_center', parentId: null, name: '数据中心', code: 'CENTER', sortOrder: 1, status: 'enabled', createdAt: timestamp, updatedAt: timestamp },
      { id: 'd_quality', parentId: null, name: '质量部', code: 'QUALITY', sortOrder: 2, status: 'enabled', createdAt: timestamp, updatedAt: timestamp },
      { id: 'd_hr', parentId: null, name: '人力资源部', code: 'HR', sortOrder: 3, status: 'enabled', createdAt: timestamp, updatedAt: timestamp },
      { id: 'd_factory_xa', parentId: null, name: '西安工厂', code: 'XA_FACTORY', sortOrder: 4, status: 'enabled', createdAt: timestamp, updatedAt: timestamp },
      { id: 'd_factory_bj', parentId: null, name: '宝鸡工厂', code: 'BJ_FACTORY', sortOrder: 5, status: 'enabled', createdAt: timestamp, updatedAt: timestamp }
    ],
    roles: [
      { id: 'r_admin', parentId: null, name: '系统管理员', code: 'ADMIN', description: '拥有系统完全控制权限', status: 'enabled', createdAt: timestamp, updatedAt: timestamp },
      { id: 'r_doc_admin', parentId: null, name: '文档管理员', code: 'DOC_ADMIN', description: '维护部门文档和权限', status: 'enabled', createdAt: timestamp, updatedAt: timestamp },
      { id: 'r_employee', parentId: null, name: '普通员工', code: 'EMPLOYEE', description: '浏览授权文档', status: 'enabled', createdAt: timestamp, updatedAt: timestamp }
    ],
    nodes,
    versions: [],
    permissionTemplates: [
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
    ],
    permissionRules: [
      {
        id: 'pr_root_admin',
        nodeId: 'n_root',
        subjectType: 'role',
        subjectId: 'r_admin',
        scope: 'all',
        actions: fullActions(),
        effect: 'allow',
        priority: 1000,
        condition: null,
        inheritEnabled: true,
        createdBy: 'u_admin',
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: 'pr_root_employee',
        nodeId: 'n_root',
        subjectType: 'role',
        subjectId: 'r_employee',
        scope: 'all',
        actions: ['visible', 'file:preview', 'file:download'],
        effect: 'allow',
        priority: 10,
        condition: null,
        inheritEnabled: true,
        createdBy: 'u_admin',
        createdAt: timestamp,
        updatedAt: timestamp
      },
    ],
    categories: [
      { id: 'c_contract', parentId: null, name: '合同', fullPath: '/合同', sortOrder: 1, status: 'enabled' },
      { id: 'c_project', parentId: null, name: '项目', fullPath: '/项目', sortOrder: 2, status: 'enabled' },
      { id: 'c_archive', parentId: null, name: '档案', fullPath: '/档案', sortOrder: 3, status: 'enabled' },
      { id: 'c_iso', parentId: null, name: 'ISO9000文件', fullPath: '/ISO9000文件', sortOrder: 4, status: 'enabled' }
    ],
    documentCategories: [],
    propertyDefinitions: [],
    propertyValues: [],
    messages: [],
    notificationDeliveries: [],
    backupJobs: [],
    systemAlerts: [],
    favorites: [],
    comments: [],
    ratings: [],
    attachments: [],
    fileRelations: [],
    reminders: [],
    documentApprovals: [],
    approvalTemplates: [],
    documentReviews: [],
    versionChangeLogs: [],
    officeEditSessions: [],
    announcements: [],
    auditLogs: [],
    apiCredentials: [],
    apiCallLogs: [],
    loginTickets: [],
    externalSyncJobs: [],
    recentAccesses: [],
    searchEvents: [],
    settings: {
      filePolicy: {
        allowedExtensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'csv', 'json', 'xml', 'html', 'png', 'jpg', 'jpeg', 'gif', 'zip'],
        maxSizeMb: 300
      },
      externalLibrary: {
        rootPath: config.externalLibraryRoot || '',
        includePaths: [],
        excludePatterns: [],
        lastSyncedAt: null,
        lastSyncSummary: null,
        lastSyncJob: null
      },
      securityPolicy: {
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
      },
      wecom: {
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
      },
      officePreview: {
        enabled: false,
        provider: 'onlyoffice',
        documentServerUrl: '',
        publicBaseUrl: '',
        jwtSecret: '',
        lastTestAt: null,
        lastTestResult: null
      }
    }
  };
}

let cache = null;

async function loadJsonDbOrInitial() {
  await ensureDir(config.dataDir);
  try {
    const raw = await fs.readFile(config.dbFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    const db = createInitialDb();
    await writeJsonDb(db);
    return db;
  }
}

async function writeJsonDb(db) {
  await ensureDir(config.dataDir);
  await fs.writeFile(config.dbFile, JSON.stringify(db, null, 2), 'utf8');
}

export async function loadDb() {
  if (cache) return cache;
  const storageConfig = await readStorageConfig({ includePassword: true });
  if (storageConfig.provider === 'mysql' && hasCompleteMysqlConfig(storageConfig.mysql)) {
    try {
      const mysqlLoad = loadMysqlSnapshot(storageConfig);
      const mysqlDb = await Promise.race([
        mysqlLoad,
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('MySQL 启动连接超时（4 秒）'), { code: 'ETIMEDOUT' })), 4000))
      ]);
      if (mysqlDb) {
        cache = mysqlDb;
      } else {
        cache = await loadJsonDbOrInitial();
        await saveMysqlSnapshot(cache, storageConfig);
      }
      markStorageRuntime({
        configuredProvider: 'mysql',
        activeProvider: 'mysql',
        lastError: null,
        lastLoadedAt: now()
      });
      await writeJsonDb(cache);
      return cache;
    } catch (error) {
      markStorageRuntime({
        configuredProvider: 'mysql',
        activeProvider: 'json',
        lastError: error.message,
        lastLoadedAt: now()
      });
      console.error('failed to load mysql storage, falling back to json', error);
      cache = await loadJsonDbOrInitial();
      return cache;
    }
  }
  cache = await loadJsonDbOrInitial();
  markStorageRuntime({
    configuredProvider: storageConfig.provider,
    activeProvider: 'json',
    lastError: null,
    lastLoadedAt: now()
  });
  return cache;
}

export async function saveDb(db = cache) {
  cache = db;
  await writeJsonDb(db);
  const storageConfig = await readStorageConfig({ includePassword: true });
  const runtimeInfo = getStorageRuntimeInfo();
  if (storageConfig.provider === 'mysql' && runtimeInfo.activeProvider === 'json' && runtimeInfo.lastError) {
    markStorageRuntime({
      configuredProvider: 'mysql',
      activeProvider: 'json',
      lastError: runtimeInfo.lastError,
      lastSavedAt: now()
    });
    return;
  }
  if (storageConfig.provider === 'mysql' && hasCompleteMysqlConfig(storageConfig.mysql)) {
    try {
      await saveMysqlSnapshot(db, storageConfig);
      markStorageRuntime({
        configuredProvider: 'mysql',
        activeProvider: 'mysql',
        lastError: null,
        lastSavedAt: now()
      });
    } catch (error) {
      markStorageRuntime({
        configuredProvider: 'mysql',
        activeProvider: 'json',
        lastError: error.message,
        lastSavedAt: now()
      });
      const storageError = Object.assign(new Error(`MySQL 保存失败：${error.message}`), {
        status: 503,
        code: 'MYSQL_STORAGE_ERROR'
      });
      throw storageError;
    }
  } else {
    markStorageRuntime({
      configuredProvider: storageConfig.provider,
      activeProvider: 'json',
      lastError: null,
      lastSavedAt: now()
    });
  }
}

export async function resetDb() {
  cache = createInitialDb();
  await saveDb(cache);
  return cache;
}

export async function reloadDb() {
  cache = null;
  return loadDb();
}

export function addAudit(db, actorId, action, targetType, targetId, detail = {}, req = null) {
  db.auditLogs.unshift({
    id: newId('al_'),
    actorId,
    action,
    targetType,
    targetId,
    targetPath: detail.targetPath || '',
    ip: req?.ip || '',
    userAgent: req?.headers?.['user-agent'] || '',
    detail,
    createdAt: now()
  });
}

export function addMessage(db, receiverId, messageType, title, content, relatedNodeId = null) {
  db.messages.unshift({
    id: newId('msg_'),
    receiverId,
    messageType,
    title,
    content,
    relatedNodeId,
    readAt: null,
    createdAt: now()
  });
}
