// The handful of server calls the intents make, done in Swift so nothing
// waits on the React Native bridge (docs/siri-design.md §5.1). Same headers
// the app sends (`x-labee-session`, `x-labee-device: Siri`), same host
// prefixing: chats and the router live on the selected Mac, runs on the
// account server. A 12-second deadline keeps every call inside Siri's 30.
import Foundation

enum LabeeError: LocalizedError {
  case notSignedIn
  case hostAsleep
  case noRun
  case server(String)
  case network

  var errorDescription: String? {
    switch self {
    case .notSignedIn: return "Sign in to Labee first."
    case .hostAsleep: return "Your Mac is asleep, so I can't reach your session."
    case .noRun: return "No run is in progress."
    case .server(let m): return m
    case .network: return "I couldn't reach Labee."
    }
  }
}

struct Empty: Decodable {}

final class LabeeAPI {
  let config: SiriConfig

  init(config: SiriConfig) { self.config = config }

  static func current() throws -> LabeeAPI {
    guard let config = SiriConfigStore.load(), !config.base.isEmpty else { throw LabeeError.notSignedIn }
    return LabeeAPI(config: config)
  }

  /// Chats, the router, quick answers: on the selected Mac when there is one.
  func viaHost(_ path: String) -> String {
    if let h = config.hostId, !h.isEmpty {
      return "/api/hosts/\(h.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? h)\(path)"
    }
    return path
  }

  func get<T: Decodable>(_ path: String) async throws -> T {
    try await request("GET", path, body: nil as String?)
  }

  func post<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
    try await request("POST", path, body: body)
  }

  func request<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
    guard let url = URL(string: config.base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { throw LabeeError.network }
    var req = URLRequest(url: url, timeoutInterval: 12)
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "accept")
    req.setValue("Siri", forHTTPHeaderField: "x-labee-device")
    if let token = config.sessionToken, !token.isEmpty { req.setValue(token, forHTTPHeaderField: "x-labee-session") }
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "content-type")
      req.httpBody = try JSONEncoder().encode(body)
    }
    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await URLSession.shared.data(for: req)
    } catch {
      throw LabeeError.network
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 { throw LabeeError.notSignedIn }
    if status == 503 { throw LabeeError.hostAsleep }
    if status >= 400 {
      let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "Labee answered \(status)."
      if status == 404, message.lowercased().contains("no run") { throw LabeeError.noRun }
      throw LabeeError.server(message)
    }
    if T.self == Empty.self { return Empty() as! T }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw LabeeError.server("Labee sent something I couldn't read.")
    }
  }
}

struct ErrorBody: Decodable { let error: String }

// MARK: - Wire shapes (only the fields the intents read)

struct RouteResult: Decodable {
  let action: String
  let sessionId: String?
  let title: String?
  let runId: String?
  let candidates: [Candidate]
  struct Candidate: Decodable { let sessionId: String; let title: String }
}

struct SendResult: Decodable {
  let needsChoice: Bool
  let sessionId: String?
  let title: String?
  let created: Bool?
  let queued: Bool?
  let candidates: [RouteResult.Candidate]?
}

/// POST /api/siri/say (siri-agent design §3): a phrase, or a yes to a
/// confirmation asked a moment ago.
struct SayBody: Encodable {
  var text: String? = nil
  var confirmId: String? = nil
  var yes: Bool? = nil
  init(text: String) { self.text = text }
  init(confirmId: String, yes: Bool) { self.confirmId = confirmId; self.yes = yes }
}

struct SayResult: Decodable {
  /// answered · working (a chat was started; the return comes later) · confirm
  let status: String
  let spoken: String
  let confirmId: String?
  let siriTurnId: String?
}

struct QuickAnswer: Decodable {
  let answer: String
  let needsAgent: Bool
  let reason: String?
  let sessionId: String?
}

struct SessionSummary: Decodable {
  let id: String
  let title: String
  let status: String
  let kind: String?
  let updatedAt: String
  /// The last assistant line, one sentence, for the index (phase 3).
  let lastLine: String?
  let run: RunBadge?
  struct RunBadge: Decodable { let id: String; let protocolName: String; let current: Int; let total: Int; let status: String }
}

struct SessionsList: Decodable { let sessions: [SessionSummary] }

