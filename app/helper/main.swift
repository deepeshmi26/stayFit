import Foundation
import AppKit

// ---- CONFIG ----

// Ignore apps that should never trigger logic
let ignoredBundleIds: Set<String> = [
    "com.apple.Terminal",        // Terminal.app
    "com.apple.finder"           // Optional: Finder
]

// ---- LOGIC ----

func emitFocusedApp(_ app: NSRunningApplication) {
    let bundleId = app.bundleIdentifier ?? "unknown"
    let name = app.localizedName ?? "unknown"
    let pid = app.processIdentifier

    let json = "{\"focusedApp\":\"\(bundleId)\",\"localizedName\":\"\(name)\",\"processIdentifier\":\(pid)}"

    print(json)
    fflush(stdout)
}

const BLOCKED_APPS = new Set([
  'com.google.Chrome',
  'com.tinyspeck.slackmacgap'
])

// Observe app focus changes
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: nil
) { notification in
    guard
        let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
            as? NSRunningApplication,
        let bundleId = app.bundleIdentifier,
        !ignoredBundleIds.contains(bundleId)
    else {
        return
    }

    emitFocusedApp(app)
}

// ---- KEEP PROCESS ALIVE ----

RunLoop.current.run()
