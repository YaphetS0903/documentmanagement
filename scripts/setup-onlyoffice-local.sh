#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="${ONLYOFFICE_CONTAINER_NAME:-document-platform-onlyoffice}"
IMAGE="${ONLYOFFICE_IMAGE:-onlyoffice/documentserver:8.2.3.1}"
DOCSERVER_PORT="${ONLYOFFICE_PORT:-8080}"
PLATFORM_PORT="${PLATFORM_PORT:-3000}"
DOCUMENT_SERVER_URL="${DOCUMENT_SERVER_URL:-http://localhost:${DOCSERVER_PORT}}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://host.docker.internal:${PLATFORM_PORT}}"
PLATFORM_API_URL="${PLATFORM_API_URL:-http://localhost:${PLATFORM_PORT}/api/v1}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"
SECRETS_FILE="${ONLYOFFICE_SECRETS_FILE:-${ROOT_DIR}/backend/data/onlyoffice.env}"

if ! command -v docker >/dev/null 2>&1; then
  cat <<'EOF'
未检测到 docker 命令。

请先安装并启动 Docker Desktop for Mac，然后重新运行：
  npm run onlyoffice:setup

Apple Silicon 电脑安装 Docker Desktop 后，脚本会使用 linux/amd64 镜像启动 ONLYOFFICE Document Server。
EOF
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker 已安装但服务未启动，请先打开 Docker Desktop，等状态变为 Running 后再运行本脚本。"
  exit 1
fi

mkdir -p "$(dirname "${SECRETS_FILE}")"
if [ -f "${SECRETS_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${SECRETS_FILE}"
fi

if [ -z "${JWT_SECRET:-}" ]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  {
    echo "JWT_SECRET=${JWT_SECRET}"
    echo "CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${SECRETS_FILE}"
  chmod 600 "${SECRETS_FILE}"
fi

if lsof -nP -iTCP:"${DOCSERVER_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  EXISTING="$(lsof -nP -iTCP:"${DOCSERVER_PORT}" -sTCP:LISTEN | tail -n +2 || true)"
  if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    echo "端口 ${DOCSERVER_PORT} 已被占用："
    echo "${EXISTING}"
    echo "请释放端口，或用 ONLYOFFICE_PORT=其它端口 重新运行。"
    exit 1
  fi
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null
fi

echo "启动 ONLYOFFICE Document Server..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --memory "${ONLYOFFICE_MEMORY_LIMIT:-8g}" \
  --memory-swap "${ONLYOFFICE_MEMORY_SWAP_LIMIT:-10g}" \
  --platform linux/amd64 \
  -p "${DOCSERVER_PORT}:80" \
  -e JWT_ENABLED=true \
  -e JWT_SECRET="${JWT_SECRET}" \
  -e PLUGINS_ENABLED=false \
  "${IMAGE}" >/dev/null

echo "等待 Document Server 就绪：${DOCUMENT_SERVER_URL}"
READY=0
for _ in $(seq 1 90); do
  if curl -fsS "${DOCUMENT_SERVER_URL}/web-apps/apps/api/documents/api.js" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done

if [ "${READY}" != "1" ]; then
  echo "ONLYOFFICE 启动超时，请查看日志：docker logs ${CONTAINER_NAME}"
  exit 1
fi

echo "写入文档管理平台 Office 预览配置..."
PLATFORM_API_URL_ENV="${PLATFORM_API_URL}" \
ADMIN_USER_ENV="${ADMIN_USER}" \
ADMIN_PASSWORD_ENV="${ADMIN_PASSWORD}" \
DOCUMENT_SERVER_URL_ENV="${DOCUMENT_SERVER_URL}" \
PUBLIC_BASE_URL_ENV="${PUBLIC_BASE_URL}" \
JWT_SECRET_ENV="${JWT_SECRET}" \
node --input-type=module <<'NODE'
const base = process.env.PLATFORM_API_URL_ENV;
const username = process.env.ADMIN_USER_ENV;
const password = process.env.ADMIN_PASSWORD_ENV;
const documentServerUrl = process.env.DOCUMENT_SERVER_URL_ENV;
const publicBaseUrl = process.env.PUBLIC_BASE_URL_ENV;
const jwtSecret = process.env.JWT_SECRET_ENV;

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 'OK') {
    throw new Error(payload.message || response.statusText || '请求失败');
  }
  return payload.data;
}

const captcha = await request('/auth/captcha');
const captchaAnswer = captcha.question.match(/\\d+/g).map(Number).reduce((sum, value) => sum + value, 0);
const login = await request('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password, captchaId: captcha.id, captchaAnswer: String(captchaAnswer) })
});
await request('/system-settings/office-preview', {
  method: 'PUT',
  headers: { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    enabled: true,
    provider: 'onlyoffice',
    documentServerUrl,
    publicBaseUrl,
    jwtSecret
  })
});
console.log(JSON.stringify({ documentServerUrl, publicBaseUrl }, null, 2));
NODE

cat <<EOF

完成。

ONLYOFFICE 地址：
  ${DOCUMENT_SERVER_URL}

平台文件访问地址：
  ${PUBLIC_BASE_URL}

JWT 密钥保存位置：
  ${SECRETS_FILE}

现在可以在文档管理平台里打开 doc/docx/ppt/pptx/xls/xlsx 文件测试原版预览。
EOF
