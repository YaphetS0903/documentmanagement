import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const errors = [];
const requiredFiles = [
  '.env.example',
  'CHANGELOG.md',
  'docs/正式版发布检查清单.md',
  'docs/四期验收报告.md',
  'dist/index.html'
];

if (!/^1\.0\.0-rc\.\d+$/.test(packageJson.version)) errors.push(`候选版版本号无效：${packageJson.version}`);
requiredFiles.forEach((file) => {
  if (!fs.existsSync(file)) errors.push(`缺少发布文件：${file}`);
});
const builtAssets = fs.existsSync('dist/assets')
  ? fs.readdirSync('dist/assets').filter((name) => name.endsWith('.js')).map((name) => fs.readFileSync(`dist/assets/${name}`, 'utf8')).join('\n')
  : '';
if (/admin123|user123|默认账号/.test(builtAssets)) errors.push('生产前端产物包含开发账号或默认密码');

const trackedFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const forbiddenPaths = trackedFiles.filter((file) => /(^|\/)(\.env($|\.)|backend\/(data|uploads|tmp|backups)\/)|ssh/i.test(file) && file !== '.env.example');
forbiddenPaths.forEach((file) => errors.push(`仓库包含禁止提交的运行时或敏感文件：${file}`));

const trackedText = trackedFiles
  .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size < 2_000_000)
  .map((file) => `${file}\n${fs.readFileSync(file, 'utf8')}`)
  .join('\n');
const secretPatterns = [
  [new RegExp(['密码', '555', 'wang'].join(''), 'i'), '服务器密码'],
  [/JWT_SECRET=[a-f0-9]{32,}/i, '真实 JWT'],
  [/mysql:\/\/[^\s:]+:[^\s@]+@/i, 'MySQL 连接串']
];
secretPatterns.forEach(([pattern, label]) => {
  if (pattern.test(trackedText)) errors.push(`发现疑似${label}`);
});

if (errors.length) {
  errors.forEach((message) => console.error(`错误：${message}`));
  process.exit(1);
}
console.log(`发布检查通过：document-platform ${packageJson.version}`);
