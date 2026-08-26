"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { generateAssets } = require("./generate-assets");

generateAssets();

const result = spawnSync(process.execPath, [
  path.join(__dirname, "..", "node_modules", "electron", "install.js")
], { stdio: "inherit" });

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
