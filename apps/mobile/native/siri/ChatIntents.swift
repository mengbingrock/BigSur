// Talking to the agent (docs/siri-design.md §2.2): tell it something, ask a
// quick question, answer its question, hear what it is doing, stop it, or
// open the app in Voice mode. Text goes through the Siri session's router,
// so Siri's confirmation always names the chat it went to.
import AppIntents
import Foundation

@available(iOS 26.0, *)
struct TellLabeeIntent: AppIntent {
  static let title: LocalizedStringResource = "Tell Labee"
  static let description = IntentDescription("Send a message to the agent; the right chat is picked for you.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Message", requestValueDialog: "What's the message?")
  var message: String?

  @Parameter(title: "Chat")
  var chat: SessionEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("Tell Labee \(\.$message)") {
      \.$chat
    }
  }

  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let text = try await resolved(message, "What's the message?", $message)
    let api = try LabeeAPI.current()
    let r: SendResult = try await api.post(api.viaHost("/api/siri/send"), SendBody(text: text, kind: "tell", sessionId: chat?.id))
    if r.needsChoice, let candidates = r.candidates, !candidates.isEmpty {
      // Unsure: ask which chat, then send there (siri-design §3.3 step 5).
      let options = candidates.map { SessionEntity(id: $0.sessionId, title: $0.title) } + [SessionEntity(id: "__new__", title: "A new chat")]
      let picked: SessionEntity = try await $chat.requestDisambiguation(among: options, dialog: IntentDialog("Which chat: \(candidates.map(\.title).joined(separator: ", ")), or a new one?"))
      let again: SendResult = try await api.post(
        api.viaHost("/api/siri/send"),
        SendBody(text: text, kind: "tell", sessionId: picked.id == "__new__" ? nil : picked.id, forceNew: picked.id == "__new__")
      )
      return .result(dialog: say(sentDialog(again)))
    }
    return .result(dialog: say(sentDialog(r)))
  }

  private func sentDialog(_ r: SendResult) -> String {
    let where_ = r.title.map { "\"\($0)\"" } ?? "your chat"
    let created = r.created == true ? "Started " : "Sent to "
    let queued = r.queued == true ? " It's queued behind the current turn." : " I'll let you know when it answers."
    return created + where_ + "." + queued
  }
}

@available(iOS 26.0, *)
struct AskLabeeIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Labee"
  static let description = IntentDescription("A quick answer from your protocols and chats, or send it to your session.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Question", requestValueDialog: "What's your question?")
  var question: String?

  @Parameter(title: "Chat")
  var chat: SessionEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("Ask Labee \(\.$question)") {
      \.$chat
    }
  }

  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let q = try await resolved(question, "What's your question?", $question)
    let api = try LabeeAPI.current()
    let quick: QuickAnswer = try await api.post(api.viaHost("/api/ask/quick"), QuickBody(q: q, sessionId: chat?.id))
    if !quick.needsAgent, !quick.answer.isEmpty {
      return .result(dialog: IntentDialog("\(quick.answer) Anything else?"))
    }
    // It needs the agent: confirm, then send it to the session (§3.2).
    let reason = quick.reason ?? "That needs your session."
    try await requestConfirmation(result: .result(dialog: IntentDialog("\(reason) Send it to your session?")))
    let r: SendResult = try await api.post(api.viaHost("/api/siri/send"), SendBody(text: q, kind: "ask", sessionId: chat?.id))
    let title = r.title.map { "\"\($0)\"" } ?? "your session"
    return .result(dialog: IntentDialog("Sent to \(title). I'll let you know."))
  }
}

@available(iOS 26.0, *)
struct AnswerLabeeIntent: AppIntent {
  static let title: LocalizedStringResource = "Answer Labee"
  static let description = IntentDescription("Answer the question the agent is waiting on.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Answer", requestValueDialog: "What's your answer?")
  var answer: String?

