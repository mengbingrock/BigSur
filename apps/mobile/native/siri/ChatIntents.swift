// Talking to Labee (docs/siri-agent-design.md §3, §7): say anything, and the
// Siri agent answers within Siri's budget, acts, or delegates and reports
// back later. Answer the question a chat is waiting on. Open the app in
// Voice mode. All but the last run in the background on a locked phone.
import AppIntents
import Foundation

@available(iOS 26.0, *)
struct SayToLabeeIntent: AppIntent {
  static let title: LocalizedStringResource = "Tell Labee"
  static let description = IntentDescription("Say anything: a question, a command for your run, a message for a chat. Labee answers or gets it done.")
  static let supportedModes: IntentModes = .background
  // Spoken from a locked phone: no Face ID, the phone is on the person.
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  @Parameter(title: "Message", requestValueDialog: "What would you like to say?")
  var message: String?

  static var parameterSummary: some ParameterSummary {
    Summary("Tell Labee \(\.$message)")
  }

  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let text = try await resolved(message, "What would you like to say?", $message)
    let api = try LabeeAPI.current()
    let r: SayResult = try await api.post(api.viaHost("/api/siri/say"), SayBody(text: text))
    if r.status == "confirm", let confirmId = r.confirmId {
      // A risky action (design §6): the agent asks first, and only a yes acts.
      try await requestConfirmation(result: .result(dialog: say(r.spoken)))
      let done: SayResult = try await api.post(api.viaHost("/api/siri/say"), SayBody(confirmId: confirmId, yes: true))
      await SiriActivity.show(await SiriActivity.state(spoken: done.spoken, chatTitle: nil, sessionId: nil))
      return .result(dialog: say(done.spoken))
    }
    // The lock screen keeps what was said (phase 4); a glance replaces a phrase.
    await SiriActivity.show(await SiriActivity.state(spoken: r.spoken, chatTitle: nil, sessionId: nil))
    await LabeeIndex.refresh()
    return .result(dialog: say(r.spoken))
  }
}

@available(iOS 26.0, *)
struct AnswerLabeeIntent: AppIntent {
  static let title: LocalizedStringResource = "Answer Labee"
  static let description = IntentDescription("Answer the question the agent is waiting on.")
  static let supportedModes: IntentModes = .background
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

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
