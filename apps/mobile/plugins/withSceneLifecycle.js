// Config plugin: adopt the UIScene life cycle. Xcode 27 / iOS 27 trap at launch
// ("UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption") when an app
// starts React Native from application(_:didFinishLaunchingWithOptions:) with
// no scene manifest. Expo SDK 57 ships ExpoAppSceneDelegate for exactly this;
// the bare template just doesn't use it yet. Applied on every prebuild.
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const SCENE_DELEGATE = `
/// Scene-based life cycle (required by the iOS 27 SDK). Creates the window and
/// starts React Native; every event is forwarded to AppDelegate/subscribers.
class SceneDelegate: ExpoAppSceneDelegate {}
`;

function patchAppDelegate(src) {
  if (src.includes("class SceneDelegate: ExpoAppSceneDelegate")) return src;
  let out = src;
  // 1. Conform to the provider protocol the scene delegate looks up.
  out = out.replace(
    "class AppDelegate: ExpoAppDelegate {",
    "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {\n  var reactNativeFactoryModuleName: String { \"main\" }",
  );
  // 2. Don't start React Native here — the scene delegate does it with its window.
  out = out.replace(
    /#if os\(iOS\) \|\| os\(tvOS\)\s*\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*\n\s*factory\.startReactNative\(\s*\n\s*withModuleName: "main",\s*\n\s*in: window,\s*\n\s*launchOptions: launchOptions\)\s*\n#endif\s*\n/,
    "",
  );
  // 3. The scene delegate class, in the same file so no pbxproj edit is needed.
  return out + SCENE_DELEGATE;
}

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return c;
  });
  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") throw new Error("withSceneLifecycle expects a Swift AppDelegate");
    c.modResults.contents = patchAppDelegate(c.modResults.contents);
    return c;
  });
  return config;
};
