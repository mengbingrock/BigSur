// "Any news from Labee?" (docs/siri-agent-design.md §5): read the returns
// not yet heard, newest first, one per breath, and mark them read. With
// nothing unread, say what is going on instead.
import AppIntents
import Foundation

@available(iOS 26.0, *)
struct CatchUpIntent: AppIntent {
  static let title: LocalizedStringResource = "Any news"
  static let description = IntentDescription("Hear what your chats answered and what your runs are doing.")
  static let supportedModes: IntentModes = .background
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let api = try LabeeAPI.current()
    let news: NewsList = try await api.get(api.viaHost("/api/siri/news"))
    if !news.items.isEmpty {
      let heard = news.items.prefix(3)
      var parts: [String] = []
      if news.items.count == 1 { parts.append("One thing.") } else { parts.append("\(news.items.count) things.") }
      for item in heard {
        let lead = item.question != nil ? "\"\(item.title)\" asks:" : "From \"\(item.title)\":"
        parts.append("\(lead) \(item.spoken)")
      }
      if news.items.count > heard.count { parts.append("And \(news.items.count - heard.count) more in the Siri chat.") }
      if heard.contains(where: { $0.question != nil }) { parts.append("Say answer Labee to reply.") }
      let _: Empty = try await api.post(api.viaHost("/api/siri/news/read"), ReadBody(idx: heard.map(\.idx)))
      if let first = heard.first {
        await SiriActivity.show(await SiriActivity.state(spoken: first.spoken, chatTitle: first.title, sessionId: first.sessionId, unread: news.items.count - heard.count))
      }
      return .result(dialog: say(parts.joined(separator: " ")))
    }
    // Nothing unread: the runs, then the chats.
    let runs: RunsList = (try? await api.get("/api/runs")) ?? RunsList(runs: [])
    let open = runs.runs.filter { $0.status == "running" || $0.status == "paused" }
    if !open.isEmpty {
      let lines = open.map { "\($0.protocolName) at step \($0.current) of \($0.total)\($0.status == "paused" ? ", paused" : "")" }
      return .result(dialog: say("Nothing new. \(open.count == 1 ? "One run is going" : "\(open.count) runs are going"): \(lines.joined(separator: "; "))."))
    }
    if let list: SessionsList = try? await api.get(api.viaHost("/api/sessions")),
       let running = list.sessions.first(where: { $0.kind != "siri" && $0.status == "running" }) {
      return .result(dialog: say("Nothing new yet. \"\(running.title)\" is still working."))
    }
    return .result(dialog: say("Nothing new, and nothing running."))
  }
}
