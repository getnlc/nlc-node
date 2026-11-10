import AppKit
import Darwin
import Foundation

// NLC Node menu-bar app. Starts the Node host, shows a connected / paused / offline dot in the menu bar,
// opens the Node window (a loopback page served by the host, piece K), registers launch at login, and keeps one instance.

let windowPath = "/"
let bundleIdentifier = "com.nlc.node"
let launchAgentLabel = "com.nlc.node"

struct ReadyRecord: Decodable {
    let state: String
    let pid: Int32
    let launchId: String
}

struct EndpointRecord: Decodable {
    let port: Int
}

let stateRoot = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/NLC Node")

func readyRecord() -> ReadyRecord? {
    guard let data = try? Data(contentsOf: stateRoot.appendingPathComponent("ready.json")) else { return nil }
    return try? JSONDecoder().decode(ReadyRecord.self, from: data)
}

func processIsAlive(_ pid: Int32) -> Bool {
    if pid <= 0 { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

func hostIsLive() -> Bool {
    if let record = readyRecord(), record.state == "ready", processIsAlive(record.pid) { return true }
    return false
}

func windowURL() -> URL? {
    guard let data = try? Data(contentsOf: stateRoot.appendingPathComponent("endpoint.json")),
          let endpoint = try? JSONDecoder().decode(EndpointRecord.self, from: data),
          endpoint.port > 0, endpoint.port <= 65535 else { return nil }
    return URL(string: "http://127.0.0.1:\(endpoint.port)\(windowPath)")
}

// In verification runs it only records the address it would open, so a build machine opens no window.
func openWindow(recordOnly: Bool) {
    guard let url = windowURL() else { return }
    if recordOnly {
        try? url.absoluteString.write(to: stateRoot.appendingPathComponent("last-open.txt"), atomically: true, encoding: .utf8)
        return
    }
    NSWorkspace.shared.open(url)
}

enum Indicator: String {
    case connected, paused, offline
}

// The host writes indicator.json ({"state":"connected"|"paused"|"offline"}) when the connection changes and at least every 20 seconds.
// A missing or stale file, or a host that is not running, shows as offline.
func currentIndicator() -> Indicator {
    guard hostIsLive() else { return .offline }
    let file = stateRoot.appendingPathComponent("indicator.json")
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
          let modified = attributes[.modificationDate] as? Date,
          Date().timeIntervalSince(modified) <= 60,
          let data = try? Data(contentsOf: file),
          let text = String(data: data, encoding: .utf8) else { return .offline }
    if text.contains("\"state\":\"connected\"") { return .connected }
    if text.contains("\"state\":\"paused\"") { return .paused }
    return .offline
}

func launchAgentURL() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel).plist")
}

// Launch at login for this user: a LaunchAgent that starts this app quietly (no window).
func installLaunchAtLogin() {
    guard let executable = Bundle.main.executablePath else { return }
    let plist: [String: Any] = [
        "Label": launchAgentLabel,
        "ProgramArguments": [executable, "--background"],
        "RunAtLoad": true,
        "LimitLoadToSessionType": "Aqua",
        "ProcessType": "Interactive",
    ]
    guard let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) else { return }
    let destination = launchAgentURL()
    if let existing = try? Data(contentsOf: destination), existing == data { return }
    try? FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: destination, options: .atomic)
}

func removeLaunchAtLogin() {
    try? FileManager.default.removeItem(at: launchAgentURL())
}

func showNotReady() {
    let alert = NSAlert()
    alert.messageText = "NLC Node is not ready yet. Please try again."
    alert.alertStyle = .warning
    alert.runModal()
}

func startHostAndWait() -> Bool {
    guard let host = Bundle.main.url(forAuxiliaryExecutable: "NLC Node Host") else { return false }
    let launchId = UUID().uuidString
    let process = Process()
    process.executableURL = host
    process.arguments = ["--launch-id", launchId]
    do { try process.run() } catch { return false }
    for _ in 0..<100 {
        if let record = readyRecord(), record.state == "ready", record.pid == process.processIdentifier, record.launchId == launchId {
            return true
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return false
}

func stopHost() {
    guard let host = Bundle.main.url(forAuxiliaryExecutable: "NLC Node Host") else { return }
    let process = Process()
    process.executableURL = host
    process.arguments = ["--stop"]
    do { try process.run() } catch { return }
    process.waitUntilExit()
}

func dot(_ color: NSColor) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
        color.setFill()
        NSBezierPath(ovalIn: rect.insetBy(dx: 4, dy: 4)).fill()
        return true
    }
    image.isTemplate = false
    return image
}

final class MenuBarController: NSObject {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let header = NSMenuItem(title: "NLC Node", action: nil, keyEquivalent: "")
    var shown: Indicator? = nil

    func start() {
        header.isEnabled = false
        let menu = NSMenu()
        menu.addItem(header)
        menu.addItem(NSMenuItem.separator())
        let open = NSMenuItem(title: "Open NLC Node", action: #selector(openFromMenu), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        let quit = NSMenuItem(title: "Quit NLC Node", action: #selector(quitFromMenu), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        refresh()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        let indicator = currentIndicator()
        if indicator == shown { return }
        shown = indicator
        let color: NSColor = indicator == .connected ? .systemGreen : indicator == .paused ? .systemGray : .systemRed
        item.button?.image = dot(color)
        item.button?.toolTip = "NLC Node - \(indicator.rawValue)"
        header.title = "NLC Node - \(indicator.rawValue)"
        try? indicator.rawValue.write(to: stateRoot.appendingPathComponent("tray.txt"), atomically: true, encoding: .utf8)
    }

    @objc func openFromMenu() { openWindow(recordOnly: false) }

    @objc func quitFromMenu() {
        stopHost()
        NSApplication.shared.terminate(nil)
    }
}

let arguments = CommandLine.arguments
let verificationRun = arguments.contains("--verify")
let backgroundRun = arguments.contains("--background")

if arguments.contains("--uninstall-login") {
    removeLaunchAtLogin()
    exit(0)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

// Single instance: a second launch shows the existing window and starts nothing new.
if !verificationRun {
    let me = NSRunningApplication.current.processIdentifier
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
        .filter { $0.processIdentifier != me }
    if !others.isEmpty {
        if !backgroundRun { openWindow(recordOnly: false) }
        exit(0)
    }
}

installLaunchAtLogin()

let hostWasRunning = hostIsLive()
if !hostWasRunning && !startHostAndWait() {
    if !verificationRun { showNotReady() }
    exit(1)
}

if verificationRun {
    if hostWasRunning { openWindow(recordOnly: true) }
    exit(0)
}

if !backgroundRun { openWindow(recordOnly: false) }
let menuBar = MenuBarController()
menuBar.start()
application.run()
