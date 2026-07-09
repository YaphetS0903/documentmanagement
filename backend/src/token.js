import crypto from 'node:crypto';
import { config } from './config.js';

function base64url(input) {
  return Buffer.from(JSON.stringify(input)).toString('base64url');
}

export function signToken(payload, expiresInMs = 24 * 60 * 60 * 1000) {
  const body = {
    ...payload,
    exp: Date.now() + expiresInMs
  };
  const encoded = base64url(body);
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(encoded).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Date.now()) return null;
  return payload;
}
