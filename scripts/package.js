'use strict';
/**
 * 部署打包脚本: 生成干净的部署 zip (排除开发文件/系统文件)
 * 用法: npm run deploy:package
 */
const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'deploy');
const ZIP_NAME = `texas-holdem-deploy-${new Date().toISOString().slice(0, 10)}.zip`;

// 打包排除的规则 (相对 ROOT)
const EXCLUDE_RULES = [
  /\.workbuddy/,
  /node_modules/,
  /deploy/,
  /^\.git/,
  /\.DS_Store$/,
  /Thumbs\.db$/,
  /\.log$/,
  /package-lock\.json$/,
];

function shouldExclude(relPath) {
  return EXCLUDE_RULES.some(rule => rule.test(relPath));
}

function collectFiles(dir, base) {
  const result = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (shouldExclude(rel)) continue;
    if (entry.isDirectory()) {
      result.push(...collectFiles(full, base));
    } else {
      result.push(rel);
    }
  }
  return result;
}

function main() {
  console.log('📦 德州扑克部署打包');
  console.log('----------------------------------');

  // 校验核心文件存在
  const missing = [];
  for (const f of ['server.js', 'package.json', 'public/index.html', 'src/game.js']) {
    if (!fs.existsSync(path.join(ROOT, f))) missing.push(f);
  }
  if (missing.length) {
    console.error('✗ 缺少核心文件:', missing.join(', '));
    process.exit(1);
  }

  const files = collectFiles(ROOT, ROOT);
  console.log(`✓ 收集到 ${files.length} 个文件`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = path.join(OUT_DIR, ZIP_NAME);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const output = fs.createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
      console.log(`✓ 打包完成: ${zipPath} (${size} MB)`);
      console.log(`  ${files.length} 个文件, 不含 node_modules/.workbuddy`);
      console.log('');
      console.log('部署步骤:');
      console.log('  1. 上传 zip 到服务器或解压到本地');
      console.log('  2. 安装依赖: npm install');
      console.log('  3. 启动: npm start (或 ./start.sh)');
      resolve();
    });
    archive.on('error', reject);
    archive.pipe(output);
    // 逐个添加文件 (保持目录结构)
    for (const rel of files) {
      archive.file(path.join(ROOT, rel), { name: rel });
    }
    archive.finalize();
  }).catch(e => {
    console.error('✗ 打包失败:', e.message);
    process.exit(1);
  });
}

main();
