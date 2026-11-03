import AVFoundation
import XCTest
@testable import NihoSpeech

final class ConvertTests: XCTestCase {
    /// 44.1 kHz stereo float CAF: 1 s of a 440 Hz tone (amplitude 0.5), 1 s
    /// of silence, 1 s of the tone; `rightGain` scales the right channel.
    private func writeToneFile(to url: URL, seconds: Int = 3, rightGain: Float = 1) throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2))
        let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let frames = AVAudioFrameCount(seconds * 44100)
        if frames > 0 {
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
            buffer.frameLength = frames
            for channel in 0 ..< 2 {
                let data = try XCTUnwrap(buffer.floatChannelData?[channel])
                for index in 0 ..< Int(frames) {
                    let time = Double(index) / 44100
                    let tone = (1 ..< 2).contains(time) ? 0 : Float(0.5 * sin(2 * .pi * 440 * time))
                    data[index] = channel == 0 ? tone : tone * rightGain
                }
            }
            try file.write(from: buffer)
        }
        file.close()
    }

    /// AVFoundation が実際に読む AIFC fixture。拡張子だけで対応扱いにしないため、container magic も固定する。
    private func writeAIFCToneFile(to url: URL) throws {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 22_050.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: true,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 22_050, channels: 1))
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let frames: AVAudioFrameCount = 22_050
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData?[0])
        for index in 0 ..< Int(frames) {
            samples[index] = Float(0.25 * sin(2 * .pi * 440 * Double(index) / 22_050))
        }
        try file.write(from: buffer)
        file.close()
        let header = try Data(contentsOf: url, options: .mappedIfSafe).prefix(12)
        XCTAssertEqual(String(decoding: header.prefix(4), as: UTF8.self), "FORM")
        XCTAssertEqual(String(decoding: header.suffix(4), as: UTF8.self), "AIFC")
    }

    private func assertConvertFails(
        input: String, output: String, code: String, exitCode: Int32,
        file: StaticString = #filePath, line: UInt = #line
    ) async {
        do {
            _ = try await AudioConverter.convert(input: input, output: output)
            XCTFail("converted \(input)", file: file, line: line)
        } catch {
            XCTAssertEqual((error as? ToolError)?.code, code, "\(error)", file: file, line: line)
            XCTAssertEqual((error as? ToolError)?.exitCode, exitCode, "\(error)", file: file, line: line)
        }
    }

    func testConvertsStereoFloatToMono16kWAV() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let input = directory.appendingPathComponent("tone.caf")
        let output = directory.appendingPathComponent("tone.wav")
        try writeToneFile(to: input)

        let frames = try await AudioConverter.convert(input: input.path, output: output.path)
        XCTAssertEqual(Double(frames), 48000, accuracy: 1)
        let bytes = try [UInt8](Data(contentsOf: output))
        XCTAssertEqual(Array(bytes[0 ..< 44]), WAVFormat.header(dataBytes: frames * 2))
        XCTAssertEqual(bytes.count, 44 + frames * 2)

        let reader = try WAVReader(path: output.path)
        XCTAssertEqual(reader.frameCount, frames)
        let silences = try SilenceDetector.detect(in: reader)
        XCTAssertEqual(silences.count, 1, "\(silences)")
        XCTAssertEqual(silences[0].startSec, 1, accuracy: 0.002)
        XCTAssertEqual(silences[0].endSec, 2, accuracy: 0.002)
        XCTAssertEqual(silences[0].midpointSec, 1.5, accuracy: 0.001)
        // (L + R) / 2 like ffmpeg -ac 1: the tone keeps its 0.5 amplitude.
        XCTAssertEqual(Double(try peak(of: reader, frames: 0 ..< 15000)), 16384, accuracy: 100)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted(), ["tone.caf", "tone.wav"])
    }

    func testDecodesAndConvertsAIFCInsteadOfTrustingItsExtension() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let input = directory.appendingPathComponent("tone.aifc")
        let output = directory.appendingPathComponent("tone.wav")
        try writeAIFCToneFile(to: input)
        let frames = try await AudioConverter.convert(input: input.path, output: output.path)
        XCTAssertEqual(Double(frames), 16_000, accuracy: 2)
        XCTAssertEqual(try WAVReader(path: output.path).durationSec, 1, accuracy: 0.001)

        let corrupt = directory.appendingPathComponent("corrupt.aifc")
        try Data("not an AIFC container".utf8).write(to: corrupt)
        await assertConvertFails(input: corrupt.path, output: output.path, code: "input_unreadable", exitCode: 3)
        XCTAssertTrue(FileManager.default.fileExists(atPath: input.path), "変換失敗で元音声を消さない")
    }

    /// One-sided stereo is averaged too: half the left channel's level.
    func testStereoIsAveragedLikeFFmpeg() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let input = directory.appendingPathComponent("left.caf")
        let output = directory.appendingPathComponent("left.wav")
        try writeToneFile(to: input, seconds: 1, rightGain: 0)
        _ = try await AudioConverter.convert(input: input.path, output: output.path)
        XCTAssertEqual(Double(try peak(of: WAVReader(path: output.path), frames: 0 ..< 15000)), 8192, accuracy: 60)
    }

    func testAverageRoundsHalfToEven() {
        XCTAssertEqual(AudioConverter.averageOf(1, 2), 2)
        XCTAssertEqual(AudioConverter.averageOf(1, 0), 0)
        XCTAssertEqual(AudioConverter.averageOf(3, 0), 2)
        XCTAssertEqual(AudioConverter.averageOf(-1, 0), 0)
        XCTAssertEqual(AudioConverter.averageOf(-3, 0), -2)
        XCTAssertEqual(AudioConverter.averageOf(32767, 32767), 32767)
        XCTAssertEqual(AudioConverter.averageOf(32767, 32766), 32766)
        XCTAssertEqual(AudioConverter.averageOf(-32768, -32768), -32768)
    }

    private func peak(of reader: WAVReader, frames: Range<Int>) throws -> Int16 {
        var buffer = [Int16](repeating: 0, count: frames.count)
        let read = try buffer.withUnsafeMutableBufferPointer { try reader.readFrames(at: frames.lowerBound, into: $0) }
        XCTAssertEqual(read, frames.count)
        return buffer.map { $0 == .min ? .max : abs($0) }.max() ?? 0
    }

    func testCommandReportsDurationAndReplacesTheOutput() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let input = directory.appendingPathComponent("tone.caf")
        let output = directory.appendingPathComponent("out.wav")
        try writeToneFile(to: input)
        try Data("old".utf8).write(to: output)

        let captured = CapturedOutput()
        let status = await NihoSpeechCLI.run(["convert", "--input", input.path, "--output", output.path], output: captured.output)
        XCTAssertEqual(status, 0, "\(captured.lines)")
        XCTAssertEqual(captured.lines, [#"{"durationSec":3}"#])
        XCTAssertEqual(try WAVReader(path: output.path).durationSec, 3, accuracy: 0.001)
    }

    /// Sparse files: the sizes are logical, no disk is used.
    private func writeSparseFile(_ url: URL, header: [UInt8] = [], size: Int) throws {
        try Data(header).write(to: url)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: UInt64(size))
    }

    /// One input is at most 2 GiB (spec §6.2): refused before decoding, with exit 3.
    func testRefusesAFileOverTwoGiB() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let output = directory.appendingPathComponent("out.wav").path
        let atLimit = directory.appendingPathComponent("at-limit.m4a")
        try writeSparseFile(atLimit, size: 2 * 1024 * 1024 * 1024)
        // Exactly 2 GiB passes the size check (it is not audio, so it fails later as unreadable).
        await assertConvertFails(input: atLimit.path, output: output, code: "input_unreadable", exitCode: 3)

        let big = directory.appendingPathComponent("big.m4a")
        try writeSparseFile(big, size: 2 * 1024 * 1024 * 1024 + 1)
        await assertConvertFails(input: big.path, output: output, code: "input_too_large", exitCode: 3)

        let captured = CapturedOutput()
        let status = await NihoSpeechCLI.run(["convert", "--input", big.path, "--output", output], output: captured.output)
        XCTAssertEqual(status, 3, "\(captured.lines)")
        let line = try jsonObject(try XCTUnwrap(captured.lines.first))
        XCTAssertEqual(line["type"] as? String, "error")
        XCTAssertEqual(line["code"] as? String, "input_too_large")
        XCTAssertFalse(FileManager.default.fileExists(atPath: output))
    }

    /// One input is at most 6 hours (spec §6.2): a WAV whose header says 6 h + 1 s is refused,
    /// 6 h itself is not (it is not read here; only the boundary of the limit is pinned).
    func testRefusesAudioOverSixHours() async throws {
        XCTAssertEqual(InputLimits.maximumFrames, 6 * 60 * 60 * 16_000)
        let directory = try makeTemporaryDirectory(for: self)
        let output = directory.appendingPathComponent("out.wav").path
        let dataBytes = (6 * 60 * 60 + 1) * 16_000 * 2
        let wav = directory.appendingPathComponent("long.wav")
        try writeSparseFile(wav, header: Array(WAVFormat.header(dataBytes: dataBytes)), size: 44 + dataBytes)
        await assertConvertFails(input: wav.path, output: output, code: "input_too_large", exitCode: 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output))
    }

    func testErrors() async throws {
        let directory = try makeTemporaryDirectory(for: self)
        let output = directory.appendingPathComponent("out.wav").path
        await assertConvertFails(
            input: directory.appendingPathComponent("missing.m4a").path, output: output,
            code: "input_not_found", exitCode: 3
        )
        let text = directory.appendingPathComponent("text.m4a")
        try Data("this is not audio".utf8).write(to: text)
        await assertConvertFails(input: text.path, output: output, code: "input_unreadable", exitCode: 3)
        await assertConvertFails(input: directory.path, output: output, code: "input_unreadable", exitCode: 3)

        let empty = directory.appendingPathComponent("empty.caf")
        try writeToneFile(to: empty, seconds: 0)
        await assertConvertFails(input: empty.path, output: output, code: "input_empty", exitCode: 3)

        let tone = directory.appendingPathComponent("tone.caf")
        try writeToneFile(to: tone, seconds: 1)
        await assertConvertFails(
            input: tone.path, output: directory.appendingPathComponent("missing/out.wav").path,
            code: "write_failed", exitCode: 1
        )
        // Nothing half-written was left behind.
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted(),
            ["empty.caf", "text.m4a", "tone.caf"]
        )
    }

    /// Silences of the converted fixture against ffmpeg's on the API path
    /// (`ffmpeg -ac 1 -ar 16000 -sample_fmt s16`, then
    /// `silencedetect=noise=-35dB:d=0.35`): [5.923188, 8.797813] and
    /// [12.982313, end of file].
    ///
    /// The detector itself is sample-exact (ffmpeg prints the same intervals
    /// for this WAV); the samples differ. Speech onsets land on the same frame
    /// (8.797813), but where a voice fades out slowly around -35 dB the two
    /// resamplers' slightly different levels move the silence start by up to
    /// ~15 ms (5.9176 / 12.9674 here). The end differs because AVFoundation
    /// drops the AAC end padding (13.3467 s, the real length) and ffmpeg
    /// keeps it (13.371813 s).
    func testFixtureSilencesMatchFFmpeg() async throws {
        let output = try makeTemporaryDirectory(for: self).appendingPathComponent("ja-sample.wav")
        let frames = try await AudioConverter.convert(input: try fixtureURL("ja-sample", "m4a").path, output: output.path)
        // 294 295 AAC frames at 22 050 Hz.
        XCTAssertEqual(frames, 213_547)
        let silences = try SilenceDetector.detect(in: WAVReader(path: output.path))
        XCTAssertEqual(silences.count, 2, "\(silences)")
        XCTAssertEqual(silences[0].startSec, 5.923188, accuracy: 0.02)
        XCTAssertEqual(silences[0].endSec, 8.797813, accuracy: 0.002)
        XCTAssertEqual(silences[1].startSec, 12.982313, accuracy: 0.02)
        XCTAssertEqual(silences[1].endFrame, frames)
        // The cut ffmpeg's silence gives: 7.3605 (here 7.3577).
        XCTAssertEqual(silences[0].midpointSec, 7.3605, accuracy: 0.01)
    }
}
