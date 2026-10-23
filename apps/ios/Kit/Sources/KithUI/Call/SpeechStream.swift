import Foundation

// Pure parts of Kith voice's live speech (ported from the desktop's speech-stream.ts and
// speech-clips.ts): which sentences of a growing reply are ready to say, whether a transcript is
// the bot's own voice coming back through the microphone, when to say "working on it", and the
// clip queue that fetches one clip ahead.

private typealias Scalars = [Unicode.Scalar]

private func scalars(_ s: String) -> Scalars { Array(s.unicodeScalars) }

private func string(_ s: ArraySlice<Unicode.Scalar>) -> String {
    var view = String.UnicodeScalarView()
    view.append(contentsOf: s)
    return String(view)
}

enum SentenceBounds {
    private static let cjk: Set<Unicode.Scalar> = ["。", "！", "？", "\n"]
    private static let ascii: Set<Unicode.Scalar> = [".", "!", "?"]

    /// True when a sentence ends after `text[i]`. A "." inside "3.5" or "a.ts" doesn't end one.
    fileprivate static func endsAt(_ text: Scalars, _ i: Int) -> Bool {
        let ch = text[i]
        if cjk.contains(ch) { return true }
        guard ascii.contains(ch), i + 1 < text.count else { return false }
        return text[i + 1].properties.isWhitespace
    }

    /// Where the last finished sentence of `text` ends (a scalar offset), or 0.
    static func end(_ text: String) -> Int { end(scalars(text)) }

    fileprivate static func end(_ text: Scalars) -> Int {
        for i in stride(from: text.count - 1, through: 0, by: -1) where endsAt(text, i) { return i + 1 }
        return 0
    }

    /// The first sentence end at or after `from`, or the text's end.
    fileprivate static func end(_ text: Scalars, from: Int) -> Int {
        var i = max(from - 1, 0)
        while i < text.count {
            if endsAt(text, i) { return i + 1 }
            i += 1
        }
        return text.count
    }
}

/// Turns the full, growing text of each agent entry (the host sends the whole buffer about every
/// 300 ms) into the sentences not yet spoken, once each and in order.
struct SentenceStream {
    private struct Progress {
        /// The cleaned text already handed out.
        var spoken: Scalars = []
        /// An update rewrote text that was already spoken: nothing more until the entry is final.
        var rewritten = false
        var final = false
        /// The user cut this reply short.
        var muted = false
    }

    private var entries: [String: Progress] = [:]

