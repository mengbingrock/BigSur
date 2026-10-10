// Talking to a run (docs/protocol-run-design.md §3). Progress is one word
// per phrase; only notes and questions need Siri's follow-up. Every reply
// is the protocol's own words, read back so a wrong "done" is heard at once.
import AppIntents
import Foundation
import UserNotifications

// MARK: - Start

@available(iOS 26.0, *)
struct StartRunIntent: AppIntent {
  static let title: LocalizedStringResource = "Start a run"
  static let description = IntentDescription("Start a protocol run and read its first step.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Protocol", requestValueDialog: "Which protocol?")
  var protocolEntity: ProtocolEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Start \(\.$protocolEntity)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let api = try LabeeAPI.current()
    // The router resumes a paused run of this protocol, continues a chat that
    // has it attached, else starts fresh (siri-design §3.3).
    let route: RouteResult = try await api.post(api.viaHost("/api/siri/route"), RouteBody(text: "", kind: "start", protocolSlug: protocolEntity.id))
    if route.action == "resume", let runId = route.runId {
      let p: RunPayload = try await api.get("/api/runs/\(runId)")
      if p.run.status == "paused" {
        let resumed: RunPayload = try await api.post("/api/runs/\(runId)/resume", RunActionBody())
        return .result(dialog: IntentDialog("Resumed \(p.run.protocolName) at step \(resumed.run.current). \(resumed.view.current.map { Spoken.step($0) } ?? "")"))
      }
      return .result(dialog: IntentDialog("\(p.run.protocolName) is already running, at step \(p.run.current) of \(p.run.snapshot.steps.count). \(p.view.current.map { Spoken.step($0) } ?? "")"))
    }
    let body = StartRunBody(protocolSlug: protocolEntity.id, hostId: api.config.hostId, sessionId: route.action == "continue" ? route.sessionId : nil)
    let p: RunPayload = try await api.post("/api/runs", body)
    let timers = p.run.snapshot.steps.filter { $0.timer != nil }.count
    let first = p.view.current.map { Spoken.step($0) } ?? ""
    let count = "\(p.run.snapshot.steps.count) steps" + (timers > 0 ? ", \(timers) timed" : "")
    return .result(dialog: IntentDialog("Started \(p.run.protocolName). \(count). \(first)"))
  }
}

// MARK: - Progress: one intent, one word

@available(iOS 26.0, *)
enum RunStepAction: String, AppEnum {
  case done, next, back, skip, current, whereAmI, details, pause, resume, finish

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Run action")
  static let caseDisplayRepresentations: [RunStepAction: DisplayRepresentation] = [
    .done: "done",
    .next: "next step",
    .back: "go back",
    .skip: "skip this step",
    .current: "current step",
    .whereAmI: "where am I",
    .details: "step details",
    .pause: "pause",
    .resume: "resume",
    .finish: "finish the run",
  ]
}

@available(iOS 26.0, *)
struct RunStepIntent: AppIntent {
  static let title: LocalizedStringResource = "Run step"
  static let description = IntentDescription("Mark a step done, go back, skip, or hear where you are in the run.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Action")
  var action: RunStepAction

  static var parameterSummary: some ParameterSummary {
    Summary("\(\.$action)")
  }

