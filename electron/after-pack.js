// electron-builder afterPack hook.
//
// We have no Apple Developer ID, so electron-builder skips code signing. An
// *unsigned* app on Apple Silicon is reported by Gatekeeper as "damaged and
// can't be opened" once it carries the download quarantine flag. Ad-hoc
// signing (codesign --sign -) gives the bundle a valid signature, so the OS
// instead shows the normal, bypassable "unidentified developer" prompt
// (right-click → Open), and the arm64 binary is allowed to execute.
//
// This is NOT notarization — it just makes the unsigned build runnable.

const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`[after-pack] ad-hoc signing ${appName}`);
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" },
  );
  // Sanity check — fails the build if the signature didn't take.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log("[after-pack] ad-hoc signature OK");
};