  static var parameterSummary: some ParameterSummary {
    Summary("Answer Labee \(\.$answer)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let text = try await resolved(answer, "What's your answer?", $answer)
    let api = try LabeeAPI.current()
    let route: RouteResult = try await api.post(api.viaHost("/api/siri/route"), RouteBody(text: text, kind: "answer"))
    guard let sessionId = route.sessionId else {
      return .result(dialog: IntentDialog("Nothing is waiting on you right now."))
    }
    let r: AnswerResult = try await api.post(api.viaHost("/api/sessions/\(sessionId)/answer"), SpokenBody(spoken: text))
    let title = route.title.map { "\"\($0)\"" } ?? "your chat"
    if r.matched == false {
      return .result(dialog: IntentDialog("Sent \"\(text)\" as your answer in \(title)."))
    }
    return .result(dialog: IntentDialog("Okay, going with \"\(text)\" in \(title)."))
  }
}

@available(iOS 26.0, *)
enum ChatAction: String, AppEnum {
  case status, stop

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Agent action")
  static let caseDisplayRepresentations: [ChatAction: DisplayRepresentation] = [
    .status: "what's happening",
    .stop: "stop",
  ]
}

@available(iOS 26.0, *)
struct ChatActionIntent: AppIntent {
  static let title: LocalizedStringResource = "Agent status"
  static let description = IntentDescription("Hear what the agent is doing, or stop it.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Action")
  var action: ChatAction

  static var parameterSummary: some ParameterSummary {
    Summary("\(\.$action)")
  }

  init() {}
  init(action: ChatAction) { self.action = action }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let api = try LabeeAPI.current()
    let list: SessionsList = try await api.get(api.viaHost("/api/sessions"))
    let sessions = list.sessions.filter { $0.kind != "siri" }
    switch action {
    case .status:
      if let waiting = sessions.first(where: { $0.status == "awaiting_input" }) {
        return .result(dialog: IntentDialog("\"\(waiting.title)\" is waiting on you. Say answer Labee to reply."))
      }
      if let running = sessions.first(where: { $0.status == "running" }) {
        return .result(dialog: IntentDialog("Working on \"\(running.title)\"."))
      }
      if let run = sessions.compactMap(\.run).first(where: { $0.status == "running" }) {
        return .result(dialog: IntentDialog("Nothing is running. Your \(run.protocolName) run is at step \(run.current) of \(run.total)."))
      }
      return .result(dialog: IntentDialog("Nothing is running right now."))
    case .stop:
      guard let running = sessions.first(where: { $0.status == "running" }) else {
        return .result(dialog: IntentDialog("Nothing is running."))
      }
      let _: Empty = try await api.post(api.viaHost("/api/sessions/\(running.id)/cancel"), Empty2())
      return .result(dialog: IntentDialog("Stopped \"\(running.title)\"."))
    }
  }
}

struct Empty2: Encodable {}

@available(iOS 26.0, *)
struct NewChatIntent: AppIntent {
  static let title: LocalizedStringResource = "New Labee chat"
  static let description = IntentDescription("Start a new chat with a first message.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Message", requestValueDialog: "What should I send?")
  var message: String?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let text = try await resolved(message, "What should I send?", $message)
    let api = try LabeeAPI.current()
    let r: SendResult = try await api.post(api.viaHost("/api/siri/send"), SendBody(text: text, kind: "tell", forceNew: true))
    return .result(dialog: IntentDialog("Started \"\(r.title ?? "a new chat")\". I'll let you know."))
  }
}

/// Opens the app in Voice mode: the real conversation (siri-design §2.3).
@available(iOS 26.0, *)
struct TalkToLabeeIntent: AppIntent {
  static let title: LocalizedStringResource = "Talk to Labee"
  static let description = IntentDescription("Open Labee in voice mode on a chat.")
  static let supportedModes: IntentModes = .foreground
  static let openAppWhenRun = true

  @Parameter(title: "Chat")
  var chat: SessionEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("Talk to Labee about \(\.$chat)")
  }

  func perform() async throws -> some IntentResult & OpensIntent {
    let target: String
    if let chat { target = chat.id }
    else if let api = try? LabeeAPI.current(),
            let list: SessionsList = try? await api.get(api.viaHost("/api/sessions")),
            let first = list.sessions.first(where: { $0.kind != "siri" }) { target = first.id }
    else { target = "new" }
    return .result(opensIntent: OpenURLIntent(URL(string: "labee://session/\(target)?voice=1")!))
  }
}

// MARK: - shared

/// A dialog from a computed string (a literal with interpolation is already
/// a LocalizedStringResource; a String variable is not).
@available(iOS 26.0, *)
func say(_ text: String) -> IntentDialog {
  IntentDialog(stringLiteral: text)
}

/// A free-text parameter: use what the phrase carried, else have Siri ask.
@available(iOS 26.0, *)
func resolved(_ value: String?, _ prompt: String, _ param: IntentParameter<String?>) async throws -> String {
  if let v = value?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty { return v }
  let asked: String = try await param.requestValue(IntentDialog(stringLiteral: prompt))
  return asked
}
