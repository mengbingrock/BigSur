// What Siri can name in a phrase (docs/siri-design.md §2.4): the person's
// protocols, their chats, and the materials of the run in progress. Each
// query lists recent items so Siri recognises the names instead of
// transcribing them as free text; synonyms cover the short forms people say.
import AppIntents
import CoreSpotlight
import Foundation

@available(iOS 26.0, *)
struct ProtocolEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Protocol")
  static let defaultQuery = ProtocolQuery()

  let id: String
  let name: String
  let synonyms: [String]

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", synonyms: synonyms.map { LocalizedStringResource(stringLiteral: $0) })
  }

  static func synonyms(for name: String) -> [String] {
    // "Gibson assembly reaction" → "Gibson assembly", "Gibson".
    var out: [String] = []
    let words = name.split(separator: " ").map(String.init)
    if words.count > 2 { out.append(words.prefix(2).joined(separator: " ")) }
    if words.count > 1, let first = words.first, first.count > 3 { out.append(first) }
    let noParens = name.replacingOccurrences(of: #"\s*\(.*?\)"#, with: "", options: .regularExpression)
    if noParens != name { out.append(noParens) }
    return Array(Set(out)).filter { $0.caseInsensitiveCompare(name) != .orderedSame }
  }
}

@available(iOS 26.0, *)
struct ProtocolQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [ProtocolEntity] {
    try await all().filter { identifiers.contains($0.id) }
  }
  func entities(matching string: String) async throws -> [ProtocolEntity] {
    let q = string.lowercased()
    return try await all().filter { $0.name.lowercased().contains(q) || $0.synonyms.contains { $0.lowercased().contains(q) } }
  }
  func suggestedEntities() async throws -> [ProtocolEntity] {
    try await all()
  }
  private func all() async throws -> [ProtocolEntity] {
    let api = try LabeeAPI.current()
    let list: SkillsList = try await api.get(api.viaHost("/api/skills"))
    return list.skills.filter { $0.artifactKind == "protocol" }.prefix(60).map {
      ProtocolEntity(id: $0.slug, name: $0.name, synonyms: ProtocolEntity.synonyms(for: $0.name))
    }
  }
}

/// A chat. Indexed (siri-agent design, phase 3): the system's semantic
/// index holds the title and last line, so Siri AI and Spotlight can refer
/// to "the gel chat" without a phrase, and "Talk to Labee about …" resolves
/// by meaning rather than by substring.
@available(iOS 26.0, *)
struct SessionEntity: IndexedEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Chat")
  static let defaultQuery = SessionQuery()

  let id: String
  let title: String
  var lastLine: String = ""
  var status: String = "idle"

  init(id: String, title: String, lastLine: String = "", status: String = "idle") {
    self.id = id
    self.title = title
    self.lastLine = lastLine
    self.status = status
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)", subtitle: lastLine.isEmpty ? nil : "\(lastLine)")
  }

  var attributeSet: CSSearchableItemAttributeSet {
    let a = CSSearchableItemAttributeSet(contentType: .text)
    a.title = title
    a.contentDescription = lastLine.isEmpty ? "A Labee chat" : lastLine
    a.keywords = ["Labee", "chat", status]
    return a
  }
}

@available(iOS 26.0, *)
struct SessionQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [SessionEntity] {
    try await recent().filter { identifiers.contains($0.id) }
  }
  func entities(matching string: String) async throws -> [SessionEntity] {
    let q = string.lowercased()
    return try await recent().filter { $0.title.lowercased().contains(q) }
  }
  func suggestedEntities() async throws -> [SessionEntity] {
    try await recent()
  }
  private func recent() async throws -> [SessionEntity] {
    let api = try LabeeAPI.current()
    let list: SessionsList = try await api.get(api.viaHost("/api/sessions"))
    return list.sessions.filter { $0.kind != "siri" }.prefix(20).map { SessionEntity(id: $0.id, title: $0.title) }
  }
}

