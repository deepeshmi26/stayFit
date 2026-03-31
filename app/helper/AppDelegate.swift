import AppKit
import Foundation

// MARK: - Overlay Window

final class OverlayWindow: NSWindow {

    private let button: NSButton

    init(frame: CGRect) {
        // Create button first
        button = NSButton(
            title: "Postpone",
            target: nil,
            action: nil
        )

        super.init(
            contentRect: frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )

        // Window appearance
        isOpaque = false
        backgroundColor = NSColor.black.withAlphaComponent(0.6)
        hasShadow = false
        level = .screenSaver
        ignoresMouseEvents = false
        collectionBehavior = [.fullScreenAuxiliary]

        // Content view
        let contentView = NSView(frame: frame)
        self.contentView = contentView

        // Configure button
        button.target = self
        button.action = #selector(buttonClicked)
        button.bezelStyle = .rounded
        button.translatesAutoresizingMaskIntoConstraints = false

        contentView.addSubview(button)

        // Center button
        NSLayoutConstraint.activate([
            button.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            button.centerYAnchor.constraint(equalTo: contentView.centerYAnchor)
        ])

        makeKeyAndOrderFront(nil)
    }

    @objc private func buttonClicked() {
        print("BUTTON_CLICKED")
        fflush(stdout)
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {

    private var overlay: OverlayWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        startReadingStdin()
    }

    // MARK: Overlay control

    private func showOverlay(rect: CGRect) {
        if overlay == nil {
            overlay = OverlayWindow(frame: rect)
        } else {
            overlay?.setFrame(rect, display: true)
        }
    }

    private func hideOverlay() {
        overlay?.close()
        overlay = nil
    }

    // MARK: Stdin handling

    private func startReadingStdin() {
        let stdin = FileHandle.standardInput

        stdin.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            guard let line = String(data: data, encoding: .utf8) else { return }
            self?.handleCommand(line)
        }
    }

    private func handleCommand(_ line: String) {
        guard
            let data = line.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let cmd = json["cmd"] as? String
        else { return }

        DispatchQueue.main.async {
            switch cmd {

            case "SHOW_OVERLAY":
                if let frame = NSScreen.main?.frame {
                    self.showOverlay(rect: frame)
                }

            case "SHOW_OVERLAY_RECT":
                guard
                    let x = json["x"] as? CGFloat,
                    let y = json["y"] as? CGFloat,
                    let w = json["width"] as? CGFloat,
                    let h = json["height"] as? CGFloat
                else { return }

                let rect = CGRect(x: x, y: y, width: w, height: h)
                self.showOverlay(rect: rect)

            case "HIDE_OVERLAY":
                self.hideOverlay()

            default:
                break
            }
        }
    }
}
