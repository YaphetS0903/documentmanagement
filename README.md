# 文档管理平台

基于 Vue 3、Express、MySQL/JSON 账本和 ONLYOFFICE Docs 的企业 B/S 文档管理平台。当前候选版本为 `1.0.0-rc.1`。

## 核心能力

- 企业文档库、个人网盘、服务器同步目录和细粒度权限继承。
- 文件上传、批量操作、版本、回滚、锁定、回收站和物理文件清理。
- DOCX、XLSX、PPTX 原版预览、在线编辑和自动保存新版本。
- PDF、图片、文本、Markdown、JSON、代码预览和语法高亮。
- 正文全文检索、相关性排序、组合筛选、建议、最近搜索和索引重建。
- 分类、标签、扩展属性、评论、评分、关联、质量检查和周期复审。
- 发布、借阅、下载、外发和权限申请审批，支持条件分支、会签、或签、转交、加签、撤回、催办和超时提醒。
- 站内消息、企业微信投递记录与重试、公告、订阅和提醒。
- 用户、部门、角色、审计、开放 API、备份恢复、一致性检查、健康状态和告警。

## 技术架构

- 前端：Vue 3、Vite、Element Plus、Lucide。
- 后端：Node.js 20、Express。
- 数据：远程 MySQL 快照账本；不可用时可在非正式环境降级 JSON。
- 文件：服务器持久化目录，可配合 NAS 或共享目录。
- Office：ONLYOFFICE Document Server。

## 本地开发

```bash
npm install --cache .npm-cache
cp .env.example .env
npm run seed
npm run dev
```

开发环境使用初始化测试账号；生产登录页不会显示或预填测试密码。生产环境必须在首次初始化时配置强密码，并在上线前修改或停用测试账号。

## 验证

```bash
npm test
npm run build
npm run release:check
```

`npm test` 覆盖文档主流程、三种 Office 在线编辑回调、检索、审批、通知、备份恢复、健康检查、安全约束和物理文件清理。

## 生产部署

```bash
cp .env.example .env
npm ci --omit=dev --cache .npm-cache
npm run build
npm run production:check
npm start
```

生产环境要求：

- 使用至少 32 字符的随机 `JWT_SECRET`。
- 将 `DATA_DIR`、`UPLOAD_DIR`、`TMP_DIR`、`BACKUP_DIR`、`QUARANTINE_DIR` 放在仓库外的持久化磁盘。
- 正式 MySQL 必须连接成功，不应以 JSON 降级状态上线。
- 修改管理员默认密码，停用不需要的演示账号。
- 配置 HTTPS、反向代理、ONLYOFFICE JWT 和备份策略。

详细资料：

- `docs/生产部署说明.md`
- `docs/部署与数据安全说明.md`
- `docs/正式版发布检查清单.md`
- `docs/正式上线与数据迁移实施方案.md`
- `docs/四期验收报告.md`

真实 `.env`、数据库连接、SSH 文件、运行数据、上传文件和备份不得提交到 Git。
