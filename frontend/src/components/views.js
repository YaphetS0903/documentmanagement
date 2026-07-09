import {
  ClipboardCheck as ClipboardCheckIcon,
  Download as DownloadIcon,
  BellRing as BellRingIcon,
  Clock as ClockIcon,
  FileText as FileTextIcon,
  Folder as FolderIcon,
  KeyRound as KeyRoundIcon,
  Lock as LockIcon,
  MoreHorizontal as MoreHorizontalIcon,
  Paperclip as PaperclipIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshCwIcon,
  Search as SearchIcon,
  Share2 as Share2Icon,
  Shield as ShieldIcon,
  Star as StarIcon,
  Tags as TagsIcon,
  Trash2 as Trash2Icon,
  Unlock as UnlockIcon,
  UploadCloud as UploadCloudIcon
} from 'lucide-vue-next';

export const DashboardView = {
  props: ['dashboard', 'formatDate'],
  emits: ['open-docs'],
  computed: {
    maxGrowthValue() {
      return Math.max(1, ...(this.dashboard?.growthTrend || []).map((item) => Math.max(item.files || 0, item.versions || 0)));
    }
  },
  template: `
    <div>
      <div class="stats-grid">
        <div class="stat-tile"><span>可见文件夹</span><strong>{{ dashboard?.stats?.folders || 0 }}</strong></div>
        <div class="stat-tile"><span>可见文件</span><strong>{{ dashboard?.stats?.files || 0 }}</strong></div>
        <div class="stat-tile"><span>文件版本</span><strong>{{ dashboard?.stats?.versions || 0 }}</strong></div>
        <div class="stat-tile"><span>未读消息</span><strong>{{ dashboard?.stats?.unreadMessages || 0 }}</strong></div>
      </div>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">文件增长概况</h2>
        </div>
        <div class="growth-strip">
          <div v-for="item in dashboard?.growthTrend || []" :key="item.date" class="growth-day">
            <div class="growth-bars">
              <span class="growth-bar file" :style="{ height: Math.max(8, ((item.files || 0) / maxGrowthValue) * 72) + 'px' }"></span>
              <span class="growth-bar version" :style="{ height: Math.max(8, ((item.versions || 0) / maxGrowthValue) * 72) + 'px' }"></span>
            </div>
            <strong>{{ item.files || 0 }}/{{ item.versions || 0 }}</strong>
            <span>{{ item.date.slice(5) }}</span>
          </div>
        </div>
        <div class="legend-row">
          <span><i class="legend-dot file"></i>新增文件</span>
          <span><i class="legend-dot version"></i>新增版本</span>
        </div>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">最新文件</h2>
          <el-button type="primary" @click="$emit('open-docs')">进入文档库</el-button>
        </div>
        <el-table :data="dashboard?.latestFiles || []" border>
          <el-table-column prop="name" label="名称" min-width="220" />
          <el-table-column prop="fullPath" label="路径" min-width="260" />
          <el-table-column label="更新时间" width="180">
            <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
          </el-table-column>
        </el-table>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">最近操作</h2>
        </div>
        <el-table :data="dashboard?.recentAudits || []" border>
          <el-table-column prop="action" label="动作" width="180" />
          <el-table-column prop="targetPath" label="对象" min-width="260" />
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  `
};

