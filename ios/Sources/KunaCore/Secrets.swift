import CryptoKit
import Foundation
import NIOSSH
import Security

/// Passwords and the device key, in the iPhone keychain: this device only, never in iCloud or a backup to another phone.
public enum Keychain {
  private static func query(_ account: String) -> [CFString: Any] {
    [kSecClass: kSecClassGenericPassword, kSecAttrService: "kuna", kSecAttrAccount: account]
  }

  public static func get(_ account: String) -> Data? { try? read(account) }

  /// What is kept, nil when nothing is. Throws when the keychain cannot say: a locked phone
  /// answers so, and that is not "nothing kept".
  public static func read(_ account: String) throws -> Data? {
    var found: AnyObject?
    let status = SecItemCopyMatching(query(account).merging([kSecReturnData: true]) { $1 } as CFDictionary, &found)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw KunaError("This phone's keychain could not be read (\(status)); it cannot while the phone is locked.") }
    return found as? Data
  }

  /// `nil` or empty removes it.
  @discardableResult
  public static func set(_ account: String, _ value: Data?) -> Bool {
    SecItemDelete(query(account) as CFDictionary)
    guard let value, !value.isEmpty else { return true }
    return SecItemAdd(query(account).merging([kSecValueData: value, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { $1 } as CFDictionary, nil) == errSecSuccess
  }
}

/// The phone's own ssh key: made once, in the Secure Enclave, which signs with it but never gives it out.
/// The keychain holds only the enclave's handle to it, useless on any other device.
public enum DeviceKey {
  public static func load() throws -> NIOSSHPrivateKey {
    // a keychain that cannot be read is no reason for a new key: the one the hosts know would be lost
    let saved = try Keychain.read("device-key")
    guard SecureEnclave.isAvailable else {
      // the simulator has no enclave: an ordinary key in its keychain
      let key = try saved.map { try P256.Signing.PrivateKey(rawRepresentation: $0) } ?? P256.Signing.PrivateKey()
      if saved == nil { try keep(key.rawRepresentation) }
      return NIOSSHPrivateKey(p256Key: key)
    }
    let key = try saved.map { try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: $0) } ?? SecureEnclave.P256.Signing.PrivateKey()
    if saved == nil { try keep(key.dataRepresentation) }
    return NIOSSHPrivateKey(secureEnclaveP256Key: key)
  }

  /// A key that is not kept would be another one at every launch, and no host would know it.
  private static func keep(_ data: Data) throws {
    guard Keychain.set("device-key", data) else { throw KunaError("This phone's key could not be saved in the keychain.", final: true) }
  }
}

/// A host key's fingerprint as `ssh` prints it (`SHA256:…`), from its `ssh-ed25519 AAAA…` text.
public func fingerprint(openSSHKey: String) -> String {
  let parts = openSSHKey.split(separator: " ")
  guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return "unreadable key" }
  return "SHA256:" + Data(SHA256.hash(data: blob)).base64EncodedString().replacingOccurrences(of: "=", with: "")
}
