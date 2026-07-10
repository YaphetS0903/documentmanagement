# ONLYOFFICE 原版预览配置

本文用于配置 Word、PPT、Excel 的原版在线预览。系统已内置文本兜底预览：没有配置 ONLYOFFICE 时仍可打开 Office 文件，但只能看到提取文本；配置成功后会保留原排版、分页、表格和 PPT 页面。

## 当前部署状态

腾讯云测试环境已部署并验收 ONLYOFFICE Docs `8.2.3.1`。容器仅监听服务器本机端口，由 Nginx 通过统一子路径转发，JWT 密钥保存在服务器运行目录，不进入 Git 仓库。

本地开发机如需验证原版预览，需要先安装并启动 Docker Desktop，再运行项目脚本。

官方入口：

- Docker Desktop for Mac: https://docs.docker.com/desktop/setup/install/mac-install/
- ONLYOFFICE Docs Docker 安装: https://helpcenter.onlyoffice.com/installation/docs-community-install-docker.aspx

## 一键启动

确认文档管理平台已经运行在 `http://localhost:3000` 后执行：

```bash
npm run onlyoffice:setup
```

脚本会做这些事：

- 启动容器 `document-platform-onlyoffice`
- 使用固定镜像 `onlyoffice/documentserver:8.2.3.1`
- 映射端口 `8080 -> 80`
- 固定 `JWT_SECRET`
- 等待 `http://localhost:8080/web-apps/apps/api/documents/api.js` 可访问
- 自动写入后台 `系统管理 -> Office 原版预览` 配置

JWT 密钥保存在：

```text
backend/data/onlyoffice.env
```

`backend/data/` 已在 `.gitignore`，不要提交这个文件。

## 后台配置含义

`Document Server 地址`：

```text
http://localhost:8080
```

浏览器用这个地址加载 ONLYOFFICE 的前端脚本。

`平台外部访问地址`：

```text
http://host.docker.internal:3000
```

ONLYOFFICE 容器用这个地址回连文档管理平台，下载需要预览的文件。服务器正式部署时，应改成服务器域名或内网 IP。

`JWT Secret`：

必须和启动 Document Server 时的 `JWT_SECRET` 一致。脚本会自动生成并写入后台。

## 常用命令

查看服务：

```bash
docker ps --filter name=document-platform-onlyoffice
```

查看日志：

```bash
docker logs -f document-platform-onlyoffice
```

重启：

```bash
docker restart document-platform-onlyoffice
```

停止：

```bash
docker stop document-platform-onlyoffice
```

删除并重新初始化：

```bash
docker rm -f document-platform-onlyoffice
npm run onlyoffice:setup
```

## 常见问题

如果后台测试提示 `Document Server API 不可访问`，先检查：

- Docker Desktop 是否已启动
- `docker ps` 里是否有 `document-platform-onlyoffice`
- `http://localhost:8080/web-apps/apps/api/documents/api.js` 是否能打开
- 端口 `8080` 是否被其他程序占用

如果预览窗口显示原版预览加载失败，但文本兜底正常，重点检查：

- 后台 `JWT Secret` 是否和 `backend/data/onlyoffice.env` 一致
- `平台外部访问地址` 是否能被容器访问
- 文档管理平台是否仍运行在 `http://localhost:3000`

本地 Docker Desktop 推荐使用：

```text
平台外部访问地址 = http://host.docker.internal:3000
```

正式服务器部署推荐使用：

```text
平台外部访问地址 = https://服务器域名/文档平台-api
Document Server 地址 = https://服务器域名/文档平台-office
```

服务器上建议只把容器端口绑定到回环地址，例如 `127.0.0.1:8081:80`，再由 Nginx 对外提供 HTTPS 地址。不要直接把 Document Server 管理端口暴露到公网。
