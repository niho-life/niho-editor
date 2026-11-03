import Foundation

public enum NihoSpeechError: Error, LocalizedError, Sendable {
    case invalidInput(String)
    case modelMissing(String)
    case modelCorrupt(String)
    case modelDownload(String)
    case diarizationFailed(String)

    public var errorDescription: String? {
        switch self {
        case .invalidInput(let message), .modelMissing(let message), .modelCorrupt(let message),
             .modelDownload(let message), .diarizationFailed(let message):
            message
        }
    }
}

public struct SpeakerTurn: Codable, Equatable, Sendable {
    public let start: Double
    public let end: Double
    /// FluidAudio の文字列 ID を、その音声での初出順に 1 始まりへ直した番号。
    public let id: Int

    public init(start: Double, end: Double, id: Int) throws {
        guard start.isFinite, end.isFinite, start >= 0, end > start, id >= 1 else {
            throw NihoSpeechError.invalidInput("話者ターンの時刻または番号が不正です。")
        }
        self.start = start
        self.end = end
        self.id = id
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            start: values.decode(Double.self, forKey: .start),
            end: values.decode(Double.self, forKey: .end),
            id: values.decode(Int.self, forKey: .id)
        )
    }
}

public struct TimedText: Codable, Equatable, Sendable {
    public let text: String
    public let start: Double?
    public let end: Double?

    public init(text: String, start: Double? = nil, end: Double? = nil) throws {
        if let start, !start.isFinite || start < 0 {
            throw NihoSpeechError.invalidInput("文字の開始時刻が不正です。")
        }
        if let end, !end.isFinite || end < 0 {
            throw NihoSpeechError.invalidInput("文字の終了時刻が不正です。")
        }
        if (start == nil) != (end == nil) || (start != nil && end! < start!) {
            throw NihoSpeechError.invalidInput("文字の時刻範囲が不正です。")
        }
        self.text = text
        self.start = start
        self.end = end
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            text: values.decode(String.self, forKey: .text),
            start: values.decodeIfPresent(Double.self, forKey: .start),
            end: values.decodeIfPresent(Double.self, forKey: .end)
        )
    }
}

public struct AlignedUtterance: Codable, Equatable, Sendable {
    public let text: String
    public let start: Double?
    public let end: Double?
    /// 根拠が足りない、または重なり話者が競合するときは nil。
    public let speaker: Int?

    public init(text: String, start: Double?, end: Double?, speaker: Int?) throws {
        if let speaker, speaker < 1 {
            throw NihoSpeechError.invalidInput("話者番号が不正です。")
        }
        if let start, let end, (!start.isFinite || !end.isFinite || start < 0 || end < start) {
            throw NihoSpeechError.invalidInput("発話の時刻範囲が不正です。")
        }
        if (start == nil) != (end == nil) {
            throw NihoSpeechError.invalidInput("発話の時刻範囲が不正です。")
        }
        self.text = text
        self.start = start
        self.end = end
        self.speaker = speaker
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            text: values.decode(String.self, forKey: .text),
            start: values.decodeIfPresent(Double.self, forKey: .start),
            end: values.decodeIfPresent(Double.self, forKey: .end),
            speaker: values.decodeIfPresent(Int.self, forKey: .speaker)
        )
    }
}

public struct SpeakerMap: Codable, Equatable, Sendable {
    public static let schemaVersion = 1

    public let version: Int
    public let duration: Double
    public let turns: [SpeakerTurn]

    public init(duration: Double, turns: [SpeakerTurn]) throws {
        guard duration.isFinite, duration > 0 else {
            throw NihoSpeechError.invalidInput("音声の長さが不正です。")
        }
        var previousStart = -Double.infinity
        for turn in turns {
            guard turn.start >= previousStart, turn.end <= duration + 0.02 else {
                throw NihoSpeechError.invalidInput("話者ターンが時刻順でないか、音声の範囲外です。")
            }
            previousStart = turn.start
        }
        version = Self.schemaVersion
        self.duration = duration
        self.turns = turns
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let version = try values.decode(Int.self, forKey: .version)
        guard version == Self.schemaVersion else {
            throw NihoSpeechError.invalidInput("未対応の話者マップです。")
        }
        try self.init(
            duration: values.decode(Double.self, forKey: .duration),
            turns: values.decode([SpeakerTurn].self, forKey: .turns)
        )
    }

    public static func read(from url: URL) throws -> SpeakerMap {
        do {
            return try JSONDecoder().decode(SpeakerMap.self, from: Data(contentsOf: url, options: [.mappedIfSafe]))
        } catch let error as NihoSpeechError {
            throw error
        } catch {
            throw NihoSpeechError.invalidInput("話者マップを読めません: \(error.localizedDescription)")
        }
    }

    public func write(to url: URL) throws {
        let data = try JSONEncoder().encode(self)
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try data.write(to: temporary, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
            if FileManager.default.fileExists(atPath: url.path) {
                _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: url)
            }
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw NihoSpeechError.invalidInput("話者マップを書けません: \(error.localizedDescription)")
        }
    }
}

public enum SpeakerConstraint: Codable, Equatable, Sendable {
    case automatic
    case exactly(Int)
    case atLeast(Int)

    /// Clustering can return fewer speakers than requested. Never report that as a successful constraint.
    public func validateDetectedSpeakers(_ turns: [SpeakerTurn]) throws {
        let detected = Set(turns.map(\.id)).count
        switch self {
        case .automatic:
            return
        case .exactly(let count), .atLeast(let count):
            guard (2 ... 20).contains(count) else {
                throw NihoSpeechError.invalidInput("話者人数が範囲外です。")
            }
        }
        switch self {
        case .exactly(let count) where detected != count:
            throw NihoSpeechError.diarizationFailed("指定した話者数は\(count)ですが、検出結果は\(detected)です。音声と人数の設定を確認してください。")
        case .atLeast(let count) where detected < count:
            throw NihoSpeechError.diarizationFailed("指定した最少話者数は\(count)ですが、検出結果は\(detected)です。音声と人数の設定を確認してください。")
        default:
            return
        }
    }
}
