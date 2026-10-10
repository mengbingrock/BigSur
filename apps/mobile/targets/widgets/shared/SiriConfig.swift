// What an intent needs to reach the server, kept in the Keychain under this
// app's own service name with AfterFirstUnlock accessibility: expo-secure-
// store's default is WhenUnlocked, which a Siri request from the lock screen
// cannot read. The widget extension reads the same item: both targets list
// `$(AppIdentifierPrefix)online.labee.mobile` first in keychain-access-groups
// (app.json and targets/widgets/expo-target.config.js), which makes it the
// default group for every query here, so no explicit kSecAttrAccessGroup is
// needed (and a simulator build without entitlements keeps working).
import Foundation
import Security

struct SiriConfig: Codable {
  var base: String
  var hostId: String?
  var sessionToken: String?
}

enum SiriConfigStore {
  private static let service = "online.labee.siri"
  private static let account = "config"

  static func load() -> SiriConfig? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return try? JSONDecoder().decode(SiriConfig.self, from: data)
  }

  static func save(_ config: SiriConfig) throws {
    let data = try JSONEncoder().encode(config)
    clear()
    let attrs: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
      kSecValueData as String: data,
    ]
    let status = SecItemAdd(attrs as CFDictionary, nil)
    if status != errSecSuccess {
      throw NSError(domain: "LabeeSiri", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Keychain write failed (\(status))."])
    }
  }

  static func clear() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
