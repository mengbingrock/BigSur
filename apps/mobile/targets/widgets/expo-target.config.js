// The widget extension: the run's Live Activity and the Control Center
// control (docs/protocol-run-design.md §5.3). Managed by @bacons/apple-targets;
// every file in this folder, including shared/, is part of the target. The
// shared/ files are also compiled into the app as inline modules.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "widget",
  name: "LabeeWidgets",
  displayName: "Labee",
  bundleIdentifier: ".widgets",
  deploymentTarget: "26.0",
  frameworks: ["WidgetKit", "SwiftUI", "ActivityKit", "AppIntents"],
  // The extension reads the Siri config the app wrote to the Keychain
  // (shared/SiriConfig.swift). An extension has its own default keychain
  // group, so both targets list the app's group first and share it.
  entitlements: {
    "keychain-access-groups": ["$(AppIdentifierPrefix)online.labee.mobile"],
  },
  colors: {
    $accent: "#2F6F4F",
    $widgetBackground: { color: "#FAFAF7", darkColor: "#111111" },
  },
};
