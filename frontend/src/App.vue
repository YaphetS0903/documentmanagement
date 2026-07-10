<template>
  <div v-if="!token || !user" class="login-shell">
    <section class="login-panel" aria-label="登录">
      <h1 class="login-title">文档管理平台</h1>
      <p class="login-subtitle">B/S 架构三期开发版</p>
      <el-form label-position="top" @submit.prevent="login">
        <el-form-item label="账号">
          <el-input v-model="loginForm.username" size="large" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="loginForm.password" size="large" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-form-item label="验证码">
          <div class="captcha-row">
            <el-input v-model="loginForm.captchaAnswer" size="large" autocomplete="off" @keyup.enter="login" />
            <el-button @click="loadCaptcha">{{ captcha?.question || '刷新' }}</el-button>
          </div>
        </el-form-item>
        <el-button type="primary" size="large" :loading="loading" style="width: 100%" @click="login">登录</el-button>
      </el-form>
      <p class="muted" style="margin-bottom: 0">默认账号：admin/admin123，demo/user123</p>
    </section>
  </div>

  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">文</div>
        <div class="brand-copy">
          <strong>文档管理平台</strong>
          <span>Phase 3</span>
        </div>
        <el-button
          class="sidebar-toggle"
          :icon="sidebarCollapsed ? PanelLeftOpen : PanelLeftClose"
          circle
          :aria-label="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="sidebarCollapsed = !sidebarCollapsed"
        />
      </div>
      <nav class="nav-list" aria-label="主导航">
        <button v-for="item in visibleNavItems" :key="item.key" class="nav-button" :title="item.label" :class="{ active: activeView === item.key }" @click="switchView(item.key)">
          <component :is="item.icon" />
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <div>{{ user.displayName }}</div>
        <div>{{ roleNames }}</div>
      </div>
    </aside>

    <main class="main">
      <div class="mobile-nav">
        <button v-for="item in visibleNavItems" :key="item.key" class="nav-button" :class="{ active: activeView === item.key }" @click="switchView(item.key)">
          <component :is="item.icon" />
          {{ item.label }}
        </button>
      </div>
      <header class="topbar">
        <h1>{{ currentTitle }}</h1>
        <div class="topbar-actions">
          <el-tag type="info">{{ user.username }}</el-tag>
          <el-button :icon="RefreshCw" circle aria-label="刷新" @click="refreshCurrent" />
          <el-button :icon="LogOut" circle aria-label="退出登录" @click="logout" />
        </div>
      </header>
      <div class="content">
        <DashboardViewPanel v-if="activeView === 'dashboard'" :dashboard="dashboard" :format-date="formatDate" @open-docs="switchView('docs')" />
        <DocsViewPanel
          v-if="activeView === 'docs'"
          :tree="docTree"
          :children="docChildren"
          :selected-folder="selectedFolder"
          :users="users"
          :departments="flatDepartments"
          :roles="flatRoles"
          :format-date="formatDate"
          :format-size="formatSize"
          :actions="actions"
          :is-admin="isAdminUser"
          :enable-sync="true"
          :recent-accesses="recentAccesses"
          storage-scope="docs"
          :suggest-search="suggestSearchFiles"
          @select-folder="selectFolder"
          @create-folder="openFolderDialog"
          @upload="openUploadDialog"
          @rename="renameNode"
          @delete="deleteNode"
          @download="downloadNode"
          @preview="previewNode"
          @versions="openVersionDialog"
          @lock="lockNode"
          @unlock="unlockNode"
          @favorite="favoriteNode"
          @permissions="openPermissionDialog"
          @view-access="openViewAccessDialog"
          @node-password="openNodePasswordDialog"
          @sync-external="openExternalLibraryDialog"
          @search="searchFiles"
          @batch-download="batchDownload"
          @batch-move="openBatchMoveDialog"
          @batch-delete="batchDelete"
          @batch-metadata="openBatchMetadataDialog"
          @move="openMoveDialog"
          @copy="openMoveDialog"
          @copy-enterprise="openCopyToEnterpriseDialog"
          @share="openShareDialog"
          @subscribe="subscribeNode"
          @reminder="openReminderDialog"
          @metadata="openMetadataDialog"
          @links="openLinkDialog"
          @workflow="openWorkflowDialog"
          @security="openSecurityDialog"
          @request-download="openDownloadApprovalDialog"
          @governance="openGovernanceDialog"
        />
        <DocsViewPanel
          v-if="activeView === 'drive'"
          :tree="driveTree"
          :children="driveChildren"
          :selected-folder="selectedDriveFolder"
          :users="users"
          :departments="flatDepartments"
          :roles="flatRoles"
          :format-date="formatDate"
          :format-size="formatSize"
          :actions="actions"
          :space-summary="driveSummary"
          :is-admin="false"
          :enable-sync="false"
          :recent-accesses="recentAccesses"
          storage-scope="drive"
          :suggest-search="suggestSearchDriveFiles"
          @select-folder="selectDriveFolder"
          @create-folder="openFolderDialog"
          @upload="openUploadDialog"
          @rename="renameNode"
          @delete="deleteNode"
          @download="downloadNode"
          @preview="previewNode"
          @versions="openVersionDialog"
          @lock="lockNode"
          @unlock="unlockNode"
          @favorite="favoriteNode"
          @permissions="openPermissionDialog"
          @view-access="openViewAccessDialog"
          @node-password="openNodePasswordDialog"
          @search="searchDriveFiles"
          @batch-download="batchDownload"
          @batch-move="openBatchMoveDialog"
          @batch-delete="batchDelete"
          @batch-metadata="openBatchMetadataDialog"
          @move="openMoveDialog"
          @copy="openMoveDialog"
          @copy-enterprise="openCopyToEnterpriseDialog"
          @share="openShareDialog"
          @subscribe="subscribeNode"
          @reminder="openReminderDialog"
          @metadata="openMetadataDialog"
          @links="openLinkDialog"
          @workflow="openWorkflowDialog"
          @security="openSecurityDialog"
          @request-download="openDownloadApprovalDialog"
          @governance="openGovernanceDialog"
        />
        <UsersViewPanel v-if="activeView === 'users'" :users="users" :departments="flatDepartments" :roles="flatRoles" @create="openUserDialog" @edit="openUserDialog" @reset="resetPassword" />
        <OrgViewPanel
          v-if="activeView === 'org'"
          :departments="departmentTree"
          :roles="roleTree"
          @create-department="openDepartmentDialog"
          @edit-department="openDepartmentDialog"
          @delete-department="deleteDepartment"
          @create-role="openRoleDialog"
          @edit-role="openRoleDialog"
          @delete-role="deleteRole"
        />
        <KnowledgeViewPanel
          v-if="activeView === 'knowledge'"
          :categories="categoryTree"
          :properties="propertyDefinitions"
          :category-files="categoryFiles"
          :selected-category="selectedCategory"
          :format-date="formatDate"
          :format-size="formatSize"
          @create-category="openCategoryDialog"
          @edit-category="openCategoryDialog"
          @delete-category="deleteCategory"
          @select-category="selectCategory"
          @preview-file="previewNode"
          @metadata-file="openMetadataDialog"
          @create-property="openPropertyDialog"
          @edit-property="openPropertyDialog"
          @delete-property="deletePropertyDefinition"
        />
        <TrashViewPanel v-if="activeView === 'trash'" :items="trashItems" :format-date="formatDate" @restore="restoreTrash" @destroy="destroyTrash" />
        <MessagesViewPanel v-if="activeView === 'messages'" :messages="messages" :format-date="formatDate" @open="openMessageDialog" @read="readMessage" @read-all="readAllMessages" />
        <CollaborationViewPanel
          v-if="activeView === 'collaboration'"
          :shares="shares"
          :subscriptions="subscriptions"
          :reminders="reminders"
          :format-date="formatDate"
          @revoke-share="revokeShare"
          @cancel-subscription="cancelSubscription"
          @edit-reminder="openReminderDialog"
          @cancel-reminder="cancelReminder"
        />
        <ApprovalCenterViewPanel
          v-if="activeView === 'approvals'"
          :todo="approvalTodo"
          :mine="approvalMine"
          :all="approvalAll"
          :format-date="formatDate"
          @approve="decideGeneralApproval($event, 'approve')"
          @reject="decideGeneralApproval($event, 'reject')"
          @refresh="loadApprovals"
        />
        <ProfileViewPanel
          v-if="activeView === 'profile'"
          :user="user"
          :departments="flatDepartments"
          :roles="flatRoles"
          @change-password="openPasswordDialog"
        />
        <AnnouncementsViewPanel
          v-if="activeView === 'announcements'"
          :announcements="announcements"
          :format-date="formatDate"
          :format-size="formatSize"
          @create="openAnnouncementDialog"
          @edit="openAnnouncementDialog"
          @publish="publishAnnouncement"
          @revoke="revokeAnnouncement"
          @delete="deleteAnnouncement"
          @download="downloadAnnouncementAttachment"
        />
        <ApiManagementViewPanel
          v-if="activeView === 'api'"
          :credentials="apiCredentials"
          :call-logs="apiCallLogs"
          :users="users"
          :file-policy="filePolicy"
          :format-date="formatDate"
          @create="openCredentialDialog"
          @edit="openCredentialDialog"
          @rotate="rotateCredentialSecret"
          @disable="disableCredential"
          @edit-file-policy="openFilePolicyDialog"
        />
        <GovernanceViewPanel
          v-if="activeView === 'governance'"
          :dashboard="governanceDashboard"
          :quality-items="governanceQualityItems"
          :duplicate-data="governanceDuplicateData"
          :review-items="governanceReviewItems"
          :search-analytics="governanceSearchAnalytics"
          :users="users"
          :format-date="formatDate"
          :format-size="formatSize"
          @preview="previewNode"
          @manage="openGovernanceDialog"
          @refresh="loadGovernance"
          @change-search-days="loadGovernanceSearchAnalytics"
        />
        <SystemManagementViewPanel
          v-if="activeView === 'system'"
          :dashboard="dashboard"
          :audit-logs="auditLogs"
          :file-policy="filePolicy"
          :external-library="externalLibrary"
          :storage-settings="storageSettings"
          :security-policy="securityPolicy"
          :wecom-settings="wecomSettings"
          :office-preview-settings="officePreviewSettings"
          :search-index-status="searchIndexStatus"
          :runtime-status="runtimeStatus"
          :audit-report="auditReport"
          :format-date="formatDate"
          @edit-file-policy="openFilePolicyDialog"
          @edit-external-library="openExternalLibraryDialog"
          @edit-storage="openStorageDialog"
          @sync-storage="syncStorageToMysql"
          @edit-security-policy="openSecurityPolicyDialog"
          @edit-office-preview="openOfficePreviewDialog"
          @test-office-preview="testOfficePreviewSettings"
          @rebuild-search-index="rebuildSearchIndex"
          @edit-wecom="openWecomDialog"
          @test-wecom="testWecomSettings"
          @export-audit="exportAuditLogs"
        />
        <AuditViewPanel v-if="activeView === 'audit'" :logs="auditLogs" :format-date="formatDate" @export="exportAuditLogs" />
      </div>
    </main>

    <el-dialog v-model="folderDialog.visible" title="新建文件夹" width="420px">
      <el-form label-position="top">
        <el-form-item label="上级目录">
          <el-input :model-value="activeFolder?.fullPath || '/'" disabled />
        </el-form-item>
        <el-form-item label="文件夹名称">
          <el-input v-model="folderDialog.name" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="folderDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="createFolder">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="uploadDialog.visible" title="上传文件" width="520px">
      <el-form label-position="top">
        <el-form-item label="目标目录">
          <el-input :model-value="activeFolder?.fullPath || '/'" disabled />
        </el-form-item>
        <el-form-item label="版本说明">
          <el-input v-model="uploadDialog.description" />
        </el-form-item>
        <el-upload drag multiple :auto-upload="false" :on-change="onUploadFileChange" :on-remove="onUploadFileRemove">
          <UploadCloud class="toolbar-icon" />
          <div>拖拽文件到这里，或点击选择文件</div>
        </el-upload>
      </el-form>
      <template #footer>
        <el-button @click="uploadDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="uploadFile">上传</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="moveDialog.visible" :title="moveDialog.mode === 'copy' || moveDialog.mode === 'copy-enterprise' ? '复制到' : moveDialog.mode === 'batch-move' ? '批量移动到' : '移动到'" width="520px">
      <el-form label-position="top">
        <el-form-item label="当前对象">
          <el-input :model-value="moveDialog.mode === 'batch-move' ? `${moveDialog.nodes.length} 个项目` : (moveDialog.node?.fullPath || moveDialog.node?.name)" disabled />
        </el-form-item>
        <el-form-item label="目标目录">
          <el-tree
            :data="moveDialog.space === 'drive' ? driveTree : docTree"
            node-key="id"
            default-expand-all
            highlight-current
            :props="{ label: 'name', children: 'children' }"
            @node-click="moveDialog.targetId = $event.id"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="moveDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="executeMoveCopy">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="versionDialog.visible" title="版本管理" width="760px">
      <el-table :data="versionDialog.items" border>
        <el-table-column prop="versionNo" label="版本" width="80" />
        <el-table-column prop="description" label="说明" min-width="180" />
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ formatSize(row.sizeBytes) }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="FileText" @click="previewNode(versionDialog.node, row.id)">预览</el-button>
            <el-button size="small" :icon="Download" @click="downloadNode(versionDialog.node, row.id)">下载</el-button>
            <el-button size="small" :icon="RotateCcw" @click="rollbackVersion(row)">回滚</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-divider />
      <div class="section-header">
        <h2 class="section-title">版本变更记录</h2>
      </div>
      <el-table :data="versionDialog.logs" border>
        <el-table-column label="动作" width="120">
          <template #default="{ row }">{{ versionActionLabel(row.action) }}</template>
        </el-table-column>
        <el-table-column label="版本" width="90">
          <template #default="{ row }">{{ row.toVersionNo || row.versionNo || '-' }}</template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="180" />
        <el-table-column label="操作者" width="130">
          <template #default="{ row }">{{ row.actorName || userName(row.actorId) }}</template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
      <el-divider />
      <el-upload :auto-upload="false" :limit="1" :on-change="onVersionFileChange" :on-remove="onVersionFileRemove">
        <el-button :icon="UploadCloud">上传新版本</el-button>
      </el-upload>
      <el-input v-model="versionDialog.description" placeholder="新版本说明" style="margin-top: 10px" />
      <template #footer>
        <el-button @click="versionDialog.visible = false">关闭</el-button>
        <el-button type="primary" :loading="loading" @click="uploadVersion">保存新版本</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="workflowDialog.visible" title="文档流程" width="880px" class="tall-dialog">
      <div class="workflow-summary">
        <div>
          <span>当前对象</span>
          <strong>{{ workflowDialog.node?.fullPath || workflowDialog.node?.name }}</strong>
        </div>
        <div>
          <span>当前状态</span>
          <strong>{{ businessStatusLabel(workflowDialog.node?.businessStatus) }}</strong>
        </div>
      </div>
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="流程动作">
            <el-segmented v-model="workflowDialog.action" :options="workflowActionOptions" />
          </el-form-item>
          <el-form-item label="审批人">
            <el-select v-model="workflowDialog.approverId" filterable style="width: 100%">
              <el-option v-for="item in users" :key="item.id" :label="item.displayName || item.username" :value="item.id" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="处理说明">
          <el-input v-model="workflowDialog.comment" type="textarea" :rows="3" placeholder="填写发布说明、作废原因或归档说明" />
        </el-form-item>
      </el-form>
      <div class="toolbar">
        <el-button type="primary" :icon="ClipboardCheck" @click="submitWorkflowApproval">提交审批</el-button>
        <el-button :icon="CheckCircle2" @click="executeWorkflowAction">直接执行</el-button>
      </div>
      <el-divider />
      <div class="section-header">
        <h2 class="section-title">审批记录</h2>
      </div>
      <el-table :data="workflowDialog.approvals" border>
        <el-table-column prop="actionLabel" label="动作" width="100" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag :type="approvalStatusTag(row.status)">{{ approvalStatusLabel(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="requesterName" label="申请人" width="120" />
        <el-table-column prop="approverName" label="审批人" width="120" />
        <el-table-column prop="requestComment" label="申请说明" min-width="180" />
        <el-table-column prop="decisionComment" label="处理说明" min-width="160" />
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.canDecide" size="small" type="primary" @click="decideWorkflowApproval(row, 'approve')">通过</el-button>
            <el-button v-if="row.canDecide" size="small" type="danger" @click="decideWorkflowApproval(row, 'reject')">驳回</el-button>
            <span v-if="!row.canDecide" class="muted">-</span>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="permissionDialog.visible" title="权限管理" width="980px" class="tall-dialog">
      <el-table :data="permissionDialog.rules" border>
        <el-table-column label="授权对象" min-width="180">
          <template #default="{ row }">{{ subjectLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="权限" min-width="240">
          <template #default="{ row }">{{ row.actions.join('、') }}</template>
        </el-table-column>
        <el-table-column label="条件" min-width="220">
          <template #default="{ row }">{{ conditionLabel(row.condition) }}</template>
        </el-table-column>
        <el-table-column prop="effect" label="效果" width="90" />
        <el-table-column prop="priority" label="优先级" width="90" />
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button size="small" @click="editPermission(row)">编辑</el-button>
            <el-button size="small" type="danger" :icon="Trash2" @click="deletePermission(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-divider />
      <div class="permission-panel">
        <div class="section-header">
          <h2 class="section-title">权限模板</h2>
          <div class="permission-panel-actions">
            <el-button v-if="isAdminUser" :icon="Plus" @click="saveCurrentPermissionTemplate">保存当前为模板</el-button>
            <el-button
              v-if="isAdminUser"
              :icon="Trash2"
              :disabled="!selectedPermissionTemplate || selectedPermissionTemplate.systemBuiltIn"
              @click="deleteSelectedPermissionTemplate"
            >
              删除模板
            </el-button>
          </div>
        </div>
        <div class="form-grid">
          <el-form-item label="模板">
            <el-select v-model="permissionDialog.templateId" clearable filterable style="width: 100%">
              <el-option v-for="item in permissionTemplates" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="批量对象类型">
            <el-segmented v-model="permissionDialog.batch.subjectType" :options="subjectTypes" @change="onBatchSubjectTypeChange" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item v-if="permissionDialog.batch.subjectType !== 'all'" label="批量对象">
            <el-select v-model="permissionDialog.batch.subjectIds" multiple filterable collapse-tags collapse-tags-tooltip style="width: 100%">
              <el-option v-for="item in batchSubjectOptions" :key="item.id" :label="item.name || item.displayName" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="覆盖同对象旧规则">
            <el-switch v-model="permissionDialog.batch.replaceExisting" />
          </el-form-item>
        </div>
        <div class="toolbar permission-template-toolbar">
          <el-button :icon="RefreshCw" @click="applySelectedPermissionTemplate">套用到表单</el-button>
          <el-button type="primary" :icon="Shield" @click="batchApplyPermission">批量授权</el-button>
        </div>
      </div>
      <el-divider />
      <div class="section-header">
        <h2 class="section-title">单条规则</h2>
      </div>
      <el-form label-position="top">
        <el-form-item label="授权类型">
          <el-segmented v-model="permissionDialog.form.subjectType" :options="subjectTypes" />
        </el-form-item>
        <el-form-item label="授权对象" v-if="permissionDialog.form.subjectType !== 'all'">
          <el-select v-model="permissionDialog.form.subjectId" filterable style="width: 100%">
            <el-option v-for="item in subjectOptions" :key="item.id" :label="item.name || item.displayName" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="权限动作">
          <el-checkbox-group v-model="permissionDialog.form.actions">
            <el-checkbox v-for="action in actions" :key="action" :label="action" />
          </el-checkbox-group>
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="效果">
            <el-segmented v-model="permissionDialog.form.effect" :options="permissionEffects" />
          </el-form-item>
          <el-form-item label="作用范围">
            <el-select v-model="permissionDialog.form.scope" style="width: 100%">
              <el-option label="当前及下级" value="all" />
              <el-option label="仅当前" value="self" />
              <el-option label="下级" value="children" />
              <el-option label="当前及直接文件" value="self_and_files" />
              <el-option label="子文件夹" value="children_folders" />
              <el-option label="子文件" value="children_files" />
              <el-option label="仅文件" value="files" />
            </el-select>
          </el-form-item>
          <el-form-item label="优先级">
            <el-input-number v-model="permissionDialog.form.priority" :min="0" :max="9999" style="width: 100%" />
          </el-form-item>
          <el-form-item label="继承到下级">
            <el-switch v-model="permissionDialog.form.inheritEnabled" />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="文件名包含">
            <el-input v-model="permissionDialog.form.condition.filenameContains" />
          </el-form-item>
          <el-form-item label="路径前缀">
            <el-input v-model="permissionDialog.form.condition.pathPrefix" />
          </el-form-item>
          <el-form-item label="扩展名">
            <el-input v-model="permissionDialog.form.condition.extensions" placeholder="docx,pdf,xlsx" />
          </el-form-item>
          <el-form-item label="业务状态">
            <el-select v-model="permissionDialog.form.condition.businessStatus" clearable style="width: 100%">
              <el-option label="有效" value="effective" />
              <el-option label="草稿" value="draft" />
              <el-option label="作废" value="invalid" />
              <el-option label="归档" value="archived" />
            </el-select>
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="permissionDialog.visible = false">关闭</el-button>
        <el-button v-if="permissionDialog.editingId" @click="cancelPermissionEdit">取消编辑</el-button>
        <el-button type="primary" @click="savePermission">{{ permissionDialog.editingId ? '保存规则' : '添加规则' }}</el-button>
      </template>
      <el-divider />
      <div class="section-header">
        <h2 class="section-title">权限预览</h2>
      </div>
      <div class="toolbar">
        <el-select v-model="permissionDialog.previewUserId" filterable placeholder="选择用户" style="max-width: 240px">
          <el-option v-for="item in users" :key="item.id" :label="item.displayName || item.username" :value="item.id" />
        </el-select>
        <el-button @click="previewPermission">查看最终权限</el-button>
        <span v-if="permissionDialog.previewActions.length" class="muted">{{ permissionDialog.previewActions.join('、') }}</span>
      </div>
    </el-dialog>

    <el-dialog v-model="externalLibraryDialog.visible" title="服务器目录同步" width="760px">
      <el-form label-position="top">
        <el-form-item label="服务器根目录">
          <el-input v-model="externalLibraryDialog.rootPath" placeholder="D:\\开始云管家" />
        </el-form-item>
        <el-form-item label="只同步指定目录">
          <el-input
            v-model="externalLibraryDialog.includePathsText"
            type="textarea"
            :rows="2"
            placeholder="每行一个相对目录；留空则同步根目录下全部内容"
          />
        </el-form-item>
        <el-form-item label="排除规则">
          <el-input
            v-model="externalLibraryDialog.excludePatternsText"
            type="textarea"
            :rows="2"
            placeholder="每行一个规则，如 node_modules、*.tmp、archive/*"
          />
        </el-form-item>
      </el-form>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="同步状态">{{ externalLibrary?.lastSyncJob?.status || '-' }}</el-descriptions-item>
        <el-descriptions-item label="进度">
          {{ externalLibrary?.lastSyncJob?.progress?.processed ?? 0 }} / {{ externalLibrary?.lastSyncJob?.progress?.total ?? 0 }}
        </el-descriptions-item>
        <el-descriptions-item label="上次同步">{{ formatDate(externalLibrary?.lastSyncedAt) }}</el-descriptions-item>
        <el-descriptions-item label="扫描数量">{{ externalLibrary?.lastSyncSummary?.scanned ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="新增文件夹">{{ externalLibrary?.lastSyncSummary?.foldersCreated ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="新增文件">{{ externalLibrary?.lastSyncSummary?.filesCreated ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="更新文件">{{ externalLibrary?.lastSyncSummary?.filesUpdated ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="删除标记">{{ externalLibrary?.lastSyncSummary?.deleted ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="跳过项目">{{ externalLibrary?.lastSyncSummary?.skipped ?? '-' }}</el-descriptions-item>
      </el-descriptions>
      <el-table class="sync-log-table" :data="externalLibraryDialog.syncJobs" border>
        <el-table-column label="开始时间" width="170">
          <template #default="{ row }">{{ formatDate(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90" />
        <el-table-column label="进度" width="110">
          <template #default="{ row }">{{ row.progress?.processed || 0 }} / {{ row.progress?.total || 0 }}</template>
        </el-table-column>
        <el-table-column label="结果" min-width="220">
          <template #default="{ row }">
            <span v-if="row.error">{{ row.error.message }}</span>
            <span v-else>扫描 {{ row.summary?.scanned ?? 0 }}，新增 {{ row.summary?.filesCreated ?? 0 }}，更新 {{ row.summary?.filesUpdated ?? 0 }}，跳过 {{ row.summary?.skipped ?? 0 }}</span>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="externalLibraryDialog.visible = false">取消</el-button>
        <el-button @click="saveExternalLibrary">保存路径</el-button>
        <el-button type="primary" :loading="loading" @click="syncExternalLibrary">同步目录</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="storageDialog.visible" title="数据库连接配置" width="640px">
      <el-form label-position="top">
        <el-form-item label="账本存储方式">
          <el-radio-group v-model="storageDialog.form.provider">
            <el-radio-button label="json">本地 JSON</el-radio-button>
            <el-radio-button label="mysql">远程 MySQL</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <div v-if="storageDialog.form.provider === 'mysql'" class="form-grid">
          <el-form-item label="主机地址">
            <el-input v-model="storageDialog.form.host" placeholder="例如 127.0.0.1" />
          </el-form-item>
          <el-form-item label="端口">
            <el-input-number v-model="storageDialog.form.port" :min="1" :max="65535" style="width: 100%" />
          </el-form-item>
          <el-form-item label="数据库名">
            <el-input v-model="storageDialog.form.database" />
          </el-form-item>
          <el-form-item label="用户名">
            <el-input v-model="storageDialog.form.user" autocomplete="off" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input
              v-model="storageDialog.form.password"
              type="password"
              show-password
              autocomplete="new-password"
              :placeholder="storageDialog.hasPassword ? '留空表示不修改密码' : '请输入密码'"
            />
          </el-form-item>
          <el-form-item label="SSL">
            <el-switch v-model="storageDialog.form.ssl" active-text="启用" inactive-text="关闭" />
          </el-form-item>
        </div>
      </el-form>
      <el-alert
        v-if="storageDialog.testResult"
        type="success"
        :closable="false"
        show-icon
        :title="'连接成功：' + storageDialog.testResult.database"
        :description="storageDialog.testResult.version ? 'MySQL ' + storageDialog.testResult.version : ''"
      />
      <template #footer>
        <el-button @click="storageDialog.visible = false">取消</el-button>
        <el-button v-if="storageDialog.form.provider === 'mysql'" :loading="storageDialog.testing" @click="testStorageConnection">测试连接</el-button>
        <el-button type="primary" :loading="loading" @click="saveStorageSettings">保存配置</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="governanceDialog.visible" title="文档质量与复审" width="860px" class="tall-dialog">
      <div class="governance-dialog-heading">
        <strong>{{ governanceDialog.node?.name || '-' }}</strong>
        <span>{{ governanceDialog.node?.fullPath || '-' }}</span>
      </div>
      <el-tabs v-model="governanceDialog.activeTab">
        <el-tab-pane label="质量评分" name="quality">
          <div class="quality-summary-panel">
            <div class="quality-total-score">
              <strong>{{ governanceDialog.quality?.score ?? '-' }}</strong>
              <span>质量分 / 100</span>
              <el-tag :type="qualityTagType(governanceDialog.quality?.level)">{{ governanceDialog.quality?.levelLabel || '-' }}</el-tag>
            </div>
            <div class="quality-dimension-list">
              <div v-for="item in governanceDialog.quality?.dimensions || []" :key="item.key" class="quality-dimension-row">
                <div><strong>{{ item.label }}</strong><span>{{ item.detail }}</span></div>
                <el-progress :percentage="Math.round((item.score / item.maxScore) * 100)" :stroke-width="8" :show-text="false" />
                <b>{{ item.score }}/{{ item.maxScore }}</b>
              </div>
            </div>
          </div>
          <div class="governance-suggestions">
            <h3>改进建议</h3>
            <el-empty v-if="!governanceDialog.quality?.suggestions?.length" description="当前没有需要改进的项目" :image-size="72" />
            <div v-else class="suggestion-list">
              <div v-for="item in governanceDialog.quality.suggestions" :key="item.key">
                <el-tag size="small" type="warning" effect="plain">{{ item.label }}</el-tag>
                <span>{{ item.suggestion }}</span>
              </div>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="复审计划" name="review">
          <el-form label-position="top" class="governance-review-form">
            <div class="form-grid">
              <el-form-item label="启用复审">
                <el-switch v-model="governanceDialog.reviewForm.enabled" :disabled="!governanceDialog.canConfigure" active-text="启用" inactive-text="关闭" />
              </el-form-item>
              <el-form-item label="当前状态">
                <el-tag :type="reviewTagType(governanceDialog.review?.status)">{{ reviewStatusLabel(governanceDialog.review?.status) }}</el-tag>
              </el-form-item>
              <el-form-item label="复审负责人">
                <el-select v-model="governanceDialog.reviewForm.ownerId" :disabled="!governanceDialog.canConfigure || !governanceDialog.reviewForm.enabled" filterable clearable style="width: 100%">
                  <el-option v-for="item in users" :key="item.id" :label="item.displayName || item.username" :value="item.id" />
                </el-select>
              </el-form-item>
              <el-form-item label="复审周期（天）">
                <el-input-number v-model="governanceDialog.reviewForm.cycleDays" :disabled="!governanceDialog.canConfigure || !governanceDialog.reviewForm.enabled" :min="1" :max="3650" style="width: 100%" />
              </el-form-item>
              <el-form-item label="下次复审时间">
                <el-date-picker v-model="governanceDialog.reviewForm.nextReviewAt" :disabled="!governanceDialog.canConfigure || !governanceDialog.reviewForm.enabled" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 100%" />
              </el-form-item>
              <el-form-item label="上次复审">
                <el-input :model-value="formatDate(governanceDialog.review?.lastReviewedAt)" disabled />
              </el-form-item>
            </div>
            <div v-if="governanceDialog.canComplete && governanceDialog.reviewForm.enabled" class="review-complete-box">
              <h3>提交本次复审</h3>
              <div class="form-grid">
                <el-form-item label="复审结论">
                  <el-select v-model="governanceDialog.completeForm.conclusion" style="width: 100%">
                    <el-option label="内容有效" value="valid" />
                    <el-option label="需要更新" value="needs_update" />
                    <el-option label="停止使用" value="retire" />
                  </el-select>
                </el-form-item>
                <el-form-item label="下次复审时间（可选）">
                  <el-date-picker v-model="governanceDialog.completeForm.nextReviewAt" type="datetime" clearable value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 100%" />
                </el-form-item>
              </div>
              <el-form-item label="复审备注">
                <el-input v-model="governanceDialog.completeForm.note" type="textarea" :rows="3" placeholder="记录本次核查结论和后续处理事项" />
              </el-form-item>
              <el-button type="primary" :loading="governanceDialog.saving" @click="completeDocumentReview">完成复审</el-button>
            </div>
          </el-form>
          <div class="review-history-block">
            <h3>复审历史</h3>
            <el-table :data="governanceDialog.history" border max-height="260" empty-text="暂无复审记录">
              <el-table-column label="结论" width="110"><template #default="{ row }">{{ reviewConclusionLabel(row.conclusion) }}</template></el-table-column>
              <el-table-column label="复审人" width="130"><template #default="{ row }">{{ row.reviewer?.displayName || row.reviewer?.username || row.reviewerId }}</template></el-table-column>
              <el-table-column prop="note" label="备注" min-width="240" />
              <el-table-column label="时间" width="170"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
            </el-table>
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="governanceDialog.visible = false">关闭</el-button>
        <el-button v-if="governanceDialog.activeTab === 'review' && governanceDialog.canConfigure" type="primary" :loading="governanceDialog.saving" @click="saveDocumentReviewSettings">保存复审计划</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="officePreviewDialog.visible" title="Office 原版预览配置" width="700px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="启用原版预览">
            <el-switch v-model="officePreviewDialog.form.enabled" active-text="启用" inactive-text="关闭" />
          </el-form-item>
          <el-form-item label="预览服务">
            <el-select v-model="officePreviewDialog.form.provider" disabled style="width: 100%">
              <el-option label="ONLYOFFICE Docs" value="onlyoffice" />
            </el-select>
          </el-form-item>
          <el-form-item label="Document Server 地址">
            <el-input v-model="officePreviewDialog.form.documentServerUrl" placeholder="例如 http://127.0.0.1:8080" />
          </el-form-item>
          <el-form-item label="平台外部访问地址">
            <el-input v-model="officePreviewDialog.form.publicBaseUrl" placeholder="例如 http://服务器IP:3000，留空自动使用当前访问地址" />
          </el-form-item>
          <el-form-item label="JWT Secret">
            <el-input
              v-model="officePreviewDialog.form.jwtSecret"
              type="password"
              show-password
              autocomplete="new-password"
              :placeholder="officePreviewSettings?.hasJwtSecret ? '留空表示不修改' : '与 Document Server JWT 密钥一致，可留空'"
            />
          </el-form-item>
        </div>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="说明"
          description="原版预览依赖独立的 ONLYOFFICE Document Server。未启用或加载失败时，系统仍会展示提取文本兜底预览。"
        />
      </el-form>
      <template #footer>
        <el-button @click="officePreviewDialog.visible = false">取消</el-button>
        <el-button @click="testOfficePreviewSettings">测试配置</el-button>
        <el-button type="primary" :loading="loading" @click="saveOfficePreviewSettings">保存配置</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="securityDialog.visible" title="文件安全设置" width="560px">
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="securityDialog.node?.fullPath || ''" disabled />
        </el-form-item>
        <el-form-item label="密级">
          <el-segmented v-model="securityDialog.form.securityLevel" :options="securityLevelOptions" />
        </el-form-item>
        <el-form-item label="敏感文件">
          <el-switch v-model="securityDialog.form.sensitive" active-text="敏感" inactive-text="普通" />
        </el-form-item>
        <el-form-item label="敏感原因">
          <el-input v-model="securityDialog.form.sensitiveReason" type="textarea" :rows="3" placeholder="例如：包含经营数据、合同价格或内部资料" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="securityDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="saveNodeSecurity">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="securityPolicyDialog.visible" title="安全策略配置" width="720px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="预览水印">
            <el-switch v-model="securityPolicyDialog.form.enablePreviewWatermark" active-text="启用" inactive-text="关闭" />
          </el-form-item>
          <el-form-item label="敏感文件下载">
            <el-switch v-model="securityPolicyDialog.form.blockSensitiveDownload" active-text="限制" inactive-text="允许" />
          </el-form-item>
          <el-form-item label="管理员绕过">
            <el-switch v-model="securityPolicyDialog.form.allowAdminBypass" active-text="允许" inactive-text="禁止" />
          </el-form-item>
          <el-form-item label="敏感访问日志">
            <el-switch v-model="securityPolicyDialog.form.logSensitiveAccess" active-text="记录" inactive-text="关闭" />
          </el-form-item>
          <el-form-item label="下载水印预留">
            <el-switch v-model="securityPolicyDialog.form.enableDownloadWatermark" active-text="启用" inactive-text="关闭" />
          </el-form-item>
          <el-form-item label="敏感下载审批">
            <el-switch v-model="securityPolicyDialog.form.requireDownloadApprovalForSensitive" active-text="需要" inactive-text="不需要" />
          </el-form-item>
          <el-form-item label="发布审批">
            <el-switch v-model="securityPolicyDialog.form.requirePublishApproval" active-text="需要" inactive-text="不需要" />
          </el-form-item>
          <el-form-item label="权限申请审批">
            <el-switch v-model="securityPolicyDialog.form.requirePermissionApproval" active-text="需要" inactive-text="不需要" />
          </el-form-item>
        </div>
        <el-form-item label="水印内容">
          <el-radio-group v-model="securityPolicyDialog.form.watermarkTextMode">
            <el-radio-button label="user">用户+时间</el-radio-button>
            <el-radio-button label="company">公司名称</el-radio-button>
            <el-radio-button label="custom">自定义</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="固定/自定义水印文字">
          <el-input v-model="securityPolicyDialog.form.customWatermarkText" placeholder="例如：公司内部资料" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="securityPolicyDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="saveSecurityPolicy">保存策略</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="wecomDialog.visible" title="企业微信配置" width="700px">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="启用企业微信">
            <el-switch v-model="wecomDialog.form.enabled" active-text="启用" inactive-text="关闭" />
          </el-form-item>
          <el-form-item label="消息推送">
            <el-switch v-model="wecomDialog.form.pushMessages" active-text="启用" inactive-text="关闭" />
          </el-form-item>
          <el-form-item label="CorpID">
            <el-input v-model="wecomDialog.form.corpId" autocomplete="off" />
          </el-form-item>
          <el-form-item label="AgentID">
            <el-input v-model="wecomDialog.form.agentId" autocomplete="off" />
          </el-form-item>
          <el-form-item label="Secret">
            <el-input v-model="wecomDialog.form.secret" type="password" show-password autocomplete="new-password" :placeholder="wecomSettings?.hasSecret ? '留空表示不修改' : '请输入 Secret'" />
          </el-form-item>
          <el-form-item label="回调地址">
            <el-input v-model="wecomDialog.form.callbackUrl" placeholder="/api/v1/wecom/auth/callback" />
          </el-form-item>
          <el-form-item label="同步部门">
            <el-switch v-model="wecomDialog.form.syncDepartments" active-text="启用" inactive-text="关闭" />
          </el-form-item>
          <el-form-item label="同步用户">
            <el-switch v-model="wecomDialog.form.syncUsers" active-text="启用" inactive-text="关闭" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="wecomDialog.visible = false">取消</el-button>
        <el-button @click="testWecomSettings">测试配置</el-button>
        <el-button type="primary" :loading="loading" @click="saveWecomSettings">保存配置</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="approvalRequestDialog.visible" :title="approvalRequestDialog.type === 'permission' ? '权限申请' : '下载审批申请'" width="560px">
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="approvalRequestDialog.node?.fullPath || approvalRequestDialog.node?.name || ''" disabled />
        </el-form-item>
        <el-form-item label="审批人">
          <el-select v-model="approvalRequestDialog.approverId" filterable style="width: 100%">
            <el-option v-for="item in users" :key="item.id" :label="item.displayName || item.username" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="approvalRequestDialog.type === 'permission'" label="申请权限">
          <el-checkbox-group v-model="approvalRequestDialog.requestedActions">
            <el-checkbox label="visible">可见</el-checkbox>
            <el-checkbox label="file:preview">预览</el-checkbox>
            <el-checkbox label="file:download">下载</el-checkbox>
            <el-checkbox label="file:update">编辑</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="申请理由">
          <el-input v-model="approvalRequestDialog.reason" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="approvalRequestDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="submitApprovalRequest">提交申请</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchMetadataDialog.visible" title="批量属性编辑" width="640px">
      <el-form label-position="top">
        <el-alert type="info" :closable="false" :title="'将更新 ' + batchMetadataDialog.rows.length + ' 个项目'" />
        <el-form-item label="标签">
          <el-input v-model="batchMetadataDialog.tagsText" placeholder="留空不更新，多个标签用逗号分隔" />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="业务状态">
            <el-select v-model="batchMetadataDialog.businessStatus" clearable style="width: 100%">
              <el-option label="不更新" value="" />
              <el-option label="草稿" value="draft" />
              <el-option label="有效" value="effective" />
              <el-option label="作废" value="invalid" />
              <el-option label="归档" value="archived" />
            </el-select>
          </el-form-item>
          <el-form-item label="密级">
            <el-select v-model="batchMetadataDialog.securityLevel" clearable style="width: 100%">
              <el-option label="不更新" value="" />
              <el-option v-for="item in securityLevelOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="敏感标识">
            <el-select v-model="batchMetadataDialog.sensitiveMode" style="width: 100%">
              <el-option label="不更新" value="keep" />
              <el-option label="设为敏感" value="true" />
              <el-option label="设为普通" value="false" />
            </el-select>
          </el-form-item>
          <el-form-item label="敏感原因">
            <el-input v-model="batchMetadataDialog.sensitiveReason" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="batchMetadataDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="saveBatchMetadata">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="viewAccessDialog.visible" title="可查看范围" width="620px">
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="viewAccessDialog.node?.fullPath || ''" disabled />
        </el-form-item>
        <el-form-item label="访问模式">
          <el-switch v-model="viewAccessDialog.restricted" active-text="指定范围可见" inactive-text="所有员工可见" />
        </el-form-item>
        <template v-if="viewAccessDialog.restricted">
          <el-form-item label="用户">
            <el-select v-model="viewAccessDialog.userIds" multiple filterable style="width: 100%">
              <el-option v-for="item in users" :key="item.id" :label="item.displayName || item.username" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="部门">
            <el-select v-model="viewAccessDialog.departmentIds" multiple filterable style="width: 100%">
              <el-option v-for="item in flatDepartments" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="角色">
            <el-select v-model="viewAccessDialog.roleIds" multiple filterable style="width: 100%">
              <el-option v-for="item in flatRoles" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="viewAccessDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveViewAccess">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="nodePasswordDialog.visible" title="文件/文件夹加密" width="480px">
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="nodePasswordDialog.node?.fullPath || ''" disabled />
        </el-form-item>
        <el-form-item label="启用加密">
          <el-switch v-model="nodePasswordDialog.enabled" />
        </el-form-item>
        <template v-if="nodePasswordDialog.enabled">
          <el-form-item label="访问密码">
            <el-input v-model="nodePasswordDialog.password" type="password" show-password autocomplete="new-password" />
          </el-form-item>
          <el-form-item label="确认密码">
            <el-input v-model="nodePasswordDialog.confirmPassword" type="password" show-password autocomplete="new-password" />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="nodePasswordDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveNodePassword">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="unlockDialog.visible" title="密码验证" width="420px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="unlockDialog.nodeName || unlockDialog.node?.name || ''" disabled />
        </el-form-item>
        <el-form-item label="访问密码">
          <el-input v-model="unlockDialog.password" type="password" show-password autocomplete="off" @keyup.enter="confirmUnlockPassword" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cancelUnlockPassword">取消</el-button>
        <el-button type="primary" :loading="loading" @click="confirmUnlockPassword">验证</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="passwordDialog.visible" title="修改密码" width="420px">
      <el-form label-position="top">
        <el-form-item label="原密码">
          <el-input v-model="passwordDialog.form.oldPassword" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="passwordDialog.form.newPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="passwordDialog.form.confirmPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="changePassword">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="messageDialog.visible" title="消息详情" width="640px">
      <el-descriptions :column="1" border>
        <el-descriptions-item label="标题">{{ messageDialog.item?.title || '-' }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ messageDialog.item?.messageType || '-' }}</el-descriptions-item>
        <el-descriptions-item label="内容">{{ messageDialog.item?.content || '-' }}</el-descriptions-item>
        <el-descriptions-item label="时间">{{ formatDate(messageDialog.item?.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="关联对象">{{ messageDialog.item?.relatedNode?.fullPath || '-' }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="messageDialog.visible = false">关闭</el-button>
        <el-button v-if="messageDialog.item?.relatedNode" type="primary" @click="openMessageRelatedNode">打开关联文件</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="filePolicyDialog.visible" title="上传策略" width="520px">
      <el-form label-position="top">
        <el-form-item label="允许扩展名">
          <el-input v-model="filePolicyDialog.form.allowedExtensionsText" type="textarea" :rows="4" placeholder="docx,pdf,xlsx,png" />
        </el-form-item>
        <el-form-item label="单文件大小上限 MB">
          <el-input-number v-model="filePolicyDialog.form.maxSizeMb" :min="1" :max="300" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="filePolicyDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveFilePolicy">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="announcementDialog.visible" :title="announcementDialog.form.id ? '编辑公告' : '新建公告'" width="680px">
      <el-form label-position="top">
        <el-form-item label="公告标题">
          <el-input v-model="announcementDialog.form.title" />
        </el-form-item>
        <el-form-item label="公告内容">
          <el-input v-model="announcementDialog.form.content" type="textarea" :rows="5" />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="状态">
            <el-select v-model="announcementDialog.form.status" style="width: 100%">
              <el-option label="发布" value="published" />
              <el-option label="草稿" value="draft" />
              <el-option label="撤销" value="revoked" />
            </el-select>
          </el-form-item>
          <el-form-item label="过期时间">
            <el-date-picker v-model="announcementDialog.form.expiresAt" type="datetime" clearable style="width: 100%" />
          </el-form-item>
        </div>
        <el-form-item label="发布范围">
          <el-segmented v-model="announcementDialog.audienceType" :options="subjectTypes" />
        </el-form-item>
        <el-form-item label="范围对象" v-if="announcementDialog.audienceType !== 'all'">
          <el-select v-model="announcementDialog.audienceIds" multiple filterable style="width: 100%">
            <el-option v-for="item in announcementSubjectOptions" :key="item.id" :label="item.name || item.displayName" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="公告附件">
          <el-upload :auto-upload="false" :limit="1" :on-change="onAnnouncementFileChange" :on-remove="onAnnouncementFileRemove">
            <el-button :icon="Paperclip">选择附件</el-button>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="announcementDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="saveAnnouncement">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="credentialDialog.visible" :title="credentialDialog.form.id ? '编辑 API 凭证' : '新建 API 凭证'" width="560px">
      <el-form label-position="top">
        <el-form-item label="凭证名称">
          <el-input v-model="credentialDialog.form.name" />
        </el-form-item>
        <el-form-item label="关联用户">
          <el-select v-model="credentialDialog.form.userId" filterable style="width: 100%">
            <el-option v-for="item in users" :key="item.id" :label="item.displayName || item.username" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="权限范围">
          <el-input v-model="credentialDialog.form.scopesText" placeholder="files:read,files:write" />
        </el-form-item>
        <el-form-item label="每分钟限流">
          <el-input-number v-model="credentialDialog.form.rateLimitPerMinute" :min="1" :max="10000" style="width: 100%" />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="状态">
            <el-select v-model="credentialDialog.form.status" style="width: 100%">
              <el-option label="启用" value="enabled" />
              <el-option label="停用" value="disabled" />
            </el-select>
          </el-form-item>
          <el-form-item label="过期时间">
            <el-date-picker v-model="credentialDialog.form.expiresAt" type="datetime" clearable style="width: 100%" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="credentialDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" @click="saveCredential">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="shareDialog.visible" :title="shareDialog.form.type === 'publish' ? '文件发布' : '文件分享'" width="620px">
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="shareDialog.node?.fullPath || ''" disabled />
        </el-form-item>
        <el-form-item label="类型">
          <el-segmented v-model="shareDialog.form.type" :options="shareTypes" />
        </el-form-item>
        <el-form-item label="接收范围">
          <el-segmented v-model="shareDialog.audienceType" :options="subjectTypes" />
        </el-form-item>
        <el-form-item label="接收对象" v-if="shareDialog.audienceType !== 'all'">
          <el-select v-model="shareDialog.audienceIds" multiple filterable style="width: 100%">
            <el-option v-for="item in shareSubjectOptions" :key="item.id" :label="item.name || item.displayName" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="授予权限">
          <el-checkbox-group v-model="shareDialog.form.actions">
            <el-checkbox label="visible">可见</el-checkbox>
            <el-checkbox label="file:preview">预览</el-checkbox>
            <el-checkbox label="file:download">下载</el-checkbox>
            <el-checkbox label="file:update">修改</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="有效天数">
          <el-input-number v-model="shareDialog.days" :min="1" :max="365" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="shareDialog.form.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="shareDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="createShare">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="reminderDialog.visible" title="文件闹钟" width="640px">
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="reminderDialog.node?.fullPath || ''" disabled />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="首次触发时间">
            <el-date-picker v-model="reminderDialog.form.triggerAt" type="datetime" style="width: 100%" />
          </el-form-item>
          <el-form-item label="结束时间">
            <el-date-picker v-model="reminderDialog.form.endAt" type="datetime" clearable style="width: 100%" />
          </el-form-item>
          <el-form-item label="循环周期">
            <el-segmented v-model="reminderDialog.form.cycle" :options="reminderCycles" />
          </el-form-item>
          <el-form-item label="自定义间隔天数">
            <el-input-number v-model="reminderDialog.form.intervalDays" :min="0" :max="365" style="width: 100%" />
          </el-form-item>
        </div>
        <el-form-item label="提醒方式">
          <el-checkbox-group v-model="reminderDialog.form.remindBy">
            <el-checkbox v-for="item in reminderChannels" :key="item.value" :label="item.value">{{ item.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="reminderDialog.form.remark" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reminderDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="createReminder">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="linkDialog.visible" title="附件与关联文件" width="880px">
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="linkDialog.node?.fullPath || ''" disabled />
        </el-form-item>
      </el-form>
      <el-tabs v-model="linkDialog.tab">
        <el-tab-pane label="附件" name="attachments">
          <div class="toolbar">
            <el-upload :auto-upload="false" :limit="1" :on-change="onAttachmentFileChange" :on-remove="onAttachmentFileRemove">
              <el-button :icon="Paperclip">选择附件</el-button>
            </el-upload>
            <el-input v-model="linkDialog.attachmentDescription" placeholder="附件说明" style="max-width: 280px" />
            <el-button type="primary" :loading="loading" @click="uploadAttachment">上传附件</el-button>
          </div>
          <el-table :data="linkDialog.attachments" border>
            <el-table-column prop="name" label="附件名称" min-width="180" />
            <el-table-column prop="description" label="说明" min-width="180" />
            <el-table-column label="大小" width="110">
              <template #default="{ row }">{{ formatSize(row.sizeBytes) }}</template>
            </el-table-column>
            <el-table-column label="上传时间" width="180">
              <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button size="small" :icon="Download" @click="downloadAttachment(row)">下载</el-button>
                <el-button size="small" type="danger" :icon="Trash2" @click="deleteAttachment(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="关联文件" name="relations">
          <div class="toolbar">
            <el-input v-model="linkDialog.relationKeyword" placeholder="搜索要关联的文件" clearable style="max-width: 320px" @keyup.enter="searchRelationCandidates" />
            <el-input v-model="linkDialog.relationDescription" placeholder="关联说明" style="max-width: 280px" />
            <el-button :icon="Search" @click="searchRelationCandidates">搜索</el-button>
          </div>
          <el-table v-if="linkDialog.candidates.length" :data="linkDialog.candidates" border style="margin-bottom: 14px">
            <el-table-column prop="name" label="候选文件" min-width="180" />
            <el-table-column prop="fullPath" label="路径" min-width="260" />
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="primary" @click="createRelation(row)">关联</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-table :data="linkDialog.relations" border>
            <el-table-column prop="relatedNodeName" label="关联对象" min-width="180" />
            <el-table-column prop="relatedNodePath" label="路径" min-width="260" />
            <el-table-column prop="description" label="说明" min-width="160" />
            <el-table-column label="创建时间" width="180">
              <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.relatedNode?.nodeType === 'file'" size="small" @click="previewNode(row.relatedNode)">预览</el-button>
                <el-button size="small" type="danger" @click="deleteRelation(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="linkDialog.visible = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="metadataDialog.visible" title="属性、分类与评论" width="760px">
      <el-descriptions :column="2" border style="margin-bottom: 14px">
        <el-descriptions-item label="名称">{{ metadataDialog.node?.name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ metadataDialog.node?.nodeType === 'folder' ? '文件夹' : metadataDialog.node?.extension || '文件' }}</el-descriptions-item>
        <el-descriptions-item label="路径">{{ metadataDialog.node?.fullPath || '-' }}</el-descriptions-item>
        <el-descriptions-item label="大小">{{ metadataDialog.node?.currentVersion ? formatSize(metadataDialog.node.currentVersion.sizeBytes) : '-' }}</el-descriptions-item>
        <el-descriptions-item label="密级">{{ securityLevelLabel(metadataDialog.node) }}</el-descriptions-item>
        <el-descriptions-item label="敏感标识">{{ metadataDialog.node?.sensitive ? '敏感文件' : '普通文件' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatDate(metadataDialog.node?.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="更新时间">{{ formatDate(metadataDialog.node?.updatedAt) }}</el-descriptions-item>
      </el-descriptions>
      <el-form label-position="top">
        <el-form-item label="文件/文件夹">
          <el-input :model-value="metadataDialog.node?.fullPath || ''" disabled />
        </el-form-item>
        <el-form-item label="业务状态">
          <el-select v-model="metadataDialog.businessStatus" style="width: 100%">
            <el-option label="草稿" value="draft" />
            <el-option label="有效" value="effective" />
            <el-option label="作废" value="invalid" />
            <el-option label="归档" value="archived" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="metadataDialog.tagsText" placeholder="多个标签用逗号分隔" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="metadataDialog.categoryIds" multiple style="width: 100%">
            <el-option v-for="item in flatCategories" :key="item.id" :label="item.fullPath || item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-for="item in propertyDefinitions" :key="item.id" :label="item.name">
          <el-select v-if="item.dataType === 'enum'" v-model="metadataDialog.values[item.id]" clearable style="width: 100%">
            <el-option v-for="option in item.options || []" :key="option" :label="option" :value="option" />
          </el-select>
          <el-switch v-else-if="item.dataType === 'boolean'" v-model="metadataDialog.values[item.id]" active-value="true" inactive-value="false" />
          <el-date-picker v-else-if="item.dataType === 'date'" v-model="metadataDialog.values[item.id]" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          <el-input-number v-else-if="item.dataType === 'number'" v-model="metadataDialog.values[item.id]" style="width: 100%" />
          <el-input v-else v-model="metadataDialog.values[item.id]" />
        </el-form-item>
        <el-form-item label="评分">
          <el-rate v-model="metadataDialog.score" />
        </el-form-item>
        <el-form-item label="评论">
          <el-input v-model="metadataDialog.comment" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <el-table :data="metadataDialog.comments" border>
        <el-table-column prop="content" label="历史评论" min-width="260" />
        <el-table-column prop="userId" label="用户" width="130" />
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="metadataDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveMetadata">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="propertyDialog.visible" :title="propertyDialog.form.id ? '编辑扩展属性' : '新建扩展属性'" width="460px">
      <el-form label-position="top">
        <el-form-item label="属性名称">
          <el-input v-model="propertyDialog.form.name" />
        </el-form-item>
        <el-form-item label="适用对象">
          <el-select v-model="propertyDialog.form.targetType" style="width: 100%">
            <el-option label="文件" value="file" />
            <el-option label="分类" value="category" />
          </el-select>
        </el-form-item>
        <el-form-item label="数据类型">
          <el-select v-model="propertyDialog.form.dataType" style="width: 100%">
            <el-option label="文本" value="string" />
            <el-option label="数字" value="number" />
            <el-option label="日期" value="date" />
            <el-option label="布尔" value="boolean" />
            <el-option label="枚举" value="enum" />
          </el-select>
        </el-form-item>
        <el-form-item label="是否必填">
          <el-switch v-model="propertyDialog.form.required" />
        </el-form-item>
        <el-form-item label="枚举选项">
          <el-input v-model="propertyDialog.form.optionsText" type="textarea" :rows="3" placeholder="多个选项用逗号或换行分隔" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="propertyDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="savePropertyDefinition">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="categoryDialog.visible" :title="categoryDialog.form.id ? '编辑分类' : '新建分类'" width="520px">
      <el-form label-position="top">
        <el-form-item label="分类名称">
          <el-input v-model="categoryDialog.form.name" />
        </el-form-item>
        <el-form-item label="上级分类">
          <el-select v-model="categoryDialog.form.parentId" clearable style="width: 100%">
            <el-option v-for="item in categoryParentOptions" :key="item.id" :label="item.fullPath || item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="categoryDialog.form.sortOrder" :min="0" :max="9999" style="width: 100%" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="categoryDialog.form.status" style="width: 100%">
            <el-option label="启用" value="enabled" />
            <el-option label="禁用" value="disabled" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="categoryDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveCategory">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewDialog.visible" :title="previewDialog.node?.name || '预览'" width="80%">
      <div class="preview-box" :class="{ 'has-watermark': previewDialog.data?.watermark?.enabled }">
        <div v-if="previewDialog.loading" class="preview-loading">正在加载预览...</div>
        <iframe v-else-if="previewDialog.data?.previewType === 'pdf'" class="preview-frame" :src="previewDialog.data.rawUrl" title="PDF预览" />
        <img v-else-if="previewDialog.data?.previewType === 'image'" class="preview-image" :src="previewDialog.data.rawUrl" alt="文件预览" />
        <div v-else-if="['text', 'json'].includes(previewDialog.data?.previewType)" class="preview-document">
          <div class="preview-toolbar">
            <div class="preview-toolbar-title">
              <span>{{ previewModeLabel }}</span>
              <small v-if="previewLineSummary">{{ previewLineSummary }}</small>
            </div>
            <div class="preview-toolbar-actions">
              <el-radio-group v-if="isMarkdownPreview" v-model="previewSettings.markdownMode" size="small">
                <el-radio-button label="render">
                  <Eye :size="14" />
                  渲染
                </el-radio-button>
                <el-radio-button label="source">
                  <Code2 :size="14" />
                  源码
                </el-radio-button>
              </el-radio-group>
              <template v-if="isCodePreview && !isRenderedMarkdown">
                <el-checkbox v-model="previewSettings.lineNumbers" size="small">
                  <ListOrdered :size="14" />
                  行号
                </el-checkbox>
                <el-checkbox v-model="previewSettings.wrap" size="small">
                  <WrapText :size="14" />
                  换行
                </el-checkbox>
                <el-tooltip content="减小字号" placement="top">
                  <el-button size="small" :icon="ZoomOut" circle aria-label="减小字号" @click="adjustPreviewFontSize(-1)" />
                </el-tooltip>
                <span class="preview-font-size">{{ previewSettings.fontSize }}px</span>
                <el-tooltip content="增大字号" placement="top">
                  <el-button size="small" :icon="ZoomIn" circle aria-label="增大字号" @click="adjustPreviewFontSize(1)" />
                </el-tooltip>
              </template>
              <el-input
                v-model.trim="previewSettings.searchKeyword"
                class="preview-search-input"
                size="small"
                clearable
                placeholder="搜索当前预览"
                :prefix-icon="Search"
              />
              <span v-if="previewSettings.searchKeyword" class="preview-search-count">{{ previewSearchMatchCount }} 处</span>
              <el-button size="small" :icon="Copy" @click="copyPreviewContent">复制</el-button>
              <el-button size="small" :icon="Download" @click="downloadNode(previewDialog.node)">下载原文件</el-button>
            </div>
          </div>
          <div v-if="isRenderedMarkdown" class="preview-markdown" v-html="renderedMarkdownHtml"></div>
          <div
            v-else-if="isCodePreview"
            class="preview-code-shell"
            :class="{ 'is-wrap': previewSettings.wrap, 'has-line-numbers': previewSettings.lineNumbers }"
            :style="previewCodeStyle"
          >
            <div v-if="previewSettings.lineNumbers" class="preview-line-numbers" aria-hidden="true">
              <span v-for="lineNumber in previewLineNumbers" :key="lineNumber">{{ lineNumber }}</span>
            </div>
            <pre class="preview-text is-code"><code class="preview-code" :class="'language-' + previewLanguage" v-html="highlightedPreviewHtml"></code></pre>
          </div>
          <pre v-else class="preview-text" v-html="plainPreviewHtml"></pre>
          <div v-if="previewHasMore" class="preview-chunk-bar">
            <span>为保证打开速度，当前只显示 {{ previewVisibleSummary }}，共 {{ previewTotalSummary }}。</span>
            <div>
              <el-button size="small" @click="loadMorePreviewContent">加载更多</el-button>
              <el-button size="small" type="primary" plain @click="showAllPreviewContent">显示全部</el-button>
            </div>
          </div>
        </div>
        <div v-else-if="previewDialog.data?.previewType === 'office'" class="preview-office">
          <div class="preview-office-card">
            <div>
              <strong>Office 文件预览</strong>
              <p>{{ previewDialog.data.officePreview?.message || '当前展示提取文本，原版排版预览需要接入 Office 在线预览服务。' }}</p>
            </div>
            <div class="preview-office-actions">
              <el-tag v-if="isOfficeNativePreview" type="success" effect="light">原版预览</el-tag>
              <el-tag v-else type="info" effect="light">文本兜底</el-tag>
              <el-button :icon="Download" type="primary" @click="downloadNode(previewDialog.node)">下载原文件</el-button>
            </div>
          </div>
          <div v-if="isOfficeNativePreview" class="preview-office-native">
            <div v-if="officeNativeState.loading" class="preview-office-loading">正在加载 Office 原版预览...</div>
            <el-alert
              v-if="officeNativeState.error"
              type="warning"
              :closable="false"
              show-icon
              title="原版预览暂不可用"
              :description="officeNativeState.error"
            />
            <div ref="officeEditorHost" class="preview-office-editor"></div>
          </div>
          <div v-if="previewDialog.data.content && (!isOfficeNativePreview || officeNativeState.error)" class="preview-document">
            <div class="preview-toolbar">
              <div class="preview-toolbar-title">
                <span>{{ isOfficeNativePreview ? '提取文本备用预览' : '提取文本' }}</span>
                <small v-if="previewLineSummary">{{ previewLineSummary }}</small>
              </div>
              <div class="preview-toolbar-actions">
                <el-input
                  v-model.trim="previewSettings.searchKeyword"
                  class="preview-search-input"
                  size="small"
                  clearable
                  placeholder="搜索当前预览"
                  :prefix-icon="Search"
                />
                <span v-if="previewSettings.searchKeyword" class="preview-search-count">{{ previewSearchMatchCount }} 处</span>
              </div>
            </div>
            <pre class="preview-text is-document" v-html="plainPreviewHtml"></pre>
            <div v-if="previewHasMore" class="preview-chunk-bar">
              <span>为保证打开速度，当前只显示 {{ previewVisibleSummary }}，共 {{ previewTotalSummary }}。</span>
              <div>
                <el-button size="small" @click="loadMorePreviewContent">加载更多</el-button>
                <el-button size="small" type="primary" plain @click="showAllPreviewContent">显示全部</el-button>
              </div>
            </div>
          </div>
          <el-empty v-else description="暂未提取到文本内容，请下载原文件查看" />
        </div>
        <el-empty v-else description="该格式暂不支持浏览器预览，请下载后查看">
          <el-button :icon="Download" type="primary" @click="downloadNode(previewDialog.node)">下载文件</el-button>
        </el-empty>
        <div
          v-if="previewDialog.data?.watermark?.enabled"
          class="preview-watermark"
          aria-hidden="true"
        >
          <span v-for="index in 36" :key="index">{{ previewDialog.data.watermark.text }}</span>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="userDialog.visible" :title="userDialog.form.id ? '编辑用户' : '新建用户'" width="560px">
      <el-form label-position="top">
        <el-form-item label="账号">
          <el-input v-model="userDialog.form.username" :disabled="Boolean(userDialog.form.id)" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="userDialog.form.displayName" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="userDialog.form.email" />
        </el-form-item>
        <el-form-item label="电话">
          <el-input v-model="userDialog.form.phone" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="userDialog.form.status" style="width: 100%">
            <el-option label="启用" value="enabled" />
            <el-option label="禁用" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item label="部门">
          <el-select v-model="userDialog.form.departmentIds" multiple style="width: 100%">
            <el-option v-for="item in flatDepartments" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="userDialog.form.roleIds" multiple style="width: 100%">
            <el-option v-for="item in flatRoles" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveUser">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="departmentDialog.visible" :title="departmentDialog.form.id ? '编辑部门' : '新建部门'" width="520px">
      <el-form label-position="top">
        <el-form-item label="部门名称">
          <el-input v-model="departmentDialog.form.name" />
        </el-form-item>
        <el-form-item label="部门编码">
          <el-input v-model="departmentDialog.form.code" />
        </el-form-item>
        <el-form-item label="上级部门">
          <el-select v-model="departmentDialog.form.parentId" clearable style="width: 100%">
            <el-option v-for="item in departmentParentOptions" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="departmentDialog.form.status" style="width: 100%">
            <el-option label="启用" value="enabled" />
            <el-option label="禁用" value="disabled" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="departmentDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveDepartment">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="roleDialog.visible" :title="roleDialog.form.id ? '编辑角色' : '新建角色'" width="520px">
      <el-form label-position="top">
        <el-form-item label="角色名称">
          <el-input v-model="roleDialog.form.name" />
        </el-form-item>
        <el-form-item label="角色编码">
          <el-input v-model="roleDialog.form.code" />
        </el-form-item>
        <el-form-item label="上级角色">
          <el-select v-model="roleDialog.form.parentId" clearable style="width: 100%">
            <el-option v-for="item in roleParentOptions" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="roleDialog.form.status" style="width: 100%">
            <el-option label="启用" value="enabled" />
            <el-option label="禁用" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="roleDialog.form.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveRole">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  Bell,
  BookOpen,
  ChartNoAxesCombined,
  CheckCircle2,
  ClipboardCheck,
  Code2,
  Copy,
  Download,
  Eye,
  FileArchive,
  FileText,
  Folder,
  Gauge,
  History,
  ListOrdered,
  Lock,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Shield,
  Star,
  Trash2,
  Unlock,
  UploadCloud,
  WrapText,
  ZoomIn,
  ZoomOut,
  UserRound,
  UsersRound
} from 'lucide-vue-next';
import { api, downloadFile, getToken, setToken } from './api.js';
import {
  AnnouncementsView as AnnouncementsViewPanel,
  ApiManagementView as ApiManagementViewPanel,
  ApprovalCenterView as ApprovalCenterViewPanel,
  AuditView as AuditViewPanel,
  CollaborationView as CollaborationViewPanel,
  DashboardView as DashboardViewPanel,
  DocsView as DocsViewPanel,
  GovernanceView as GovernanceViewPanel,
  KnowledgeView as KnowledgeViewPanel,
  MessagesView as MessagesViewPanel,
  OrgView as OrgViewPanel,
  ProfileView as ProfileViewPanel,
  SystemManagementView as SystemManagementViewPanel,
  TrashView as TrashViewPanel,
  UsersView as UsersViewPanel
} from './components/views.js';

const token = ref(getToken());
const user = ref(null);
const loading = ref(false);
const activeView = ref('docs');
const sidebarCollapsed = ref(true);
const loginForm = reactive({ username: 'admin', password: 'admin123', captchaId: '', captchaAnswer: '' });
const captcha = ref(null);
const dashboard = ref(null);
const users = ref([]);
const departmentTree = ref([]);
const roleTree = ref([]);
const docTree = ref([]);
const docChildren = ref([]);
const selectedFolder = ref(null);
const driveTree = ref([]);
const driveChildren = ref([]);
const selectedDriveFolder = ref(null);
const driveSummary = ref(null);
const messages = ref([]);
const auditLogs = ref([]);
const actions = ref([]);
const categoryTree = ref([]);
const categoryFiles = ref([]);
const selectedCategory = ref(null);
const propertyDefinitions = ref([]);
const trashItems = ref([]);
const shares = ref([]);
const subscriptions = ref([]);
const reminders = ref([]);
const announcements = ref([]);
const apiCredentials = ref([]);
const apiCallLogs = ref([]);
const permissionTemplates = ref([]);
const filePolicy = ref({ allowedExtensions: [], maxSizeMb: 300 });
const externalLibrary = ref({ rootPath: '', lastSyncedAt: null, lastSyncSummary: null });
const storageSettings = ref(null);
const securityPolicy = ref(null);
const wecomSettings = ref(null);
const officePreviewSettings = ref(null);
const searchIndexStatus = ref(null);
const approvalTodo = ref([]);
const approvalMine = ref([]);
const approvalAll = ref([]);
const recentAccesses = ref([]);
const runtimeStatus = ref(null);
const auditReport = ref(null);
const governanceDashboard = ref(null);
const governanceQualityItems = ref([]);
const governanceDuplicateData = ref({ groups: [], summary: {} });
const governanceReviewItems = ref([]);
const governanceSearchAnalytics = ref(null);
const governanceSearchDays = ref(30);
const nodeUnlockTokens = reactive({});

const folderDialog = reactive({ visible: false, name: '' });
const uploadDialog = reactive({ visible: false, files: [], description: '初始版本' });
const moveDialog = reactive({ visible: false, mode: 'move', space: 'docs', node: null, nodes: [], targetId: '' });
const versionDialog = reactive({ visible: false, node: null, items: [], logs: [], file: null, description: '' });
const workflowDialog = reactive({ visible: false, node: null, action: 'publish', approverId: '', comment: '', approvals: [] });
const permissionDialog = reactive({
  visible: false,
  node: null,
  rules: [],
  editingId: null,
  templateId: '',
  batch: { subjectType: 'role', subjectIds: [], replaceExisting: false },
  previewUserId: '',
  previewActions: [],
  form: {
    subjectType: 'role',
    subjectId: '',
    actions: ['visible', 'file:preview', 'file:download'],
    effect: 'allow',
    scope: 'all',
    priority: 100,
    inheritEnabled: true,
    condition: { filenameContains: '', pathPrefix: '', extensions: '', businessStatus: '' }
  }
});
const PREVIEW_INITIAL_LINES = 800;
const PREVIEW_LOAD_LINES = 800;
const PREVIEW_INITIAL_CHARS = 60000;
const PREVIEW_LOAD_CHARS = 60000;
const previewDialog = reactive({ visible: false, node: null, data: null, loading: false });
const previewSettings = reactive({
  lineNumbers: true,
  wrap: false,
  fontSize: 13,
  markdownMode: 'render',
  visibleLines: PREVIEW_INITIAL_LINES,
  visibleChars: PREVIEW_INITIAL_CHARS,
  searchKeyword: ''
});
const officeEditorHost = ref(null);
const officeNativeState = reactive({ loading: false, error: '' });
let officeEditorInstance = null;
let officeApiScriptPromise = null;
let officeApiScriptUrl = '';
const CODE_LANGUAGE_BY_EXTENSION = {
  html: 'html',
  htm: 'html',
  xml: 'html',
  vue: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonl: 'json',
  py: 'python',
  pyw: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  config: 'ini',
  properties: 'ini',
  env: 'ini',
  sql: 'sql',
  md: 'markdown',
  java: 'java',
  kt: 'java',
  kts: 'java',
  go: 'go',
  rs: 'rust',
  php: 'php',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift'
};
const CODE_LANGUAGE_BY_FILENAME = {
  '.env': 'ini',
  '.gitignore': 'ini',
  '.dockerignore': 'ini',
  '.npmrc': 'ini',
  '.nvmrc': 'ini',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  readme: 'markdown',
  license: 'markdown'
};
const CODE_LANGUAGE_LABELS = {
  html: 'HTML',
  css: 'CSS',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  python: 'Python',
  shell: 'Shell',
  yaml: 'YAML',
  ini: '配置文件',
  sql: 'SQL',
  markdown: 'Markdown',
  java: 'Java/Kotlin',
  go: 'Go',
  rust: 'Rust',
  php: 'PHP',
  ruby: 'Ruby',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  swift: 'Swift',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile'
};
const userDialog = reactive({ visible: false, form: {} });
const departmentDialog = reactive({ visible: false, form: {} });
const roleDialog = reactive({ visible: false, form: {} });
const shareDialog = reactive({
  visible: false,
  node: null,
  audienceType: 'role',
  audienceIds: [],
  days: 30,
  form: { type: 'share', description: '', actions: ['visible', 'file:preview', 'file:download'] }
});
const reminderDialog = reactive({ visible: false, node: null, form: { triggerAt: new Date(), endAt: null, cycle: 'none', intervalDays: 0, remindBy: ['system'], remark: '' } });
const linkDialog = reactive({
  visible: false,
  node: null,
  tab: 'attachments',
  attachments: [],
  attachmentFile: null,
  attachmentDescription: '',
  relations: [],
  relationKeyword: '',
  relationDescription: '',
  candidates: []
});
const metadataDialog = reactive({ visible: false, node: null, tagsText: '', categoryIds: [], values: {}, businessStatus: 'effective', comments: [], comment: '', score: 5 });
const categoryDialog = reactive({ visible: false, form: {} });
const propertyDialog = reactive({ visible: false, form: { name: '', targetType: 'file', dataType: 'string', required: false, optionsText: '' } });
const passwordDialog = reactive({ visible: false, form: { oldPassword: '', newPassword: '', confirmPassword: '' } });
const externalLibraryDialog = reactive({ visible: false, rootPath: '', includePathsText: '', excludePatternsText: '', syncJobs: [] });
const storageDialog = reactive({
  visible: false,
  testing: false,
  hasPassword: false,
  testResult: null,
  form: { provider: 'json', host: '', port: 3306, database: '', user: '', password: '', ssl: false }
});
const governanceDialog = reactive({
  visible: false,
  activeTab: 'quality',
  node: null,
  quality: null,
  review: null,
  history: [],
  canConfigure: false,
  canComplete: false,
  saving: false,
  reviewForm: { enabled: false, ownerId: '', cycleDays: 365, nextReviewAt: '' },
  completeForm: { conclusion: 'valid', note: '', nextReviewAt: '' }
});
const securityDialog = reactive({ visible: false, node: null, form: { securityLevel: 'internal', sensitive: false, sensitiveReason: '' } });
const securityPolicyDialog = reactive({
  visible: false,
  form: {
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
  }
});
const wecomDialog = reactive({
  visible: false,
  form: {
    enabled: false,
    corpId: '',
    agentId: '',
    secret: '',
    callbackUrl: '',
    syncDepartments: true,
    syncUsers: true,
    pushMessages: false
  }
});
const officePreviewDialog = reactive({
  visible: false,
  form: {
    enabled: false,
    provider: 'onlyoffice',
    documentServerUrl: '',
    publicBaseUrl: '',
    jwtSecret: ''
  }
});
const approvalRequestDialog = reactive({
  visible: false,
  node: null,
  type: 'download',
  approverId: '',
  requestedActions: ['file:download'],
  reason: ''
});
const batchMetadataDialog = reactive({
  visible: false,
  rows: [],
  tagsText: '',
  businessStatus: '',
  securityLevel: '',
  sensitiveMode: 'keep',
  sensitiveReason: ''
});
const viewAccessDialog = reactive({ visible: false, node: null, restricted: false, userIds: [], departmentIds: [], roleIds: [] });
const nodePasswordDialog = reactive({ visible: false, node: null, enabled: false, password: '', confirmPassword: '' });
const unlockDialog = reactive({ visible: false, node: null, nodeName: '', password: '', retry: null, resolve: null, reject: null });
const messageDialog = reactive({ visible: false, item: null });
const filePolicyDialog = reactive({ visible: false, form: { allowedExtensionsText: '', maxSizeMb: 300 } });
const announcementDialog = reactive({ visible: false, file: null, audienceType: 'all', audienceIds: [], form: { title: '', content: '', status: 'published', expiresAt: null } });
const credentialDialog = reactive({ visible: false, form: { id: '', name: '', userId: '', scopesText: 'files:read', status: 'enabled', rateLimitPerMinute: 120, expiresAt: null } });

const navItems = [
  { key: 'dashboard', label: '工作台', icon: Gauge },
  { key: 'docs', label: '文档库', icon: FileArchive },
  { key: 'drive', label: '个人网盘', icon: Folder },
  { key: 'profile', label: '个人中心', icon: UserRound },
  { key: 'users', label: '用户管理', icon: UserRound },
  { key: 'org', label: '组织角色', icon: UsersRound },
  { key: 'knowledge', label: '知识分类', icon: BookOpen },
  { key: 'governance', label: '知识治理', icon: ChartNoAxesCombined },
  { key: 'trash', label: '回收站', icon: Trash2 },
  { key: 'messages', label: '消息中心', icon: Bell },
  { key: 'collaboration', label: '协作中心', icon: Share2 },
  { key: 'approvals', label: '审批中心', icon: ClipboardCheck },
  { key: 'announcements', label: '公告管理', icon: Bell },
  { key: 'api', label: '开放 API', icon: Shield },
  { key: 'system', label: '系统管理', icon: Settings },
  { key: 'audit', label: '审计日志', icon: History }
];
const adminOnlyViews = new Set(['users', 'org', 'governance', 'announcements', 'api', 'system', 'audit']);
const isAdminUser = computed(() => (user.value?.roleIds || []).includes('r_admin'));
const visibleNavItems = computed(() => navItems.filter((item) => !adminOnlyViews.has(item.key) || isAdminUser.value));

const subjectTypes = [
  { label: '角色', value: 'role' },
  { label: '部门', value: 'department' },
  { label: '用户', value: 'user' },
  { label: '所有人', value: 'all' }
];
const shareTypes = [
  { label: '分享', value: 'share' },
  { label: '发布', value: 'publish' }
];
const permissionEffects = [
  { label: '允许', value: 'allow' },
  { label: '拒绝', value: 'deny' }
];
const workflowActionOptions = [
  { label: '发布', value: 'publish' },
  { label: '作废', value: 'invalidate' },
  { label: '归档', value: 'archive' }
];
const securityLevelOptions = [
  { label: '公开', value: 'public' },
  { label: '内部', value: 'internal' },
  { label: '受限', value: 'restricted' },
  { label: '机密', value: 'confidential' }
];
const reminderCycles = [
  { label: '不循环', value: 'none' },
  { label: '每天', value: 'daily' },
  { label: '每周', value: 'weekly' },
  { label: '每月', value: 'monthly' }
];
const reminderChannels = [
  { label: '系统消息', value: 'system' },
  { label: '邮件', value: 'email' },
  { label: '企业微信', value: 'wecom' }
];

const currentTitle = computed(() => navItems.find((item) => item.key === activeView.value)?.label || '文档管理平台');
const activeFolder = computed(() => activeView.value === 'drive' ? selectedDriveFolder.value : selectedFolder.value);
const flatDepartments = computed(() => flattenTree(departmentTree.value));
const flatRoles = computed(() => flattenTree(roleTree.value));
const flatCategories = computed(() => flattenTree(categoryTree.value));
const departmentParentOptions = computed(() => flatDepartments.value.filter((item) => item.id !== departmentDialog.form.id));
const roleParentOptions = computed(() => flatRoles.value.filter((item) => item.id !== roleDialog.form.id));
const categoryParentOptions = computed(() => flatCategories.value.filter((item) => item.id !== categoryDialog.form.id));
const roleNames = computed(() => user.value?.roleIds?.map((id) => flatRoles.value.find((item) => item.id === id)?.name).filter(Boolean).join('、') || '未分配角色');
const subjectOptions = computed(() => {
  if (permissionDialog.form.subjectType === 'department') return flatDepartments.value;
  if (permissionDialog.form.subjectType === 'role') return flatRoles.value;
  if (permissionDialog.form.subjectType === 'user') return users.value;
  return [];
});
const batchSubjectOptions = computed(() => {
  if (permissionDialog.batch.subjectType === 'department') return flatDepartments.value;
  if (permissionDialog.batch.subjectType === 'role') return flatRoles.value;
  if (permissionDialog.batch.subjectType === 'user') return users.value;
  return [];
});
const selectedPermissionTemplate = computed(() => permissionTemplates.value.find((item) => item.id === permissionDialog.templateId) || null);
const shareSubjectOptions = computed(() => {
  if (shareDialog.audienceType === 'department') return flatDepartments.value;
  if (shareDialog.audienceType === 'role') return flatRoles.value;
  if (shareDialog.audienceType === 'user') return users.value;
  return [];
});
const announcementSubjectOptions = computed(() => {
  if (announcementDialog.audienceType === 'department') return flatDepartments.value;
  if (announcementDialog.audienceType === 'role') return flatRoles.value;
  if (announcementDialog.audienceType === 'user') return users.value;
  return [];
});
const previewLanguage = computed(() => detectPreviewLanguage(previewDialog.node, previewDialog.data));
const isCodePreview = computed(() => Boolean(previewLanguage.value && ['text', 'json'].includes(previewDialog.data?.previewType)));
const isMarkdownPreview = computed(() => previewLanguage.value === 'markdown' && ['text', 'json'].includes(previewDialog.data?.previewType));
const isRenderedMarkdown = computed(() => isMarkdownPreview.value && previewSettings.markdownMode === 'render');
const isOfficeNativePreview = computed(() => Boolean(previewDialog.data?.officePreview?.status === 'native_ready' && previewDialog.data?.officePreview?.native));
const previewModeLabel = computed(() => {
  if (isRenderedMarkdown.value) return 'Markdown 渲染预览';
  if (isCodePreview.value) return `${CODE_LANGUAGE_LABELS[previewLanguage.value] || '代码'} 预览`;
  return previewDialog.data?.previewType === 'json' ? 'JSON 预览' : '文本预览';
});
const previewRawContent = computed(() => String(previewDialog.data?.content ?? ''));
const previewNormalizedContent = computed(() => previewRawContent.value.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
const previewAllLines = computed(() => previewNormalizedContent.value ? previewNormalizedContent.value.split('\n') : []);
const previewLineCount = computed(() => previewAllLines.value.length);
const previewTotalCharCount = computed(() => previewNormalizedContent.value.length);
const previewContentForRender = computed(() => {
  if (!previewNormalizedContent.value) return '';
  const lineLimit = Math.max(1, previewSettings.visibleLines);
  const charLimit = Math.max(1, previewSettings.visibleChars);
  const lineChunk = previewAllLines.value.slice(0, lineLimit).join('\n');
  return lineChunk.length > charLimit ? lineChunk.slice(0, charLimit) : lineChunk;
});
const previewVisibleLineCount = computed(() => previewContentForRender.value ? previewContentForRender.value.split('\n').length : 0);
const previewVisibleCharCount = computed(() => previewContentForRender.value.length);
const previewHasMore = computed(() => previewVisibleCharCount.value < previewTotalCharCount.value);
const previewLineSummary = computed(() => {
  if (!previewTotalCharCount.value) return '';
  if (previewHasMore.value) {
    if (previewLineCount.value <= 1) return `已显示 ${formatPreviewCount(previewVisibleCharCount.value)} / ${formatPreviewCount(previewTotalCharCount.value)} 字`;
    return `已显示 ${formatPreviewCount(previewVisibleLineCount.value)} / ${formatPreviewCount(previewLineCount.value)} 行`;
  }
  return `${formatPreviewCount(previewLineCount.value)} 行`;
});
const previewVisibleSummary = computed(() => {
  if (previewLineCount.value <= 1) return `${formatPreviewCount(previewVisibleCharCount.value)} 字`;
  return `${formatPreviewCount(previewVisibleLineCount.value)} 行`;
});
const previewTotalSummary = computed(() => {
  if (previewLineCount.value <= 1) return `${formatPreviewCount(previewTotalCharCount.value)} 字`;
  return `${formatPreviewCount(previewLineCount.value)} 行`;
});
const previewSearchMatchCount = computed(() => countTextMatches(previewContentForRender.value, previewSettings.searchKeyword));
const highlightedPreviewHtml = computed(() => highlightSearchInHtml(highlightCode(previewContentForRender.value || '暂无可预览内容', previewLanguage.value), previewSettings.searchKeyword));
const renderedMarkdownHtml = computed(() => highlightSearchInHtml(renderMarkdown(previewContentForRender.value || ''), previewSettings.searchKeyword));
const plainPreviewHtml = computed(() => highlightSearchInHtml(escapeHtml(previewContentForRender.value || '暂无可预览内容'), previewSettings.searchKeyword));
const previewLineNumbers = computed(() => Array.from({ length: previewVisibleLineCount.value || 1 }, (_, index) => index + 1));
const previewCodeStyle = computed(() => ({ '--preview-code-font-size': `${previewSettings.fontSize}px` }));

function resetPreviewViewport() {
  previewSettings.visibleLines = PREVIEW_INITIAL_LINES;
  previewSettings.visibleChars = PREVIEW_INITIAL_CHARS;
  previewSettings.searchKeyword = '';
  officeNativeState.error = '';
  destroyOfficeEditor();
}

function loadMorePreviewContent() {
  previewSettings.visibleLines = Math.min(previewLineCount.value || PREVIEW_INITIAL_LINES, previewSettings.visibleLines + PREVIEW_LOAD_LINES);
  previewSettings.visibleChars = Math.min(previewTotalCharCount.value || PREVIEW_INITIAL_CHARS, previewSettings.visibleChars + PREVIEW_LOAD_CHARS);
}

function showAllPreviewContent() {
  previewSettings.visibleLines = Math.max(previewLineCount.value, 1);
  previewSettings.visibleChars = Math.max(previewTotalCharCount.value, 1);
}

function destroyOfficeEditor() {
  try {
    officeEditorInstance?.destroyEditor?.();
  } catch {
    // ONLYOFFICE cleanup is best-effort because external script versions differ.
  }
  officeEditorInstance = null;
  officeNativeState.loading = false;
  if (officeEditorHost.value) officeEditorHost.value.innerHTML = '';
}

function loadOfficeApi(scriptUrl) {
  if (window.DocsAPI?.DocEditor && officeApiScriptUrl === scriptUrl) return Promise.resolve();
  if (officeApiScriptPromise && officeApiScriptUrl === scriptUrl) return officeApiScriptPromise;
  officeApiScriptUrl = scriptUrl;
  officeApiScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => {
      reject(new Error('Document Server API 加载超时，请检查 Office 预览服务地址和网络连通性'));
    }, 8000);
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timeout);
      window.DocsAPI?.DocEditor ? resolve() : reject(new Error('Document Server API 加载后未找到 DocsAPI'));
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('无法加载 Document Server API，请检查系统管理中的 Office 预览地址'));
    };
    document.head.appendChild(script);
  });
  officeApiScriptPromise.catch(() => {
    if (officeApiScriptUrl === scriptUrl) officeApiScriptPromise = null;
  });
  return officeApiScriptPromise;
}

async function mountOfficeEditor() {
  const native = previewDialog.data?.officePreview?.native;
  destroyOfficeEditor();
  officeNativeState.error = '';
  if (!previewDialog.visible || !native?.scriptUrl || !native?.config) return;
  officeNativeState.loading = true;
  try {
    await loadOfficeApi(native.scriptUrl);
    await nextTick();
    if (!officeEditorHost.value || previewDialog.data?.officePreview?.native !== native) return;
    const editorId = `office-editor-${Date.now()}`;
    officeEditorHost.value.innerHTML = `<div id="${editorId}" class="preview-office-editor-host"></div>`;
    officeEditorInstance = new window.DocsAPI.DocEditor(editorId, native.config);
  } catch (error) {
    officeNativeState.error = error.message || 'Office 原版预览加载失败，请检查 Document Server 是否可访问';
  } finally {
    officeNativeState.loading = false;
  }
}

function formatPreviewCount(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function flattenTree(items = []) {
  const result = [];
  const walk = (list) => {
    list.forEach((item) => {
      result.push(item);
      if (item.children?.length) walk(item.children);
    });
  };
  walk(items);
  return result;
}

function nodeFilename(node) {
  return String(node?.name || node?.currentVersion?.originalFilename || '').trim();
}

function nodeExtension(node) {
  const explicit = String(node?.extension || '').replace(/^\./, '').toLowerCase();
  if (explicit) return explicit;
  const name = nodeFilename(node);
  const index = name.lastIndexOf('.');
  return index > -1 ? name.slice(index + 1).toLowerCase() : '';
}

function detectPreviewLanguage(node, data) {
  if (!data || !['text', 'json'].includes(data.previewType)) return '';
  if (data.previewType === 'json') return 'json';
  const name = nodeFilename(node).toLowerCase();
  return CODE_LANGUAGE_BY_FILENAME[name] || CODE_LANGUAGE_BY_EXTENSION[nodeExtension(node)] || '';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countTextMatches(content, keyword) {
  const needle = String(keyword || '').trim();
  if (!needle || !content) return 0;
  const matches = String(content).match(new RegExp(escapeRegExp(needle), 'gi'));
  return matches?.length || 0;
}

function highlightSearchInHtml(html, keyword) {
  const needle = String(keyword || '').trim();
  if (!needle) return html;
  const escapedNeedle = escapeHtml(needle);
  const regex = new RegExp(escapeRegExp(escapedNeedle), 'gi');
  return String(html)
    .split(/(<[^>]+>)/g)
    .map((part) => part.startsWith('<') ? part : part.replace(regex, '<mark class="preview-search-mark">$&</mark>'))
    .join('');
}

function keywordPattern(words, flags = 'y') {
  return { className: 'keyword', regex: new RegExp(`\\b(${words.join('|')})\\b`, flags) };
}

function commonStringPatterns() {
  return [
    { className: 'string', regex: /&quot;(?:\\.|(?!&quot;)[\s\S])*?&quot;/y },
    { className: 'string', regex: /&#39;(?:\\.|(?!&#39;)[\s\S])*?&#39;/y },
    { className: 'string', regex: /`(?:\\.|[^`])*`/y }
  ];
}

function highlightPatterns(language) {
  if (language === 'html') {
    return [
      { className: 'comment', regex: /&lt;!--[\s\S]*?--&gt;/y },
      { className: 'tag', regex: /&lt;\/?[\w!:-]+(?:\s+[\w:-]+(?:=(?:&quot;[\s\S]*?&quot;|&#39;[\s\S]*?&#39;|[^\s&]+))?)*\s*\/?&gt;/y },
      ...commonStringPatterns()
    ];
  }
  if (language === 'json') {
    return [
      { className: 'property', regex: /&quot;(?:\\.|(?!&quot;)[\s\S])*?&quot;(?=\s*:)/y },
      ...commonStringPatterns(),
      keywordPattern(['true', 'false', 'null']),
      { className: 'number', regex: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy }
    ];
  }
  if (language === 'markdown') {
    return [
      { className: 'comment', regex: /```[\s\S]*?```/y },
      { className: 'keyword', regex: /^#{1,6}\s.*$/my },
      { className: 'string', regex: /\[[^\]]+\]\([^)]+\)/y },
      { className: 'number', regex: /^\s*(?:[-*+]|\d+\.)\s+/my },
      ...commonStringPatterns()
    ];
  }
  const lineComment = ['python', 'shell', 'yaml', 'ini', 'ruby'].includes(language)
    ? { className: 'comment', regex: /#.*/y }
    : language === 'sql'
      ? { className: 'comment', regex: /--.*/y }
      : { className: 'comment', regex: /\/\/.*/y };
  const keywords = {
    javascript: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'while'],
    typescript: ['abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'interface', 'keyof', 'let', 'namespace', 'new', 'null', 'number', 'private', 'protected', 'public', 'readonly', 'return', 'string', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'undefined', 'while'],
    python: ['and', 'as', 'async', 'await', 'break', 'class', 'continue', 'def', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'if', 'import', 'in', 'is', 'lambda', 'None', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield'],
    shell: ['case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'then', 'while'],
    sql: ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'INSERT', 'INTO', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX', 'VALUES', 'SET', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'OFFSET', 'HAVING', 'AS', 'ON'],
    java: ['abstract', 'break', 'case', 'catch', 'class', 'const', 'continue', 'data', 'default', 'do', 'else', 'enum', 'extends', 'false', 'final', 'finally', 'for', 'fun', 'if', 'implements', 'import', 'interface', 'new', 'null', 'object', 'override', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'throws', 'true', 'try', 'val', 'var', 'void', 'when', 'while'],
    go: ['break', 'case', 'chan', 'const', 'continue', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'],
    rust: ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'],
    php: ['abstract', 'array', 'as', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'echo', 'else', 'elseif', 'extends', 'false', 'final', 'finally', 'foreach', 'function', 'if', 'implements', 'interface', 'namespace', 'new', 'null', 'private', 'protected', 'public', 'return', 'static', 'switch', 'throw', 'trait', 'true', 'try', 'use', 'var', 'while'],
    ruby: ['BEGIN', 'END', 'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined', 'do', 'else', 'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo', 'rescue', 'retry', 'return', 'self', 'super', 'then', 'true', 'undef', 'unless', 'until', 'when', 'while', 'yield'],
    c: ['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'if', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while'],
    cpp: ['auto', 'bool', 'break', 'case', 'catch', 'class', 'const', 'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'false', 'float', 'for', 'friend', 'if', 'inline', 'int', 'long', 'namespace', 'new', 'nullptr', 'private', 'protected', 'public', 'return', 'short', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'using', 'virtual', 'void', 'while'],
    csharp: ['abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'case', 'catch', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'false', 'finally', 'for', 'foreach', 'if', 'in', 'int', 'interface', 'internal', 'is', 'namespace', 'new', 'null', 'object', 'out', 'override', 'private', 'protected', 'public', 'readonly', 'return', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'using', 'var', 'virtual', 'void', 'while'],
    swift: ['as', 'associatedtype', 'break', 'case', 'catch', 'class', 'continue', 'default', 'defer', 'do', 'else', 'enum', 'extension', 'false', 'for', 'func', 'guard', 'if', 'import', 'in', 'init', 'let', 'nil', 'private', 'protocol', 'public', 'return', 'self', 'static', 'struct', 'switch', 'throw', 'throws', 'true', 'try', 'typealias', 'var', 'where', 'while']
  }[language] || [];
  return [
    { className: 'comment', regex: /\/\*[\s\S]*?\*\//y },
    lineComment,
    ...commonStringPatterns(),
    ...(keywords.length ? [keywordPattern(keywords, language === 'sql' ? 'iy' : 'y')] : []),
    { className: 'number', regex: /\b\d+(?:\.\d+)?\b/y }
  ];
}

function highlightCode(content, language) {
  const escaped = escapeHtml(content || '暂无可预览内容');
  if (!language) return escaped;
  const patterns = highlightPatterns(language);
  let index = 0;
  let result = '';
  while (index < escaped.length) {
    let matched = false;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = index;
      const match = pattern.regex.exec(escaped);
      if (match) {
        result += `<span class="token ${pattern.className}">${match[0]}</span>`;
        index += match[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result += escaped[index];
      index += 1;
    }
  }
  return result;
}

function renderMarkdownInline(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, href) => {
    const safeHref = escapeHtml(href);
    return `<a href="${safeHref}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  return html;
}

function renderMarkdown(content) {
  const lines = String(content || '暂无可预览内容').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  let codeFence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.type === 'ol' ? 'ol' : 'ul';
    blocks.push(`<${tag}>${list.items.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join('')}</${tag}>`);
    list = null;
  };
  const flushCode = () => {
    if (!codeFence) return;
    const language = CODE_LANGUAGE_BY_EXTENSION[codeFence.language] || codeFence.language || '';
    const code = codeFence.lines.join('\n');
    const highlighted = language ? highlightCode(code, language) : escapeHtml(code);
    blocks.push(`<pre><code class="${language ? `language-${language}` : ''}">${highlighted}</code></pre>`);
    codeFence = null;
  };
  const flushFlow = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (codeFence) {
        flushCode();
      } else {
        flushFlow();
        codeFence = { language: (fence[1] || '').toLowerCase(), lines: [] };
      }
      continue;
    }
    if (codeFence) {
      codeFence.lines.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      flushFlow();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushFlow();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushFlow();
      blocks.push('<hr>');
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushFlow();
      blocks.push(`<blockquote>${renderMarkdownInline(quote[1])}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (!list || list.type !== 'ul') flushList();
      if (!list) list = { type: 'ul', items: [] };
      list.items.push(unordered[1]);
      continue;
    }
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (!list || list.type !== 'ol') flushList();
      if (!list) list = { type: 'ol', items: [] };
      list.items.push(ordered[1]);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushFlow();
  flushCode();
  return blocks.join('');
}

async function copyPreviewContent() {
  const text = previewDialog.data?.content || '';
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    ElMessage.success('已复制预览内容');
  } catch {
    ElMessage.error('复制失败，请手动选择复制');
  }
}

function adjustPreviewFontSize(delta) {
  previewSettings.fontSize = Math.max(11, Math.min(18, previewSettings.fontSize + delta));
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(bytes);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function qualityTagType(level) {
  return { excellent: 'success', good: 'primary', fair: 'warning', poor: 'danger' }[level] || 'info';
}

function reviewTagType(status) {
  return { normal: 'success', due_soon: 'warning', overdue: 'danger', not_scheduled: 'info' }[status] || 'info';
}

function reviewStatusLabel(status) {
  return { normal: '正常', due_soon: '即将到期', overdue: '已逾期', not_scheduled: '未设置' }[status] || '-';
}

function reviewConclusionLabel(conclusion) {
  return { valid: '内容有效', needs_update: '需要更新', retire: '停止使用' }[conclusion] || conclusion || '-';
}

function userName(userId) {
  const item = users.value.find((userItem) => userItem.id === userId);
  return item?.displayName || item?.username || userId || '-';
}

function businessStatusLabel(status) {
  return { draft: '草稿', effective: '有效', invalid: '作废', archived: '归档' }[status] || status || '-';
}

function securityLevelLabel(nodeOrLevel) {
  const level = typeof nodeOrLevel === 'string' ? nodeOrLevel : nodeOrLevel?.securityLevel;
  return { public: '公开', internal: '内部', restricted: '受限', confidential: '机密' }[level] || '-';
}

function approvalStatusLabel(status) {
  return { pending: '待审批', approved: '已通过', rejected: '已驳回', cancelled: '已取消' }[status] || status || '-';
}

function approvalStatusTag(status) {
  return { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' }[status] || 'info';
}

function versionActionLabel(action) {
  return {
    create: '初始上传',
    upload: '上传新版本',
    rollback: '版本回滚',
    external_create: '同步新增',
    external_update: '同步更新'
  }[action] || action || '-';
}

function nodeUnlockHeaders() {
  const tokens = Object.values(nodeUnlockTokens).filter(Boolean);
  return tokens.length ? { 'X-Node-Unlock': tokens.join(',') } : {};
}

async function requestUnlockPassword(node, errorData = {}) {
  return new Promise((resolve, reject) => {
    unlockDialog.node = node;
    unlockDialog.nodeName = errorData?.requiredNodeName || node?.name || '';
    unlockDialog.password = '';
    unlockDialog.resolve = resolve;
    unlockDialog.reject = reject;
    unlockDialog.visible = true;
  });
}

async function runWithPasswordUnlock(node, action) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (error.code !== 'NODE_PASSWORD_REQUIRED') throw error;
      await requestUnlockPassword(node, error.data || {});
    }
  }
  throw new Error('密码验证次数过多');
}

async function confirmUnlockPassword() {
  if (!unlockDialog.node || !unlockDialog.password) return ElMessage.warning('请输入访问密码');
  loading.value = true;
  try {
    const data = await api(`/nodes/${unlockDialog.node.id}/password/verify`, {
      method: 'POST',
      headers: nodeUnlockHeaders(),
      body: { password: unlockDialog.password }
    });
    nodeUnlockTokens[data.nodeId] = data.unlockToken;
    const resolve = unlockDialog.resolve;
    unlockDialog.visible = false;
    unlockDialog.resolve = null;
    unlockDialog.reject = null;
    ElMessage.success('验证通过');
    resolve?.(data);
  } finally {
    loading.value = false;
  }
}

function cancelUnlockPassword() {
  const reject = unlockDialog.reject;
  unlockDialog.visible = false;
  unlockDialog.resolve = null;
  unlockDialog.reject = null;
  reject?.(new Error('取消密码验证'));
}

async function login() {
  loading.value = true;
  try {
    const data = await api('/auth/login', { method: 'POST', body: loginForm });
    setToken(data.token);
    token.value = data.token;
    user.value = data.user;
    ElMessage.success('登录成功');
    await bootstrap();
  } catch (error) {
    await loadCaptcha();
    throw error;
  } finally {
    loading.value = false;
  }
}

async function loadCaptcha() {
  const data = await api('/auth/captcha');
  captcha.value = data;
  loginForm.captchaId = data.id;
  loginForm.captchaAnswer = '';
}

async function consumeSsoTicketFromUrl() {
  const currentUrl = new URL(window.location.href);
  const ticket = currentUrl.searchParams.get('ssoTicket');
  if (!ticket) return false;
  try {
    const data = await api(`/sso/consume?ticket=${encodeURIComponent(ticket)}`);
    setToken(data.token);
    token.value = data.token;
    user.value = data.user;
    currentUrl.searchParams.delete('ssoTicket');
    window.history.replaceState({}, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    await bootstrap();
    ElMessage.success('单点登录成功');
    return true;
  } catch (error) {
    currentUrl.searchParams.delete('ssoTicket');
    window.history.replaceState({}, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    ElMessage.error(error.message || '单点登录失败，请使用账号密码登录');
    return false;
  }
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    // ignored
  }
  setToken('');
  token.value = '';
  user.value = null;
}

async function bootstrap() {
  const me = await api('/auth/me');
  user.value = me.user;
  actions.value = me.actions;
  if (adminOnlyViews.has(activeView.value) && !isAdminUser.value) activeView.value = 'dashboard';
  const commonLoads = [loadOrg(), loadUsers(), loadKnowledge(), loadDashboard(), loadDocTree(), loadMessages(), loadCollaboration(), loadRecentAccess(), loadApprovals()];
  const adminLoads = isAdminUser.value ? [loadAnnouncements(), loadAudit(), loadExternalLibrary(), loadSecurityPolicy(), loadWecomSettings()] : [];
  await Promise.all([...commonLoads, ...adminLoads]);
}

async function loadDashboard() {
  dashboard.value = await api('/dashboard');
}

async function loadOrg() {
  const [deps, roles] = await Promise.all([api('/departments/tree'), api('/roles/tree')]);
  departmentTree.value = deps;
  roleTree.value = roles;
}

async function loadUsers() {
  const page = await api('/users?pageSize=300');
  users.value = page.items;
}

async function loadPermissionTemplates() {
  permissionTemplates.value = await api('/permission-templates');
}

async function loadDocTree() {
  docTree.value = await api('/nodes/tree', { headers: nodeUnlockHeaders() });
  const root = flattenTree(docTree.value).find((item) => item.id === 'n_root') || flattenTree(docTree.value)[0];
  if (!selectedFolder.value && root) await selectFolder(root);
}

async function selectFolder(node) {
  if (!node || node.nodeType !== 'folder') return;
  await runWithPasswordUnlock(node, async () => {
    const children = await api(`/nodes/${node.id}/children`, { headers: nodeUnlockHeaders() });
    selectedFolder.value = node;
    docChildren.value = children;
  });
}

async function loadPersonalDrive() {
  const [tree, summary] = await Promise.all([api('/personal-drive/tree', { headers: nodeUnlockHeaders() }), api('/personal-drive/summary')]);
  driveTree.value = tree;
  driveSummary.value = summary;
  const folders = flattenTree(driveTree.value);
  const root = folders[0];
  if (!selectedDriveFolder.value && root) await selectDriveFolder(root);
  else if (selectedDriveFolder.value) await selectDriveFolder(selectedDriveFolder.value);
}

async function selectDriveFolder(node) {
  if (!node || node.nodeType !== 'folder') return;
  await runWithPasswordUnlock(node, async () => {
    const children = await api(`/nodes/${node.id}/children`, { headers: nodeUnlockHeaders() });
    selectedDriveFolder.value = node;
    driveChildren.value = children;
  });
}

async function loadMessages() {
  const page = await api('/messages?pageSize=100');
  messages.value = page.items;
}

async function loadAudit() {
  try {
    const page = await api('/audit-logs?pageSize=100');
    auditLogs.value = page.items;
  } catch {
    auditLogs.value = [];
  }
}

async function loadKnowledge() {
  const [categories, properties] = await Promise.all([api('/categories/tree'), api('/property-definitions')]);
  categoryTree.value = categories;
  propertyDefinitions.value = properties;
  if (selectedCategory.value) await selectCategory(selectedCategory.value);
}

async function selectCategory(category) {
  selectedCategory.value = category;
  const page = await api(`/categories/${category.id}/files?pageSize=100`);
  categoryFiles.value = page.items;
}

async function loadTrash() {
  const page = await api('/trash?pageSize=200');
  trashItems.value = page.items;
}

async function loadCollaboration() {
  const [sharePage, subItems, reminderItems] = await Promise.all([
    api('/shares?pageSize=200'),
    api('/subscriptions'),
    api('/reminders')
  ]);
  shares.value = sharePage.items;
  subscriptions.value = subItems;
  reminders.value = reminderItems;
}

async function loadAnnouncements() {
  const page = await api('/announcements?pageSize=200');
  announcements.value = page.items;
}

async function loadApiManagement() {
  const [credentialPage, logPage, policy] = await Promise.all([
    api('/api-credentials?pageSize=200'),
    api('/api-call-logs?pageSize=200'),
    api('/system-settings/file-policy')
  ]);
  apiCredentials.value = credentialPage.items;
  apiCallLogs.value = logPage.items;
  filePolicy.value = policy;
}

async function loadExternalLibrary() {
  if (!isAdminUser.value) return;
  const [settings, jobs] = await Promise.all([
    api('/system-settings/external-library'),
    api('/external-library/sync-jobs?pageSize=8')
  ]);
  externalLibrary.value = settings;
  externalLibraryDialog.syncJobs = jobs.items || [];
}

async function loadStorageSettings() {
  if (!isAdminUser.value) return;
  storageSettings.value = await api('/system-settings/storage');
}

async function loadSecurityPolicy() {
  if (!isAdminUser.value) return;
  securityPolicy.value = await api('/system-settings/security-policy');
}

async function loadWecomSettings() {
  if (!isAdminUser.value) return;
  wecomSettings.value = await api('/system-settings/wecom');
}

async function loadOfficePreviewSettings() {
  if (!isAdminUser.value) return;
  officePreviewSettings.value = await api('/system-settings/office-preview');
}

async function loadSearchIndexStatus() {
  if (!isAdminUser.value) return;
  searchIndexStatus.value = await api('/search/index/status');
}

async function loadRuntimeStatus() {
  if (!isAdminUser.value) return;
  runtimeStatus.value = await api('/system/runtime-status');
}

async function loadAuditReport() {
  if (!isAdminUser.value) return;
  auditReport.value = await api('/audit-logs/report');
}

async function loadGovernanceSearchAnalytics(days = 30) {
  if (!isAdminUser.value) return;
  governanceSearchDays.value = Number(days || 30);
  governanceSearchAnalytics.value = await api(`/governance/search-analytics?days=${encodeURIComponent(governanceSearchDays.value)}`);
}

async function loadGovernance() {
  if (!isAdminUser.value) return;
  const [summary, qualityPage, duplicateResult, reviewPage, analytics] = await Promise.all([
    api('/governance/dashboard'),
    api('/governance/quality?pageSize=500'),
    api('/governance/duplicates'),
    api('/governance/reviews?pageSize=500'),
    api(`/governance/search-analytics?days=${encodeURIComponent(governanceSearchDays.value)}`)
  ]);
  governanceDashboard.value = summary;
  governanceQualityItems.value = qualityPage.items || [];
  governanceDuplicateData.value = duplicateResult;
  governanceReviewItems.value = reviewPage.items || [];
  governanceSearchAnalytics.value = analytics;
}

async function loadApprovals() {
  const [todo, mine, all] = await Promise.all([
    api('/approvals?scope=todo&pageSize=200'),
    api('/approvals?scope=mine&pageSize=200'),
    isAdminUser.value ? api('/approvals?scope=all&pageSize=200') : Promise.resolve({ items: [] })
  ]);
  approvalTodo.value = todo.items || [];
  approvalMine.value = mine.items || [];
  approvalAll.value = all.items || [];
}

async function loadRecentAccess() {
  const page = await api('/recent-access?pageSize=10');
  recentAccesses.value = page.items || [];
}

async function loadSystemManagement() {
  if (!isAdminUser.value) return;
  await Promise.all([
    loadDashboard(),
    loadAudit(),
    loadApiManagement(),
    loadExternalLibrary(),
    loadStorageSettings(),
    loadSecurityPolicy(),
    loadWecomSettings(),
    loadOfficePreviewSettings(),
    loadSearchIndexStatus(),
    loadRuntimeStatus(),
    loadAuditReport()
  ]);
}

async function switchView(view) {
  if (adminOnlyViews.has(view) && !isAdminUser.value) {
    ElMessage.warning('当前账号没有访问该管理模块的权限');
    return;
  }
  activeView.value = view;
  await refreshCurrent();
  await nextTick();
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

async function refreshCurrent() {
  if (activeView.value === 'dashboard') await loadDashboard();
  if (activeView.value === 'docs') {
    await loadDocTree();
    if (selectedFolder.value) await selectFolder(selectedFolder.value);
  }
  if (activeView.value === 'drive') await loadPersonalDrive();
  if (activeView.value === 'users' && isAdminUser.value) await loadUsers();
  if (activeView.value === 'org' && isAdminUser.value) await loadOrg();
  if (activeView.value === 'knowledge') await loadKnowledge();
  if (activeView.value === 'trash') await loadTrash();
  if (activeView.value === 'messages') await loadMessages();
  if (activeView.value === 'collaboration') await loadCollaboration();
  if (activeView.value === 'approvals') await loadApprovals();
  if (activeView.value === 'announcements' && isAdminUser.value) await loadAnnouncements();
  if (activeView.value === 'api' && isAdminUser.value) {
    await loadUsers();
    await loadApiManagement();
  }
  if (activeView.value === 'governance' && isAdminUser.value) await loadGovernance();
  if (activeView.value === 'system' && isAdminUser.value) await loadSystemManagement();
  if (activeView.value === 'audit' && isAdminUser.value) await loadAudit();
  if (activeView.value === 'profile') {
    const me = await api('/auth/me');
    user.value = me.user;
    actions.value = me.actions;
  }
}

function openFolderDialog() {
  folderDialog.name = '';
  folderDialog.visible = true;
}

async function createFolder() {
  const fallbackParent = activeView.value === 'drive' ? selectedDriveFolder.value?.id : 'n_root';
  await api('/folders', { method: 'POST', headers: nodeUnlockHeaders(), body: { parentId: activeFolder.value?.id || fallbackParent || 'n_root', name: folderDialog.name } });
  folderDialog.visible = false;
  ElMessage.success('文件夹已创建');
  await refreshCurrent();
}

function openUploadDialog() {
  uploadDialog.files = [];
  uploadDialog.description = '初始版本';
  uploadDialog.visible = true;
}

function onUploadFileChange(_file, files) {
  uploadDialog.files = files.map((item) => item.raw).filter(Boolean);
}

function onUploadFileRemove(_file, files) {
  uploadDialog.files = files.map((item) => item.raw).filter(Boolean);
}

async function uploadFile() {
  if (!uploadDialog.files.length) return ElMessage.warning('请选择文件');
  loading.value = true;
  try {
    for (const file of uploadDialog.files) {
      const form = new FormData();
      form.append('parentId', activeFolder.value?.id || 'n_root');
      form.append('description', uploadDialog.description || '初始版本');
      form.append('file', file);
      await api('/files', { method: 'POST', headers: nodeUnlockHeaders(), body: form });
    }
    uploadDialog.visible = false;
    ElMessage.success('上传成功');
    await refreshCurrent();
  } finally {
    loading.value = false;
  }
}

async function renameNode(node) {
  const { value } = await ElMessageBox.prompt('请输入新名称', '重命名', {
    inputValue: node.name,
    inputValidator: (value) => Boolean(value?.trim()) || '名称不能为空'
  });
  await runWithPasswordUnlock(node, async () => {
    await api(`/nodes/${node.id}/rename`, { method: 'PUT', headers: nodeUnlockHeaders(), body: { name: value } });
  });
  ElMessage.success('已重命名');
  await refreshCurrent();
}

async function deleteNode(node) {
  await ElMessageBox.confirm(`确定删除“${node.name}”吗？`, '删除确认', { type: 'warning' });
  await runWithPasswordUnlock(node, async () => {
    await api(`/nodes/${node.id}`, { method: 'DELETE', headers: nodeUnlockHeaders() });
  });
  ElMessage.success('已删除');
  await refreshCurrent();
}

async function downloadNode(node, versionId = null) {
  if (!node?.id) {
    ElMessage.warning('请先选择要下载的文件或文件夹');
    return;
  }
  if (node.nodeType === 'file' && !node.currentVersion && !versionId) {
    ElMessage.warning('当前文件没有可下载版本');
    return;
  }
  try {
    await runWithPasswordUnlock(node, async () => {
      if (node.nodeType === 'folder') {
        await downloadFile('/files/batch-download', `${node.name}.zip`, { nodeIds: [node.id] }, { headers: nodeUnlockHeaders() });
        return;
      }
      const suffix = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
      await downloadFile(`/files/${node.id}/download${suffix}`, node.name, null, { headers: nodeUnlockHeaders() });
    });
    await loadRecentAccess();
  } catch (error) {
    if (error.code === 'SENSITIVE_DOWNLOAD_BLOCKED') {
      openDownloadApprovalDialog(node);
      return;
    }
    throw error;
  }
}

async function batchDownload(rows) {
  if (!rows.length) return ElMessage.warning('请选择要下载的文件或文件夹');
  try {
    await runWithPasswordUnlock(rows[0], async () => {
      await downloadFile('/files/batch-download', '文档打包下载.zip', { nodeIds: rows.map((item) => item.id) }, { headers: nodeUnlockHeaders() });
    });
    await loadRecentAccess();
  } catch (error) {
    if (error.code === 'SENSITIVE_DOWNLOAD_BLOCKED') {
      ElMessage.warning(error.message || '批量下载中包含受控敏感文件');
      return;
    }
    throw error;
  }
}

function openBatchMetadataDialog(rows) {
  if (!rows.length) return ElMessage.warning('请选择要批量编辑的文件或文件夹');
  batchMetadataDialog.rows = rows;
  batchMetadataDialog.tagsText = '';
  batchMetadataDialog.businessStatus = '';
  batchMetadataDialog.securityLevel = '';
  batchMetadataDialog.sensitiveMode = 'keep';
  batchMetadataDialog.sensitiveReason = '';
  batchMetadataDialog.visible = true;
}

async function saveBatchMetadata() {
  const body = { nodeIds: batchMetadataDialog.rows.map((item) => item.id) };
  const tags = String(batchMetadataDialog.tagsText || '').split(/[,\s，]+/).map((item) => item.trim()).filter(Boolean);
  if (tags.length) body.tags = tags;
  if (batchMetadataDialog.businessStatus) body.businessStatus = batchMetadataDialog.businessStatus;
  if (batchMetadataDialog.securityLevel) body.securityLevel = batchMetadataDialog.securityLevel;
  if (batchMetadataDialog.sensitiveMode !== 'keep') body.sensitive = batchMetadataDialog.sensitiveMode === 'true';
  if (batchMetadataDialog.sensitiveReason.trim()) body.sensitiveReason = batchMetadataDialog.sensitiveReason.trim();
  await api('/nodes/batch-metadata', { method: 'PUT', headers: nodeUnlockHeaders(), body });
  batchMetadataDialog.visible = false;
  ElMessage.success('批量属性已更新');
  await refreshCurrent();
}

function openMoveDialog(node, mode = 'move') {
  moveDialog.node = node;
  moveDialog.nodes = [];
  moveDialog.mode = mode;
  moveDialog.space = activeView.value === 'drive' ? 'drive' : 'docs';
  moveDialog.targetId = activeFolder.value?.id || 'n_root';
  moveDialog.visible = true;
}

function openCopyToEnterpriseDialog(node) {
  moveDialog.node = node;
  moveDialog.nodes = [];
  moveDialog.mode = 'copy-enterprise';
  moveDialog.space = 'docs';
  moveDialog.targetId = selectedFolder.value?.id || 'n_root';
  moveDialog.visible = true;
}

function openBatchMoveDialog(rows) {
  if (!rows.length) return ElMessage.warning('请选择要移动的文件或文件夹');
  moveDialog.node = null;
  moveDialog.nodes = rows;
  moveDialog.mode = 'batch-move';
  moveDialog.space = activeView.value === 'drive' ? 'drive' : 'docs';
  moveDialog.targetId = activeFolder.value?.id || 'n_root';
  moveDialog.visible = true;
}

async function executeMoveCopy() {
  if (!moveDialog.targetId) return ElMessage.warning('请选择目标目录');
  if (moveDialog.mode === 'batch-move') {
    if (!moveDialog.nodes.length) return ElMessage.warning('请选择要移动的文件或文件夹');
    await runWithPasswordUnlock(moveDialog.nodes[0], async () => {
      await api('/nodes/batch-move', { method: 'POST', headers: nodeUnlockHeaders(), body: { nodeIds: moveDialog.nodes.map((item) => item.id), targetParentId: moveDialog.targetId } });
    });
  } else {
    if (!moveDialog.node) return ElMessage.warning('请选择要处理的对象');
    const url = moveDialog.mode === 'copy' || moveDialog.mode === 'copy-enterprise' ? `/nodes/${moveDialog.node.id}/copy` : `/nodes/${moveDialog.node.id}/move`;
    await runWithPasswordUnlock(moveDialog.node, async () => {
      await api(url, { method: 'POST', headers: nodeUnlockHeaders(), body: { targetParentId: moveDialog.targetId } });
    });
  }
  moveDialog.visible = false;
  ElMessage.success(moveDialog.mode === 'copy' ? '已复制' : '已移动');
  await refreshCurrent();
}

async function batchDelete(rows) {
  if (!rows.length) return ElMessage.warning('请选择要删除的文件或文件夹');
  await ElMessageBox.confirm(`确定删除选中的 ${rows.length} 个项目吗？`, '批量删除确认', { type: 'warning' });
  await runWithPasswordUnlock(rows[0], async () => {
    await api('/nodes/batch-delete', { method: 'POST', headers: nodeUnlockHeaders(), body: { nodeIds: rows.map((item) => item.id) } });
  });
  ElMessage.success('已批量删除');
  await refreshCurrent();
}

function applyPreviewSearchKeyword(keyword) {
  const searchKeyword = String(keyword || '').trim();
  if (!searchKeyword) return;
  previewSettings.searchKeyword = searchKeyword;
  const visibleContent = previewContentForRender.value.toLowerCase();
  if (!visibleContent.includes(searchKeyword.toLowerCase())) showAllPreviewContent();
}

async function previewNode(node, versionId = null, options = {}) {
  if (!node) return;
  await runWithPasswordUnlock(node, async () => {
    previewDialog.node = node;
    previewDialog.data = null;
    previewDialog.loading = true;
    previewDialog.visible = true;
    resetPreviewViewport();
    const suffix = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
    try {
      previewDialog.data = await api(`/files/${node.id}/preview${suffix}`, { headers: nodeUnlockHeaders() });
      await nextTick();
      applyPreviewSearchKeyword(options.searchKeyword || node.searchMatch?.keyword || '');
      previewDialog.loading = false;
      void Promise.allSettled([markUploadMessagesRead(node), loadRecentAccess()]);
    } catch (error) {
      previewDialog.visible = false;
      throw error;
    } finally {
      previewDialog.loading = false;
    }
  });
}

async function markUploadMessagesRead(node) {
  if (!node?.hasUnread || node.nodeType !== 'file') return;
  const result = await api(`/files/${node.id}/read-upload-messages`, { method: 'POST', headers: nodeUnlockHeaders() });
  if (!result?.readCount) return;
  await Promise.all([loadMessages(), loadDashboard()]);
  if ((node.spaceType || 'enterprise') === 'personal') {
    await loadPersonalDrive();
    return;
  }
  await loadDocTree();
  if (selectedFolder.value) await selectFolder(selectedFolder.value);
}

async function lockNode(node) {
  await api(`/files/${node.id}/lock`, { method: 'POST' });
  ElMessage.success('文件已锁定');
  await refreshCurrent();
}

async function unlockNode(node) {
  await api(`/files/${node.id}/unlock`, { method: 'POST' });
  ElMessage.success('文件已解锁');
  await refreshCurrent();
}

async function favoriteNode(node) {
  await api('/favorites', { method: 'POST', body: { nodeId: node.id } });
  ElMessage.success('已收藏');
  await loadDashboard();
}

async function openVersionDialog(node) {
  await runWithPasswordUnlock(node, async () => {
    versionDialog.node = node;
    const [versions, logs] = await Promise.all([
      api(`/files/${node.id}/versions`, { headers: nodeUnlockHeaders() }),
      api(`/files/${node.id}/version-logs`, { headers: nodeUnlockHeaders() })
    ]);
    versionDialog.items = versions;
    versionDialog.logs = logs;
    versionDialog.file = null;
    versionDialog.description = '';
    versionDialog.visible = true;
  });
}

function onVersionFileChange(file) {
  versionDialog.file = file.raw;
}

function onVersionFileRemove() {
  versionDialog.file = null;
}

async function uploadVersion() {
  if (!versionDialog.file) return ElMessage.warning('请选择新版本文件');
  const form = new FormData();
  form.append('description', versionDialog.description || '上传更新');
  form.append('unlock', 'true');
  form.append('file', versionDialog.file);
  loading.value = true;
  try {
    await api(`/files/${versionDialog.node.id}/versions`, { method: 'POST', headers: nodeUnlockHeaders(), body: form });
    ElMessage.success('新版本已保存');
    await openVersionDialog(versionDialog.node);
    await refreshCurrent();
  } finally {
    loading.value = false;
  }
}

async function rollbackVersion(row) {
  await ElMessageBox.confirm(`确定回滚到版本 ${row.versionNo} 吗？`, '版本回滚', { type: 'warning' });
  await api(`/files/${versionDialog.node.id}/versions/${row.id}/rollback`, { method: 'POST', headers: nodeUnlockHeaders() });
  ElMessage.success('已回滚');
  await openVersionDialog(versionDialog.node);
  await refreshCurrent();
}

function defaultWorkflowApproverId() {
  return users.value.find((item) => (item.roleIds || []).includes('r_admin'))?.id || users.value[0]?.id || '';
}

async function loadWorkflowDialogData() {
  if (!workflowDialog.node) return;
  const data = await api(`/nodes/${workflowDialog.node.id}/workflow`, { headers: nodeUnlockHeaders() });
  workflowDialog.node = data.node;
  workflowDialog.approvals = data.approvals || [];
}

async function openWorkflowDialog(node) {
  await runWithPasswordUnlock(node, async () => {
    workflowDialog.node = node;
    workflowDialog.action = node.businessStatus === 'archived' ? 'publish' : 'archive';
    workflowDialog.approverId = defaultWorkflowApproverId();
    workflowDialog.comment = '';
    await loadWorkflowDialogData();
    workflowDialog.visible = true;
  });
}

async function submitWorkflowApproval() {
  if (!workflowDialog.node) return;
  if (!workflowDialog.approverId) return ElMessage.warning('请选择审批人');
  await api(`/nodes/${workflowDialog.node.id}/approvals`, {
    method: 'POST',
    headers: nodeUnlockHeaders(),
    body: {
      action: workflowDialog.action,
      approverId: workflowDialog.approverId,
      comment: workflowDialog.comment
    }
  });
  ElMessage.success('审批已提交');
  workflowDialog.comment = '';
  await loadWorkflowDialogData();
  await Promise.all([loadMessages(), refreshCurrent()]);
}

async function executeWorkflowAction() {
  if (!workflowDialog.node) return;
  await ElMessageBox.confirm(`确定直接${workflowActionOptions.find((item) => item.value === workflowDialog.action)?.label || '执行'}吗？`, '流程确认', { type: 'warning' });
  const data = await api(`/nodes/${workflowDialog.node.id}/workflow-actions`, {
    method: 'POST',
    headers: nodeUnlockHeaders(),
    body: { action: workflowDialog.action, comment: workflowDialog.comment }
  });
  workflowDialog.node = data.node;
  workflowDialog.comment = '';
  ElMessage.success('流程状态已更新');
  await loadWorkflowDialogData();
  await refreshCurrent();
}

async function decideWorkflowApproval(row, decision) {
  const { value } = await ElMessageBox.prompt('请输入处理说明', decision === 'approve' ? '审批通过' : '审批驳回', {
    inputValue: '',
    inputPlaceholder: '可选'
  });
  await api(`/approvals/${row.id}/${decision}`, {
    method: 'POST',
    headers: nodeUnlockHeaders(),
    body: { comment: value || '' }
  });
  ElMessage.success(decision === 'approve' ? '已通过审批' : '已驳回审批');
  await loadWorkflowDialogData();
  await Promise.all([loadMessages(), refreshCurrent()]);
}

async function decideGeneralApproval(row, decision) {
  const { value } = await ElMessageBox.prompt('请输入处理说明', decision === 'approve' ? '审批通过' : '审批驳回', {
    inputValue: '',
    inputPlaceholder: '可选'
  });
  await api(`/approvals/${row.id}/${decision}`, {
    method: 'POST',
    headers: nodeUnlockHeaders(),
    body: { comment: value || '' }
  });
  ElMessage.success(decision === 'approve' ? '已通过审批' : '已驳回审批');
  await Promise.all([loadApprovals(), loadMessages(), refreshCurrent()]);
}

function openApprovalRequest(node, type = 'download') {
  approvalRequestDialog.node = node;
  approvalRequestDialog.type = type;
  approvalRequestDialog.approverId = defaultWorkflowApproverId();
  approvalRequestDialog.requestedActions = type === 'permission' ? ['visible', 'file:preview'] : ['file:download'];
  approvalRequestDialog.reason = type === 'download' && node?.sensitive ? '因工作需要申请下载敏感文件' : '';
  approvalRequestDialog.visible = true;
}

function openDownloadApprovalDialog(node) {
  openApprovalRequest(node, 'download');
}

async function submitApprovalRequest() {
  if (!approvalRequestDialog.node) return;
  if (!approvalRequestDialog.approverId) return ElMessage.warning('请选择审批人');
  const body = {
    nodeId: approvalRequestDialog.node.id,
    type: approvalRequestDialog.type,
    approverId: approvalRequestDialog.approverId,
    reason: approvalRequestDialog.reason
  };
  if (approvalRequestDialog.type === 'permission') body.requestedActions = approvalRequestDialog.requestedActions;
  await api('/approvals', { method: 'POST', headers: nodeUnlockHeaders(), body });
  approvalRequestDialog.visible = false;
  ElMessage.success('审批申请已提交');
  await Promise.all([loadApprovals(), loadMessages()]);
}

async function openPermissionDialog(node) {
  permissionDialog.node = node;
  const [rules] = await Promise.all([
    api(`/nodes/${node.id}/permission-rules`),
    loadPermissionTemplates()
  ]);
  permissionDialog.rules = rules;
  permissionDialog.editingId = null;
  permissionDialog.templateId = '';
  permissionDialog.batch = defaultPermissionBatchForm();
  permissionDialog.previewUserId = users.value[0]?.id || '';
  permissionDialog.previewActions = [];
  permissionDialog.form = defaultPermissionForm();
  permissionDialog.visible = true;
}

function defaultPermissionBatchForm() {
  return { subjectType: 'role', subjectIds: [], replaceExisting: false };
}

function defaultPermissionForm() {
  return {
    subjectType: 'role',
    subjectId: flatRoles.value[0]?.id || '',
    actions: ['visible', 'file:preview', 'file:download'],
    effect: 'allow',
    scope: 'all',
    priority: 100,
    inheritEnabled: true,
    condition: { filenameContains: '', pathPrefix: '', extensions: '', businessStatus: '' }
  };
}

function permissionTemplateToForm(template, current = permissionDialog.form) {
  return {
    ...current,
    actions: [...(template.actions || [])],
    effect: template.effect || 'allow',
    scope: template.scope || 'all',
    priority: Number(template.priority || 100),
    inheritEnabled: template.inheritEnabled !== false,
    condition: {
      filenameContains: template.condition?.filenameContains || '',
      pathPrefix: template.condition?.pathPrefix || '',
      extensions: Array.isArray(template.condition?.extensions) ? template.condition.extensions.join(',') : '',
      businessStatus: template.condition?.businessStatus || ''
    }
  };
}

function hydratePermissionForm(row) {
  return {
    subjectType: row.subjectType || 'role',
    subjectId: row.subjectId || '',
    actions: [...(row.actions || [])],
    effect: row.effect || 'allow',
    scope: row.scope || 'all',
    priority: Number(row.priority || 100),
    inheritEnabled: row.inheritEnabled !== false,
    condition: {
      filenameContains: row.condition?.filenameContains || '',
      pathPrefix: row.condition?.pathPrefix || '',
      extensions: Array.isArray(row.condition?.extensions) ? row.condition.extensions.join(',') : '',
      businessStatus: row.condition?.businessStatus || ''
    }
  };
}

function onBatchSubjectTypeChange() {
  permissionDialog.batch.subjectIds = [];
}

function applySelectedPermissionTemplate() {
  if (!selectedPermissionTemplate.value) return ElMessage.warning('请选择权限模板');
  permissionDialog.form = permissionTemplateToForm(selectedPermissionTemplate.value);
  ElMessage.success('已套用模板');
}

function buildPermissionPayload() {
  const form = permissionDialog.form;
  const extensions = String(form.condition.extensions || '')
    .split(/[,\s，]+/)
    .map((item) => item.replace(/^\./, '').trim().toLowerCase())
    .filter(Boolean);
  return {
    subjectType: form.subjectType,
    subjectId: form.subjectType === 'all' ? null : form.subjectId,
    actions: form.actions,
    effect: form.effect,
    scope: form.scope,
    priority: form.priority,
    inheritEnabled: form.inheritEnabled,
    condition: {
      filenameContains: form.condition.filenameContains,
      pathPrefix: form.condition.pathPrefix,
      extensions,
      businessStatus: form.condition.businessStatus
    }
  };
}

function buildTemplatePayloadFromForm(name) {
  const payload = buildPermissionPayload();
  return {
    name,
    description: '',
    actions: payload.actions,
    effect: payload.effect,
    scope: payload.scope,
    priority: payload.priority,
    inheritEnabled: payload.inheritEnabled,
    condition: payload.condition
  };
}

function editPermission(row) {
  permissionDialog.editingId = row.id;
  permissionDialog.form = hydratePermissionForm(row);
}

function cancelPermissionEdit() {
  permissionDialog.editingId = null;
  permissionDialog.form = defaultPermissionForm();
}

async function saveCurrentPermissionTemplate() {
  const { value } = await ElMessageBox.prompt('请输入模板名称', '保存权限模板', {
    inputValidator: (value) => Boolean(value?.trim()) || '模板名称不能为空'
  });
  const template = await api('/permission-templates', { method: 'POST', body: buildTemplatePayloadFromForm(value.trim()) });
  await loadPermissionTemplates();
  permissionDialog.templateId = template.id;
  ElMessage.success('权限模板已保存');
}

async function deleteSelectedPermissionTemplate() {
  const template = selectedPermissionTemplate.value;
  if (!template || template.systemBuiltIn) return;
  await ElMessageBox.confirm(`确定删除模板“${template.name}”吗？`, '删除权限模板', { type: 'warning' });
  await api(`/permission-templates/${template.id}`, { method: 'DELETE' });
  permissionDialog.templateId = '';
  await loadPermissionTemplates();
  ElMessage.success('权限模板已删除');
}

async function savePermission() {
  const payload = buildPermissionPayload();
  if (payload.subjectType !== 'all' && !payload.subjectId) return ElMessage.warning('请选择授权对象');
  if (permissionDialog.editingId) {
    await api(`/permission-rules/${permissionDialog.editingId}`, { method: 'PUT', body: payload });
    ElMessage.success('权限规则已更新');
  } else {
    await api(`/nodes/${permissionDialog.node.id}/permission-rules`, { method: 'POST', body: payload });
    ElMessage.success('权限规则已添加');
  }
  permissionDialog.rules = await api(`/nodes/${permissionDialog.node.id}/permission-rules`);
  permissionDialog.editingId = null;
  permissionDialog.form = defaultPermissionForm();
}

async function batchApplyPermission() {
  if (!permissionDialog.node) return;
  const batch = permissionDialog.batch;
  if (batch.subjectType !== 'all' && !batch.subjectIds.length) return ElMessage.warning('请选择批量授权对象');
  const defaults = permissionDialog.templateId ? {} : buildPermissionPayload();
  const payload = {
    ...defaults,
    templateId: permissionDialog.templateId || undefined,
    subjectType: batch.subjectType,
    subjectIds: batch.subjectType === 'all' ? [] : batch.subjectIds,
    replaceExisting: batch.replaceExisting
  };
  const result = await api(`/nodes/${permissionDialog.node.id}/permission-rules/batch`, { method: 'POST', body: payload });
  permissionDialog.rules = await api(`/nodes/${permissionDialog.node.id}/permission-rules`);
  ElMessage.success(`已添加 ${result.created.length} 条权限规则`);
  await refreshCurrent();
}

async function deletePermission(row) {
  await api(`/permission-rules/${row.id}`, { method: 'DELETE' });
  ElMessage.success('权限规则已删除');
  permissionDialog.rules = await api(`/nodes/${permissionDialog.node.id}/permission-rules`);
  if (permissionDialog.editingId === row.id) cancelPermissionEdit();
}

async function previewPermission() {
  if (!permissionDialog.node || !permissionDialog.previewUserId) return ElMessage.warning('请选择用户');
  const data = await api(`/nodes/${permissionDialog.node.id}/permissions/effective?userId=${encodeURIComponent(permissionDialog.previewUserId)}`);
  permissionDialog.previewActions = data.actions || [];
}

async function openExternalLibraryDialog() {
  if (!isAdminUser.value) {
    await syncExternalLibrary();
    return;
  }
  await loadExternalLibrary();
  externalLibraryDialog.rootPath = externalLibrary.value.rootPath || '';
  externalLibraryDialog.includePathsText = (externalLibrary.value.includePaths || []).join('\n');
  externalLibraryDialog.excludePatternsText = (externalLibrary.value.excludePatterns || []).join('\n');
  externalLibraryDialog.visible = true;
}

function optionLines(text) {
  return String(text || '').split(/\n+/).map((item) => item.trim()).filter(Boolean);
}

async function saveExternalLibrary() {
  externalLibrary.value = await api('/system-settings/external-library', {
    method: 'PUT',
    body: {
      rootPath: externalLibraryDialog.rootPath,
      includePaths: optionLines(externalLibraryDialog.includePathsText),
      excludePatterns: optionLines(externalLibraryDialog.excludePatternsText)
    }
  });
  await loadExternalLibrary();
  ElMessage.success('服务器目录路径已保存');
}

async function openStorageDialog() {
  await loadStorageSettings();
  const mysql = storageSettings.value?.mysql || {};
  storageDialog.form = {
    provider: storageSettings.value?.provider || 'json',
    host: mysql.host || '',
    port: mysql.port || 3306,
    database: mysql.database || '',
    user: mysql.user || '',
    password: '',
    ssl: Boolean(mysql.ssl)
  };
  storageDialog.hasPassword = Boolean(mysql.hasPassword);
  storageDialog.testResult = null;
  storageDialog.visible = true;
}

function storagePayload() {
  return {
    provider: storageDialog.form.provider,
    mysql: {
      host: storageDialog.form.host,
      port: storageDialog.form.port,
      database: storageDialog.form.database,
      user: storageDialog.form.user,
      password: storageDialog.form.password,
      ssl: storageDialog.form.ssl
    }
  };
}

async function testStorageConnection() {
  if (storageDialog.form.provider !== 'mysql') return;
  storageDialog.testing = true;
  try {
    storageDialog.testResult = await api('/system-settings/storage/test', { method: 'POST', body: storagePayload() });
    ElMessage.success('MySQL 连接成功');
  } finally {
    storageDialog.testing = false;
  }
}

async function saveStorageSettings() {
  loading.value = true;
  try {
    storageSettings.value = await api('/system-settings/storage', { method: 'PUT', body: storagePayload() });
    storageDialog.visible = false;
    ElMessage.success('数据库连接配置已保存');
    await loadSystemManagement();
  } finally {
    loading.value = false;
  }
}

async function syncStorageToMysql() {
  await ElMessageBox.confirm('确定把当前系统账本同步到已配置的 MySQL 吗？', '同步确认', { type: 'warning' });
  loading.value = true;
  try {
    const result = await api('/system-settings/storage/sync', { method: 'POST' });
    storageSettings.value = result.storage;
    ElMessage.success('当前账本已同步到 MySQL');
    await loadSystemManagement();
  } finally {
    loading.value = false;
  }
}

function openSecurityDialog(node) {
  securityDialog.node = node;
  securityDialog.form = {
    securityLevel: node.securityLevel || 'internal',
    sensitive: Boolean(node.sensitive),
    sensitiveReason: node.sensitiveReason || ''
  };
  securityDialog.visible = true;
}

async function saveNodeSecurity() {
  if (!securityDialog.node) return;
  loading.value = true;
  try {
    const updated = await api(`/nodes/${securityDialog.node.id}/security`, {
      method: 'PUT',
      headers: nodeUnlockHeaders(),
      body: securityDialog.form
    });
    securityDialog.visible = false;
    ElMessage.success('安全设置已保存');
    metadataDialog.node = metadataDialog.node?.id === updated.id ? updated : metadataDialog.node;
    await refreshCurrent();
  } finally {
    loading.value = false;
  }
}

async function refreshGovernanceDialogData() {
  const node = governanceDialog.node;
  if (!node) return;
  const [qualityResult, reviewResult, historyPage] = await runWithPasswordUnlock(node, () => Promise.all([
    api(`/nodes/${node.id}/quality`, { headers: nodeUnlockHeaders() }),
    api(`/nodes/${node.id}/review`, { headers: nodeUnlockHeaders() }),
    api(`/nodes/${node.id}/review-history?pageSize=100`, { headers: nodeUnlockHeaders() })
  ]));
  governanceDialog.node = reviewResult.node || qualityResult.node || node;
  governanceDialog.quality = qualityResult.quality;
  governanceDialog.review = reviewResult.review;
  governanceDialog.history = historyPage.items || [];
  governanceDialog.canConfigure = Boolean(reviewResult.canConfigure);
  governanceDialog.canComplete = Boolean(reviewResult.canComplete);
  governanceDialog.reviewForm = {
    enabled: Boolean(reviewResult.review?.enabled),
    ownerId: reviewResult.review?.ownerId || '',
    cycleDays: reviewResult.review?.cycleDays || 365,
    nextReviewAt: reviewResult.review?.nextReviewAt || ''
  };
}

async function openGovernanceDialog(node, activeTab = 'quality') {
  if (!node || node.nodeType !== 'file') return ElMessage.warning('请选择文件');
  governanceDialog.node = node;
  governanceDialog.activeTab = activeTab;
  governanceDialog.completeForm = { conclusion: 'valid', note: '', nextReviewAt: '' };
  loading.value = true;
  try {
    await refreshGovernanceDialogData();
    governanceDialog.visible = true;
  } finally {
    loading.value = false;
  }
}

async function saveDocumentReviewSettings() {
  if (!governanceDialog.node) return;
  if (governanceDialog.reviewForm.enabled && !governanceDialog.reviewForm.ownerId) return ElMessage.warning('请选择复审负责人');
  governanceDialog.saving = true;
  try {
    await api(`/nodes/${governanceDialog.node.id}/review`, {
      method: 'PUT',
      headers: nodeUnlockHeaders(),
      body: governanceDialog.reviewForm
    });
    ElMessage.success('复审计划已保存');
    await refreshGovernanceDialogData();
    if (activeView.value === 'governance') await loadGovernance();
    else await refreshCurrent();
  } finally {
    governanceDialog.saving = false;
  }
}

async function completeDocumentReview() {
  if (!governanceDialog.node) return;
  governanceDialog.saving = true;
  try {
    await api(`/nodes/${governanceDialog.node.id}/review/complete`, {
      method: 'POST',
      headers: nodeUnlockHeaders(),
      body: governanceDialog.completeForm
    });
    governanceDialog.completeForm = { conclusion: 'valid', note: '', nextReviewAt: '' };
    ElMessage.success('本次复审已完成');
    await refreshGovernanceDialogData();
    if (activeView.value === 'governance') await loadGovernance();
    else await refreshCurrent();
  } finally {
    governanceDialog.saving = false;
  }
}

async function openSecurityPolicyDialog() {
  await loadSecurityPolicy();
  securityPolicyDialog.form = { ...securityPolicyDialog.form, ...(securityPolicy.value || {}) };
  securityPolicyDialog.visible = true;
}

async function saveSecurityPolicy() {
  loading.value = true;
  try {
    securityPolicy.value = await api('/system-settings/security-policy', { method: 'PUT', body: securityPolicyDialog.form });
    securityPolicyDialog.visible = false;
    ElMessage.success('安全策略已保存');
    await loadSystemManagement();
  } finally {
    loading.value = false;
  }
}

async function openWecomDialog() {
  await loadWecomSettings();
  wecomDialog.form = {
    enabled: Boolean(wecomSettings.value?.enabled),
    corpId: wecomSettings.value?.corpId || '',
    agentId: wecomSettings.value?.agentId || '',
    secret: '',
    callbackUrl: wecomSettings.value?.callbackUrl || '/api/v1/wecom/auth/callback',
    syncDepartments: wecomSettings.value?.syncDepartments !== false,
    syncUsers: wecomSettings.value?.syncUsers !== false,
    pushMessages: Boolean(wecomSettings.value?.pushMessages)
  };
  wecomDialog.visible = true;
}

async function saveWecomSettings() {
  loading.value = true;
  try {
    wecomSettings.value = await api('/system-settings/wecom', { method: 'PUT', body: wecomDialog.form });
    wecomDialog.visible = false;
    ElMessage.success('企业微信配置已保存');
    await loadSystemManagement();
  } finally {
    loading.value = false;
  }
}

async function testWecomSettings() {
  const result = await api('/system-settings/wecom/test', { method: 'POST' });
  ElMessage[result.ok ? 'success' : 'warning'](result.message);
  await loadWecomSettings();
}

async function openOfficePreviewDialog() {
  await loadOfficePreviewSettings();
  officePreviewDialog.form = {
    enabled: Boolean(officePreviewSettings.value?.enabled),
    provider: officePreviewSettings.value?.provider || 'onlyoffice',
    documentServerUrl: officePreviewSettings.value?.documentServerUrl || '',
    publicBaseUrl: officePreviewSettings.value?.publicBaseUrl || '',
    jwtSecret: ''
  };
  officePreviewDialog.visible = true;
}

async function saveOfficePreviewSettings() {
  loading.value = true;
  try {
    officePreviewSettings.value = await api('/system-settings/office-preview', { method: 'PUT', body: officePreviewDialog.form });
    officePreviewDialog.visible = false;
    ElMessage.success('Office 原版预览配置已保存');
    await loadSystemManagement();
  } finally {
    loading.value = false;
  }
}

async function testOfficePreviewSettings() {
  const body = officePreviewDialog.visible ? officePreviewDialog.form : {};
  const result = await api('/system-settings/office-preview/test', { method: 'POST', body });
  ElMessage[result.ok ? 'success' : 'warning'](result.message);
  await loadOfficePreviewSettings();
}

async function rebuildSearchIndex() {
  await ElMessageBox.confirm('确定重新读取当前所有文件并重建全文检索索引吗？', '重建索引', { type: 'warning' });
  loading.value = true;
  try {
    const result = await api('/search/index/rebuild', { method: 'POST' });
    searchIndexStatus.value = result.status;
    ElMessage.success(`索引重建完成：已索引 ${result.rebuilt} 个，空内容 ${result.empty} 个，失败 ${result.failed} 个`);
    await Promise.all([loadSearchIndexStatus(), loadAudit()]);
  } finally {
    loading.value = false;
  }
}

async function syncExternalLibrary() {
  if (isAdminUser.value && !externalLibraryDialog.rootPath?.trim()) return ElMessage.warning('请输入服务器根目录');
  loading.value = true;
  try {
    const body = isAdminUser.value ? {
      rootPath: externalLibraryDialog.rootPath,
      includePaths: optionLines(externalLibraryDialog.includePathsText),
      excludePatterns: optionLines(externalLibraryDialog.excludePatternsText)
    } : {};
    const summary = await api('/external-library/sync', { method: 'POST', body });
    if (isAdminUser.value) await loadExternalLibrary();
    selectedFolder.value = null;
    await loadDocTree();
    if (isAdminUser.value) externalLibraryDialog.visible = false;
    ElMessage.success(`同步完成：扫描 ${summary.scanned} 项，新增文件 ${summary.filesCreated} 个，更新 ${summary.filesUpdated} 个`);
  } finally {
    loading.value = false;
  }
}

async function openViewAccessDialog(node) {
  const data = await api(`/nodes/${node.id}/view-access`);
  viewAccessDialog.node = node;
  viewAccessDialog.restricted = Boolean(data.restricted);
  viewAccessDialog.userIds = [...(data.audience?.userIds || [])];
  viewAccessDialog.departmentIds = [...(data.audience?.departmentIds || [])];
  viewAccessDialog.roleIds = [...(data.audience?.roleIds || [])];
  viewAccessDialog.visible = true;
}

async function saveViewAccess() {
  const audience = {
    all: !viewAccessDialog.restricted,
    userIds: viewAccessDialog.userIds,
    departmentIds: viewAccessDialog.departmentIds,
    roleIds: viewAccessDialog.roleIds
  };
  if (viewAccessDialog.restricted && !audience.userIds.length && !audience.departmentIds.length && !audience.roleIds.length) {
    return ElMessage.warning('请选择允许查看的用户、部门或角色');
  }
  await api(`/nodes/${viewAccessDialog.node.id}/view-access`, {
    method: 'PUT',
    body: { restricted: viewAccessDialog.restricted, audience }
  });
  viewAccessDialog.visible = false;
  ElMessage.success('可查看范围已保存');
  await refreshCurrent();
}

function openNodePasswordDialog(node) {
  nodePasswordDialog.node = node;
  nodePasswordDialog.enabled = Boolean(node.passwordEnabled);
  nodePasswordDialog.password = '';
  nodePasswordDialog.confirmPassword = '';
  nodePasswordDialog.visible = true;
}

async function saveNodePassword() {
  if (nodePasswordDialog.enabled) {
    if (!nodePasswordDialog.password || nodePasswordDialog.password.length < 4) return ElMessage.warning('访问密码至少 4 位');
    if (nodePasswordDialog.password !== nodePasswordDialog.confirmPassword) return ElMessage.warning('两次输入的访问密码不一致');
  }
  await api(`/nodes/${nodePasswordDialog.node.id}/password`, {
    method: 'PUT',
    body: { enabled: nodePasswordDialog.enabled, password: nodePasswordDialog.password }
  });
  delete nodeUnlockTokens[nodePasswordDialog.node.id];
  nodePasswordDialog.visible = false;
  ElMessage.success(nodePasswordDialog.enabled ? '加密已启用' : '加密已关闭');
  await refreshCurrent();
}

function subjectLabel(row) {
  if (row.subjectType === 'all') return '所有人';
  if (row.subjectType === 'user') return users.value.find((item) => item.id === row.subjectId)?.displayName || row.subjectId;
  if (row.subjectType === 'department') return flatDepartments.value.find((item) => item.id === row.subjectId)?.name || row.subjectId;
  if (row.subjectType === 'role') return flatRoles.value.find((item) => item.id === row.subjectId)?.name || row.subjectId;
  return row.subjectId || '-';
}

function conditionLabel(condition) {
  if (!condition) return '无';
  const parts = [];
  if (condition.filenameContains) parts.push(`文件名含 ${condition.filenameContains}`);
  if (condition.pathPrefix) parts.push(`路径 ${condition.pathPrefix}`);
  if (condition.extensions?.length) parts.push(`扩展名 ${condition.extensions.join(',')}`);
  if (condition.businessStatus) parts.push(`状态 ${condition.businessStatus}`);
  return parts.join('；') || '无';
}

function hasSearchCriteria(criteria) {
  return Boolean(
    String(criteria.keyword || '').trim() ||
    criteria.fileTypes?.length ||
    criteria.creatorId ||
    criteria.updatedFrom ||
    criteria.updatedTo
  );
}

async function searchFiles(keyword) {
  const criteria = typeof keyword === 'object' ? keyword : { keyword };
  if (!hasSearchCriteria(criteria)) return refreshCurrent();
  const page = await api('/search/files', {
    method: 'POST',
    body: { ...criteria, pathPrefix: selectedFolder.value?.fullPath || '', page: 1, pageSize: 100 }
  });
  docChildren.value = page.items;
}

async function searchDriveFiles(keyword) {
  const criteria = typeof keyword === 'object' ? keyword : { keyword };
  if (!hasSearchCriteria(criteria)) return refreshCurrent();
  const page = await api('/search/files', {
    method: 'POST',
    body: { ...criteria, pathPrefix: selectedDriveFolder.value?.fullPath || '', page: 1, pageSize: 100 }
  });
  driveChildren.value = page.items;
}

async function suggestSearchFiles(keyword) {
  const query = String(keyword || '').trim();
  if (!query) return [];
  return api(`/search/suggestions?keyword=${encodeURIComponent(query)}&pathPrefix=${encodeURIComponent(selectedFolder.value?.fullPath || '')}&limit=8`);
}

async function suggestSearchDriveFiles(keyword) {
  const query = String(keyword || '').trim();
  if (!query) return [];
  return api(`/search/suggestions?keyword=${encodeURIComponent(query)}&pathPrefix=${encodeURIComponent(selectedDriveFolder.value?.fullPath || '')}&limit=8`);
}

function openShareDialog(node, type = 'share') {
  shareDialog.node = node;
  shareDialog.audienceType = 'role';
  shareDialog.audienceIds = flatRoles.value.length ? ['r_employee'] : [];
  shareDialog.days = 30;
  shareDialog.form = { type, description: '', actions: ['visible', 'file:preview', 'file:download'] };
  shareDialog.visible = true;
}

async function createShare() {
  const audience = { all: shareDialog.audienceType === 'all', userIds: [], departmentIds: [], roleIds: [] };
  if (shareDialog.audienceType === 'user') audience.userIds = shareDialog.audienceIds;
  if (shareDialog.audienceType === 'department') audience.departmentIds = shareDialog.audienceIds;
  if (shareDialog.audienceType === 'role') audience.roleIds = shareDialog.audienceIds;
  const expiresAt = new Date(Date.now() + Number(shareDialog.days || 30) * 24 * 60 * 60 * 1000).toISOString();
  await api(`/nodes/${shareDialog.node.id}/share`, {
    method: 'POST',
    body: { ...shareDialog.form, audience, expiresAt, includeChildren: true }
  });
  shareDialog.visible = false;
  ElMessage.success(shareDialog.form.type === 'publish' ? '发布成功' : '分享成功');
  await loadMessages();
  await loadCollaboration();
}

async function subscribeNode(node) {
  await api(`/nodes/${node.id}/subscriptions`, { method: 'POST', body: { includeChildren: true, eventTypes: ['update', 'delete'] } });
  ElMessage.success('已订阅，后续更新/删除会收到消息');
  await loadCollaboration();
}

function openReminderDialog(nodeOrReminder) {
  if (nodeOrReminder.nodeId && !nodeOrReminder.nodeType) {
    const reminder = nodeOrReminder;
    reminderDialog.node = { id: reminder.nodeId, fullPath: reminder.nodePath || reminder.nodeName || reminder.nodeId };
    reminderDialog.form = {
      id: reminder.id,
      triggerAt: reminder.triggerAt ? new Date(reminder.triggerAt) : new Date(Date.now() + 60 * 60 * 1000),
      endAt: reminder.endAt ? new Date(reminder.endAt) : null,
      cycle: reminder.cycle || 'none',
      intervalDays: Number(reminder.intervalDays || 0),
      remindBy: Array.isArray(reminder.remindBy) ? reminder.remindBy : [reminder.remindBy || 'system'],
      remark: reminder.remark || ''
    };
  } else {
    reminderDialog.node = nodeOrReminder;
    reminderDialog.form = { id: null, triggerAt: new Date(Date.now() + 60 * 60 * 1000), endAt: null, cycle: 'none', intervalDays: 0, remindBy: ['system'], remark: '请处理该文件' };
  }
  reminderDialog.visible = true;
}

async function createReminder() {
  const triggerAt = new Date(reminderDialog.form.triggerAt).toISOString();
  const endAt = reminderDialog.form.endAt ? new Date(reminderDialog.form.endAt).toISOString() : null;
  const body = { ...reminderDialog.form, triggerAt, endAt, startAt: triggerAt };
  if (reminderDialog.form.id) {
    await api(`/reminders/${reminderDialog.form.id}`, { method: 'PUT', body });
  } else {
    await api(`/nodes/${reminderDialog.node.id}/reminders`, { method: 'POST', body });
  }
  reminderDialog.visible = false;
  ElMessage.success(reminderDialog.form.id ? '文件闹钟已更新' : '文件闹钟已设置');
  await loadDashboard();
  await loadCollaboration();
}

async function openLinkDialog(node) {
  await runWithPasswordUnlock(node, async () => {
    linkDialog.node = node;
    linkDialog.tab = 'attachments';
    linkDialog.attachmentFile = null;
    linkDialog.attachmentDescription = '';
    linkDialog.relationKeyword = '';
    linkDialog.relationDescription = '';
    linkDialog.candidates = [];
    linkDialog.visible = true;
    await loadNodeLinks();
  });
}

async function loadNodeLinks() {
  if (!linkDialog.node) return;
  const [attachments, relations] = await Promise.all([
    api(`/nodes/${linkDialog.node.id}/attachments`, { headers: nodeUnlockHeaders() }),
    api(`/nodes/${linkDialog.node.id}/relations`, { headers: nodeUnlockHeaders() })
  ]);
  linkDialog.attachments = attachments;
  linkDialog.relations = relations;
}

function onAttachmentFileChange(file) {
  linkDialog.attachmentFile = file.raw;
}

function onAttachmentFileRemove() {
  linkDialog.attachmentFile = null;
}

async function uploadAttachment() {
  if (!linkDialog.attachmentFile) return ElMessage.warning('请选择附件文件');
  const form = new FormData();
  form.append('description', linkDialog.attachmentDescription || '');
  form.append('file', linkDialog.attachmentFile);
  loading.value = true;
  try {
    await api(`/nodes/${linkDialog.node.id}/attachments`, { method: 'POST', headers: nodeUnlockHeaders(), body: form });
    linkDialog.attachmentFile = null;
    linkDialog.attachmentDescription = '';
    ElMessage.success('附件已上传');
    await loadNodeLinks();
  } finally {
    loading.value = false;
  }
}

async function downloadAttachment(row) {
  await downloadFile(`/attachments/${row.id}/download`, row.originalFilename || row.name, null, { headers: nodeUnlockHeaders() });
}

async function deleteAttachment(row) {
  await ElMessageBox.confirm(`确定删除附件“${row.name}”吗？`, '删除附件', { type: 'warning' });
  await api(`/attachments/${row.id}`, { method: 'DELETE', headers: nodeUnlockHeaders() });
  ElMessage.success('附件已删除');
  await loadNodeLinks();
}

async function searchRelationCandidates() {
  const keyword = linkDialog.relationKeyword.trim();
  if (!keyword) return ElMessage.warning('请输入文件关键词');
  const page = await api('/search/files', {
    method: 'POST',
    body: { keyword, page: 1, pageSize: 20 }
  });
  const relationIds = new Set(linkDialog.relations.flatMap((item) => [item.nodeId, item.relatedNodeId]));
  linkDialog.candidates = page.items.filter((item) => item.id !== linkDialog.node.id && !relationIds.has(item.id));
}

async function createRelation(row) {
  await api(`/nodes/${linkDialog.node.id}/relations`, {
    method: 'POST',
    headers: nodeUnlockHeaders(),
    body: { relatedNodeId: row.id, description: linkDialog.relationDescription || '' }
  });
  ElMessage.success('关联已创建');
  linkDialog.candidates = linkDialog.candidates.filter((item) => item.id !== row.id);
  await loadNodeLinks();
}

async function deleteRelation(row) {
  await api(`/relations/${row.id}`, { method: 'DELETE' });
  ElMessage.success('关联已删除');
  await loadNodeLinks();
}

async function revokeShare(row) {
  await ElMessageBox.confirm(`确定撤销“${row.nodePath || row.nodeName}”的${row.type === 'publish' ? '发布' : '分享'}吗？`, '撤销确认', { type: 'warning' });
  await api(`/shares/${row.id}/revoke`, { method: 'PATCH' });
  ElMessage.success('已撤销');
  await loadCollaboration();
}

async function cancelSubscription(row) {
  await api(`/subscriptions/${row.id}`, { method: 'DELETE' });
  ElMessage.success('订阅已取消');
  await loadCollaboration();
}

async function cancelReminder(row) {
  await api(`/reminders/${row.id}`, { method: 'DELETE' });
  ElMessage.success('闹钟已取消');
  await loadCollaboration();
  await loadDashboard();
}

async function openMetadataDialog(node) {
  await runWithPasswordUnlock(node, async () => {
    metadataDialog.node = node;
    await loadKnowledge();
    const [meta, comments] = await Promise.all([
      api(`/nodes/${node.id}/properties`, { headers: nodeUnlockHeaders() }),
      api(`/nodes/${node.id}/comments`, { headers: nodeUnlockHeaders() })
    ]);
    metadataDialog.tagsText = (meta.tags || []).join('，');
    metadataDialog.categoryIds = meta.categories || [];
    metadataDialog.businessStatus = node.businessStatus || 'effective';
    metadataDialog.values = {};
    (meta.values || []).forEach((item) => {
      metadataDialog.values[item.definition.id] = item.value || '';
    });
    metadataDialog.comments = comments;
    metadataDialog.comment = '';
    metadataDialog.score = 5;
    metadataDialog.visible = true;
  });
}

async function saveMetadata() {
  const tags = metadataDialog.tagsText
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  await api(`/nodes/${metadataDialog.node.id}/properties`, {
    method: 'PUT',
    headers: nodeUnlockHeaders(),
    body: { tags, categoryIds: metadataDialog.categoryIds, values: metadataDialog.values }
  });
  await api(`/nodes/${metadataDialog.node.id}/status`, { method: 'PATCH', headers: nodeUnlockHeaders(), body: { businessStatus: metadataDialog.businessStatus } });
  await api(`/nodes/${metadataDialog.node.id}/rating`, { method: 'POST', headers: nodeUnlockHeaders(), body: { score: metadataDialog.score } });
  if (metadataDialog.comment.trim()) {
    await api(`/nodes/${metadataDialog.node.id}/comments`, { method: 'POST', headers: nodeUnlockHeaders(), body: { content: metadataDialog.comment.trim() } });
  }
  metadataDialog.visible = false;
  ElMessage.success('属性已保存');
  await refreshCurrent();
}

function openCategoryDialog(row = null) {
  categoryDialog.form = row?.id
    ? { id: row.id, name: row.name, parentId: row.parentId || '', sortOrder: row.sortOrder || 100, status: row.status || 'enabled' }
    : { name: '', parentId: row?.id || '', sortOrder: 100, status: 'enabled' };
  categoryDialog.visible = true;
}

async function saveCategory() {
  const body = { ...categoryDialog.form, parentId: categoryDialog.form.parentId || null };
  if (!body.name?.trim()) return ElMessage.warning('请输入分类名称');
  if (body.id) await api(`/categories/${body.id}`, { method: 'PUT', body });
  else await api('/categories', { method: 'POST', body });
  categoryDialog.visible = false;
  ElMessage.success('分类已保存');
  await loadKnowledge();
}

async function deleteCategory(row) {
  await ElMessageBox.confirm(`确定删除分类“${row.name}”及其下级分类吗？`, '删除分类', { type: 'warning' });
  await api(`/categories/${row.id}`, { method: 'DELETE' });
  selectedCategory.value = null;
  categoryFiles.value = [];
  ElMessage.success('分类已删除');
  await loadKnowledge();
}

function openPropertyDialog(row = null) {
  propertyDialog.form = row?.id
    ? {
      id: row.id,
      name: row.name,
      targetType: row.targetType || 'file',
      dataType: row.dataType || 'string',
      required: Boolean(row.required),
      optionsText: (row.options || []).join('\n')
    }
    : { name: '', targetType: 'file', dataType: 'string', required: false, optionsText: '' };
  propertyDialog.visible = true;
}

function propertyPayload() {
  return {
    name: propertyDialog.form.name,
    targetType: propertyDialog.form.targetType || 'file',
    dataType: propertyDialog.form.dataType || 'string',
    required: Boolean(propertyDialog.form.required),
    options: String(propertyDialog.form.optionsText || '').split(/[,\n，]+/).map((item) => item.trim()).filter(Boolean)
  };
}

async function savePropertyDefinition() {
  const body = propertyPayload();
  if (!body.name?.trim()) return ElMessage.warning('请输入属性名称');
  if (propertyDialog.form.id) await api(`/property-definitions/${propertyDialog.form.id}`, { method: 'PUT', body });
  else await api('/property-definitions', { method: 'POST', body });
  propertyDialog.visible = false;
  ElMessage.success('扩展属性已保存');
  await loadKnowledge();
}

async function deletePropertyDefinition(row) {
  await ElMessageBox.confirm(`确定删除扩展属性“${row.name}”吗？`, '删除确认', { type: 'warning' });
  await api(`/property-definitions/${row.id}`, { method: 'DELETE' });
  ElMessage.success('扩展属性已删除');
  await loadKnowledge();
}

async function restoreTrash(row) {
  await api(`/trash/${row.id}/restore`, { method: 'POST' });
  ElMessage.success('已恢复');
  await loadTrash();
  await loadDocTree();
}

async function destroyTrash(row) {
  await ElMessageBox.confirm(`彻底删除“${row.name}”后不可恢复，确定继续吗？`, '彻底删除', { type: 'warning' });
  await api(`/trash/${row.id}`, { method: 'DELETE' });
  ElMessage.success('已彻底删除');
  await loadTrash();
}

function openUserDialog(row = null) {
  userDialog.form = row
    ? { ...row, departmentIds: [...(row.departmentIds || [])], roleIds: [...(row.roleIds || [])] }
    : { username: '', displayName: '', email: '', phone: '', status: 'enabled', departmentIds: [], roleIds: ['r_employee'] };
  userDialog.visible = true;
}

async function saveUser() {
  if (userDialog.form.id) {
    await api(`/users/${userDialog.form.id}`, { method: 'PUT', body: userDialog.form });
  } else {
    await api('/users', { method: 'POST', body: { ...userDialog.form, password: 'User1234' } });
  }
  userDialog.visible = false;
  ElMessage.success('用户已保存');
  await loadUsers();
}

async function resetPassword(row) {
  await api(`/users/${row.id}/reset-password`, { method: 'POST', body: { password: 'User1234' } });
  ElMessage.success('密码已重置为 User1234');
}

function openDepartmentDialog(row = null) {
  departmentDialog.form = row?.id
    ? { id: row.id, name: row.name, code: row.code || '', parentId: row.parentId || '', status: row.status || 'enabled' }
    : { name: '', code: '', parentId: row?.id || '', status: 'enabled' };
  departmentDialog.visible = true;
}

async function saveDepartment() {
  const body = { ...departmentDialog.form, parentId: departmentDialog.form.parentId || null };
  if (!body.name?.trim()) return ElMessage.warning('请输入部门名称');
  if (body.id) await api(`/departments/${body.id}`, { method: 'PUT', body });
  else await api('/departments', { method: 'POST', body });
  departmentDialog.visible = false;
  ElMessage.success('部门已保存');
  await loadOrg();
  await loadUsers();
}

async function deleteDepartment(row) {
  await ElMessageBox.confirm(`确定删除部门“${row.name}”吗？下级部门会平移到上级。`, '删除部门', { type: 'warning' });
  await api(`/departments/${row.id}`, { method: 'DELETE' });
  ElMessage.success('部门已删除');
  await loadOrg();
  await loadUsers();
}

function openRoleDialog(row = null) {
  roleDialog.form = row?.id
    ? { id: row.id, name: row.name, code: row.code || '', parentId: row.parentId || '', status: row.status || 'enabled', description: row.description || '' }
    : { name: '', code: '', parentId: row?.id || '', status: 'enabled', description: '' };
  roleDialog.visible = true;
}

async function saveRole() {
  const body = { ...roleDialog.form, parentId: roleDialog.form.parentId || null };
  if (!body.name?.trim()) return ElMessage.warning('请输入角色名称');
  if (body.id) await api(`/roles/${body.id}`, { method: 'PUT', body });
  else await api('/roles', { method: 'POST', body });
  roleDialog.visible = false;
  ElMessage.success('角色已保存');
  await loadOrg();
  await loadUsers();
}

async function deleteRole(row) {
  await ElMessageBox.confirm(`确定删除角色“${row.name}”吗？下级角色会平移到上级。`, '删除角色', { type: 'warning' });
  await api(`/roles/${row.id}`, { method: 'DELETE' });
  ElMessage.success('角色已删除');
  await loadOrg();
  await loadUsers();
}

async function readMessage(row) {
  await api(`/messages/${row.id}/read`, { method: 'POST' });
  await loadMessages();
}

async function readAllMessages() {
  await api('/messages/read-all', { method: 'POST' });
  await loadMessages();
}

async function openMessageDialog(row) {
  messageDialog.item = await api(`/messages/${row.id}`);
  messageDialog.visible = true;
}

async function openMessageRelatedNode() {
  const node = messageDialog.item?.relatedNode;
  if (!node) return;
  messageDialog.visible = false;
  if (node.nodeType === 'folder') {
    activeView.value = node.spaceType === 'personal' ? 'drive' : 'docs';
    if (activeView.value === 'drive') {
      await loadPersonalDrive();
      await selectDriveFolder(node);
    } else {
      await loadDocTree();
      await selectFolder(node);
    }
  } else {
    await previewNode(node);
  }
}

function openPasswordDialog() {
  passwordDialog.form = { oldPassword: '', newPassword: '', confirmPassword: '' };
  passwordDialog.visible = true;
}

async function changePassword() {
  const { oldPassword, newPassword, confirmPassword } = passwordDialog.form;
  if (!oldPassword || !newPassword) return ElMessage.warning('请输入原密码和新密码');
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) return ElMessage.warning('新密码至少 8 位且包含字母和数字');
  if (newPassword !== confirmPassword) return ElMessage.warning('两次输入的新密码不一致');
  loading.value = true;
  try {
    await api('/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } });
    passwordDialog.visible = false;
    ElMessage.success('密码已修改');
  } finally {
    loading.value = false;
  }
}

async function exportAuditLogs() {
  await downloadFile('/audit-logs/export', '审计日志.csv', {});
  ElMessage.success('审计日志已导出');
}

function dialogAudience(type, ids) {
  const audience = { all: type === 'all', userIds: [], departmentIds: [], roleIds: [] };
  if (type === 'user') audience.userIds = ids;
  if (type === 'department') audience.departmentIds = ids;
  if (type === 'role') audience.roleIds = ids;
  return audience;
}

function openAnnouncementDialog(row = null) {
  const audience = row?.audience || { all: true };
  announcementDialog.audienceType = audience.all ? 'all' : audience.userIds?.length ? 'user' : audience.departmentIds?.length ? 'department' : 'role';
  announcementDialog.audienceIds = audience.userIds?.length ? [...audience.userIds] : audience.departmentIds?.length ? [...audience.departmentIds] : [...(audience.roleIds || [])];
  announcementDialog.file = null;
  announcementDialog.form = row?.id
    ? { id: row.id, title: row.title, content: row.content, status: row.status, expiresAt: row.expiresAt ? new Date(row.expiresAt) : null }
    : { title: '', content: '', status: 'published', expiresAt: null };
  announcementDialog.visible = true;
}

function onAnnouncementFileChange(file) {
  announcementDialog.file = file.raw;
}

function onAnnouncementFileRemove() {
  announcementDialog.file = null;
}

async function saveAnnouncement() {
  if (!announcementDialog.form.title?.trim()) return ElMessage.warning('请输入公告标题');
  if (!announcementDialog.form.content?.trim()) return ElMessage.warning('请输入公告内容');
  const form = new FormData();
  form.append('title', announcementDialog.form.title);
  form.append('content', announcementDialog.form.content);
  form.append('status', announcementDialog.form.status || 'published');
  form.append('audience', JSON.stringify(dialogAudience(announcementDialog.audienceType, announcementDialog.audienceIds)));
  if (announcementDialog.form.expiresAt) form.append('expiresAt', new Date(announcementDialog.form.expiresAt).toISOString());
  if (announcementDialog.file) form.append('file', announcementDialog.file);
  loading.value = true;
  try {
    if (announcementDialog.form.id) {
      await api(`/announcements/${announcementDialog.form.id}`, { method: 'PUT', body: form });
    } else {
      await api('/announcements', { method: 'POST', body: form });
    }
    announcementDialog.visible = false;
    ElMessage.success('公告已保存');
    await loadAnnouncements();
    await loadMessages();
  } finally {
    loading.value = false;
  }
}

async function publishAnnouncement(row) {
  await api(`/announcements/${row.id}/publish`, { method: 'PATCH', body: {} });
  ElMessage.success('公告已发布');
  await loadAnnouncements();
}

async function revokeAnnouncement(row) {
  await api(`/announcements/${row.id}/revoke`, { method: 'PATCH', body: {} });
  ElMessage.success('公告已撤销');
  await loadAnnouncements();
}

async function deleteAnnouncement(row) {
  await ElMessageBox.confirm(`确定删除公告“${row.title}”吗？`, '删除公告', { type: 'warning' });
  await api(`/announcements/${row.id}`, { method: 'DELETE' });
  ElMessage.success('公告已删除');
  await loadAnnouncements();
}

async function downloadAnnouncementAttachment(row) {
  await downloadFile(`/announcements/${row.id}/attachment`, row.attachment?.originalFilename || `${row.title}.附件`);
}

function openCredentialDialog(row = null) {
  credentialDialog.form = row?.id
    ? { id: row.id, name: row.name, userId: row.userId, scopesText: (row.scopes || []).join(','), status: row.status || 'enabled', rateLimitPerMinute: row.rateLimitPerMinute || 120, expiresAt: row.expiresAt ? new Date(row.expiresAt) : null }
    : { id: '', name: '', userId: user.value?.id || '', scopesText: 'files:read', status: 'enabled', rateLimitPerMinute: 120, expiresAt: null };
  credentialDialog.visible = true;
}

function credentialPayload() {
  return {
    name: credentialDialog.form.name,
    userId: credentialDialog.form.userId,
    scopes: String(credentialDialog.form.scopesText || '').split(/[,\s，]+/).map((item) => item.trim()).filter(Boolean),
    status: credentialDialog.form.status || 'enabled',
    rateLimitPerMinute: credentialDialog.form.rateLimitPerMinute || 120,
    expiresAt: credentialDialog.form.expiresAt ? new Date(credentialDialog.form.expiresAt).toISOString() : null
  };
}

async function showCredentialSecret(data) {
  if (!data.secret) return;
  await ElMessageBox.alert(`AccessKey：${data.accessKey}\nSecret：${data.secret}`, '请立即保存 API Secret', {
    confirmButtonText: '已保存'
  });
}

async function saveCredential() {
  const body = credentialPayload();
  if (!body.name?.trim()) return ElMessage.warning('请输入凭证名称');
  loading.value = true;
  try {
    const data = credentialDialog.form.id
      ? await api(`/api-credentials/${credentialDialog.form.id}`, { method: 'PUT', body })
      : await api('/api-credentials', { method: 'POST', body });
    credentialDialog.visible = false;
    await showCredentialSecret(data);
    ElMessage.success('API 凭证已保存');
    await loadApiManagement();
  } finally {
    loading.value = false;
  }
}

async function rotateCredentialSecret(row) {
  const data = await api(`/api-credentials/${row.id}/rotate-secret`, { method: 'POST', body: {} });
  await showCredentialSecret(data);
  await loadApiManagement();
}

async function disableCredential(row) {
  await ElMessageBox.confirm(`确定停用 API 凭证“${row.name}”吗？`, '停用确认', { type: 'warning' });
  await api(`/api-credentials/${row.id}`, { method: 'DELETE' });
  ElMessage.success('API 凭证已停用');
  await loadApiManagement();
}

function openFilePolicyDialog() {
  filePolicyDialog.form = {
    allowedExtensionsText: (filePolicy.value.allowedExtensions || []).join(','),
    maxSizeMb: filePolicy.value.maxSizeMb || 300
  };
  filePolicyDialog.visible = true;
}

async function saveFilePolicy() {
  const body = {
    allowedExtensions: String(filePolicyDialog.form.allowedExtensionsText || '').split(/[,\s，]+/).map((item) => item.replace(/^\./, '').trim().toLowerCase()).filter(Boolean),
    maxSizeMb: filePolicyDialog.form.maxSizeMb || 300
  };
  filePolicy.value = await api('/system-settings/file-policy', { method: 'PUT', body });
  filePolicyDialog.visible = false;
  ElMessage.success('上传策略已保存');
}

watch(
  () => previewDialog.data?.officePreview?.native,
  () => {
    void mountOfficeEditor();
  }
);

watch(
  () => previewDialog.visible,
  (visible) => {
    if (!visible) destroyOfficeEditor();
  }
);

onBeforeUnmount(() => {
  destroyOfficeEditor();
});

onMounted(async () => {
  await loadCaptcha();
  if (await consumeSsoTicketFromUrl()) return;
  if (token.value) {
    try {
      await bootstrap();
    } catch {
      setToken('');
      token.value = '';
      user.value = null;
    }
  }
});
</script>

<script>
import {
  Download as DownloadIcon,
  FileText as FileTextIcon,
  Folder as FolderIcon,
  Lock as LockIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  Shield as ShieldIcon,
  Star as StarIcon,
  Trash2 as Trash2Icon,
  Unlock as UnlockIcon,
  UploadCloud as UploadCloudIcon
} from 'lucide-vue-next';

const DashboardView = {
  props: ['dashboard', 'formatDate'],
  emits: ['open-docs'],
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

const DocsView = {
  props: ['tree', 'children', 'selectedFolder', 'users', 'departments', 'roles', 'formatDate', 'formatSize', 'actions'],
  emits: ['select-folder', 'create-folder', 'upload', 'rename', 'delete', 'download', 'preview', 'versions', 'lock', 'unlock', 'favorite', 'permissions', 'search', 'batch-download', 'move', 'copy'],
  data: () => ({ keyword: '', selection: [] }),
  components: {
    Folder: FolderIcon,
    FileText: FileTextIcon,
    Search: SearchIcon,
    Plus: PlusIcon,
    UploadCloud: UploadCloudIcon,
    Download: DownloadIcon,
    Shield: ShieldIcon,
    Lock: LockIcon,
    Unlock: UnlockIcon,
    Star: StarIcon,
    Trash2: Trash2Icon
  },
  methods: {
    can(row, action) {
      return row.permissions?.includes(action) || row.permissions?.includes('full_control');
    }
  },
  template: `
    <div class="split-layout">
      <aside class="tree-pane">
        <div class="section-header">
          <h2 class="section-title">目录</h2>
          <el-button :icon="Plus" circle aria-label="新建文件夹" @click="$emit('create-folder')" />
        </div>
        <el-tree :data="tree" node-key="id" default-expand-all :props="{ label: 'name', children: 'children' }" @node-click="$emit('select-folder', $event)" />
      </aside>
      <section class="list-pane">
        <div class="toolbar">
          <el-button type="primary" :icon="UploadCloud" @click="$emit('upload')">上传</el-button>
          <el-button :icon="Plus" @click="$emit('create-folder')">新建文件夹</el-button>
          <el-button :icon="Download" :disabled="!selection.length" @click="$emit('batch-download', selection)">批量下载</el-button>
          <div class="toolbar-spacer" />
          <el-input v-model="keyword" placeholder="搜索当前目录文件" clearable style="max-width: 300px" @keyup.enter="$emit('search', keyword)">
            <template #append>
              <el-button :icon="Search" aria-label="搜索" @click="$emit('search', keyword)" />
            </template>
          </el-input>
        </div>
        <div class="muted" style="margin-bottom: 10px">当前位置：{{ selectedFolder?.fullPath || '/' }}</div>
        <el-table :data="children" border height="calc(100dvh - 230px)" @selection-change="selection = $event">
          <el-table-column type="selection" width="44" />
          <el-table-column label="名称" min-width="260">
            <template #default="{ row }">
              <div class="file-name">
                <Folder v-if="row.nodeType === 'folder'" class="toolbar-icon" />
                <FileText v-else class="toolbar-icon" />
                <span>{{ row.name }}</span>
                <el-tag v-if="row.lockedBy" size="small" type="warning">锁定</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="90">
            <template #default="{ row }">{{ row.nodeType === 'folder' ? '文件夹' : row.extension || '文件' }}</template>
          </el-table-column>
          <el-table-column label="大小" width="110">
            <template #default="{ row }">{{ row.currentVersion ? formatSize(row.currentVersion.sizeBytes) : '-' }}</template>
          </el-table-column>
          <el-table-column label="更新时间" width="180">
            <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="390" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.nodeType === 'folder'" size="small" @click="$emit('select-folder', row)">打开</el-button>
              <el-button v-if="row.nodeType === 'file' && can(row, 'file:preview')" size="small" @click="$emit('preview', row)">预览</el-button>
              <el-button v-if="row.nodeType === 'file' && can(row, 'file:download')" size="small" :icon="Download" @click="$emit('download', row)" />
              <el-button v-if="row.nodeType === 'folder'" size="small" :icon="Download" @click="$emit('download', row)" />
              <el-button size="small" @click="$emit('rename', row)">重命名</el-button>
              <el-button size="small" @click="$emit('move', row, 'move')">移动</el-button>
              <el-button size="small" @click="$emit('copy', row, 'copy')">复制</el-button>
              <el-button v-if="row.nodeType === 'file'" size="small" @click="$emit('versions', row)">版本</el-button>
              <el-button v-if="row.nodeType === 'file' && !row.lockedBy" size="small" :icon="Lock" @click="$emit('lock', row)" />
              <el-button v-if="row.nodeType === 'file' && row.lockedBy" size="small" :icon="Unlock" @click="$emit('unlock', row)" />
              <el-button size="small" :icon="Star" @click="$emit('favorite', row)" />
              <el-button v-if="can(row, 'permission:manage')" size="small" :icon="Shield" @click="$emit('permissions', row)" />
              <el-button v-if="can(row, 'file:delete')" size="small" type="danger" :icon="Trash2" @click="$emit('delete', row)" />
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  `
};

const UsersView = {
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

const OrgView = {
  props: ['departments', 'roles'],
  emits: ['create-department', 'create-role'],
  template: `
    <div class="split-layout">
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">部门树</h2>
          <el-button type="primary" @click="$emit('create-department')">新建部门</el-button>
        </div>
        <el-tree :data="departments" default-expand-all :props="{ label: 'name', children: 'children' }" />
      </section>
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">角色树</h2>
          <el-button type="primary" @click="$emit('create-role')">新建角色</el-button>
        </div>
        <el-tree :data="roles" default-expand-all :props="{ label: 'name', children: 'children' }" />
      </section>
    </div>
  `
};

const MessagesView = {
  props: ['messages', 'formatDate'],
  emits: ['read', 'read-all'],
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">消息中心</h2>
        <el-button @click="$emit('read-all')">全部已读</el-button>
      </div>
      <el-table :data="messages" border>
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.readAt ? 'info' : 'primary'">{{ row.readAt ? '已读' : '未读' }}</el-tag></template></el-table-column>
        <el-table-column prop="title" label="标题" min-width="180" />
        <el-table-column prop="content" label="内容" min-width="320" />
        <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
        <el-table-column label="操作" width="110"><template #default="{ row }"><el-button size="small" @click="$emit('read', row)">标记已读</el-button></template></el-table-column>
      </el-table>
    </section>
  `
};

const AuditView = {
  props: ['logs', 'formatDate'],
  template: `
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">审计日志</h2>
      </div>
      <el-table :data="logs" border>
        <el-table-column prop="action" label="动作" width="180" />
        <el-table-column prop="actorId" label="操作者" width="150" />
        <el-table-column prop="targetPath" label="对象路径" min-width="300" />
        <el-table-column label="时间" width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      </el-table>
    </section>
  `
};

export default {
  components: {
    DashboardView,
    DocsView,
    UsersView,
    OrgView,
    MessagesView,
    AuditView
  }
};
</script>
