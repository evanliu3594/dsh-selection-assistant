import Foundation

/// helper-state.json: helper-owned, merge-on-write, UTF-8 without BOM.
final class StateStore {
    let dataDir: String
    let statePath: String
    let startedAt: Int64
    private(set) var values: [String: Any] = [:]
    private let processId = ProcessInfo.processInfo.processIdentifier

    init(dataDir: String) {
        self.dataDir = dataDir
        self.statePath = (dataDir as NSString).appendingPathComponent("helper-state.json")
        self.startedAt = Int64(Date().timeIntervalSince1970 * 1000)

        if let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
           let object = try? JSONSerialization.jsonObject(with: data),
           let dict = object as? [String: Any] {
            values = dict
        }
        values["version"] = 1
        values["pid"] = Int(processId)
        values["startedAt"] = startedAt
        if values["lastActionId"] == nil { values["lastActionId"] = "" }
        save()
    }

    var rememberedResultSize: (width: Double, height: Double)? {
        guard let width = number("resultWidth"), let height = number("resultHeight") else { return nil }
        return (width, height)
    }

    var rememberedResultOrigin: (x: Double, y: Double)? {
        guard let x = number("resultX"), let y = number("resultY") else { return nil }
        return (x, y)
    }

    func setResultOrigin(x: Double, y: Double) {
        values["resultX"] = (x * 10).rounded() / 10
        values["resultY"] = (y * 10).rounded() / 10
        save()
    }

    func setResultSize(width: Double, height: Double) {
        values["resultWidth"] = (width * 10).rounded() / 10
        values["resultHeight"] = (height * 10).rounded() / 10
        save()
    }

    func setToolbarPosition(x: Int, y: Int) {
        values["toolbarX"] = x
        values["toolbarY"] = y
        save()
    }

    func setLastActionId(_ id: String) {
        values["lastActionId"] = id
        save()
    }

    private func number(_ key: String) -> Double? {
        if let n = values[key] as? NSNumber { return n.doubleValue }
        if let d = values[key] as? Double { return d }
        return nil
    }

    func save() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: dataDir) {
            try? fm.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        }
        guard JSONSerialization.isValidJSONObject(values),
              let data = try? JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys]) else {
            return
        }
        try? data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}
