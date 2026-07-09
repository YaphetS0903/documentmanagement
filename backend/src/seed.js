import { resetDb } from './db.js';
import { ensureDir } from './utils.js';
import { config } from './config.js';

await ensureDir(config.uploadDir);
await ensureDir(config.tmpDir);
const db = await resetDb();

console.log(`Seed complete: ${db.users.length} users, ${db.departments.length} departments, ${db.roles.length} roles, ${db.nodes.length} nodes.`);
console.log('Default accounts: admin/admin123, demo/user123');
