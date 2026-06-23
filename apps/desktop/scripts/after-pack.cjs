// Ad-hoc code-sign the macOS .app so unsigned local/dev builds launch without
// a "damaged" Gatekeeper error. No-op on other platforms. Notarized release
// signing is handled separately.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "inherit",
    });
    console.log(`[after-pack] ad-hoc signed ${appName}`);
  } catch (err) {
    console.warn(`[after-pack] ad-hoc sign failed: ${err.message}`);
  }
};