  init() {}
  init(action: RunStepAction) { self.action = action }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let api = try LabeeAPI.current()
    switch action {
    case .done, .next:
      let p: RunPayload = try await api.post("/api/runs/active/advance", RunActionBody())
      let doneN = p.done?.n ?? max(1, p.run.current - 1)
      if let next = p.next {
        return .result(dialog: IntentDialog("Done with \(doneN). \(Spoken.step(next))"))
      }
      return .result(dialog: IntentDialog("Done with \(doneN). That was the last step. Say finish the \(appName) run to write it up."))
    case .back:
      let p: RunPayload = try await api.post("/api/runs/active/back", RunActionBody())
      return .result(dialog: IntentDialog("Back on step \(p.run.current). \(p.view.current.map { $0.say } ?? "")"))
    case .skip:
      let p: RunPayload = try await api.post("/api/runs/active/skip", RunActionBody())
      if let next = p.next { return .result(dialog: IntentDialog("Skipped. \(Spoken.step(next))")) }
      return .result(dialog: IntentDialog("Skipped the last step. Say finish the \(appName) run to write it up."))
    case .current:
      let p: RunPayload = try await api.get("/api/runs/active")
      guard let cur = p.view.current else { return .result(dialog: IntentDialog("\(p.run.protocolName) is \(p.run.status).")) }
      return .result(dialog: say(Spoken.step(cur)))
    case .whereAmI:
      let p: RunPayload = try await api.get("/api/runs/active")
      var s = "\(p.run.protocolName), step \(p.run.current) of \(p.run.snapshot.steps.count), \(Spoken.elapsed(p.view.elapsedSeconds)) in."
      if p.run.status == "paused" { s += " Paused." }
      if let t = p.view.timers.first(where: { $0.state == "running" }) {
        let left = Spoken.remaining(until: t.endsAt)
        s += left > 0 ? " Timer: \(Spoken.clock(left)) left." : " The \(t.label) timer is done."
      }
      return .result(dialog: say(s))
    case .details:
      let p: RunPayload = try await api.get("/api/runs/active")
      guard let cur = p.view.current else { return .result(dialog: IntentDialog("No step is in progress.")) }
      var s = "Step \(cur.n), in full: \(cur.say)"
      if !cur.amounts.isEmpty {
        s += " Amounts: " + cur.amounts.map { "\($0.qty) \($0.unit)" + ($0.of.map { " \($0)" } ?? "") }.joined(separator: ", ") + "."
      }
      if let note = cur.note { s += " From the notes: \(note)" }
      return .result(dialog: say(s))
    case .pause:
      let p: RunPayload = try await api.post("/api/runs/active/pause", RunActionBody())
      return .result(dialog: IntentDialog("Paused at step \(p.run.current)."))
    case .resume:
      let p: RunPayload = try await api.post("/api/runs/active/resume", RunActionBody())
      return .result(dialog: IntentDialog("Resumed. \(p.view.current.map { Spoken.step($0) } ?? "")"))
    case .finish:
      let p: RunPayload = try await api.post("/api/runs/active/finish", RunActionBody())
      let done = p.view.stepLogDone
      return .result(dialog: IntentDialog("Finished: \(done) of \(p.run.snapshot.steps.count) steps in \(Spoken.elapsed(p.view.elapsedSeconds)), \(p.view.notes.count) note\(p.view.notes.count == 1 ? "" : "s"). Writing it up in your session."))
    }
  }

  private var appName: String { "Labee" }
}

@available(iOS 26.0, *)
extension RunView {
  /// `stepLog` is not decoded (it is large); notes and timers are enough for
  /// the spoken summary, and "done" is current-1 for a finished run.
  var stepLogDone: Int { max(0, (current?.n ?? 0) - 1) }
}

// MARK: - Timers

@available(iOS 26.0, *)
enum TimerLength: String, AppEnum {
  case one, two, three, five, ten, fifteen, twenty, thirty, fortyFive, sixty, ninety, twoHours

  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Timer length")
  static let caseDisplayRepresentations: [TimerLength: DisplayRepresentation] = [
    .one: "1 minute", .two: "2 minutes", .three: "3 minutes", .five: "5 minutes", .ten: "10 minutes",
    .fifteen: "15 minutes", .twenty: "20 minutes", .thirty: "30 minutes", .fortyFive: "45 minutes",
    .sixty: "1 hour", .ninety: "90 minutes", .twoHours: "2 hours",
  ]

  var seconds: Int {
    switch self {
    case .one: return 60
    case .two: return 120
    case .three: return 180
    case .five: return 300
    case .ten: return 600
    case .fifteen: return 900
    case .twenty: return 1200
    case .thirty: return 1800
    case .fortyFive: return 2700
    case .sixty: return 3600
    case .ninety: return 5400
    case .twoHours: return 7200
    }
  }

  var label: String {
    String(localized: TimerLength.caseDisplayRepresentations[self]!.title)
  }
}