    /// The reply as it sounds so far: an unclosed code block is cut, so code isn't read out while it streams in.
    private static func cleaned(_ markdown: String, final: Bool) -> Scalars {
        var text = markdown
        var cut = false
        if !final {
            let fences = text.components(separatedBy: "```").count - 1
            if fences % 2 == 1, let last = text.range(of: "```", options: .backwards) {
                text = String(text[..<last.lowerBound])
                cut = true
            }
        }
        // Trailing spaces would make the text before a code block differ from itself once the block
        // closes. The cut itself is a sentence end.
        let spoken = SpokenText.from(text).replacingOccurrences(of: #"[ \t]+\n"#, with: "\n", options: .regularExpression)
        return scalars(spoken + (cut ? "\n" : ""))
    }

    /// The text newly ready to be spoken for this entry ("" when nothing).
    mutating func feed(_ id: String, _ markdown: String, final: Bool) -> String {
        var p = entries[id] ?? Progress()
        defer { entries[id] = p }
        if p.final { return "" }
        p.final = final
        if p.muted { return "" }
        let text = Self.cleaned(markdown, final: final)
        if !text.starts(with: p.spoken) { p.rewritten = true }
        if p.rewritten {
            if !final { return "" }
            // Conservative: skip to the next sentence after the length already spoken, so nothing is said twice.
            let from = SentenceBounds.end(text, from: p.spoken.count)
            p.spoken = text
            return string(text[from...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let end = final ? text.count : SentenceBounds.end(text)
        if end <= p.spoken.count { return "" }
        let chunk = string(text[p.spoken.count..<end])
        p.spoken = Array(text[..<end])
        return chunk.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Nothing more of the replies still streaming is spoken (the user talked over or tapped).
    mutating func muteOpen() {
        for id in entries.keys where !entries[id]!.final { entries[id]!.muted = true }
    }

    /// Some reply is still streaming in, so more speech may come.
    var isOpen: Bool { entries.values.contains { !$0.final && !$0.muted } }
}

// MARK: echo

enum SpeechEcho {
    private static let token = try! NSRegularExpression(pattern: #"\p{Han}|\p{Hiragana}|\p{Katakana}|[\p{L}\p{N}]+"#)
    private static let cjk = try! NSRegularExpression(pattern: #"^(\p{Han}|\p{Hiragana}|\p{Katakana})$"#)
    /// A run of at least this many words copied from the spoken text counts as the bot's voice.
    private static let minRun = 3

    /// How much of the bot's recent speech is kept to compare against.
    static let windowChars = 800

    /// `recent` with `said` added, keeping only the last `windowChars` characters.
    static func remember(_ recent: String, adding said: String) -> String {
        String((recent + " " + said).suffix(windowChars))
    }

    private struct Token {
        let word: String
        /// UTF-16 offset where it ends in the original text.
        let end: Int
    }

    private static func tokens(_ text: String) -> [Token] {
        let lower = text.lowercased() as NSString
        // Lowercasing can change the length (İ); then positions can't be trusted, so use the original.
        let source = lower.length == (text as NSString).length ? lower : text as NSString
        return token.matches(in: source as String, range: NSRange(location: 0, length: source.length)).map {
            Token(word: source.substring(with: $0.range), end: $0.range.location + $0.range.length)
        }
    }

    private static func isCJK(_ word: String) -> Bool {
        cjk.firstMatch(in: word, range: NSRange(location: 0, length: (word as NSString).length)) != nil
    }

    /// Words in a transcript; a Chinese or Japanese character counts half.
    static func wordCount(_ text: String) -> Double {
        tokens(text).reduce(0) { $0 + (isCJK($1.word) ? 0.5 : 1) }
    }

    private static func bigrams(_ words: [String]) -> Set<String> {
        Set(words.indices.dropFirst().map { "\(words[$0 - 1]) \(words[$0])" })
    }

    /// The transcript is (mostly) the text being spoken: the share of its words that sit in a word
    /// pair also found in `spoken` is at least 70%. Single words match too easily ("that is right").
    static func isEcho(_ heard: String, spoken: String) -> Bool {
        let words = tokens(heard).map(\.word)
        if words.isEmpty { return true }
        if words.count == 1 { return tokens(spoken).contains { $0.word == words[0] } }
        let known = bigrams(tokens(spoken).map(\.word))
        var covered = Array(repeating: false, count: words.count)
        for i in 1..<words.count where known.contains("\(words[i - 1]) \(words[i])") {
            covered[i - 1] = true
            covered[i] = true
        }
        return Double(covered.filter { $0 }.count) / Double(words.count) >= 0.7
    }

    /// The transcript without its start if that start is the spoken text coming back: the recognizer
    /// keeps one running transcript, so the user's words arrive after the bot's.
    static func stripEcho(_ heard: String, spoken: String) -> String {
        if spoken.isEmpty { return heard }
        let said = tokens(heard)
        let reference = " " + tokens(spoken).map(\.word).joined(separator: " ") + " "
        var n = said.count
        while n >= minRun {
            let run = " " + said[..<n].map(\.word).joined(separator: " ") + " "
            if reference.contains(run) {
                let rest = (heard as NSString).substring(from: min(said[n - 1].end, (heard as NSString).length))
                // The echo's closing punctuation ("today?") isn't the user's.
                return String(rest.drop { !($0.isLetter || $0.isNumber) }).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            n -= 1
        }
        return heard
    }
}

// MARK: cue

enum SpeechCue {
    static let after: TimeInterval = 5

    /// Whether to say "Working on it": the bot is still working, nothing has been spoken since the
    /// user's message, and it has been quiet for a while. Once per message.
    static func shouldCue(now: Date, sentAt: Date?, lastSpokenAt: Date, working: Bool, cued: Bool, after: TimeInterval = after) -> Bool {
        guard let sentAt, !cued, working else { return false }
        if lastSpokenAt >= sentAt { return false }
        return now.timeIntervalSince(sentAt) >= after
    }
}

// MARK: clips

/// A reply's clips, fetched one ahead of the one playing. `stop` drops what's queued and any
/// fetch still in flight: a clip that arrives after it is never handed out.
@MainActor
final class ClipQueue<T: Sendable> {
    private var texts: [String] = []
    private var ahead: Task<T?, Never>?
    private var generation = 0
    /// Resolves nil for a clip it couldn't make (and never throws).
    private let fetch: @MainActor (String) async -> T?

    init(fetch: @escaping @MainActor (String) async -> T?) { self.fetch = fetch }

    var pending: Bool { !texts.isEmpty || ahead != nil }

    func add(_ new: [String]) { texts += new }

    /// The next clip, or nil when the queue is empty, a clip failed, or `stop` came meanwhile.
    func take() async -> T? {
        let generation = generation
        let task = ahead ?? fetchNext()
        ahead = nil
        let clip = await task?.value ?? nil
        guard generation == self.generation, let clip else { return nil }
        if !texts.isEmpty { ahead = fetchNext() }
        return clip
    }

    func stop() {
        generation += 1
        texts = []
        ahead?.cancel()
        ahead = nil
    }

    private func fetchNext() -> Task<T?, Never>? {
        guard !texts.isEmpty else { return nil }
        let text = texts.removeFirst()
        return Task { @MainActor [fetch] in await fetch(text) }
    }
}
