import Cocoa

/// Lightweight Markdown subset used by the result window:
/// **bold**, inline code, fenced code blocks and "- " lists.
enum MarkdownRenderer {
    private static let codeFence = String(repeating: "\u{60}", count: 3)
    private static let tick = Character("\u{60}")

    static func render(_ text: String, palette: Palette) -> NSAttributedString {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        let output = NSMutableAttributedString()
        var inCode = false
        var codeLines: [String] = []

        for line in lines {
            if isFence(line) {
                if inCode {
                    appendBlock(output, codeBlock(codeLines, palette: palette))
                    codeLines.removeAll()
                    inCode = false
                } else {
                    inCode = true
                }
                continue
            }
            if inCode {
                codeLines.append(line)
                continue
            }
            if let item = listItem(line) {
                appendBlock(output, listParagraph(item, palette: palette))
                continue
            }
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                continue
            }
            appendBlock(output, paragraph(line, palette: palette))
        }
        if inCode && !codeLines.isEmpty {
            appendBlock(output, codeBlock(codeLines, palette: palette))
        }
        return output
    }

    static func error(_ message: String, palette: Palette) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 21
        style.maximumLineHeight = 21
        style.paragraphSpacing = 8
        let attrs: [NSAttributedString.Key: Any] = [
            .font: Theme.font(13),
            .foregroundColor: palette.error,
            .paragraphStyle: style,
        ]
        return NSAttributedString(string: message, attributes: attrs)
    }

    private static func isFence(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix(codeFence)
    }

    private static func listItem(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        for marker in ["- ", "* "] {
            if trimmed.hasPrefix(marker) {
                return String(trimmed.dropFirst(marker.count))
            }
        }
        return nil
    }

    private static func appendBlock(_ output: NSMutableAttributedString, _ block: NSAttributedString) {
        if output.length > 0 {
            let newlineStyle = NSMutableParagraphStyle()
            newlineStyle.minimumLineHeight = 1
            newlineStyle.maximumLineHeight = 1
            output.append(NSAttributedString(string: "\n", attributes: [.font: Theme.font(1), .paragraphStyle: newlineStyle]))
        }
        output.append(block)
    }

    private static func paragraph(_ text: String, palette: Palette) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 21
        style.maximumLineHeight = 21
        style.paragraphSpacing = 8
        style.lineBreakMode = .byWordWrapping
        let result = NSMutableAttributedString()
        appendInline(result, text, palette: palette)
        if result.length > 0 {
            result.addAttributes([.paragraphStyle: style], range: NSRange(location: 0, length: result.length))
        }
        return result
    }

    private static func listParagraph(_ text: String, palette: Palette) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 21
        style.maximumLineHeight = 21
        style.paragraphSpacing = 2
        style.headIndent = 18
        style.firstLineHeadIndent = 0
        style.lineBreakMode = .byWordWrapping
        let result = NSMutableAttributedString()
        let bulletAttrs: [NSAttributedString.Key: Any] = [
            .font: Theme.font(13),
            .foregroundColor: palette.text,
        ]
        result.append(NSAttributedString(string: "•  ", attributes: bulletAttrs))
        appendInline(result, text, palette: palette)
        result.addAttributes([.paragraphStyle: style], range: NSRange(location: 0, length: result.length))
        return result
    }

    private static func codeBlock(_ lines: [String], palette: Palette) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 18
        style.maximumLineHeight = 18
        style.paragraphSpacing = 8
        style.headIndent = 8
        style.firstLineHeadIndent = 8
        style.tailIndent = -8
        style.lineBreakMode = .byWordWrapping
        let code = lines.joined(separator: "\n")
        let attrs: [NSAttributedString.Key: Any] = [
            .font: Theme.monoFont(12),
            .foregroundColor: palette.text,
            .backgroundColor: palette.codeBg,
            .paragraphStyle: style,
        ]
        return NSAttributedString(string: code, attributes: attrs)
    }

    private static func appendInline(_ target: NSMutableAttributedString, _ text: String, palette: Palette) {
        let characters = Array(text)
        var index = 0
        var plainStart = 0

        while index < characters.count {
            let character = characters[index]
            if character == "*", index + 1 < characters.count, characters[index + 1] == "*" {
                var closing = index + 2
                var found = -1
                while closing + 1 < characters.count {
                    if characters[closing] == "*", characters[closing + 1] == "*" {
                        found = closing
                        break
                    }
                    closing += 1
                }
                if found > index + 2 {
                    appendPlain(target, characters, plainStart, index, palette: palette)
                    let boldText = String(characters[(index + 2)..<found])
                    target.append(NSAttributedString(string: boldText, attributes: [
                        .font: Theme.font(13, weight: .semibold),
                        .foregroundColor: palette.text,
                    ]))
                    index = found + 2
                    plainStart = index
                    continue
                }
            }
            if character == tick {
                var closing = index + 1
                var found = -1
                while closing < characters.count {
                    if characters[closing] == tick {
                        found = closing
                        break
                    }
                    closing += 1
                }
                if found > index + 1 {
                    appendPlain(target, characters, plainStart, index, palette: palette)
                    let codeText = String(characters[(index + 1)..<found])
                    target.append(NSAttributedString(string: codeText, attributes: [
                        .font: Theme.monoFont(12),
                        .foregroundColor: palette.accent,
                        .backgroundColor: palette.codeBg,
                    ]))
                    index = found + 1
                    plainStart = index
                    continue
                }
            }
            index += 1
        }
        appendPlain(target, characters, plainStart, characters.count, palette: palette)
    }

    private static func appendPlain(_ target: NSMutableAttributedString, _ characters: [Character], _ start: Int, _ end: Int, palette: Palette) {
        guard start < end else { return }
        let text = String(characters[start..<end])
        target.append(NSAttributedString(string: text, attributes: [
            .font: Theme.font(13),
            .foregroundColor: palette.text,
        ]))
    }
}