export const DocsView = {
  props: ['tree', 'children', 'selectedFolder', 'users', 'departments', 'roles', 'formatDate', 'formatSize', 'actions', 'spaceSummary', 'isAdmin', 'enableSync'],
  emits: ['select-folder', 'create-folder', 'upload', 'rename', 'delete', 'download', 'preview', 'versions', 'lock', 'unlock', 'favorite', 'permissions', 'view-access', 'node-password', 'sync-external', 'search', 'batch-download', 'batch-move', 'batch-delete', 'move', 'copy', 'copy-enterprise', 'share', 'subscribe', 'reminder', 'metadata', 'links', 'workflow'],
  data: () => ({ keyword: '', selection: [], filtersVisible: false, fileTypesText: '', creatorId: '', updatedRange: [], sortBy: 'updatedAt', sortDir: 'desc', page: 1, pageSize: 20 }),
  computed: {
    pagedChildren() {
      const start = (this.page - 1) * this.pageSize;
      return (this.children || []).slice(start, start + this.pageSize);
    },
    singleSelection() {
      return this.selection.length === 1 ? this.selection[0] : null;
    }
  },
  watch: {
    children() {
      this.page = 1;
      this.selection = [];
    }
  },
  components: {
    Folder: FolderIcon,
    FileText: FileTextIcon,
    KeyRound: KeyRoundIcon,
    Paperclip: PaperclipIcon,
    RefreshCw: RefreshCwIcon,
    Search: SearchIcon,
    Share2: Share2Icon,
    Plus: PlusIcon,
    UploadCloud: UploadCloudIcon,
    BellRing: BellRingIcon,
    ClipboardCheck: ClipboardCheckIcon,
    Clock: ClockIcon,
    Download: DownloadIcon,
    Shield: ShieldIcon,
    Lock: LockIcon,
    MoreHorizontal: MoreHorizontalIcon,
    Unlock: UnlockIcon,
    Star: StarIcon,
    Tags: TagsIcon,
    Trash2: Trash2Icon
  },
  methods: {
    can(row, action) {
      return row.permissions?.includes(action) || row.permissions?.includes('full_control');
    },
    canModify(row) {
      if (!row) return false;
      return this.can(row, row.nodeType === 'folder' ? 'folder:create' : 'file:update');
    },
    canDownload(row) {
      if (!row) return false;
      return row.nodeType === 'folder' ? this.can(row, 'visible') : this.can(row, 'file:download');
    },
    userName(userId) {
      const user = (this.users || []).find((item) => item.id === userId);
      return user?.displayName || user?.username || userId || '-';
    },
    versionLabel(row) {
      return row.nodeType === 'file' ? (row.currentVersion?.versionNo || '-') : '-';
    },
    permissionSummary(row) {
      const permissions = row.permissions || [];
      if (permissions.includes('full_control')) return '完全控制';
      const labels = [
        ['visible', '可见'],
        ['file:preview', '预览'],
        ['file:download', '下载'],
        ['file:create', '上传'],
        ['folder:create', '新建'],
        ['file:update', '编辑'],
        ['file:delete', '删除'],
        ['permission:manage', '管理']
      ];
      const summary = labels.filter(([action]) => permissions.includes(action)).map(([, label]) => label);
      if (!summary.length) return '-';
      return summary.length > 4 ? `${summary.slice(0, 4).join('、')}...` : summary.join('、');
    },
    selectOnlyRow(row, column) {
      if (column?.type === 'selection') return;
      const table = this.$refs.docsTable;
      if (!table) return;
      table.clearSelection();
      table.toggleRowSelection(row, true);
    },
    openRow(row) {
      if (row.nodeType === 'folder') {
        this.$emit('select-folder', row);
        return;
      }
      if (this.can(row, 'file:preview')) {
        this.$emit('preview', row);
        return;
      }
      this.selectOnlyRow(row);
    },
    handleMoreCommand(payload) {
      const command = typeof payload === 'string' ? payload : payload?.action;
      const row = payload?.row || this.singleSelection;
      if (!row) return;
      const commands = {
        open: () => this.openRow(row),
        preview: () => this.$emit('preview', row),
        download: () => this.$emit('download', row),
        rename: () => this.$emit('rename', row),
        move: () => this.$emit('move', row, 'move'),
        copy: () => this.$emit('copy', row, 'copy'),
        copyEnterprise: () => this.$emit('copy-enterprise', row),
        share: () => this.$emit('share', row, 'share'),
        publish: () => this.$emit('share', row, 'publish'),
        workflow: () => this.$emit('workflow', row),
        subscribe: () => this.$emit('subscribe', row),
        reminder: () => this.$emit('reminder', row),
        metadata: () => this.$emit('metadata', row),
        links: () => this.$emit('links', row),
        versions: () => this.$emit('versions', row),
        lock: () => this.$emit('lock', row),
        unlock: () => this.$emit('unlock', row),
        favorite: () => this.$emit('favorite', row),
        permissions: () => this.$emit('permissions', row),
        viewAccess: () => this.$emit('view-access', row),
        password: () => this.$emit('node-password', row),
        delete: () => this.$emit('delete', row)
      };
      commands[command]?.();
    },
    runSearch() {
      this.page = 1;
      this.$emit('search', {
        keyword: this.keyword,
        fileTypes: String(this.fileTypesText || '').split(/[,\s，]+/).map((item) => item.replace(/^\./, '').trim().toLowerCase()).filter(Boolean),
        creatorId: this.creatorId,
        updatedFrom: this.updatedRange?.[0] ? new Date(this.updatedRange[0]).toISOString() : '',
        updatedTo: this.updatedRange?.[1] ? new Date(this.updatedRange[1]).toISOString() : '',
        sortBy: this.sortBy,
        sortDir: this.sortDir
      });
    },
    escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    },
    highlightName(row) {
      const name = this.escapeHtml(row.name);
      const keyword = String(row.matchedKeyword || this.keyword || '').trim();
      if (!keyword) return name;
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return name.replace(new RegExp(escapedKeyword, 'ig'), (match) => `<mark class="search-hit">${match}</mark>`);
    }
  },
  template: `
    <div class="split-layout">
      <aside class="tree-pane">
        <div class="section-header">
          <h2 class="section-title">目录</h2>
          <el-button :icon="Plus" circle aria-label="新建文件夹" @click="$emit('create-folder')" />
        </div>
        <el-tree :data="tree" node-key="id" :props="{ label: 'name', children: 'children' }" @node-click="$emit('select-folder', $event)">
          <template #default="{ data }">
            <span class="tree-node-label" :title="data.fullPath || data.name">
              <span class="tree-node-text">{{ data.name }}</span>
              <span
                v-if="data.hasUnread"
                class="unread-dot tree-unread-dot"
                :title="'有 ' + (data.unreadCount || 1) + ' 个未读新文件'"
                aria-label="有未读新文件"
              ></span>
            </span>
          </template>
        </el-tree>
      </aside>
      <section class="list-pane">
        <div v-if="spaceSummary" class="space-summary">
          <div><span>文件夹</span><strong>{{ spaceSummary.folders || 0 }}</strong></div>
          <div><span>文件</span><strong>{{ spaceSummary.files || 0 }}</strong></div>
          <div><span>版本</span><strong>{{ spaceSummary.versions || 0 }}</strong></div>
          <div><span>占用空间</span><strong>{{ formatSize(spaceSummary.sizeBytes || 0) }}</strong></div>
        </div>
        <div class="toolbar docs-toolbar">
          <div class="docs-actions">
            <el-button type="primary" :icon="UploadCloud" @click="$emit('upload')">上传</el-button>
            <el-button :icon="Plus" @click="$emit('create-folder')">新建</el-button>
            <el-button v-if="enableSync" :icon="RefreshCw" @click="$emit('sync-external')">同步</el-button>
            <el-dropdown trigger="click" :disabled="!singleSelection" @command="handleMoreCommand">
              <el-button :icon="MoreHorizontal" :disabled="!singleSelection">更多</el-button>
              <template #dropdown>
                <el-dropdown-menu v-if="singleSelection" class="docs-more-menu">
                  <el-dropdown-item v-if="singleSelection.nodeType === 'folder'" :command="{ action: 'open', row: singleSelection }">打开文件夹</el-dropdown-item>
                  <el-dropdown-item v-if="singleSelection.nodeType === 'file'" :command="{ action: 'preview', row: singleSelection }" :disabled="!can(singleSelection, 'file:preview')">预览</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'download', row: singleSelection }" :disabled="!canDownload(singleSelection)">{{ singleSelection.nodeType === 'folder' ? '打包下载' : '下载' }}</el-dropdown-item>
                  <el-dropdown-item v-if="singleSelection.nodeType === 'file'" :command="{ action: 'versions', row: singleSelection }">版本</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'rename', row: singleSelection }" :disabled="!canModify(singleSelection)">重命名</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'move', row: singleSelection }" :disabled="!canModify(singleSelection)">移动</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'copy', row: singleSelection }">复制</el-dropdown-item>
                  <el-dropdown-item v-if="singleSelection.spaceType === 'personal'" :command="{ action: 'copyEnterprise', row: singleSelection }">复制到文档库</el-dropdown-item>
                  <el-dropdown-item v-if="can(singleSelection, 'permission:manage')" :command="{ action: 'permissions', row: singleSelection }">权限</el-dropdown-item>
                  <el-dropdown-item v-if="can(singleSelection, 'file:delete')" :command="{ action: 'delete', row: singleSelection }" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button :icon="Download" :disabled="!selection.length" @click="$emit('batch-download', selection)">下载</el-button>
            <el-button :disabled="!selection.length" @click="$emit('batch-move', selection)">移动</el-button>
            <el-button type="danger" :icon="Trash2" :disabled="!selection.length" @click="$emit('batch-delete', selection)">删除</el-button>
          </div>
          <div class="docs-search-tools">
            <span class="selection-hint">{{ selection.length ? '已选 ' + selection.length + ' 项' : '未选择项目' }}</span>
            <el-button @click="filtersVisible = !filtersVisible">筛选</el-button>
            <el-input v-model="keyword" placeholder="搜索当前目录文件" clearable @keyup.enter="runSearch">
              <template #append>
                <el-button aria-label="搜索" @click="runSearch"><Search class="toolbar-icon" /></el-button>
              </template>
            </el-input>
          </div>
        </div>
        <div v-if="filtersVisible" class="toolbar filter-toolbar">
          <el-input v-model="fileTypesText" placeholder="扩展名：docx,pdf,xlsx" style="max-width: 220px" />
          <el-select v-model="creatorId" clearable filterable placeholder="创建人" style="max-width: 180px">
            <el-option v-for="item in users" :key="item.id" :label="item.displayName || item.username" :value="item.id" />
          </el-select>
          <el-date-picker
            v-model="updatedRange"
            type="daterange"
            start-placeholder="更新开始"
            end-placeholder="更新结束"
            value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
            style="max-width: 280px"
          />
          <el-select v-model="sortBy" style="max-width: 160px">
            <el-option label="更新时间" value="updatedAt" />
            <el-option label="创建时间" value="createdAt" />
            <el-option label="文件名" value="name" />
            <el-option label="大小" value="sizeBytes" />
            <el-option label="类型" value="extension" />
          </el-select>
          <el-select v-model="sortDir" style="max-width: 120px">
            <el-option label="降序" value="desc" />
            <el-option label="升序" value="asc" />
          </el-select>
          <el-button :icon="Search" @click="runSearch">应用筛选</el-button>
        </div>
        <div class="path-strip">当前位置：{{ selectedFolder?.fullPath || '/' }}</div>
        <el-table
          ref="docsTable"
          class="docs-table"
          :data="pagedChildren"
          border
          height="calc(100dvh - 258px)"
          @selection-change="selection = $event"
          @row-click="selectOnlyRow"
          @row-dblclick="openRow"
        >
          <el-table-column type="selection" width="44" />
          <el-table-column label="名称" min-width="300">
            <template #default="{ row }">
              <div class="file-name">
                <Folder v-if="row.nodeType === 'folder'" class="toolbar-icon" />
                <FileText v-else class="toolbar-icon" />
                <button class="file-title" :title="row.fullPath || row.name" @click.stop="openRow(row)">
                  <span v-html="highlightName(row)"></span>
                </button>
                <span
                  v-if="row.hasUnread"
                  class="unread-dot"
                  :title="'有 ' + (row.unreadCount || 1) + ' 个未读新文件'"
                  aria-label="有未读新文件"
                ></span>
                <el-tag v-if="row.sourceType === 'external'" size="small" type="success">同步</el-tag>
                <el-tag v-if="row.pendingApprovalCount" size="small" type="warning">审批 {{ row.pendingApprovalCount }}</el-tag>
                <el-tag v-if="row.passwordProtected" size="small" type="danger">加密</el-tag>
                <el-tag v-if="row.lockedBy" size="small" type="warning">锁定</el-tag>
                <el-tag v-if="row.businessStatus && row.businessStatus !== 'effective'" size="small" type="info">{{ row.businessStatus }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="90">
            <template #default="{ row }">{{ row.currentVersion ? formatSize(row.currentVersion.sizeBytes) : '-' }}</template>
          </el-table-column>
          <el-table-column label="版本" width="70">
            <template #default="{ row }">{{ versionLabel(row) }}</template>
          </el-table-column>
          <el-table-column label="创建者" width="110">
            <template #default="{ row }">{{ userName(row.createdBy || row.ownerId) }}</template>
          </el-table-column>
          <el-table-column label="修改时间" width="150">
            <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="我的权限" min-width="120">
            <template #default="{ row }">
              <span class="permission-summary" :title="permissionSummary(row)">{{ permissionSummary(row) }}</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="table-pagination">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :page-sizes="[10, 20, 50, 100]"
            :total="children?.length || 0"
            layout="total, sizes, prev, pager, next"
          />
        </div>
      </section>
    </div>
  `
};

