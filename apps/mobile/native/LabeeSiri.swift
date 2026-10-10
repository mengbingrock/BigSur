// The JS ↔ native bridge for Siri (docs/siri-design.md §5.2). The app hands
// over what the intents need to call the server — account server, selected
// Mac, sealed session — and this keeps it in the Keychain, readable after
// the first unlock so a request from the lock screen works. Inline Expo
// module: the file name is the module name.
internal import ExpoModulesCore
import AppIntents

final class LabeeSiri: Module {
  func definition() -> ModuleDefinition {
    Name("LabeeSiri")

    AsyncFunction("configure") { (config: [String: Any]?) in
      if let config, let base = config["base"] as? String {
        let hostId = config["hostId"] as? String
        let token = config["sessionToken"] as? String
        try SiriConfigStore.save(SiriConfig(base: base, hostId: hostId, sessionToken: token))
      } else {
        SiriConfigStore.clear()
      }
    }

    AsyncFunction("updateShortcuts") {
      if #available(iOS 26.0, *) {
        LabeeShortcuts.updateAppShortcutParameters()
      }
    }

    AsyncFunction("donate") { (intent: String) in
      if #available(iOS 26.0, *) {
        switch intent {
        case "tell": _ = try? await TellLabeeIntent().donate()
        case "ask": _ = try? await AskLabeeIntent().donate()
        case "note": _ = try? await NoteIntent().donate()
        default: break
        }
      }
    }

    // Live Activity for a run (run-design §5.3): the JS side passes the run
    // payload it already holds, as JSON, so no second fetch is needed.
    AsyncFunction("startRunActivity") { (payloadJson: String) in
      guard #available(iOS 16.2, *), let p = decodePayload(payloadJson) else { return }
      await RunActivity.start(with: p)
    }
    AsyncFunction("syncRunActivity") { (payloadJson: String) in
      guard #available(iOS 16.2, *), let p = decodePayload(payloadJson) else { return }
      await RunActivity.sync(with: p)
    }
    AsyncFunction("endRunActivity") { (runId: String) in
      guard #available(iOS 16.2, *) else { return }
      await RunActivity.end(runId: runId)
    }
  }

  private func decodePayload(_ json: String) -> RunPayload? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(RunPayload.self, from: data)
  }
}