@available(iOS 26.0, *)
struct StartTimerIntent: AppIntent {
  static let title: LocalizedStringResource = "Start a timer"
  static let description = IntentDescription("Start the current step's timer, or one of a given length.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Length")
  var length: TimerLength?

  static var parameterSummary: some ParameterSummary {
    Summary("Start a timer \(\.$length)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let api = try LabeeAPI.current()
    var body = RunActionBody()
    if let length {
      body.seconds = length.seconds
      body.label = length.label
    }
    let p: RunPayload = try await api.post("/api/runs/active/timer", body)
    guard let t = p.timer else { return .result(dialog: IntentDialog("I couldn't start that timer.")) }
    await scheduleTimerNotification(run: p.run, timer: t)
    return .result(dialog: IntentDialog("\(t.label), step \(t.step). I'll tell you."))
  }
}

/// The same local notification the app schedules (apps/mobile/src/runs/
/// timers.ts): time-sensitive, with Done / Five more minutes.
@available(iOS 26.0, *)
func scheduleTimerNotification(run: Run, timer: RunTimer) async {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let end = f.date(from: timer.endsAt) ?? ISO8601DateFormatter().date(from: timer.endsAt), end > Date() else { return }
  let content = UNMutableNotificationContent()
  content.title = "\(timer.label) timer done"
  content.body = "\(run.protocolName) · step \(timer.step)"
  content.sound = .default
  content.categoryIdentifier = "labee.timer"
  content.interruptionLevel = .timeSensitive
  content.userInfo = ["kind": "timer", "runId": run.id, "sessionId": run.sessionId, "step": timer.step, "timerId": timer.id]
  let trigger = UNTimeIntervalNotificationTrigger(timeInterval: end.timeIntervalSinceNow, repeats: false)
  let request = UNNotificationRequest(identifier: "labee.timer.\(timer.id)", content: content, trigger: trigger)
  try? await UNUserNotificationCenter.current().add(request)
}

// MARK: - Notes

@available(iOS 26.0, *)
struct NoteIntent: AppIntent {
  static let title: LocalizedStringResource = "Note"
  static let description = IntentDescription("File a note on the current step of the run.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Note", requestValueDialog: "What's the note?")
  var text: String?

  static var parameterSummary: some ParameterSummary {
    Summary("Note \(\.$text)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let note = try await resolvedText()
    let api = try LabeeAPI.current()
    var body = RunActionBody()
    body.text = note
    let p: RunPayload = try await api.post("/api/runs/active/note", body)
    return .result(dialog: IntentDialog("Noted on step \(p.run.current)."))
  }

  private func resolvedText() async throws -> String {
    if let t = text, !t.trimmingCharacters(in: .whitespaces).isEmpty { return t }
    let v: String = try await $text.requestValue("What's the note?")
    return v
  }
}

// MARK: - How much

@available(iOS 26.0, *)
struct HowMuchIntent: AppIntent {
  static let title: LocalizedStringResource = "How much"
  static let description = IntentDescription("The amount of a material for the current step, in the protocol's own words.")
  static let supportedModes: IntentModes = .background

  @Parameter(title: "Material")
  var material: MaterialEntity?

  @Parameter(title: "Of what", requestValueDialog: "Of what?")
  var materialName: String?

  static var parameterSummary: some ParameterSummary {
    Summary("How much \(\.$material)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let api = try LabeeAPI.current()
    let name: String
    if let m = material { name = m.name }
    else if let n = materialName, !n.isEmpty { name = n }
    else { name = try await $materialName.requestValue("Of what?") }
    let a: AmountAnswer = try await api.post("/api/runs/active/amount", AmountBody(material: name))
    if a.found { return .result(dialog: say(a.say)) }
    // Tier 2: the model, with the run as context (run-design §4.2).
    let q: QuickAnswer = try await api.post(api.viaHost("/api/ask/quick"), QuickBody(q: "How much \(name) for the current step?"))
    if !q.needsAgent, !q.answer.isEmpty { return .result(dialog: say(q.answer)) }
    return .result(dialog: IntentDialog("\(a.say) Ask \(appName) to send it to your session if you want the agent to work it out."))
  }

  private var appName: String { "Labee" }
}
