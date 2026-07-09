# API 接口草案

## 1. 统一约定

### 1.1 URL 前缀

```text
/api/v1
```

### 1.2 返回格式

```json
{
  "code": "OK",
  "message": "success",
  "data": {}
}
```

分页返回：

```json
{
  "code": "OK",
  "message": "success",
  "data": {
    "items": [],
    "page": 1,
    "pageSize": 20,
    "total": 0
  }
}
```

### 1.3 错误码

| 错误码 | 说明 |
|---|---|
| UNAUTHORIZED | 未登录或登录过期 |
| FORBIDDEN | 无权限 |
| NOT_FOUND | 资源不存在 |
| CONFLICT | 资源冲突 |
| VALIDATION_ERROR | 参数校验失败 |
| FILE_TOO_LARGE | 文件过大 |
| UNSUPPORTED_FILE_TYPE | 不支持的文件类型 |
| INTERNAL_ERROR | 服务内部错误 |

## 2. 认证接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /auth/login | 账号密码登录 |
| POST | /auth/logout | 退出登录 |
| GET | /auth/me | 当前用户信息 |
| POST | /auth/change-password | 修改密码 |
| POST | /auth/sso/once-login-url | 申请一次性登录链接 |
| POST | /auth/sso/token/resolve | 根据 token 获取用户 |

## 3. 用户、部门、角色接口

### 3.1 用户

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /users | 用户列表 |
| GET | /users/{id} | 用户详情 |
| POST | /users | 创建用户 |
| PUT | /users/{id} | 修改用户 |
| PATCH | /users/{id}/status | 启用/禁用用户 |
| POST | /users/{id}/reset-password | 重置密码 |
| PUT | /users/{id}/departments | 设置用户部门 |
| PUT | /users/{id}/roles | 设置用户角色 |

### 3.2 部门

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /departments/tree | 部门树 |
| POST | /departments | 创建部门 |
| PUT | /departments/{id} | 修改部门 |
| DELETE | /departments/{id} | 删除部门 |
| POST | /departments/{id}/move | 移动部门 |

### 3.3 角色

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /roles/tree | 角色树 |
| POST | /roles | 创建角色 |
| PUT | /roles/{id} | 修改角色 |
| DELETE | /roles/{id} | 删除角色 |
| POST | /roles/{id}/move | 移动角色 |

## 4. 文档库接口

### 4.1 文件夹与文件节点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /nodes/root | 获取根目录 |
| GET | /nodes/{id}/children | 获取子节点列表 |
| GET | /nodes/{id} | 获取文件/文件夹详情 |
| POST | /folders | 创建文件夹 |
| PUT | /nodes/{id}/rename | 重命名 |
| POST | /nodes/{id}/move | 移动 |
| POST | /nodes/{id}/copy | 复制 |
| DELETE | /nodes/{id} | 删除 |
| POST | /nodes/batch-delete | 批量删除 |
| GET | /nodes/{id}/permissions/effective | 查询当前用户最终权限 |

### 4.2 上传下载

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /files/upload-token | 申请上传地址 |
| POST | /files/complete-upload | 完成上传并创建文件 |
| POST | /files/{nodeId}/update-token | 申请更新上传地址 |
| POST | /files/{nodeId}/complete-update | 完成文件更新 |
| POST | /files/{nodeId}/download-token | 申请下载地址 |
| POST | /files/batch-download | 批量下载打包 |
| POST | /folders/{nodeId}/download | 文件夹打包下载 |

### 4.3 预览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /files/{nodeId}/preview-token | 申请预览地址 |
| GET | /files/{nodeId}/preview-status | 查询预览转换状态 |
| POST | /files/{nodeId}/convert-preview | 触发预览转换 |

## 5. 版本接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /files/{nodeId}/versions | 版本列表 |
| GET | /files/{nodeId}/versions/{versionId} | 版本详情 |
| POST | /files/{nodeId}/versions/{versionId}/rollback | 版本回滚 |
| POST | /files/{nodeId}/versions/{versionId}/download-token | 下载指定版本 |
| POST | /files/{nodeId}/lock | 锁定文件 |
| POST | /files/{nodeId}/unlock | 解锁文件 |