struct SkillsList: Decodable {
  let skills: [Skill]
  struct Skill: Decodable { let slug: String; let name: String; let artifactKind: String; let description: String? }
}

struct Amount: Decodable { let qty: String; let unit: String; let of: String?; let ratio: Bool }

struct Step: Decodable {
  let n: Int
  let text: String
  let say: String
  let note: String?
  let amounts: [Amount]
  let timer: StepTimer?
  struct StepTimer: Decodable { let seconds: Int; let label: String }
}

struct Material: Decodable { let name: String; let text: String }

struct Run: Decodable {
  let id: String
  let sessionId: String
  let protocolName: String
  let protocolSlug: String
  let current: Int
  let status: String
  let startedAt: String
  let snapshot: Snapshot
  struct Snapshot: Decodable { let steps: [Step]; let materials: [Material] }
}

struct RunTimer: Decodable { let id: String; let step: Int; let seconds: Int; let label: String; let endsAt: String; let state: String }

struct RunView: Decodable {
  let current: Step?
  let next: Step?
  let timers: [RunTimer]
  let elapsedSeconds: Int
  let notes: [Note]
  struct Note: Decodable { let step: Int; let text: String }
}

struct RunPayload: Decodable {
  let run: Run
  let view: RunView
  let done: Step?
  let next: Step?
  let timer: RunTimer?
}

struct AmountAnswer: Decodable {
  let found: Bool
  let text: String
  let say: String
  let step: Int?
}

struct AnswerResult: Decodable { let matched: Bool? }

// MARK: - Request bodies

struct RouteBody: Encodable {
  var text: String
  var kind: String
  var sessionId: String?
  var protocolSlug: String?
  var device = "Siri"
}

struct SendBody: Encodable {
  var text: String
  var kind: String
  var sessionId: String?
  var forceNew: Bool?
  var voice = true
  var device = "Siri"
}

struct QuickBody: Encodable { var q: String; var sessionId: String?; var runId: String?; var device = "Siri" }
struct SpokenBody: Encodable { var spoken: String; var voice = true; var device = "Siri" }
struct StartRunBody: Encodable { var protocolSlug: String; var hostId: String?; var sessionId: String? }
struct RunActionBody: Encodable { var device = "Siri"; var text: String?; var seconds: Int?; var label: String?; var reason: String? }
struct AmountBody: Encodable { var material: String; var step: Int? }

// MARK: - Helpers shared by the intents

enum Spoken {
  static func elapsed(_ seconds: Int) -> String {
    if seconds < 60 { return "\(seconds) seconds" }
    let h = seconds / 3600, m = (seconds % 3600) / 60
    if h > 0 { return m > 0 ? "\(h) hour\(h == 1 ? "" : "s") \(m) minutes" : "\(h) hour\(h == 1 ? "" : "s")" }
    return "\(m) minute\(m == 1 ? "" : "s")"
  }

  static func remaining(until iso: String) -> Int {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let end = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) ?? Date()
    return max(0, Int(end.timeIntervalSinceNow.rounded()))
  }

  static func clock(_ seconds: Int) -> String {
    let m = seconds / 60, s = seconds % 60
    if m == 0 { return "\(s) seconds" }
    return s == 0 ? "\(m) minute\(m == 1 ? "" : "s")" : "\(m) minute\(m == 1 ? "" : "s") \(s)"
  }

  /// "Step 5: spin ten minutes at…" with the timer, if the step has one.
  static func step(_ s: Step, withTimer: Bool = true) -> String {
    var out = "Step \(s.n): \(s.say)"
    if withTimer, let t = s.timer { out += " There's a \(t.label) timer." }
    return out
  }
}

// MARK: - Siri news and runs (shared with the widget extension)

struct ReadBody: Encodable { let idx: [Int] }

struct NewsList: Decodable {
  let items: [NewsItem]
  struct NewsItem: Decodable {
    let idx: Int
    let sessionId: String
    let title: String
    let spoken: String
    let question: Question?
    struct Question: Decodable { let text: String; let options: [String] }
  }
}

struct RunsList: Decodable {
  let runs: [RunItem]
  struct RunItem: Decodable {
    let id: String
    let protocolName: String
    let status: String
    let current: Int
    let total: Int
    let sessionId: String
  }
}
