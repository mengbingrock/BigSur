// The Siri agent's Live Activity (docs/siri-agent-design.md phase 4): the
// last thing it said, on the lock screen, so a glance replaces a phrase.
// Started by the Say and Any-news intents in the app's process; the widget
// extension draws it. Buttons: Any news (refreshes in place, no app), Done
// (when a run is going; the run's own intent), Open (the chat, in Voice
// mode). It ends itself after an hour of silence.
import ActivityKit
import AppIntents
import Foundation

struct SiriActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var spoken: String
    var chatTitle: String?
    var sessionId: String?
    /// The run in progress, for the Done button.
    var runId: String?
    var runLine: String?
    var unread: Int
    var at: Date
  }
  var started: Date
}

enum SiriActivity {
  @available(iOS 16.2, *)
  static var current: Activity<SiriActivityAttributes>? {
    Activity<SiriActivityAttributes>.activities.first
  }

  /// Show (or update) with what was just said.
  @available(iOS 16.2, *)
  static func show(_ state: SiriActivityAttributes.ContentState) async {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(3600))
    if let existing = current {
      await existing.update(content)
      return
    }
    _ = try? Activity.request(attributes: SiriActivityAttributes(started: Date()), content: content, pushType: nil)
  }

  /// A state from a spoken reply plus whatever run is going.
  static func state(spoken: String, chatTitle: String?, sessionId: String?, unread: Int = 0) async -> SiriActivityAttributes.ContentState {
    var runId: String?
    var runLine: String?
    if let api = try? LabeeAPI.current(), let runs: RunsList = try? await api.get("/api/runs"),
       let open = runs.runs.first(where: { $0.status == "running" }) {
      runId = open.id
      runLine = "\(open.protocolName), step \(open.current) of \(open.total)"
    }
    return SiriActivityAttributes.ContentState(spoken: spoken, chatTitle: chatTitle, sessionId: sessionId, runId: runId, runLine: runLine, unread: unread, at: Date())
  }

  @available(iOS 16.2, *)
  static func end() async {
    guard let a = current else { return }
    await a.end(nil, dismissalPolicy: .immediate)
  }
}

/// The Any-news button on the activity: fetch, speak nothing (it is a
/// button), show the newest return in place and mark it read.
@available(iOS 26.0, *)
struct NewsLiveIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Any news"
  static let description = IntentDescription("Show the latest answer from your chats.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  init() {}

  func perform() async throws -> some IntentResult {
    let api = try LabeeAPI.current()
    let news: NewsList = try await api.get(api.viaHost("/api/siri/news"))
    if let first = news.items.first {
      let lead = first.question != nil ? "\"\(first.title)\" asks: " : "\"\(first.title)\": "
      await SiriActivity.show(await SiriActivity.state(spoken: lead + first.spoken, chatTitle: first.title, sessionId: first.sessionId, unread: max(0, news.items.count - 1)))
      let _: Empty = try await api.post(api.viaHost("/api/siri/news/read"), ReadBody(idx: [first.idx]))
    } else {
      await SiriActivity.show(await SiriActivity.state(spoken: "Nothing new.", chatTitle: nil, sessionId: nil))
    }
    return .result()
  }
}
