"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--identifier",
      "local.prompt.inputassistant",
      appPath
    ],
    { stdio: "inherit" }
  );

  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appPath],
    { stdio: "inherit" }
  );
};
