import { ElMessage } from 'element-plus';

const API_PREFIX = import.meta.env.VITE_API_PREFIX || '/api/v1';

export function getToken() {
  return localStorage.getItem('document_platform_token') || '';
}

export function setToken(token) {
  if (token) localStorage.setItem('document_platform_token', token);
  else localStorage.removeItem('document_platform_token');
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(`${API_PREFIX}${path}`, { ...options, headers, body });
  if (options.blob) {
    if (!response.ok) throw new Error('下载失败');
    return response.blob();
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 'OK') {
    const message = payload.message || '请求失败';
    if (payload.code !== 'NODE_PASSWORD_REQUIRED') ElMessage.error(message);
    const error = new Error(message);
    error.status = response.status;
    error.code = payload.code;
    error.data = payload.data;
    throw error;
  }
  return payload.data;
}

export async function downloadFile(path, filename, body = null, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  if (body) {
    headers['Content-Type'] = 'application/json';
    response = await fetch(`${API_PREFIX}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } else {
    response = await fetch(`${API_PREFIX}${path}`, { headers });
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (payload.code !== 'NODE_PASSWORD_REQUIRED') ElMessage.error(payload.message || '下载失败');
    const error = new Error(payload.message || '下载失败');
    error.status = response.status;
    error.code = payload.code;
    error.data = payload.data;
    throw error;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
