import FluidAudio
import Foundation

public actor NihoDiarizer {
    private let modelStore: DiarizationModelStore

    public init(modelStore: DiarizationModelStore) {
        ModelHub.offlineMode = true
        self.modelStore = modelStore
    }

    /// 1 つの元音声全体を disk-backed URL のまま 1 回だけ global clustering する。
    public func diarize(
        _ audioURL: URL,
        duration: Double,
        constraint: SpeakerConstraint = .automatic,
        progress: (@Sendable (Int, Int) -> Void)? = nil
    ) async throws -> SpeakerMap {
        ModelHub.offlineMode = true
        try Task.checkCancellation()
        guard audioURL.isFileURL, FileManager.default.isReadableFile(atPath: audioURL.path) else {
            throw NihoSpeechError.invalidInput("話者分離する音声を読めません。")
        }
        let modelsRoot = try await modelStore.readyModelsRoot()
        var config = OfflineDiarizerConfig.default
        switch constraint {
        case .automatic:
            break
        case .exactly(let count):
            guard (2 ... 20).contains(count) else {
                throw NihoSpeechError.invalidInput("話者人数が範囲外です。")
            }
            config = config.withSpeakers(exactly: count)
        case .atLeast(let count):
            guard (2 ... 20).contains(count) else {
                throw NihoSpeechError.invalidInput("話者人数が範囲外です。")
            }
            config = config.withSpeakers(min: count)
        }
        do {
            let models = try await OfflineDiarizerModels.load(from: modelsRoot)
            let manager = OfflineDiarizerManager(config: config)
            manager.initialize(models: models)
            let result = try await manager.process(audioURL, progressCallback: progress)
            try Task.checkCancellation()
            let sorted = result.segments.sorted {
                $0.startTimeSeconds == $1.startTimeSeconds
                    ? $0.endTimeSeconds < $1.endTimeSeconds
                    : $0.startTimeSeconds < $1.startTimeSeconds
            }
            var ids: [String: Int] = [:]
            var turns: [SpeakerTurn] = []
            for segment in sorted {
                let raw = segment.speakerId
                let id = ids[raw] ?? {
                    let next = ids.count + 1
                    ids[raw] = next
                    return next
                }()
                let start = Double(segment.startTimeSeconds)
                let end = Double(segment.endTimeSeconds)
                guard start.isFinite, end.isFinite, start >= 0, end > start, end <= duration + 0.02 else {
                    throw NihoSpeechError.diarizationFailed("話者分離の結果に音声範囲外の時刻があります。")
                }
                turns.append(try SpeakerTurn(start: start, end: min(end, duration), id: id))
            }
            try constraint.validateDetectedSpeakers(turns)
            return try SpeakerMap(duration: duration, turns: turns)
        } catch let error as NihoSpeechError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw NihoSpeechError.diarizationFailed("話者分離に失敗しました: \(error.localizedDescription)")
        }
    }
}
