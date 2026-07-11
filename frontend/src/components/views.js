import {
  ClipboardCheck as ClipboardCheckIcon,
  Download as DownloadIcon,
  BellRing as BellRingIcon,
  Building2 as Building2Icon,
  Clock as ClockIcon,
  FileText as FileTextIcon,
  Folder as FolderIcon,
  KeyRound as KeyRoundIcon,
  Lock as LockIcon,
  MoreHorizontal as MoreHorizontalIcon,
  Paperclip as PaperclipIcon,
  Pencil as PencilIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshCwIcon,
  Search as SearchIcon,
  Share2 as Share2Icon,
  Shield as ShieldIcon,
  ShieldCheck as ShieldCheckIcon,
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
  props: ['tree', 'children', 'selectedFolder', 'users', 'departments', 'roles', 'categories', 'recentSearches', 'formatDate', 'formatSize', 'actions', 'spaceSummary', 'isAdmin', 'enableSync', 'recentAccesses', 'storageScope', 'suggestSearch'],
  emits: ['select-folder', 'create-folder', 'upload', 'rename', 'delete', 'download', 'preview', 'office-edit', 'versions', 'lock', 'unlock', 'favorite', 'permissions', 'view-access', 'node-password', 'sync-external', 'search', 'clear-recent-searches', 'batch-download', 'batch-move', 'batch-delete', 'batch-metadata', 'move', 'copy', 'copy-enterprise', 'share', 'subscribe', 'reminder', 'metadata', 'links', 'workflow', 'security', 'request-approval', 'governance'],
  data: () => ({
    Download: DownloadIcon,
    MoreHorizontal: MoreHorizontalIcon,
    Plus: PlusIcon,
    RefreshCw: RefreshCwIcon,
    Search: SearchIcon,
    Trash2: Trash2Icon,
    UploadCloud: UploadCloudIcon,
    keyword: '',
    treeKeyword: '',
    selection: [],
    filtersVisible: false,
    fileTypesText: '',
    securityLevels: [],
    categoryIds: [],
    tagsText: '',
    creatorId: '',
    updatedRange: [],
    sortBy: 'relevance',
    sortDir: 'desc',
    page: 1,
    pageSize: 20,
    savedFilterName: '',
    selectedFilterName: '',
    savedFilters: [],
    columnPrefs: { size: true, version: true, security: true, creator: true, updatedAt: true, permissions: true }
  }),
  computed: {
    filteredTree() {
      const keyword = String(this.treeKeyword || '').trim().toLowerCase();
      if (!keyword) return this.tree || [];
      const filterNode = (node) => {
        const children = (node.children || []).map(filterNode).filter(Boolean);
        const matched = String(`${node.name} ${node.fullPath || ''}`).toLowerCase().includes(keyword);
        return matched || children.length ? { ...node, children } : null;
      };
      return (this.tree || []).map(filterNode).filter(Boolean);
    },
    pagedChildren() {
      const start = (this.page - 1) * this.pageSize;
      return (this.children || []).slice(start, start + this.pageSize);
    },
    singleSelection() {
      return this.selection.length === 1 ? this.selection[0] : null;
    },
    filterStorageKey() {
      return `document_platform_filter_state_${this.storageScope || 'docs'}`;
    },
    activeFilterSummary() {
      const items = [];
      if (String(this.keyword || '').trim()) items.push(`关键词：${String(this.keyword).trim()}`);
      if (String(this.fileTypesText || '').trim()) items.push(`类型：${String(this.fileTypesText).trim()}`);
      if (this.securityLevels.length) items.push(`密级：${this.securityLevels.map((item) => ({ public: '公开', internal: '内部', restricted: '受限', confidential: '机密' }[item] || item)).join('、')}`);
      if (this.categoryIds.length) items.push(`分类：${this.categoryIds.length} 项`);
      if (String(this.tagsText || '').trim()) items.push(`标签：${String(this.tagsText).trim()}`);
      const creator = this.users?.find((item) => item.id === this.creatorId);
      if (this.creatorId) items.push(`创建人：${creator?.displayName || creator?.username || this.creatorId}`);
      if (this.updatedRange?.[0] || this.updatedRange?.[1]) items.push('更新时间');
      const sortLabels = { relevance: '相关性', updatedAt: '更新时间', createdAt: '创建时间', name: '文件名', sizeBytes: '大小', extension: '类型' };
      if (this.sortBy !== 'relevance' || this.sortDir !== 'desc') items.push(`排序：${sortLabels[this.sortBy] || this.sortBy}/${this.sortDir === 'asc' ? '升序' : '降序'}`);
      return items;
    }
  },
  watch: {
    children() {
      this.page = 1;
      this.selection = [];
    }
  },
  mounted() {
    this.loadLocalPrefs();
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
    downloadBlocked(row) {
      return row?.nodeType === 'file' && row.sensitiveDownloadBlocked;
    },
    canOfficeEdit(row) {
      return row?.nodeType === 'file'
        && ['docx', 'xlsx', 'pptx'].includes(String(row.extension || '').toLowerCase())
        && (row.sourceType || 'local') !== 'external'
        && this.can(row, 'file:update');
    },
    securityLevelLabel(row) {
      return row.securityLevelLabel || { public: '公开', internal: '内部', restricted: '受限', confidential: '机密' }[row.securityLevel] || '-';
    },
    securityTagType(row) {
      return { public: 'success', internal: 'info', restricted: 'warning', confidential: 'danger' }[row.securityLevel] || 'info';
    },
    loadLocalPrefs() {
      try {
        const rawColumns = localStorage.getItem('document_platform_column_prefs');
        if (rawColumns) this.columnPrefs = { ...this.columnPrefs, ...JSON.parse(rawColumns) };
        this.savedFilters = JSON.parse(localStorage.getItem('document_platform_saved_filters') || '[]');
        const rawFilterState = localStorage.getItem(this.filterStorageKey);
        if (rawFilterState) this.applyFilterState(JSON.parse(rawFilterState), false);
      } catch {
        this.savedFilters = [];
      }
    },
    filterState() {
      return {
        keyword: this.keyword,
        fileTypesText: this.fileTypesText,
        securityLevels: this.securityLevels,
        categoryIds: this.categoryIds,
        tagsText: this.tagsText,
        creatorId: this.creatorId,
        updatedRange: this.updatedRange,
        sortBy: this.sortBy,
        sortDir: this.sortDir
      };
    },
    applyFilterState(state, run = true) {
      this.keyword = state?.keyword || '';
      this.fileTypesText = state?.fileTypesText || '';
      this.securityLevels = state?.securityLevels || [];
      this.categoryIds = state?.categoryIds || [];
      this.tagsText = state?.tagsText || '';
      this.creatorId = state?.creatorId || '';
      this.updatedRange = state?.updatedRange || [];
      this.sortBy = state?.sortBy || 'relevance';
      this.sortDir = state?.sortDir || 'desc';
      if (run) this.runSearch();
    },
    persistFilterState() {
      localStorage.setItem(this.filterStorageKey, JSON.stringify(this.filterState()));
    },
    saveColumnPrefs() {
      localStorage.setItem('document_platform_column_prefs', JSON.stringify(this.columnPrefs));
    },
    saveCurrentFilter() {
      const name = String(this.savedFilterName || '').trim();
      if (!name) return;
      const filter = {
        name,
        keyword: this.keyword,
        fileTypesText: this.fileTypesText,
        securityLevels: this.securityLevels,
        categoryIds: this.categoryIds,
        tagsText: this.tagsText,
        creatorId: this.creatorId,
        updatedRange: this.updatedRange,
        sortBy: this.sortBy,
        sortDir: this.sortDir
      };
      this.savedFilters = [...this.savedFilters.filter((item) => item.name !== name), filter];
      localStorage.setItem('document_platform_saved_filters', JSON.stringify(this.savedFilters));
      this.selectedFilterName = name;
      this.savedFilterName = '';
    },
    applySavedFilter(name) {
      const filter = this.savedFilters.find((item) => item.name === name);
      if (!filter) return;
      this.applyFilterState(filter);
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
        this.$emit('preview', row, null, { searchKeyword: row.searchMatch?.keyword || this.keyword || '' });
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
        preview: () => this.$emit('preview', row, null, { searchKeyword: row.searchMatch?.keyword || this.keyword || '' }),
        officeEdit: () => this.$emit('office-edit', row),
        download: () => this.$emit('download', row),
        requestDownload: () => this.$emit('request-approval', row, 'download'),
        requestBorrow: () => this.$emit('request-approval', row, 'borrow'),
        requestExternal: () => this.$emit('request-approval', row, 'external'),
        requestPermission: () => this.$emit('request-approval', row, 'permission'),
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
        security: () => this.$emit('security', row),
        governance: () => this.$emit('governance', row),
        viewAccess: () => this.$emit('view-access', row),
        password: () => this.$emit('node-password', row),
        delete: () => this.$emit('delete', row)
      };
      commands[command]?.();
    },
    runSearch() {
      this.page = 1;
      this.persistFilterState();
      const criteria = {
        keyword: this.keyword,
        fileTypes: String(this.fileTypesText || '').split(/[,\s，]+/).map((item) => item.replace(/^\./, '').trim().toLowerCase()).filter(Boolean),
        securityLevels: this.securityLevels,
        categoryIds: this.categoryIds,
        tags: String(this.tagsText || '').split(/[,\s，]+/).map((item) => item.trim()).filter(Boolean),
        creatorId: this.creatorId,
        updatedFrom: this.updatedRange?.[0] ? new Date(this.updatedRange[0]).toISOString() : '',
        updatedTo: this.updatedRange?.[1] ? new Date(this.updatedRange[1]).toISOString() : '',
        sortBy: this.sortBy,
        sortDir: this.sortDir
      };
      this.$emit('search', criteria);
    },
    clearSearch() {
      this.applyFilterState({
        keyword: '',
        fileTypesText: '',
        securityLevels: [],
        categoryIds: [],
        tagsText: '',
        creatorId: '',
        updatedRange: [],
        sortBy: 'relevance',
        sortDir: 'desc'
      });
      this.selectedFilterName = '';
    },
    async querySearchSuggestions(queryString, callback) {
      const query = String(queryString || '').trim();
      if (!query || typeof this.suggestSearch !== 'function') {
        callback([]);
        return;
      }
      try {
        const suggestions = await this.suggestSearch(query);
        callback((suggestions || []).map((item) => ({ ...item, value: item.value || query })));
      } catch {
        callback([]);
      }
    },
    selectSearchSuggestion(item) {
      this.keyword = item?.value || this.keyword;
      this.runSearch();
    },
    applyRecentSearch(item) {
      const filters = item?.filters || {};
      this.applyFilterState({
        keyword: item?.keyword || '',
        fileTypesText: (filters.fileTypes || []).join(','),
        securityLevels: filters.securityLevels || [],
        categoryIds: filters.categoryIds || [],
        tagsText: (filters.tags || []).join(','),
        creatorId: filters.creatorId || '',
        updatedRange: filters.updatedFrom || filters.updatedTo ? [filters.updatedFrom || '', filters.updatedTo || ''] : [],
        sortBy: filters.sortBy || 'relevance',
        sortDir: filters.sortDir || 'desc'
      });
    },
    escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    },
    highlightName(row) {
      return this.highlightText(row.name, row.matchedKeyword || this.keyword);
    },
    highlightText(value, keywordValue) {
      const text = this.escapeHtml(value);
      const keyword = String(keywordValue || '').trim();
      if (!keyword) return text;
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text.replace(new RegExp(escapedKeyword, 'ig'), (match) => `<mark class="search-hit">${match}</mark>`);
    },
    highlightSnippet(row) {
      return this.highlightText(row.searchMatch?.snippet || '', row.searchMatch?.keyword || row.matchedKeyword || this.keyword);
    }
  },
  template: `
    <div class="split-layout">
      <aside class="tree-pane">
        <div class="section-header">
          <h2 class="section-title">目录</h2>
          <el-button :icon="Plus" circle aria-label="新建文件夹" @click="$emit('create-folder')" />
        </div>
        <el-input v-model="treeKeyword" class="tree-search-input" clearable placeholder="搜索目录" />
        <el-tree :data="filteredTree" node-key="id" :props="{ label: 'name', children: 'children' }" @node-click="$emit('select-folder', $event)">
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
        <div v-if="recentAccesses?.length" class="recent-access-strip">
          <span>最近访问</span>
          <button
            v-for="item in recentAccesses.slice(0, 5)"
            :key="item.id"
            type="button"
            :title="item.nodePath"
            @click="$emit('preview', item.node || { id: item.nodeId, name: item.nodeName, nodeType: 'file' })"
          >
            {{ item.nodeName || item.node?.name }}
          </button>
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
                  <el-dropdown-item v-if="canOfficeEdit(singleSelection)" :command="{ action: 'officeEdit', row: singleSelection }">在线编辑</el-dropdown-item>
                  <el-dropdown-item v-if="!downloadBlocked(singleSelection)" :command="{ action: 'download', row: singleSelection }" :disabled="!canDownload(singleSelection)">{{ singleSelection.nodeType === 'folder' ? '打包下载' : '下载' }}</el-dropdown-item>
                  <el-dropdown-item v-if="downloadBlocked(singleSelection)" :command="{ action: 'requestDownload', row: singleSelection }">申请下载</el-dropdown-item>
                  <el-dropdown-item v-if="singleSelection.nodeType === 'file'" :command="{ action: 'requestBorrow', row: singleSelection }">申请借阅</el-dropdown-item>
                  <el-dropdown-item v-if="singleSelection.nodeType === 'file'" :command="{ action: 'requestExternal', row: singleSelection }">申请外发</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'requestPermission', row: singleSelection }">申请权限</el-dropdown-item>
                  <el-dropdown-item v-if="singleSelection.nodeType === 'file'" :command="{ action: 'versions', row: singleSelection }">版本</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'rename', row: singleSelection }" :disabled="!canModify(singleSelection)">重命名</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'move', row: singleSelection }" :disabled="!canModify(singleSelection)">移动</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'copy', row: singleSelection }">复制</el-dropdown-item>
                  <el-dropdown-item v-if="singleSelection.spaceType === 'personal'" :command="{ action: 'copyEnterprise', row: singleSelection }">复制到文档库</el-dropdown-item>
                  <el-dropdown-item v-if="can(singleSelection, 'permission:manage')" :command="{ action: 'permissions', row: singleSelection }">权限</el-dropdown-item>
                  <el-dropdown-item :command="{ action: 'security', row: singleSelection }" :disabled="!canModify(singleSelection)">安全设置</el-dropdown-item>
                  <el-dropdown-item v-if="singleSelection.nodeType === 'file'" :command="{ action: 'governance', row: singleSelection }">质量与复审</el-dropdown-item>
                  <el-dropdown-item v-if="can(singleSelection, 'file:delete')" :command="{ action: 'delete', row: singleSelection }" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button :icon="Download" :disabled="!selection.length" @click="$emit('batch-download', selection)">下载</el-button>
            <el-button :disabled="!selection.length" @click="$emit('batch-move', selection)">移动</el-button>
            <el-button :disabled="!selection.length" @click="$emit('batch-metadata', selection)">批量属性</el-button>
            <el-button type="danger" :icon="Trash2" :disabled="!selection.length" @click="$emit('batch-delete', selection)">删除</el-button>
          </div>
          <div class="docs-search-tools">
            <span class="selection-hint">{{ selection.length ? '已选 ' + selection.length + ' 项' : '未选择项目' }}</span>
            <el-button @click="filtersVisible = !filtersVisible">筛选</el-button>
            <el-dropdown trigger="click" @command="saveColumnPrefs">
              <el-button>列</el-button>
              <template #dropdown>
                <el-dropdown-menu class="docs-more-menu">
                  <el-checkbox v-model="columnPrefs.size" label="大小" @change="saveColumnPrefs" />
                  <el-checkbox v-model="columnPrefs.version" label="版本" @change="saveColumnPrefs" />
                  <el-checkbox v-model="columnPrefs.security" label="安全" @change="saveColumnPrefs" />
                  <el-checkbox v-model="columnPrefs.creator" label="创建者" @change="saveColumnPrefs" />
                  <el-checkbox v-model="columnPrefs.updatedAt" label="修改时间" @change="saveColumnPrefs" />
                  <el-checkbox v-model="columnPrefs.permissions" label="权限" @change="saveColumnPrefs" />
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <div class="docs-search-box">
              <el-autocomplete
                v-model="keyword"
                :fetch-suggestions="querySearchSuggestions"
                placeholder="搜索文件名/正文内容"
                clearable
                :trigger-on-focus="false"
                @select="selectSearchSuggestion"
                @keyup.enter="runSearch"
              >
                <template #default="{ item }">
                  <div class="search-suggestion-item">
                    <div>
                      <strong>{{ item.value }}</strong>
                      <span>{{ item.detail || item.fullPath }}</span>
                    </div>
                    <el-tag size="small" effect="plain">{{ item.typeLabel || '建议' }}</el-tag>
                  </div>
                </template>
              </el-autocomplete>
              <el-dropdown v-if="recentSearches?.length" trigger="click" @command="applyRecentSearch">
                <el-button>最近</el-button>
                <template #dropdown>
                  <el-dropdown-menu class="docs-more-menu recent-search-menu">
                    <el-dropdown-item v-for="item in recentSearches" :key="item.id" :command="item">
                      {{ item.keyword || '组合筛选' }}（{{ item.resultCount }}）
                    </el-dropdown-item>
                    <el-dropdown-item divided @click="$emit('clear-recent-searches')">清空最近搜索</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button aria-label="搜索" @click="runSearch"><Search class="toolbar-icon" /></el-button>
            </div>
          </div>
        </div>
        <div v-if="filtersVisible" class="toolbar filter-toolbar">
          <el-input v-model="fileTypesText" placeholder="扩展名：docx,pdf,xlsx" style="max-width: 220px" />
          <el-select v-model="securityLevels" multiple collapse-tags clearable placeholder="密级" style="max-width: 190px">
            <el-option label="公开" value="public" />
            <el-option label="内部" value="internal" />
            <el-option label="受限" value="restricted" />
            <el-option label="机密" value="confidential" />
          </el-select>
          <el-select v-model="categoryIds" multiple collapse-tags clearable filterable placeholder="知识分类" style="max-width: 210px">
            <el-option v-for="item in categories || []" :key="item.id" :label="item.fullPath || item.name" :value="item.id" />
          </el-select>
          <el-input v-model="tagsText" placeholder="标签：制度,质量" style="max-width: 190px" />
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
            <el-option label="相关性" value="relevance" />
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
          <el-select v-model="selectedFilterName" clearable placeholder="已保存筛选" style="max-width: 180px" @change="applySavedFilter">
            <el-option v-for="item in savedFilters" :key="item.name" :label="item.name" :value="item.name" />
          </el-select>
          <el-input v-model="savedFilterName" placeholder="筛选名称" style="max-width: 150px" />
          <el-button @click="saveCurrentFilter">保存筛选</el-button>
        </div>
        <div v-if="activeFilterSummary.length" class="active-filter-strip">
          <span v-for="item in activeFilterSummary" :key="item">{{ item }}</span>
          <el-button size="small" text @click="clearSearch">清空</el-button>
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
              <div class="file-name-cell">
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
                  <el-tag v-if="row.sensitive" size="small" type="danger">敏感</el-tag>
                  <el-tag v-if="row.sensitiveDownloadBlocked" size="small" type="warning">限下载</el-tag>
                  <el-tag v-if="row.pendingApprovalCount" size="small" type="warning">审批 {{ row.pendingApprovalCount }}</el-tag>
                  <el-tag v-if="row.passwordProtected" size="small" type="danger">加密</el-tag>
                  <el-tag v-if="row.lockedBy" size="small" type="warning">锁定</el-tag>
                  <el-tag v-if="row.businessStatus && row.businessStatus !== 'effective'" size="small" type="info">{{ row.businessStatus }}</el-tag>
                </div>
                <div v-if="row.searchMatch?.snippet" class="search-snippet">
                  <el-tag size="small" type="info" effect="plain">{{ row.searchMatch.sourceLabel || '命中' }}</el-tag>
                  <span v-html="highlightSnippet(row)"></span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column v-if="columnPrefs.size" label="大小" width="90">
            <template #default="{ row }">{{ row.currentVersion ? formatSize(row.currentVersion.sizeBytes) : '-' }}</template>
          </el-table-column>
          <el-table-column v-if="columnPrefs.version" label="版本" width="70">
            <template #default="{ row }">{{ versionLabel(row) }}</template>
          </el-table-column>
          <el-table-column v-if="columnPrefs.security" label="安全" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="securityTagType(row)">{{ securityLevelLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="columnPrefs.creator" label="创建者" width="110">
            <template #default="{ row }">{{ userName(row.createdBy || row.ownerId) }}</template>
          </el-table-column>
          <el-table-column v-if="columnPrefs.updatedAt" label="修改时间" width="150">
            <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column v-if="columnPrefs.permissions" label="我的权限" min-width="120">
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

export const ApprovalCenterView = {
  props: ['todo', 'mine', 'all', 'formatDate', 'isAdmin', 'templates'],
  emits: ['approve', 'reject', 'withdraw', 'remind', 'transfer', 'addStep', 'refresh', 'manageTemplates'],
  data: () => ({ activeTab: 'todo', RefreshCwIcon }),
  components: { RefreshCwIcon },
  methods: {
    statusLabel(status) {
      return { pending: '待审批', approved: '已通过', rejected: '已驳回', cancelled: '已取消' }[status] || status || '-';
    },
    statusTag(status) {
      return { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' }[status] || 'info';
    },
    securityLabel(row) {
      if (!row.nodeSensitive && !row.nodeSecurityLevel) return '-';
      const level = { public: '公开', internal: '内部', restricted: '受限', confidential: '机密' }[row.nodeSecurityLevel] || row.nodeSecurityLevel || '';
      return row.nodeSensitive ? `${level} / 敏感` : level;
    }
  },
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">审批中心</h2>
        <div class="toolbar">
          <el-button v-if="isAdmin" @click="$emit('manageTemplates')">审批模板（{{ templates?.length || 0 }}）</el-button>
          <el-button :icon="RefreshCwIcon" @click="$emit('refresh')">刷新</el-button>
        </div>
      </div>
      <el-tabs v-model="activeTab">
        <el-tab-pane label="待我审批" name="todo">
          <el-table :data="todo" border height="calc(100dvh - 220px)">
            <el-table-column prop="typeLabel" label="类型" width="110" />
            <el-table-column prop="actionLabel" label="动作" width="110" />
            <el-table-column prop="nodePath" label="文件/文件夹" min-width="260" />
            <el-table-column label="安全" width="120"><template #default="{ row }">{{ securityLabel(row) }}</template></el-table-column>
            <el-table-column prop="requesterName" label="申请人" width="120" />
            <el-table-column prop="currentStepName" label="当前步骤" width="120" />
            <el-table-column prop="currentApproverNames" label="当前审批人" width="150" />
            <el-table-column prop="requestComment" label="申请说明" min-width="180" />
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusTag(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
            <el-table-column label="操作" width="270" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.canDecide" size="small" type="primary" @click="$emit('approve', row)">通过</el-button>
                <el-button v-if="row.canDecide" size="small" type="danger" @click="$emit('reject', row)">驳回</el-button>
                <el-button v-if="row.canManageStep" size="small" @click="$emit('transfer', row)">转交</el-button>
                <el-button v-if="row.canManageStep" size="small" @click="$emit('addStep', row)">加签</el-button>
                <span v-if="!row.canDecide" class="muted">-</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="我的申请" name="mine">
          <el-table :data="mine" border height="calc(100dvh - 220px)">
            <el-table-column prop="typeLabel" label="类型" width="110" />
            <el-table-column prop="actionLabel" label="动作" width="110" />
            <el-table-column prop="nodePath" label="文件/文件夹" min-width="280" />
            <el-table-column prop="approverName" label="审批人" width="120" />
            <el-table-column prop="currentStepName" label="当前步骤" width="120" />
            <el-table-column prop="requestComment" label="申请说明" min-width="180" />
            <el-table-column prop="decisionComment" label="处理说明" min-width="180" />
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusTag(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.canWithdraw" size="small" @click="$emit('remind', row)">催办</el-button>
                <el-button v-if="row.canWithdraw" size="small" type="danger" @click="$emit('withdraw', row)">撤回</el-button>
                <span v-if="!row.canWithdraw" class="muted">-</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="全部记录" name="all">
          <el-table :data="all" border height="calc(100dvh - 220px)">
            <el-table-column prop="typeLabel" label="类型" width="110" />
            <el-table-column prop="actionLabel" label="动作" width="110" />
            <el-table-column prop="nodePath" label="文件/文件夹" min-width="260" />
            <el-table-column prop="requesterName" label="申请人" width="120" />
            <el-table-column prop="approverName" label="审批人" width="120" />
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusTag(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="更新时间" width="170"><template #default="{ row }">{{ formatDate(row.updatedAt) }}</template></el-table-column>
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
  components: { Building2Icon, PencilIcon, PlusIcon, ShieldCheckIcon, Trash2Icon },
  data: () => ({ PencilIcon, PlusIcon, Trash2Icon }),
  methods: {
    countNodes(items) {
      return (items || []).reduce((total, item) => total + 1 + this.countNodes(item.children), 0);
    }
  },
  template: `
    <div class="org-layout">
      <section class="section org-panel">
        <div class="org-panel-header">
          <div>
            <h2 class="section-title">部门管理</h2>
            <p>按企业层级维护部门和下级组织</p>
          </div>
          <el-button type="primary" :icon="PlusIcon" @click="$emit('create-department', null)">新建部门</el-button>
        </div>
        <div class="org-panel-summary"><Building2Icon /><span>共 {{ countNodes(departments) }} 个部门</span></div>
        <el-empty v-if="!departments?.length" description="暂无部门" :image-size="84" />
        <el-tree v-else class="org-tree" :data="departments" node-key="id" default-expand-all :expand-on-click-node="false" :props="{ label: 'name', children: 'children' }">
          <template #default="{ data }">
            <div class="org-tree-row">
              <div class="org-tree-identity">
                <Building2Icon class="org-tree-icon" />
                <span class="org-tree-copy"><strong>{{ data.name }}</strong><small v-if="data.code">{{ data.code }}</small></span>
              </div>
              <div class="org-tree-actions">
                <el-tooltip content="新建下级部门" placement="top"><el-button text circle :icon="PlusIcon" aria-label="新建下级部门" @click.stop="$emit('create-department', data)" /></el-tooltip>
                <el-tooltip content="编辑部门" placement="top"><el-button text circle :icon="PencilIcon" aria-label="编辑部门" @click.stop="$emit('edit-department', data)" /></el-tooltip>
                <el-tooltip content="删除部门" placement="top"><el-button text circle type="danger" :icon="Trash2Icon" aria-label="删除部门" @click.stop="$emit('delete-department', data)" /></el-tooltip>
              </div>
            </div>
          </template>
        </el-tree>
      </section>
      <section class="section org-panel">
        <div class="org-panel-header">
          <div>
            <h2 class="section-title">角色管理</h2>
            <p>维护角色层级及成员权限范围</p>
          </div>
          <el-button type="primary" :icon="PlusIcon" @click="$emit('create-role', null)">新建角色</el-button>
        </div>
        <div class="org-panel-summary"><ShieldCheckIcon /><span>共 {{ countNodes(roles) }} 个角色</span></div>
        <el-empty v-if="!roles?.length" description="暂无角色" :image-size="84" />
        <el-tree v-else class="org-tree" :data="roles" node-key="id" default-expand-all :expand-on-click-node="false" :props="{ label: 'name', children: 'children' }">
          <template #default="{ data }">
            <div class="org-tree-row">
              <div class="org-tree-identity">
                <ShieldCheckIcon class="org-tree-icon role" />
                <span class="org-tree-copy"><strong>{{ data.name }}</strong><small v-if="data.code">{{ data.code }}</small></span>
              </div>
              <div class="org-tree-actions">
                <el-tooltip content="新建下级角色" placement="top"><el-button text circle :icon="PlusIcon" aria-label="新建下级角色" @click.stop="$emit('create-role', data)" /></el-tooltip>
                <el-tooltip content="编辑角色" placement="top"><el-button text circle :icon="PencilIcon" aria-label="编辑角色" @click.stop="$emit('edit-role', data)" /></el-tooltip>
                <el-tooltip :content="data.id === 'r_admin' ? '系统管理员角色不能删除' : '删除角色'" placement="top"><el-button text circle type="danger" :icon="Trash2Icon" :disabled="data.id === 'r_admin'" aria-label="删除角色" @click.stop="$emit('delete-role', data)" /></el-tooltip>
              </div>
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
    <div class="knowledge-layout">
      <section class="section knowledge-sidebar">
        <div class="section-header">
          <h2 class="section-title">知识分类</h2>
          <el-button type="primary" size="small" @click="$emit('create-category', null)">新建一级</el-button>
        </div>
        <div class="knowledge-actions">
          <el-button size="small" :disabled="!selectedCategory" @click="$emit('create-category', selectedCategory)">新建下级</el-button>
          <el-button size="small" :disabled="!selectedCategory" @click="$emit('edit-category', selectedCategory)">编辑</el-button>
          <el-button size="small" type="danger" :disabled="!selectedCategory" @click="$emit('delete-category', selectedCategory)">删除</el-button>
        </div>
        <el-empty v-if="!categories?.length" description="暂无分类" :image-size="84" />
        <el-tree
          v-else
          :data="categories"
          node-key="id"
          highlight-current
          :current-node-key="selectedCategory?.id"
          :expand-on-click-node="false"
          :props="{ label: 'name', children: 'children' }"
          @node-click="$emit('select-category', $event)"
        >
          <template #default="{ data }">
            <span class="knowledge-tree-label" :title="data.fullPath || data.name">{{ data.name }}</span>
          </template>
        </el-tree>
      </section>
      <div class="knowledge-main">
        <section class="section">
          <div class="section-header">
            <div>
              <h2 class="section-title">分类文件</h2>
              <span class="muted">{{ selectedCategory?.fullPath || selectedCategory?.name || '请选择左侧分类' }}</span>
            </div>
          </div>
          <el-empty v-if="!selectedCategory" description="请选择左侧分类" :image-size="88" />
          <el-table v-else :data="categoryFiles" border empty-text="该分类下暂无文件">
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
            <h2 class="section-title">扩展属性</h2>
            <el-button type="primary" size="small" @click="$emit('create-property')">新建属性</el-button>
          </div>
          <el-table :data="properties" border empty-text="暂无扩展属性">
            <el-table-column prop="name" label="属性名称" min-width="160" />
            <el-table-column label="对象" width="100">
              <template #default="{ row }">{{ row.targetType === 'category' ? '分类' : '文件' }}</template>
            </el-table-column>
            <el-table-column label="类型" width="120">
              <template #default="{ row }">
                <span class="property-type">{{ row.dataType }}</span>
              </template>
            </el-table-column>
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
  data: () => ({ unreadOnly: false, typePrefix: '' }),
  computed: {
    visibleMessages() {
      return (this.messages || []).filter((item) => !this.unreadOnly || !item.readAt).filter((item) => !this.typePrefix || String(item.messageType || '').startsWith(this.typePrefix));
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
          <el-select v-model="typePrefix" clearable placeholder="消息类型" style="width: 150px">
            <el-option label="文件更新" value="file" />
            <el-option label="审批" value="approval" />
            <el-option label="复审" value="review" />
            <el-option label="提醒" value="reminder" />
            <el-option label="评论" value="comment" />
          </el-select>
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

export const GovernanceView = {
  props: ['dashboard', 'qualityItems', 'duplicateData', 'reviewItems', 'searchAnalytics', 'users', 'formatDate', 'formatSize', 'loading'],
  emits: ['preview', 'manage', 'refresh', 'change-search-days'],
  data: () => ({
    activeTab: 'overview',
    issueFilter: 'all',
    qualityLevel: 'all',
    reviewStatus: 'all',
    searchDays: 30
  }),
  computed: {
    stats() {
      return this.dashboard?.stats || {};
    },
    qualityDistribution() {
      return this.dashboard?.qualityDistribution || {};
    },
    reviewDistribution() {
      return this.dashboard?.reviewDistribution || {};
    },
    filteredIssues() {
      const rows = this.dashboard?.issues || [];
      if (this.issueFilter === 'all') return rows;
      return rows.filter((item) => (item.issueTypes || []).includes(this.issueFilter));
    },
    filteredQualityItems() {
      if (this.qualityLevel === 'all') return this.qualityItems || [];
      return (this.qualityItems || []).filter((item) => item.quality?.level === this.qualityLevel);
    },
    filteredReviewItems() {
      if (this.reviewStatus === 'all') return this.reviewItems || [];
      return (this.reviewItems || []).filter((item) => item.reviewStatus === this.reviewStatus);
    }
  },
  methods: {
    qualityTag(level) {
      return { excellent: 'success', good: 'primary', fair: 'warning', poor: 'danger' }[level] || 'info';
    },
    reviewTag(status) {
      return { normal: 'success', due_soon: 'warning', overdue: 'danger', not_scheduled: 'info' }[status] || 'info';
    },
    issueLabel(type) {
      return { quality: '质量待完善', review_due_soon: '即将复审', review_overdue: '复审逾期', duplicate: '重复文件' }[type] || type;
    },
    issueTag(type) {
      return { quality: 'warning', review_due_soon: 'warning', review_overdue: 'danger', duplicate: 'info' }[type] || 'info';
    },
    userName(userId) {
      const user = (this.users || []).find((item) => item.id === userId);
      return user?.displayName || user?.username || userId || '-';
    },
    qualityPercent(level) {
      const total = Number(this.stats.files || 0);
      return total ? Math.round((Number(this.qualityDistribution[level] || 0) / total) * 100) : 0;
    },
    reviewPercent(status) {
      const total = Number(this.stats.files || 0);
      return total ? Math.round((Number(this.reviewDistribution[status] || 0) / total) * 100) : 0;
    },
    changeSearchDays(value) {
      this.searchDays = Number(value || 30);
      this.$emit('change-search-days', this.searchDays);
    }
  },
  template: `
    <div class="governance-page">
      <div class="governance-header">
        <div>
          <h2>知识治理</h2>
          <p>文档质量、重复资料、复审任务和搜索运营</p>
        </div>
        <el-button type="primary" :loading="loading" :disabled="loading" @click="$emit('refresh')">刷新数据</el-button>
      </div>
      <div class="governance-metrics">
        <div class="governance-metric"><span>文档总数</span><strong>{{ stats.files || 0 }}</strong><small>当前有效文件</small></div>
        <div class="governance-metric"><span>平均质量分</span><strong>{{ stats.averageQualityScore || 0 }}</strong><small>满分 100</small></div>
        <div class="governance-metric"><span>待完善</span><strong>{{ stats.lowQualityFiles || 0 }}</strong><small>质量分低于 70</small></div>
        <div class="governance-metric"><span>复审逾期</span><strong>{{ stats.overdueReviews || 0 }}</strong><small>需优先处理</small></div>
        <div class="governance-metric"><span>重复组</span><strong>{{ stats.duplicateGroups || 0 }}</strong><small>{{ formatSize(stats.duplicateWastedBytes || 0) }} 可核查</small></div>
        <div class="governance-metric"><span>零结果搜索</span><strong>{{ stats.zeroResultSearches || 0 }}</strong><small>{{ stats.zeroResultRate || 0 }}% 占比</small></div>
      </div>

      <section class="section governance-tabs-section">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="治理概览" name="overview">
            <div class="governance-distribution-grid">
              <div class="governance-distribution">
                <h3>质量分布</h3>
                <div v-for="item in [{ key: 'excellent', label: '优秀' }, { key: 'good', label: '良好' }, { key: 'fair', label: '待完善' }, { key: 'poor', label: '较差' }]" :key="item.key" class="distribution-row">
                  <span>{{ item.label }}</span>
                  <el-progress :percentage="qualityPercent(item.key)" :stroke-width="8" :show-text="false" />
                  <strong>{{ qualityDistribution[item.key] || 0 }}</strong>
                </div>
              </div>
              <div class="governance-distribution">
                <h3>复审状态</h3>
                <div v-for="item in [{ key: 'normal', label: '正常' }, { key: 'due_soon', label: '即将到期' }, { key: 'overdue', label: '已逾期' }, { key: 'not_scheduled', label: '未设置' }]" :key="item.key" class="distribution-row">
                  <span>{{ item.label }}</span>
                  <el-progress :percentage="reviewPercent(item.key)" :stroke-width="8" :show-text="false" />
                  <strong>{{ reviewDistribution[item.key] || 0 }}</strong>
                </div>
              </div>
            </div>
            <div class="section-header governance-table-header">
              <h3 class="section-title">待治理文档</h3>
              <el-select v-model="issueFilter" style="width: 160px">
                <el-option label="全部问题" value="all" />
                <el-option label="质量待完善" value="quality" />
                <el-option label="即将复审" value="review_due_soon" />
                <el-option label="复审逾期" value="review_overdue" />
                <el-option label="重复文件" value="duplicate" />
              </el-select>
            </div>
            <el-table :data="filteredIssues" border height="420" empty-text="当前没有待治理文档">
              <el-table-column prop="name" label="文件" min-width="220" />
              <el-table-column prop="fullPath" label="路径" min-width="280" />
              <el-table-column label="质量" width="120"><template #default="{ row }"><el-tag :type="qualityTag(row.quality?.level)">{{ row.quality?.score }} · {{ row.quality?.levelLabel }}</el-tag></template></el-table-column>
              <el-table-column label="问题" min-width="220"><template #default="{ row }"><div class="governance-tag-list"><el-tag v-for="type in row.issueTypes" :key="type" size="small" :type="issueTag(type)" effect="plain">{{ issueLabel(type) }}</el-tag></div></template></el-table-column>
              <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button size="small" @click="$emit('preview', row)">预览</el-button><el-button size="small" type="primary" @click="$emit('manage', row)">治理</el-button></template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="质量清单" name="quality" lazy>
            <div class="governance-filter-row">
              <el-select v-model="qualityLevel" style="width: 160px">
                <el-option label="全部等级" value="all" />
                <el-option label="优秀" value="excellent" />
                <el-option label="良好" value="good" />
                <el-option label="待完善" value="fair" />
                <el-option label="较差" value="poor" />
              </el-select>
              <span>按质量分从低到高排列，优先处理表格顶部资料</span>
            </div>
            <el-table :data="filteredQualityItems" border height="520" empty-text="暂无文档">
              <el-table-column prop="name" label="文件" min-width="220" />
              <el-table-column prop="fullPath" label="路径" min-width="280" />
              <el-table-column label="质量分" width="150"><template #default="{ row }"><div class="quality-score-cell"><strong>{{ row.quality?.score }}</strong><el-progress :percentage="row.quality?.score || 0" :stroke-width="7" :show-text="false" /></div></template></el-table-column>
              <el-table-column label="等级" width="110"><template #default="{ row }"><el-tag :type="qualityTag(row.quality?.level)">{{ row.quality?.levelLabel }}</el-tag></template></el-table-column>
              <el-table-column label="首要建议" min-width="260"><template #default="{ row }">{{ row.quality?.suggestions?.[0]?.suggestion || '暂无改进项' }}</template></el-table-column>
              <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button size="small" @click="$emit('preview', row)">预览</el-button><el-button size="small" type="primary" @click="$emit('manage', row)">详情</el-button></template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="重复文件" name="duplicates" lazy>
            <div class="duplicate-summary-row">
              <span>重复组 <strong>{{ duplicateData?.summary?.groupCount || 0 }}</strong></span>
              <span>涉及文件 <strong>{{ duplicateData?.summary?.fileCount || 0 }}</strong></span>
              <span>可核查空间 <strong>{{ formatSize(duplicateData?.summary?.wastedBytes || 0) }}</strong></span>
            </div>
            <el-empty v-if="!duplicateData?.groups?.length" description="当前未发现重复文件" />
            <el-collapse v-else class="duplicate-collapse">
              <el-collapse-item v-for="group in duplicateData.groups" :key="group.id" :name="group.id">
                <template #title><div class="duplicate-group-title"><el-tag :type="group.type === 'exact' ? 'danger' : 'warning'" effect="plain">{{ group.typeLabel }}</el-tag><strong>{{ group.fileCount }} 个文件</strong><span>置信度 {{ group.confidence }}%</span><span>约 {{ formatSize(group.wastedBytes) }}</span></div></template>
                <el-table :data="group.files" border>
                  <el-table-column prop="name" label="文件" min-width="220" />
                  <el-table-column prop="fullPath" label="路径" min-width="300" />
                  <el-table-column label="大小" width="100"><template #default="{ row }">{{ formatSize(row.duplicateVersion?.sizeBytes || 0) }}</template></el-table-column>
                  <el-table-column label="更新时间" width="170"><template #default="{ row }">{{ formatDate(row.updatedAt) }}</template></el-table-column>
                  <el-table-column label="操作" width="150"><template #default="{ row }"><el-button size="small" @click="$emit('preview', row)">预览</el-button><el-button size="small" @click="$emit('manage', row)">详情</el-button></template></el-table-column>
                </el-table>
              </el-collapse-item>
            </el-collapse>
          </el-tab-pane>

          <el-tab-pane label="复审任务" name="reviews" lazy>
            <div class="governance-filter-row">
              <el-select v-model="reviewStatus" style="width: 160px">
                <el-option label="全部状态" value="all" />
                <el-option label="已逾期" value="overdue" />
                <el-option label="即将到期" value="due_soon" />
                <el-option label="正常" value="normal" />
                <el-option label="未设置" value="not_scheduled" />
              </el-select>
              <span>逾期任务会优先显示</span>
            </div>
            <el-table :data="filteredReviewItems" border height="520" empty-text="暂无复审任务">
              <el-table-column prop="name" label="文件" min-width="220" />
              <el-table-column prop="fullPath" label="路径" min-width="280" />
              <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="reviewTag(row.reviewStatus)">{{ row.reviewStatusLabel }}</el-tag></template></el-table-column>
              <el-table-column label="负责人" width="130"><template #default="{ row }">{{ userName(row.review?.ownerId) }}</template></el-table-column>
              <el-table-column label="下次复审" width="180"><template #default="{ row }">{{ formatDate(row.review?.nextReviewAt) }}</template></el-table-column>
              <el-table-column label="周期" width="100"><template #default="{ row }">{{ row.review?.enabled ? row.review?.cycleDays + ' 天' : '-' }}</template></el-table-column>
              <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button size="small" @click="$emit('preview', row)">预览</el-button><el-button size="small" type="primary" @click="$emit('manage', row)">处理</el-button></template></el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="搜索运营" name="search" lazy>
            <div class="governance-filter-row">
              <el-radio-group v-model="searchDays" size="small" @change="changeSearchDays">
                <el-radio-button :value="7">近 7 天</el-radio-button>
                <el-radio-button :value="30">近 30 天</el-radio-button>
                <el-radio-button :value="90">近 90 天</el-radio-button>
              </el-radio-group>
              <span>搜索 {{ searchAnalytics?.stats?.totalSearches || 0 }} 次，零结果率 {{ searchAnalytics?.stats?.zeroResultRate || 0 }}%</span>
            </div>
            <div class="search-analytics-grid">
              <div>
                <h3>搜索热词</h3>
                <el-table :data="searchAnalytics?.popularKeywords || []" border height="360" empty-text="产生搜索记录后将在这里展示">
                  <el-table-column prop="keyword" label="关键词" min-width="180" />
                  <el-table-column prop="count" label="次数" width="90" />
                  <el-table-column prop="averageResults" label="平均结果" width="100" />
                </el-table>
              </div>
              <div>
                <h3>零结果关键词</h3>
                <el-table :data="searchAnalytics?.zeroResultKeywords || []" border height="360" empty-text="当前没有零结果搜索">
                  <el-table-column prop="keyword" label="关键词" min-width="180" />
                  <el-table-column prop="zeroResultCount" label="零结果次数" width="110" />
                  <el-table-column prop="count" label="总搜索" width="90" />
                </el-table>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </section>
    </div>
  `
};

export const SystemManagementView = {
  props: ['dashboard', 'auditLogs', 'filePolicy', 'externalLibrary', 'storageSettings', 'securityPolicy', 'wecomSettings', 'officePreviewSettings', 'searchIndexStatus', 'runtimeStatus', 'consistencyReport', 'backupJobs', 'systemAlerts', 'notificationDeliveries', 'auditReport', 'formatDate'],
  emits: ['edit-file-policy', 'edit-external-library', 'edit-storage', 'sync-storage', 'export-audit', 'edit-security-policy', 'edit-office-preview', 'test-office-preview', 'rebuild-search-index', 'edit-wecom', 'test-wecom', 'check-consistency', 'create-backup', 'drill-backup', 'resolve-alert', 'retry-notification'],
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
    },
    officePreviewStatusType() {
      if (!this.officePreviewSettings?.enabled) return 'info';
      return this.officePreviewSettings?.lastTestResult?.ok ? 'success' : 'warning';
    },
    officePreviewStatusText() {
      if (!this.officePreviewSettings?.enabled) return '未启用';
      return this.officePreviewSettings?.lastTestResult?.ok ? '可用' : '待联调';
    },
    searchIndexCounts() {
      return this.searchIndexStatus?.counts || {};
    }
  },
  methods: {
    formatBytes(value) {
      const bytes = Number(value || 0);
      if (!bytes) return '-';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
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
            <el-button @click="$emit('edit-security-policy')">安全策略</el-button>
            <el-button type="primary" @click="$emit('edit-external-library')">同步目录</el-button>
          </div>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="允许扩展名">{{ (filePolicy?.allowedExtensions || []).join('、') || '-' }}</el-descriptions-item>
          <el-descriptions-item label="单文件大小">{{ filePolicy?.maxSizeMb || '-' }} MB</el-descriptions-item>
          <el-descriptions-item label="预览水印">{{ securityPolicy?.enablePreviewWatermark ? '启用' : '关闭' }}</el-descriptions-item>
          <el-descriptions-item label="敏感文件下载">{{ securityPolicy?.blockSensitiveDownload ? '限制下载' : '允许下载' }}</el-descriptions-item>
          <el-descriptions-item label="同步根目录">{{ externalLibrary?.rootPath || '-' }}</el-descriptions-item>
          <el-descriptions-item label="同步状态">{{ externalStatus }}</el-descriptions-item>
          <el-descriptions-item label="只同步目录">{{ (externalLibrary?.includePaths || []).join('、') || '全部' }}</el-descriptions-item>
          <el-descriptions-item label="排除规则">{{ (externalLibrary?.excludePatterns || []).join('、') || '-' }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">Office 原版预览</h2>
          <div class="toolbar compact-toolbar">
            <el-button @click="$emit('edit-office-preview')">配置</el-button>
            <el-button type="primary" :disabled="!officePreviewSettings?.enabled" @click="$emit('test-office-preview')">测试配置</el-button>
          </div>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="启用状态">
            <el-tag :type="officePreviewStatusType" effect="light">{{ officePreviewStatusText }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="服务类型">{{ officePreviewSettings?.provider === 'onlyoffice' ? 'ONLYOFFICE Docs' : '-' }}</el-descriptions-item>
          <el-descriptions-item label="Document Server">{{ officePreviewSettings?.documentServerUrl || '-' }}</el-descriptions-item>
          <el-descriptions-item label="平台外部地址">{{ officePreviewSettings?.publicBaseUrl || '自动使用当前访问地址' }}</el-descriptions-item>
          <el-descriptions-item label="JWT Secret">{{ officePreviewSettings?.hasJwtSecret ? '已保存' : '-' }}</el-descriptions-item>
          <el-descriptions-item label="最后测试">{{ formatDate(officePreviewSettings?.lastTestAt) }}</el-descriptions-item>
          <el-descriptions-item label="测试结果" :span="2">{{ officePreviewSettings?.lastTestResult?.message || '-' }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">全文检索索引</h2>
          <div class="toolbar compact-toolbar">
            <el-button type="primary" @click="$emit('rebuild-search-index')">重建索引</el-button>
          </div>
        </div>
        <div class="storage-status-row search-index-row">
          <div class="storage-status-item"><span>当前文件</span><strong>{{ searchIndexStatus?.total || 0 }}</strong></div>
          <div class="storage-status-item"><span>已索引</span><strong>{{ searchIndexCounts.ready || 0 }}</strong></div>
          <div class="storage-status-item"><span>空内容</span><strong>{{ searchIndexCounts.empty || 0 }}</strong></div>
          <div class="storage-status-item"><span>异常</span><strong>{{ searchIndexCounts.failed || 0 }}</strong></div>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="暂不支持">{{ searchIndexCounts.unsupported || 0 }}</el-descriptions-item>
          <el-descriptions-item label="待处理">{{ searchIndexCounts.pending || 0 }}</el-descriptions-item>
          <el-descriptions-item label="索引字符数">{{ searchIndexStatus?.indexedChars || 0 }}</el-descriptions-item>
          <el-descriptions-item label="最近索引">{{ formatDate(searchIndexStatus?.lastIndexedAt) }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">企业微信集成</h2>
          <div class="toolbar compact-toolbar">
            <el-button @click="$emit('edit-wecom')">配置</el-button>
            <el-button type="primary" @click="$emit('test-wecom')">测试配置</el-button>
          </div>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="启用状态">{{ wecomSettings?.enabled ? '启用' : '关闭' }}</el-descriptions-item>
          <el-descriptions-item label="CorpID">{{ wecomSettings?.corpId || '-' }}</el-descriptions-item>
          <el-descriptions-item label="AgentID">{{ wecomSettings?.agentId || '-' }}</el-descriptions-item>
          <el-descriptions-item label="Secret">{{ wecomSettings?.hasSecret ? '已保存' : '-' }}</el-descriptions-item>
          <el-descriptions-item label="组织同步">{{ wecomSettings?.syncDepartments || wecomSettings?.syncUsers ? '已配置' : '关闭' }}</el-descriptions-item>
          <el-descriptions-item label="消息推送">{{ wecomSettings?.pushMessages ? '启用' : '关闭' }}</el-descriptions-item>
          <el-descriptions-item label="最后测试">{{ formatDate(wecomSettings?.lastTestAt) }}</el-descriptions-item>
          <el-descriptions-item label="测试结果">{{ wecomSettings?.lastTestResult?.message || '-' }}</el-descriptions-item>
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
          <h2 class="section-title">运行与备份状态</h2>
          <div class="toolbar compact-toolbar">
            <el-button @click="$emit('check-consistency')">一致性检查</el-button>
            <el-button type="primary" @click="$emit('create-backup')">创建备份</el-button>
          </div>
        </div>
        <div class="storage-status-row">
          <div class="storage-status-item">
            <span>服务状态</span>
            <strong><el-tag type="success">{{ runtimeStatus?.status || '-' }}</el-tag></strong>
          </div>
          <div class="storage-status-item">
            <span>运行时长</span>
            <strong>{{ runtimeStatus?.uptimeSeconds || 0 }} 秒</strong>
          </div>
          <div class="storage-status-item">
            <span>待审批</span>
            <strong>{{ runtimeStatus?.counts?.pendingApprovals || 0 }}</strong>
          </div>
          <div class="storage-status-item">
            <span>审计日志</span>
            <strong>{{ runtimeStatus?.counts?.auditLogs || 0 }}</strong>
          </div>
          <div class="storage-status-item">
            <span>开放告警</span>
            <strong>{{ runtimeStatus?.counts?.openAlerts || systemAlerts?.length || 0 }}</strong>
          </div>
          <div class="storage-status-item">
            <span>通知失败</span>
            <strong>{{ runtimeStatus?.counts?.failedNotifications || notificationDeliveries?.length || 0 }}</strong>
          </div>
        </div>
        <el-descriptions :column="3" border style="margin-bottom: 12px">
          <el-descriptions-item label="后端服务"><el-tag :type="runtimeStatus?.health?.backend?.status === 'up' ? 'success' : 'danger'">{{ runtimeStatus?.health?.backend?.message || '-' }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="MySQL"><el-tag :type="runtimeStatus?.health?.mysql?.status === 'up' ? 'success' : (runtimeStatus?.health?.mysql?.status === 'disabled' ? 'info' : 'danger')">{{ runtimeStatus?.health?.mysql?.message || '-' }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="ONLYOFFICE"><el-tag :type="runtimeStatus?.health?.onlyoffice?.status === 'up' ? 'success' : (runtimeStatus?.health?.onlyoffice?.status === 'disabled' ? 'info' : 'danger')">{{ runtimeStatus?.health?.onlyoffice?.message || '-' }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="磁盘使用率"><el-tag :type="runtimeStatus?.disk?.warning ? 'danger' : 'success'">{{ runtimeStatus?.disk?.usedPercent ?? '-' }}%</el-tag></el-descriptions-item>
          <el-descriptions-item label="磁盘可用">{{ formatBytes(runtimeStatus?.disk?.freeBytes) }}</el-descriptions-item>
          <el-descriptions-item label="告警阈值">{{ runtimeStatus?.disk?.warningPercent || 85 }}%</el-descriptions-item>
        </el-descriptions>
        <el-alert v-if="consistencyReport" :type="consistencyReport.healthy ? 'success' : 'error'" :closable="false" show-icon :title="consistencyReport.healthy ? '数据与文件一致' : '一致性检查发现异常'" :description="'错误 ' + consistencyReport.counts.errors + '，警告 ' + consistencyReport.counts.warnings" />
        <el-table class="compact-data-table" :data="runtimeStatus?.backupItems || []" border>
          <el-table-column prop="name" label="备份对象" width="150" />
          <el-table-column prop="path" label="路径" min-width="320" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }"><el-tag :type="row.exists ? 'success' : 'danger'">{{ row.exists ? '存在' : '缺失' }}</el-tag></template>
          </el-table-column>
        </el-table>
        <h3>备份历史</h3>
        <el-table class="compact-data-table" :data="backupJobs || []" border>
          <el-table-column prop="filename" label="备份文件" min-width="280" />
          <el-table-column prop="status" label="状态" width="100" />
          <el-table-column label="创建时间" width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
          <el-table-column label="演练" width="110"><template #default="{ row }">{{ row.drill ? (row.drill.valid ? '通过' : '异常') : '未执行' }}</template></el-table-column>
          <el-table-column label="操作" width="120"><template #default="{ row }"><el-button size="small" :disabled="row.status !== 'completed'" @click="$emit('drill-backup', row)">恢复演练</el-button></template></el-table-column>
        </el-table>
      </section>
      <section class="section">
        <div class="section-header"><h2 class="section-title">系统告警与通知失败</h2></div>
        <el-table class="compact-data-table" :data="systemAlerts || []" border empty-text="当前没有开放告警">
          <el-table-column prop="severity" label="级别" width="100" />
          <el-table-column prop="title" label="告警" min-width="180" />
          <el-table-column prop="detail" label="详情" min-width="280" />
          <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatDate(row.updatedAt) }}</template></el-table-column>
          <el-table-column label="操作" width="100"><template #default="{ row }"><el-button size="small" type="primary" @click="$emit('resolve-alert', row)">处理</el-button></template></el-table-column>
        </el-table>
        <el-table class="compact-data-table" :data="notificationDeliveries || []" border empty-text="当前没有通知失败" style="margin-top: 12px">
          <el-table-column prop="channel" label="渠道" width="100" />
          <el-table-column prop="title" label="消息" min-width="180" />
          <el-table-column prop="lastError" label="失败原因" min-width="260" />
          <el-table-column prop="attempts" label="次数" width="80" />
          <el-table-column label="操作" width="100"><template #default="{ row }"><el-button size="small" @click="$emit('retry-notification', row)">重试</el-button></template></el-table-column>
        </el-table>
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">审计概览</h2>
        </div>
        <div class="stats-grid">
          <div class="stat-tile"><span>日志总数</span><strong>{{ auditReport?.total || 0 }}</strong></div>
          <div class="stat-tile"><span>敏感访问</span><strong>{{ auditReport?.sensitiveAccesses || 0 }}</strong></div>
          <div class="stat-tile"><span>下载拦截</span><strong>{{ auditReport?.blockedDownloads || 0 }}</strong></div>
          <div class="stat-tile"><span>动作类型</span><strong>{{ auditReport?.topActions?.length || 0 }}</strong></div>
        </div>
        <el-table class="compact-data-table" :data="auditReport?.topActions || []" border>
          <el-table-column prop="name" label="高频动作" min-width="220" />
          <el-table-column prop="count" label="次数" width="100" />
        </el-table>
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
