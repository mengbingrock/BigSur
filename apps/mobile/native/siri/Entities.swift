// What Siri can name in a phrase (docs/siri-design.md §2.4): the person's
// protocols, their chats, and the materials of the run in progress. Each
// query lists recent items so Siri recognises the names instead of
// transcribing them as free text; synonyms cover the short forms people say.
import AppIntents
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

@available(iOS 26.0, *)
struct SessionEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Chat")
  static let defaultQuery = SessionQuery()

  let id: String
  let title: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
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
