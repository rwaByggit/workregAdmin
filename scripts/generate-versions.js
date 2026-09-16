#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const outputFile = path.join(rootDir, 'app', 'lib', 'page-versions.json');

function gitInfo(filePath) {
  try {
    const command = filePath
      ? `git log -1 --format="%h|%aI" -- "${filePath}"`
      : 'git log -1 --format="%h|%aI"';
    const output = execSync(command, {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim();
    const [hash, date] = output.split('|');
    return { hash: hash?.slice(0, 5) || 'local', date: date || new Date().toISOString() };
  } catch {
    return { hash: 'local', date: new Date().toISOString() };
  }
}

const pageFiles = execSync('find app -name "page.tsx" -type f', {
  cwd: rootDir,
  encoding: 'utf8',
}).trim().split('\n').filter(Boolean);
const versions = {};

for (const file of pageFiles) {
  const route = file.replace(/^app/, '').replace(/\/page\.tsx$/, '').replace(/\(default\)/g, '').replace(/\/+/g, '/') || '/';
  const info = gitInfo(file);
  versions[route.startsWith('/') ? route : `/${route}`] = { hash: info.hash, file, updated: info.date };
}

const appInfo = gitInfo('');
versions._app = { hash: appInfo.hash, updated: appInfo.date };
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(versions, null, 2)}\n`);
