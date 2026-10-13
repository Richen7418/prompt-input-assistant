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
  "src/renderer/quick-add.html",
  "src/renderer/quick-add.css",
  "src/renderer/quick-add.js",
  "scripts/platform/windows-bridge.ps1",
  "scripts/after-pack.js",
  "scripts/generate-assets.js",
  "assets/icon.png",
  "README.md"
];

for (const file of requiredFiles) {
  assert.ok(fs.existsSync(path.join(root, file)), `缺少文件：${file}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(packageJson.version, "1.0.1");
assert.equal(packageJson.main, "src/main/main.js");
assert.equal(packageJson.build.appId, "local.prompt.inputassistant");
assert.equal(packageJson.build.afterPack, "scripts/after-pack.js");

for (const htmlFile of ["src/renderer/manager.html", "src/renderer/popup.html", "src/renderer/quick-add.html"]) {
  const html = fs.readFileSync(path.join(root, htmlFile), "utf8");
  assert.match(html, /Content-Security-Policy/u, `${htmlFile} 缺少 CSP`);
  assert.doesNotMatch(html, /https?:\/\//u, `${htmlFile} 不应加载远程资源`);
}

const mainSource = fs.readFileSync(path.join(root, "src/main/main.js"), "utf8");
const platformSource = fs.readFileSync(path.join(root, "src/main/platform.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "src/renderer/popup.html"), "utf8");
assert.match(mainSource, /contextIsolation:\s*true/u);
assert.match(mainSource, /nodeIntegration:\s*false/u);
assert.match(mainSource, /sandbox:\s*true/u);
assert.match(mainSource, /process\.platform === "darwin" \? \{ type: "panel" \}/u,
  "macOS 候选窗必须使用不切换 Space 的 panel 类型");
assert.match(mainSource, /setMacActivationPolicy\("accessory"\)/u,
  "macOS 候选窗必须使用 accessory 激活策略");
assert.match(mainSource, /const MAC_OVERLAY_WINDOW_LEVEL = "floating"/u,
  "macOS 候选窗必须使用不会覆盖输入法候选框的浮动层级");
assert.doesNotMatch(mainSource, /window\.setAlwaysOnTop\(true, "screen-saver"\)/u,
  "macOS 候选窗不应覆盖输入法候选框");
assert.match(mainSource, /skipTransformProcessType:\s*true/u,
  "macOS 候选窗不应改变管理窗口的进程显示策略");
assert.match(mainSource, /isTrustedAccessibilityClient\(true\)/u,
  "macOS 必须主动请求辅助功能权限");
assert.match(mainSource, /quickAddWindow\.webContents\.send\("quick-add:open"/u,
  "快速新增必须使用独立浮动窗口");
assert.match(mainSource, /app\.on\("activate", handleAppActivate\)/u,
  "macOS 激活时必须优先保持已显示的浮窗，不能跳回管理窗口");
assert.doesNotMatch(mainSource, /app\.on\("activate", showManager\)/u,
  "macOS 激活时不应无条件跳回管理窗口");
assert.doesNotMatch(mainSource, /targetHasKnownNonInput\(currentTarget\)/u,
  "候选窗不能因 AX 暂时未识别到输入控件而拒绝打开");
assert.match(mainSource, /insertSemicolonIntoManager\(\)/u,
  "分号快捷键必须持续注册，并在管理窗口中原样写回输入字段");
assert.match(platformSource, /AXFocusedUIElement/u,
  "macOS 必须读取真实获得焦点的输入控件");
assert.match(popupHtml, /id="title-filter-list"/u,
  "候选窗必须包含横向标题标签栏");
assert.doesNotMatch(mainSource, /loadURL\s*\(/u, "主进程不应加载远程页面");

console.log(`静态结构检查通过：${requiredFiles.length} 个必要文件，CSP 与窗口隔离配置正常。`);
