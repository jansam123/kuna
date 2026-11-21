// swift-tools-version: 5.10
import PackageDescription

// The iPhone app's code. KunaCore is everything that is not a screen: ssh, the
// host helper and Kuna's shared TypeScript logic. KunaUI is the screens; the
// Xcode project around it only starts them. Both also build on macOS, so
// `swift build` and `swift test` check them without a phone.
let package = Package(
  name: "Kuna",
  platforms: [.iOS("27.0"), .macOS(.v14)],
  products: [.library(name: "KunaUI", targets: ["KunaUI"])],
  dependencies: [.package(url: "https://github.com/apple/swift-nio-ssh.git", from: "0.15.0")],
  targets: [
    .target(
      name: "KunaCore",
      dependencies: [.product(name: "NIOSSH", package: "swift-nio-ssh")],
      // made by `npm run ios:bundle`
      resources: [.copy("Resources/kuna-shared.js")]
    ),
    .target(name: "KunaUI", dependencies: ["KunaCore"]),
    .testTarget(name: "KunaCoreTests", dependencies: ["KunaCore"]),
  ]
)
