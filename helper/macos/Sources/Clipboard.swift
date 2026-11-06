import AppKit

/// Clipboard save / read / restore using every pasteboard item type available.
/// Text and rich formats are restored as data; content is never logged.
final class ClipboardManager {
    struct Snapshot {
        var saved = false
        var items: [[NSPasteboard.PasteboardType: Data]] = []
    }

    private let maxItemBytes = 64 * 1024 * 1024

    func save() -> Snapshot {
        var snapshot = Snapshot(saved: true, items: [])
        let pasteboard = NSPasteboard.general
        guard let items = pasteboard.pasteboardItems else { return snapshot }
        for item in items {
            var entry: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type), data.count <= maxItemBytes {
                    entry[type] = data
                }
            }
            if entry.isEmpty, let text = item.string(forType: .string) {
                entry[.string] = Data(text.utf8)
            }
            snapshot.items.append(entry)
        }
        return snapshot
    }

    @discardableResult
    func clear() -> Bool {
        NSPasteboard.general.clearContents()
        return true
    }

    func readText() -> String? {
        NSPasteboard.general.string(forType: .string)
    }

    @discardableResult
    func setText(_ text: String) -> Bool {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.setString(text, forType: .string)
    }

    func restore(_ snapshot: Snapshot) {
        guard snapshot.saved else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        guard !snapshot.items.isEmpty else { return }
        var newItems: [NSPasteboardItem] = []
        for entry in snapshot.items {
            let item = NSPasteboardItem()
            for (type, data) in entry {
                item.setData(data, forType: type)
            }
            newItems.append(item)
        }
        if !newItems.isEmpty {
            pasteboard.writeObjects(newItems)
        }
    }
}