/// A material of the run in progress, so "how much TSS" is one breath.
@available(iOS 26.0, *)
struct MaterialEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Material")
  static let defaultQuery = MaterialQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", synonyms: MaterialEntity.synonyms(for: name).map { LocalizedStringResource(stringLiteral: $0) })
  }

  static func synonyms(for name: String) -> [String] {
    var out: [String] = []
    let lower = name.lowercased()
    if lower.contains("water") { out += ["water", "ddH2O"] }
    if lower.hasSuffix(" buffer") { out.append(String(name.dropLast(7))) }
    if let first = name.split(separator: " ").first, first.count > 2, first != Substring(name) { out.append(String(first)) }
    return out
  }
}

@available(iOS 26.0, *)
struct MaterialQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [MaterialEntity] {
    try await all().filter { identifiers.contains($0.id) }
  }
  func entities(matching string: String) async throws -> [MaterialEntity] {
    let q = string.lowercased()
    return try await all().filter { $0.name.lowercased().contains(q) }
  }
  func suggestedEntities() async throws -> [MaterialEntity] {
    try await all()
  }
  private func all() async throws -> [MaterialEntity] {
    let api = try LabeeAPI.current()
    guard let run: RunPayload = try? await api.get("/api/runs/active") else { return [] }
    var names: [String] = run.run.snapshot.materials.map(\.name)
    for step in run.run.snapshot.steps {
      for a in step.amounts { if let of = a.of { names.append(of) } }
    }
    var seen = Set<String>()
    return names.compactMap { n in
      let key = n.lowercased()
      guard !key.isEmpty, !seen.contains(key) else { return nil }
      seen.insert(key)
      return MaterialEntity(id: key, name: n)
    }
  }
}

/// A protocol run in progress, indexed the same way: "my TSS run".
@available(iOS 26.0, *)
struct RunEntity: IndexedEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Run")
  static let defaultQuery = RunQuery()

  let id: String
  let protocolName: String
  let step: Int
  let total: Int
  let status: String
  let sessionId: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(protocolName)", subtitle: "Step \(step) of \(total)\(status == "paused" ? ", paused" : "")")
  }

  var attributeSet: CSSearchableItemAttributeSet {
    let a = CSSearchableItemAttributeSet(contentType: .text)
    a.title = "\(protocolName) run"
    a.contentDescription = "Step \(step) of \(total), \(status)"
    a.keywords = ["Labee", "run", "protocol", protocolName]
    return a
  }
}

@available(iOS 26.0, *)
struct RunQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [RunEntity] {
    try await open().filter { identifiers.contains($0.id) }
  }
  func entities(matching string: String) async throws -> [RunEntity] {
    let q = string.lowercased()
    return try await open().filter { $0.protocolName.lowercased().contains(q) }
  }
  func suggestedEntities() async throws -> [RunEntity] {
    try await open()
  }
  private func open() async throws -> [RunEntity] {
    let api = try LabeeAPI.current()
    let list: RunsList = try await api.get("/api/runs")
    return list.runs.filter { $0.status == "running" || $0.status == "paused" }.map {
      RunEntity(id: $0.id, protocolName: $0.protocolName, step: $0.current, total: $0.total, status: $0.status, sessionId: $0.sessionId)
    }
  }
}

/// Keep the system index current: called by the app after sign-in and
/// whenever its lists refresh, and by the intents after they act. Chats and
/// runs that are gone are dropped by re-indexing the whole (small) set.
@available(iOS 26.0, *)
enum LabeeIndex {
  static func refresh() async {
    guard let api = try? LabeeAPI.current() else { return }
    let index = CSSearchableIndex.default()
    if let list: SessionsList = try? await api.get(api.viaHost("/api/sessions")) {
      let chats = list.sessions.filter { $0.kind != "siri" }.prefix(50).map {
        SessionEntity(id: $0.id, title: $0.title, lastLine: $0.lastLine ?? "", status: $0.status)
      }
      try? await index.deleteAppEntities(ofType: SessionEntity.self)
      try? await index.indexAppEntities(Array(chats))
    }
    if let runs: RunsList = try? await api.get("/api/runs") {
      let open = runs.runs.filter { $0.status == "running" || $0.status == "paused" }.map {
        RunEntity(id: $0.id, protocolName: $0.protocolName, step: $0.current, total: $0.total, status: $0.status, sessionId: $0.sessionId)
      }
      try? await index.deleteAppEntities(ofType: RunEntity.self)
      try? await index.indexAppEntities(open)
    }
  }
}