export const CollaborationView = {
  props: ['shares', 'subscriptions', 'reminders', 'formatDate'],
  emits: ['revoke-share', 'cancel-subscription', 'edit-reminder', 'cancel-reminder'],
  data: () => ({ activeTab: 'shares' }),
  methods: {
    audienceLabel(row) {
      const audience = row.audience || {};
      if (audience.all) return '所有人';
      const parts = [];
      if (audience.userIds?.length) parts.push(`用户 ${audience.userIds.length}`);
      if (audience.departmentIds?.length) parts.push(`部门 ${audience.departmentIds.length}`);
      if (audience.roleIds?.length) parts.push(`角色 ${audience.roleIds.length}`);
      return parts.join('、') || '-';
    },
    cycleLabel(row) {
      const map = { none: '不循环', daily: '每天', weekly: '每周', monthly: '每月' };
      if (row.intervalDays > 0) return `${row.intervalDays} 天`;
      return map[row.cycle] || row.cycle || '-';
    },
    remindByLabel(row) {
      const map = { system: '系统消息', email: '邮件', wecom: '企业微信' };
      const values = Array.isArray(row.remindBy) ? row.remindBy : [row.remindBy || 'system'];
      return values.map((item) => map[item] || item).join('、');
    }
  },
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">协作中心</h2>
      </div>
      <el-tabs v-model="activeTab">
        <el-tab-pane label="分享发布" name="shares">
          <el-table :data="shares" border>
            <el-table-column label="类型" width="90">
              <template #default="{ row }">{{ row.type === 'publish' ? '发布' : '分享' }}</template>
            </el-table-column>
            <el-table-column prop="nodePath" label="文件/文件夹" min-width="260" />
            <el-table-column label="接收范围" width="130">
              <template #default="{ row }">{{ audienceLabel(row) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100" />
            <el-table-column label="到期时间" width="180">
              <template #default="{ row }">{{ formatDate(row.expiresAt) }}</template>
            </el-table-column>
            <el-table-column prop="description" label="说明" min-width="180" />
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="danger" :disabled="row.status !== 'active'" @click="$emit('revoke-share', row)">撤销</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="我的订阅" name="subscriptions">
          <el-table :data="subscriptions" border>
            <el-table-column prop="nodePath" label="文件/文件夹" min-width="280" />
            <el-table-column label="事件" width="140">
              <template #default="{ row }">{{ (row.eventTypes || []).join('、') || '-' }}</template>
            </el-table-column>
            <el-table-column label="包含子项" width="100">
              <template #default="{ row }">{{ row.includeChildren ? '是' : '否' }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100" />
            <el-table-column label="创建时间" width="180">
              <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="danger" :disabled="row.status !== 'active'" @click="$emit('cancel-subscription', row)">取消</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="文件闹钟" name="reminders">
          <el-table :data="reminders" border>
            <el-table-column prop="nodePath" label="文件/文件夹" min-width="280" />
            <el-table-column label="触发时间" width="180">
              <template #default="{ row }">{{ formatDate(row.triggerAt) }}</template>
            </el-table-column>
            <el-table-column label="循环" width="100">
              <template #default="{ row }">{{ cycleLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="方式" width="130">
              <template #default="{ row }">{{ remindByLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="结束时间" width="180">
              <template #default="{ row }">{{ formatDate(row.endAt) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100" />
            <el-table-column prop="remark" label="备注" min-width="180" />
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button size="small" :disabled="row.status !== 'active'" @click="$emit('edit-reminder', row)">编辑</el-button>
                <el-button size="small" type="danger" :disabled="row.status !== 'active'" @click="$emit('cancel-reminder', row)">取消</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </section>
  `
};

export const UsersView = {
  props: ['users', 'departments', 'roles'],
  emits: ['create', 'edit', 'reset'],
  methods: {
    depNames(row) {
      return (row.departmentIds || []).map((id) => this.departments.find((item) => item.id === id)?.name).filter(Boolean).join('、');
    },
    roleNames(row) {
      return (row.roleIds || []).map((id) => this.roles.find((item) => item.id === id)?.name).filter(Boolean).join('、');
    }
  },
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">用户管理</h2>
        <el-button type="primary" @click="$emit('create')">新建用户</el-button>
      </div>
      <el-table :data="users" border>
        <el-table-column prop="username" label="账号" width="140" />
        <el-table-column prop="displayName" label="姓名" width="160" />
        <el-table-column prop="email" label="邮箱" min-width="180" />
        <el-table-column label="部门" min-width="180"><template #default="{ row }">{{ depNames(row) }}</template></el-table-column>
        <el-table-column label="角色" min-width="180"><template #default="{ row }">{{ roleNames(row) }}</template></el-table-column>
        <el-table-column prop="status" label="状态" width="100" />
        <el-table-column label="操作" width="190">
          <template #default="{ row }">
            <el-button size="small" @click="$emit('edit', row)">编辑</el-button>
            <el-button size="small" @click="$emit('reset', row)">重置密码</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  `
};

