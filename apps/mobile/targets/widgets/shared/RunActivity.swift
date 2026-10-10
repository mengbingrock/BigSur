// The Live Activity for a run (docs/protocol-run-design.md §5.3): the current
// step and its timer on the lock screen and in the Dynamic Island, with a
// Done button. Compiled into both the app (which starts and updates the
// activity) and the widget extension (which draws it); the attributes have
// to be the same type in both.
import ActivityKit
import AppIntents
import Foundation

struct RunActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var step: Int
    var total: Int
    var stepText: String
    var timerEndsAt: Date?
    var timerLabel: String?
    var status: String
  }

  var runId: String
  var sessionId: String
  var protocolName: String
}

/// Done from the lock screen. A LiveActivityIntent runs in the app's
/// process, so it uses the same API client and Keychain config the Siri
/// intents do; nothing is needed in the extension beyond the type.
@available(iOS 26.0, *)
struct DoneStepIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Done with step"
  static let description = IntentDescription("Mark the current step of the run done.")
  // Pressed on the Lock Screen with gloves on: it must not ask for Face ID.
  // Marking a step done is the only thing it can do, so no unlock is needed.
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  @Parameter(title: "Run")
  var runId: String

  init() { runId = "" }
  init(runId: String) { self.runId = runId }

  func perform() async throws -> some IntentResult {
    let api = try LabeeAPI.current()
    let p: RunPayload = try await api.post("/api/runs/\(runId)/advance", RunActionBody(device: "Lock screen"))
    await RunActivity.sync(with: p)
    return .result()
  }
}

/// Starting, updating and ending the activity from a run payload. Used by
/// the LabeeSiri module (for the app) and by the intents.
enum RunActivity {
  static func state(from p: RunPayload) -> RunActivityAttributes.ContentState {
    let timer = p.view.timers.first { $0.state == "running" }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let ends = timer.flatMap { f.date(from: $0.endsAt) ?? ISO8601DateFormatter().date(from: $0.endsAt) }
    return RunActivityAttributes.ContentState(
      step: p.run.current,
      total: p.run.snapshot.steps.count,
      stepText: p.view.current?.text.components(separatedBy: "\n").first ?? (p.run.status == "done" ? "All steps done." : ""),
      timerEndsAt: ends,
      timerLabel: timer?.label,
      status: p.run.status
    )
  }

  @available(iOS 16.2, *)
  static func current(for runId: String) -> Activity<RunActivityAttributes>? {
    Activity<RunActivityAttributes>.activities.first { $0.attributes.runId == runId }
  }

  /// Start one for this run (or update the one that exists).
  @available(iOS 16.2, *)
  static func start(with p: RunPayload) async {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let content = ActivityContent(state: state(from: p), staleDate: nil)
    if let existing = current(for: p.run.id) {
      await existing.update(content)
      return
    }
    let attrs = RunActivityAttributes(runId: p.run.id, sessionId: p.run.sessionId, protocolName: p.run.protocolName)
    _ = try? Activity.request(attributes: attrs, content: content, pushType: nil)
  }

  /// Update if one exists; end it when the run is over.
  @available(iOS 16.2, *)
  static func sync(with p: RunPayload) async {
    guard let activity = current(for: p.run.id) else { return }
    let content = ActivityContent(state: state(from: p), staleDate: nil)
    if p.run.status == "done" || p.run.status == "abandoned" {
      await activity.end(content, dismissalPolicy: .after(.now + 60))
    } else {
      await activity.update(content)
    }
  }

  @available(iOS 16.2, *)
  static func end(runId: String) async {
    guard let activity = current(for: runId) else { return }
    await activity.end(nil, dismissalPolicy: .immediate)
  }
}
