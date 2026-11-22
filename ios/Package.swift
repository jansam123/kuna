// swift-tools-version: 5.10
import PackageDescription

// The iPhone app's code. KunaCore is everything that is not a screen: ssh, the
// host helper and Kuna's shared TypeScript logic. KunaUI is the screens; the
// Xcode project around it only starts them. KunaCore also builds on macOS, so
// `swift test` checks it without a phone; the screens are iOS only.
let package = Package(
  name: "Kuna",
  platforms: [.iOS("27.0"), .macOS(.v14)],
  products: [.library(name: "KunaUI", targets: ["KunaUI"])],
  dependencies: [
    .package(url: "https://github.com/apple/swift-nio-ssh.git", from: "0.15.0"),
    // 1.11: later ones need Xcode's separate Metal toolchain (1.12) and a build plugin Xcode stops to ask about (1.19)
    .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", .upToNextMinor(from: "1.11.2")),
  ],
  targets: [
    .target(
      name: "KunaCore",
      dependencies: [.product(name: "NIOSSH", package: "swift-nio-ssh")],
      // made by `npm run ios:bundle`
      resources: [.copy("Resources/kuna-shared.js")]
    ),
    .target(name: "KunaUI", dependencies: ["KunaCore", .product(name: "SwiftTerm", package: "SwiftTerm")]),
    .testTarget(name: "KunaCoreTests", dependencies: ["KunaCore"]),
  ]
)
