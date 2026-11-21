import CryptoKit
import Foundation
import NIOSSH
import Security

/// Passwords and the device key, in the iPhone keychain: this device only, never in iCloud or a backup to another phone.
public enum Keychain {
  private static func query(_ account: String) -> [CFString: Any] {
    [kSecClass: kSecClassGenericPassword, kSecAttrService: "kuna", kSecAttrAccount: account]
  }

  public static func get(_ account: String) -> Data? {
    var found: AnyObject?
    let status = SecItemCopyMatching(query(account).merging([kSecReturnData: true]) { $1 } as CFDictionary, &found)
    return status == errSecSuccess ? found as? Data : nil
  }

  /// `nil` or empty removes it.
  public static func set(_ account: String, _ value: Data?) {
    SecItemDelete(query(account) as CFDictionary)
    guard let value, !value.isEmpty else { return }
    SecItemAdd(query(account).merging([kSecValueData: value, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { $1 } as CFDictionary, nil)
  }
}

/// The phone's own ssh key: made once, in the Secure Enclave, which signs with it but never gives it out.
/// The keychain holds only the enclave's handle to it, useless on any other device.
public enum DeviceKey {
  public static func load() throws -> NIOSSHPrivateKey {
    let saved = Keychain.get("device-key")
    guard SecureEnclave.isAvailable else {
      // the simulator has no enclave: an ordinary key in its keychain
      let key = try saved.map { try P256.Signing.PrivateKey(rawRepresentation: $0) } ?? P256.Signing.PrivateKey()
      if saved == nil { Keychain.set("device-key", key.rawRepresentation) }
      return NIOSSHPrivateKey(p256Key: key)
    }
    let key = try saved.map { try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: $0) } ?? SecureEnclave.P256.Signing.PrivateKey()
    if saved == nil { Keychain.set("device-key", key.dataRepresentation) }
    return NIOSSHPrivateKey(secureEnclaveP256Key: key)
  }
}

/// A host key's fingerprint as `ssh` prints it (`SHA256:…`), from its `ssh-ed25519 AAAA…` text.
public func fingerprint(openSSHKey: String) -> String {
  let parts = openSSHKey.split(separator: " ")
  guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return "unreadable key" }
  return "SHA256:" + Data(SHA256.hash(data: blob)).base64EncodedString().replacingOccurrences(of: "=", with: "")
}
