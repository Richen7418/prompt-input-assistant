"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "package.json",
  "src/main/main.js",
  "src/main/clipboard.js",
  "src/main/learning-store.js",
  "src/main/platform.js",
  "src/preload.js",
  "src/core/schema.js",
  "src/core/insertion.js",
  "src/core/learning.js",
  "src/core/search.js",
  "src/renderer/manager.html",
  "src/renderer/popup.html",
  "scripts/platform/windows-bridge.ps1",
  "scripts/generate-assets.js",
  "assets/icon.png",
  "README.md"
];

for (const file of requiredFiles) {
  assert.ok(fs.existsSync(path.join(root, file)), `缺少文件：${file}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(packageJson.version, "0.1.5");
assert.equal(packageJson.main, "src/main/main.js");
assert.equal(packageJson.build.appId, "local.prompt.inputassistant");

for (const htmlFile of ["src/renderer/manager.html", "src/renderer/popup.html"]) {
  const html = fs.readFileSync(path.join(root, htmlFile), "utf8");
  assert.match(html, /Content-Security-Policy/u, `${htmlFile} 缺少 CSP`);
  assert.doesNotMatch(html, /https?:\/\//u, `${htmlFile} 不应加载远程资源`);
}

const mainSource = fs.readFileSync(path.join(root, "src/main/main.js"), "utf8");
assert.match(mainSource, /contextIsolation:\s*true/u);
assert.match(mainSource, /nodeIntegration:\s*false/u);
assert.match(mainSource, /sandbox:\s*true/u);
assert.doesNotMatch(mainSource, /loadURL\s*\(/u, "主进程不应加载远程页面");

console.log(`静态结构检查通过：${requiredFiles.length} 个必要文件，CSP 与窗口隔离配置正常。`);
