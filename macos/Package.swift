// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DayflowSync",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "DayflowSync", targets: ["DayflowSync"])],
    targets: [
        .executableTarget(name: "DayflowSync", linkerSettings: [.linkedLibrary("sqlite3")]),
        .testTarget(name: "DayflowSyncTests", dependencies: ["DayflowSync"])
    ]
)