export const ProfileView = {
  props: ['user', 'departments', 'roles'],
  emits: ['change-password'],
  methods: {
    depNames() {
      return (this.user?.departmentIds || []).map((id) => this.departments.find((item) => item.id === id)?.name).filter(Boolean).join('、') || '-';
    },
    roleNames() {
      return (this.user?.roleIds || []).map((id) => this.roles.find((item) => item.id === id)?.name).filter(Boolean).join('、') || '-';
    }
  },
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">个人中心</h2>
        <el-button type="primary" @click="$emit('change-password')">修改密码</el-button>
      </div>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="账号">{{ user?.username || '-' }}</el-descriptions-item>
        <el-descriptions-item label="姓名">{{ user?.displayName || '-' }}</el-descriptions-item>
        <el-descriptions-item label="邮箱">{{ user?.email || '-' }}</el-descriptions-item>
        <el-descriptions-item label="电话">{{ user?.phone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="部门">{{ depNames() }}</el-descriptions-item>
        <el-descriptions-item label="角色">{{ roleNames() }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ user?.status || '-' }}</el-descriptions-item>
      </el-descriptions>
    </section>
  `
};

export const OrgView = {
  props: ['departments', 'roles'],
  emits: ['create-department', 'edit-department', 'delete-department', 'create-role', 'edit-role', 'delete-role'],
  template: `
    <div class="split-layout">
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">部门树</h2>
          <el-button type="primary" @click="$emit('create-department', null)">新建部门</el-button>
        </div>
        <el-tree :data="departments" node-key="id" default-expand-all :expand-on-click-node="false" :props="{ label: 'name', children: 'children' }">
          <template #default="{ data }">
            <div class="tree-row">
              <span>{{ data.name }}</span>
              <span class="tree-actions">
                <el-button size="small" @click.stop="$emit('create-department', data)">新建下级</el-button>
                <el-button size="small" @click.stop="$emit('edit-department', data)">编辑</el-button>
                <el-button size="small" type="danger" @click.stop="$emit('delete-department', data)">删除</el-button>
              </span>
            </div>
          </template>
        </el-tree>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">角色树</h2>
          <el-button type="primary" @click="$emit('create-role', null)">新建角色</el-button>
        </div>
        <el-tree :data="roles" node-key="id" default-expand-all :expand-on-click-node="false" :props="{ label: 'name', children: 'children' }">
          <template #default="{ data }">
            <div class="tree-row">
              <span>{{ data.name }}</span>
              <span class="tree-actions">
                <el-button size="small" @click.stop="$emit('create-role', data)">新建下级</el-button>
                <el-button size="small" @click.stop="$emit('edit-role', data)">编辑</el-button>
                <el-button size="small" type="danger" :disabled="data.id === 'r_admin'" @click.stop="$emit('delete-role', data)">删除</el-button>
              </span>
            </div>
          </template>
        </el-tree>
      </section>
    </div>
  `
};

export const KnowledgeView = {
  props: ['categories', 'properties', 'categoryFiles', 'selectedCategory', 'formatDate', 'formatSize'],
  emits: ['create-category', 'edit-category', 'delete-category', 'select-category', 'preview-file', 'metadata-file', 'create-property', 'edit-property', 'delete-property'],
  template: `
    <div class="split-layout">
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">分类树</h2>
          <el-button type="primary" @click="$emit('create-category', null)">新建分类</el-button>
        </div>
        <el-tree :data="categories" node-key="id" default-expand-all :expand-on-click-node="false" :props="{ label: 'name', children: 'children' }" @node-click="$emit('select-category', $event)">
          <template #default="{ data }">
            <div class="tree-row">
              <span>{{ data.name }}</span>
              <span class="tree-actions">
                <el-button size="small" @click.stop="$emit('create-category', data)">新建下级</el-button>
                <el-button size="small" @click.stop="$emit('edit-category', data)">编辑</el-button>
                <el-button size="small" type="danger" @click.stop="$emit('delete-category', data)">删除</el-button>
              </span>
            </div>
          </template>
        </el-tree>
      </section>
      <div>
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">分类文件</h2>
            <span class="muted">{{ selectedCategory?.fullPath || selectedCategory?.name || '请选择分类' }}</span>
          </div>
          <el-table :data="categoryFiles" border>
            <el-table-column prop="name" label="文件名称" min-width="180" />
            <el-table-column prop="fullPath" label="路径" min-width="260" />
            <el-table-column label="大小" width="110">
              <template #default="{ row }">{{ row.currentVersion ? formatSize(row.currentVersion.sizeBytes) : '-' }}</template>
            </el-table-column>
            <el-table-column label="更新时间" width="180">
              <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button size="small" @click="$emit('preview-file', row)">预览</el-button>
                <el-button size="small" @click="$emit('metadata-file', row)">属性</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">文件扩展属性</h2>
            <el-button type="primary" @click="$emit('create-property')">新建属性</el-button>
          </div>
          <el-table :data="properties" border>
            <el-table-column prop="name" label="属性名称" min-width="160" />
            <el-table-column prop="targetType" label="对象" width="100" />
            <el-table-column prop="dataType" label="类型" width="120" />
            <el-table-column label="必填" width="90">
              <template #default="{ row }">{{ row.required ? '是' : '否' }}</template>
            </el-table-column>
            <el-table-column label="选项" min-width="180">
              <template #default="{ row }">{{ (row.options || []).join('、') || '-' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button size="small" @click="$emit('edit-property', row)">编辑</el-button>
                <el-button size="small" type="danger" @click="$emit('delete-property', row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </div>
    </div>
  `
};

export const TrashView = {
  props: ['items', 'formatDate'],
  emits: ['restore', 'destroy'],
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">回收站</h2>
      </div>
      <el-table :data="items" border>
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column prop="fullPath" label="原路径" min-width="260" />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ row.nodeType === 'folder' ? '文件夹' : row.extension || '文件' }}</template>
        </el-table-column>
        <el-table-column label="删除时间" width="180">
          <template #default="{ row }">{{ formatDate(row.deletedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="$emit('restore', row)">恢复</el-button>
            <el-button size="small" type="danger" @click="$emit('destroy', row)">彻底删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  `
};

export const MessagesView = {
  props: ['messages', 'formatDate'],
  emits: ['open', 'read', 'read-all'],
  data: () => ({ unreadOnly: false }),
  computed: {
    visibleMessages() {
      return this.unreadOnly ? (this.messages || []).filter((item) => !item.readAt) : (this.messages || []);
    },
    unreadCount() {
      return (this.messages || []).filter((item) => !item.readAt).length;
    }
  },
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">消息中心</h2>
        <div class="toolbar compact-toolbar">
          <el-switch v-model="unreadOnly" active-text="只看未读" />
          <el-tag type="primary">未读 {{ unreadCount }}</el-tag>
          <el-button @click="$emit('read-all')">全部已读</el-button>
        </div>
      </div>
      <el-table :data="visibleMessages" border>
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.readAt ? 'info' : 'primary'">{{ row.readAt ? '已读' : '未读' }}</el-tag></template></el-table-column>
        <el-table-column prop="title" label="标题" min-width="180" />
        <el-table-column prop="content" label="内容" min-width="320" />
        <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
        <el-table-column label="关联对象" min-width="180"><template #default="{ row }">{{ row.relatedNode?.fullPath || '-' }}</template></el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <el-button size="small" @click="$emit('open', row)">详情</el-button>
            <el-button size="small" @click="$emit('read', row)">标记已读</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  `
};

export const AnnouncementsView = {
  props: ['announcements', 'formatDate', 'formatSize'],
  emits: ['create', 'edit', 'publish', 'revoke', 'delete', 'download'],
  methods: {
    statusType(status) {
      return status === 'published' ? 'success' : status === 'draft' ? 'info' : 'warning';
    },
    statusText(status) {
      return { published: '已发布', draft: '草稿', revoked: '已撤销' }[status] || status;
    },
    audienceLabel(row) {
      const audience = row.audience || {};
      if (audience.all) return '所有人';
      const parts = [];
      if (audience.userIds?.length) parts.push(`用户 ${audience.userIds.length}`);
      if (audience.departmentIds?.length) parts.push(`部门 ${audience.departmentIds.length}`);
      if (audience.roleIds?.length) parts.push(`角色 ${audience.roleIds.length}`);
      return parts.join('、') || '-';
    }
  },
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">公告管理</h2>
        <el-button type="primary" @click="$emit('create')">新建公告</el-button>
      </div>
      <el-table :data="announcements" border>
        <el-table-column prop="title" label="标题" min-width="180" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="范围" width="140"><template #default="{ row }">{{ audienceLabel(row) }}</template></el-table-column>
        <el-table-column label="附件" min-width="160">
          <template #default="{ row }">
            <el-button v-if="row.attachment" link type="primary" @click="$emit('download', row)">{{ row.attachment.originalFilename }}</el-button>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="发布时间" width="180"><template #default="{ row }">{{ formatDate(row.publishedAt) }}</template></el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="$emit('edit', row)">编辑</el-button>
            <el-button v-if="row.status !== 'published'" size="small" type="primary" @click="$emit('publish', row)">发布</el-button>
            <el-button v-if="row.status === 'published'" size="small" @click="$emit('revoke', row)">撤销</el-button>
            <el-button size="small" type="danger" @click="$emit('delete', row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  `
};

export const ApiManagementView = {
  props: ['credentials', 'callLogs', 'users', 'filePolicy', 'formatDate'],
  emits: ['create', 'edit', 'rotate', 'disable', 'edit-file-policy'],
  methods: {
    userName(row) {
      return this.users.find((item) => item.id === row.userId)?.displayName || row.userName || row.userId;
    },
    statusType(status) {
      return status === 'enabled' ? 'success' : status === 'expired' ? 'warning' : 'info';
    }
  },
  template: `
    <div>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">API 凭证</h2>
          <el-button type="primary" @click="$emit('create')">新建凭证</el-button>
        </div>
        <el-table :data="credentials" border>
          <el-table-column prop="name" label="名称" min-width="160" />
          <el-table-column prop="accessKey" label="AccessKey" min-width="220" />
          <el-table-column label="关联用户" width="140"><template #default="{ row }">{{ userName(row) }}</template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusType(row.status)">{{ row.status }}</el-tag></template></el-table-column>
          <el-table-column prop="rateLimitPerMinute" label="限流/分钟" width="110" />
          <el-table-column label="调用次数" width="100"><template #default="{ row }">{{ row.callCount || 0 }}</template></el-table-column>
          <el-table-column label="最近调用" width="180"><template #default="{ row }">{{ formatDate(row.lastUsedAt) }}</template></el-table-column>
          <el-table-column label="操作" width="230" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="$emit('edit', row)">编辑</el-button>
              <el-button size="small" @click="$emit('rotate', row)">重置 Secret</el-button>
              <el-button size="small" type="danger" :disabled="row.status !== 'enabled'" @click="$emit('disable', row)">停用</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">调用日志</h2>
        </div>
        <el-table class="compact-data-table" :data="callLogs" border height="320">
          <el-table-column prop="accessKey" label="AccessKey" min-width="220" />
          <el-table-column prop="method" label="方法" width="80" />
          <el-table-column prop="path" label="路径" min-width="260" />
          <el-table-column prop="statusCode" label="状态码" width="90" />
          <el-table-column prop="durationMs" label="耗时(ms)" width="100" />
          <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
        </el-table>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">上传策略</h2>
          <el-button @click="$emit('edit-file-policy')">编辑策略</el-button>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="允许扩展名">{{ (filePolicy?.allowedExtensions || []).join('、') || '-' }}</el-descriptions-item>
          <el-descriptions-item label="单文件大小">{{ filePolicy?.maxSizeMb || '-' }} MB</el-descriptions-item>
        </el-descriptions>
      </section>
    </div>
  `
};

export const SystemManagementView = {
  props: ['dashboard', 'auditLogs', 'filePolicy', 'externalLibrary', 'storageSettings', 'formatDate'],
  emits: ['edit-file-policy', 'edit-external-library', 'edit-storage', 'sync-storage', 'export-audit'],
  computed: {
    stats() {
      return this.dashboard?.stats || {};
    },
    recentAuditLogs() {
      return (this.auditLogs || []).slice(0, 12);
    },
    externalStatus() {
      return this.externalLibrary?.lastSyncJob?.status || '-';
    },
    storageRuntime() {
      return this.storageSettings?.runtime || {};
    },
    storageMysql() {
      return this.storageSettings?.mysql || {};
    },
    configuredStorageLabel() {
      return this.storageSettings?.provider === 'mysql' ? '远程 MySQL' : '本地 JSON';
    },
    activeStorageLabel() {
      return this.storageRuntime?.activeProvider === 'mysql' ? '远程 MySQL' : '本地 JSON';
    },
    storageTagType() {
      if (this.storageRuntime?.lastError) return 'danger';
      return this.storageRuntime?.activeProvider === this.storageSettings?.provider ? 'success' : 'warning';
    },
    storageHealthText() {
      if (this.storageRuntime?.lastError) return '异常';
      return this.storageRuntime?.activeProvider === 'mysql' ? '运行中' : '本地模式';
    },
    storageEndpoint() {
      if (this.storageSettings?.provider !== 'mysql') return '-';
      const host = this.storageMysql.host || '-';
      const port = this.storageMysql.port || 3306;
      return `${host}:${port}`;
    }
  },
  template: `
    <div>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">数据统计</h2>
        </div>
        <div class="stats-grid">
          <div class="stat-tile"><span>可见文件夹</span><strong>{{ stats.folders || 0 }}</strong></div>
          <div class="stat-tile"><span>可见文件</span><strong>{{ stats.files || 0 }}</strong></div>
          <div class="stat-tile"><span>版本记录</span><strong>{{ stats.versions || 0 }}</strong></div>
          <div class="stat-tile"><span>未读消息</span><strong>{{ stats.unreadMessages || 0 }}</strong></div>
        </div>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">系统参数</h2>
          <div class="toolbar compact-toolbar">
            <el-button @click="$emit('edit-file-policy')">上传策略</el-button>
            <el-button type="primary" @click="$emit('edit-external-library')">同步目录</el-button>
          </div>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="允许扩展名">{{ (filePolicy?.allowedExtensions || []).join('、') || '-' }}</el-descriptions-item>
          <el-descriptions-item label="单文件大小">{{ filePolicy?.maxSizeMb || '-' }} MB</el-descriptions-item>
          <el-descriptions-item label="同步根目录">{{ externalLibrary?.rootPath || '-' }}</el-descriptions-item>
          <el-descriptions-item label="同步状态">{{ externalStatus }}</el-descriptions-item>
          <el-descriptions-item label="只同步目录">{{ (externalLibrary?.includePaths || []).join('、') || '全部' }}</el-descriptions-item>
          <el-descriptions-item label="排除规则">{{ (externalLibrary?.excludePatterns || []).join('、') || '-' }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">数据库存储</h2>
          <div class="toolbar compact-toolbar">
            <el-button @click="$emit('edit-storage')">连接配置</el-button>
            <el-button type="primary" :disabled="storageSettings?.provider !== 'mysql'" @click="$emit('sync-storage')">同步账本</el-button>
          </div>
        </div>
        <div class="storage-status-row">
          <div class="storage-status-item">
            <span>当前状态</span>
            <strong>
              <el-tag :type="storageTagType" effect="light">{{ storageHealthText }}</el-tag>
            </strong>
          </div>
          <div class="storage-status-item">
            <span>配置方式</span>
            <strong>{{ configuredStorageLabel }}</strong>
          </div>
          <div class="storage-status-item">
            <span>实际运行</span>
            <strong>{{ activeStorageLabel }}</strong>
          </div>
          <div class="storage-status-item">
            <span>密码</span>
            <strong>{{ storageMysql.hasPassword ? '已保存' : '-' }}</strong>
          </div>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="MySQL 地址">{{ storageEndpoint }}</el-descriptions-item>
          <el-descriptions-item label="数据库">{{ storageMysql.database || '-' }}</el-descriptions-item>
          <el-descriptions-item label="用户名">{{ storageMysql.user || '-' }}</el-descriptions-item>
          <el-descriptions-item label="SSL">{{ storageMysql.ssl ? '启用' : '关闭' }}</el-descriptions-item>
          <el-descriptions-item label="最后加载">{{ formatDate(storageRuntime.lastLoadedAt) }}</el-descriptions-item>
          <el-descriptions-item label="最后保存">{{ formatDate(storageRuntime.lastSavedAt) }}</el-descriptions-item>
          <el-descriptions-item label="最近错误" :span="2">{{ storageRuntime.lastError || '-' }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">最近审计</h2>
          <el-button type="primary" @click="$emit('export-audit')">导出日志</el-button>
        </div>
        <el-table class="compact-data-table" :data="recentAuditLogs" border height="360">
          <el-table-column prop="action" label="动作" width="180" />
          <el-table-column prop="actorId" label="操作者" width="150" />
          <el-table-column prop="targetPath" label="对象路径" min-width="300" />
          <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
        </el-table>
      </section>
    </div>
  `
};

export const AuditView = {
  props: ['logs', 'formatDate'],
  emits: ['export'],
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">审计日志</h2>
        <el-button type="primary" @click="$emit('export')">导出日志</el-button>
      </div>
      <el-table class="compact-data-table" :data="logs" border height="calc(100dvh - 172px)">
        <el-table-column prop="action" label="动作" width="180" />
        <el-table-column prop="actorId" label="操作者" width="150" />
        <el-table-column prop="targetPath" label="对象路径" min-width="300" />
        <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      </el-table>
    </section>
  `
};