## 6. 权限接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /nodes/{nodeId}/permission-rules | 权限规则列表 |
| POST | /nodes/{nodeId}/permission-rules | 添加权限规则 |
| PUT | /permission-rules/{ruleId} | 修改权限规则 |
| DELETE | /permission-rules/{ruleId} | 删除权限规则 |
| POST | /nodes/{nodeId}/permission-preview | 预览某用户最终权限 |

权限规则请求示例：

```json
{
  "subjectType": "department",
  "subjectId": 1001,
  "scope": "all",
  "effect": "allow",
  "actions": ["visible", "file:preview", "file:download"],
  "priority": 100,
  "inheritEnabled": true,
  "condition": {
    "filenameContains": "广东"
  }
}
```

## 7. 搜索接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /search/files | 文件搜索 |
| POST | /search/folders | 文件夹搜索 |
| GET | /search/suggestions | 搜索建议 |

搜索请求示例：

```json
{
  "keyword": "质量手册",
  "fields": ["filename", "content"],
  "fileTypes": ["docx", "pdf"],
  "creatorIds": [1, 2],
  "pathPrefix": "/02 天瑞卓越体系（TES）",
  "updatedFrom": "2026-01-01",
  "updatedTo": "2026-12-31",
  "sortField": "updatedAt",
  "sortOrder": "desc",
  "page": 1,
  "pageSize": 20
}
```

## 8. 消息与收藏接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /messages | 消息列表 |
| GET | /messages/unread-count | 未读数量 |
| GET | /messages/{id} | 消息详情 |
| POST | /messages/{id}/read | 标记已读 |
| POST | /messages/read-all | 全部标记已读 |
| GET | /favorites | 收藏列表 |
| POST | /favorites | 添加收藏 |
| DELETE | /favorites/{id} | 取消收藏 |

## 9. 协作接口

### 9.1 分享与发布

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /shares | 分享/发布记录列表 |
| POST | /nodes/{nodeId}/share | 创建分享或发布 |
| PATCH | /shares/{id}/revoke | 撤销分享或发布 |

### 9.2 订阅

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /subscriptions | 我的订阅列表 |
| POST | /nodes/{nodeId}/subscriptions | 订阅文件/文件夹 |
| DELETE | /subscriptions/{id} | 取消订阅 |

### 9.3 文件闹钟

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /reminders | 我的文件闹钟列表 |
| POST | /nodes/{nodeId}/reminders | 创建文件闹钟 |
| DELETE | /reminders/{id} | 取消文件闹钟 |

### 9.4 附件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /nodes/{nodeId}/attachments | 附件列表 |
| POST | /nodes/{nodeId}/attachments | 上传附件 |
| GET | /attachments/{id}/download | 下载附件 |
| DELETE | /attachments/{id} | 删除附件 |

### 9.5 关联文件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /nodes/{nodeId}/relations | 关联文件列表 |
| POST | /nodes/{nodeId}/relations | 创建关联文件 |
| DELETE | /relations/{id} | 删除关联关系 |

## 10. 分类与属性接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /categories/tree | 分类树 |
| POST | /categories | 创建分类 |
| PUT | /categories/{id} | 修改分类 |
| DELETE | /categories/{id} | 删除分类 |
| GET | /categories/{id}/nodes | 分类下文件 |
| GET | /nodes/{nodeId}/categories | 文件所属分类 |
| PUT | /nodes/{nodeId}/categories | 设置文件分类 |
| GET | /property-definitions | 属性定义列表 |
| POST | /property-definitions | 创建属性定义 |
| PUT | /property-definitions/{id} | 修改属性定义 |
| DELETE | /property-definitions/{id} | 删除属性定义 |
| GET | /nodes/{nodeId}/properties | 文件属性 |
| PUT | /nodes/{nodeId}/properties | 设置文件属性 |

## 11. 审计日志接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /audit-logs | 日志查询 |
| GET | /audit-logs/{id} | 日志详情 |
| POST | /audit-logs/export | 日志导出 |

## 12. 开放 API 管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api-credentials | API 凭证列表 |
| POST | /api-credentials | 创建 API 凭证 |
| PATCH | /api-credentials/{id}/status | 启用/禁用凭证 |
| DELETE | /api-credentials/{id} | 删除凭证 |
| GET | /api-access-logs | API 调用日志 |
