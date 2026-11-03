import Darwin
import Foundation
import System

/// The only WAV this tool writes and reads: 16 kHz, mono, 16-bit signed
/// little-endian PCM.
enum WAVFormat {
    static let sampleRate = 16_000
    static let bytesPerFrame = 2
    static let headerSize = 44
    /// The RIFF size field (36 + data bytes) is 32-bit: about 37 hours.
    static let maximumFrames = (Int(UInt32.max) - 36) / bytesPerFrame

    static func seconds(frames: Int) -> Double {
        Double(frames) / Double(sampleRate)
    }

    /// The frame nearest to `seconds` (finite, ≥ 0), so chunks that share a
    /// cut neither overlap nor leave a gap.
    static func frame(seconds: Double) -> Int {
        Int((seconds * Double(sampleRate)).rounded())
    }

    /// The canonical 44-byte header: RIFF/WAVE, `fmt ` (PCM tag 1, mono,
    /// 16000 Hz, 32000 bytes/s, block align 2, 16 bits), `data`.
    static func header(dataBytes: Int) -> [UInt8] {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(headerSize)
        func tag(_ text: String) { bytes += Array(text.utf8) }
        func le32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { bytes += $0 } }
        func le16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { bytes += $0 } }
        tag("RIFF"); le32(36 + dataBytes); tag("WAVE")
        tag("fmt "); le32(16); le16(1); le16(1)
        le32(sampleRate); le32(sampleRate * bytesPerFrame); le16(bytesPerFrame); le16(16)
        tag("data"); le32(dataBytes)
        return bytes
    }
}

/// Streams samples to `.<name>.partial-<pid>` next to the destination and
/// moves it over the destination (`rename(2)`, atomic, replacing) only once
/// complete, so nobody sees a partial WAV. Every failure is `write_failed`.
final class WAVWriter {
    let destination: String
    let temporaryPath: String
    private var descriptor: FileDescriptor?
    private var committed = false
    private(set) var dataBytes = 0

    var frameCount: Int { dataBytes / WAVFormat.bytesPerFrame }

    init(destination: String) throws {
        let path = FilePath(destination)
        guard let name = path.lastComponent, !destination.hasSuffix("/") else {
            throw ToolError.writeFailed("--output must name a file (got '\(destination)')")
        }
        self.destination = destination
        temporaryPath = path.removingLastComponent()
            .appending(".\(name).partial-\(getpid())").string
        do {
            let descriptor = try FileDescriptor.open(
                FilePath(temporaryPath), .writeOnly,
                options: [.create, .truncate, .closeOnExec],
                permissions: [.ownerReadWrite]
            )
            self.descriptor = descriptor
            try descriptor.writeAll(WAVFormat.header(dataBytes: 0))
        } catch {
            discard()
            throw ToolError.writeFailed("cannot create \(temporaryPath): \(error)")
        }
    }

    deinit {
        discard()
    }

    /// Little-endian 16-bit mono samples, whole frames.
    func append(_ bytes: UnsafeRawBufferPointer) throws {
        guard let descriptor else { throw ToolError.internalError("WAV writer used after commit or discard") }
        guard bytes.count % WAVFormat.bytesPerFrame == 0 else {
            throw ToolError.internalError("WAV writer got a partial frame (\(bytes.count) bytes)")
        }
        guard (dataBytes + bytes.count) / WAVFormat.bytesPerFrame <= WAVFormat.maximumFrames else {
            throw ToolError.writeFailed("the audio is too long for a WAV file (more than 37 hours at 16 kHz)")
        }
        do {
            try descriptor.writeAll(bytes)
        } catch {
            throw ToolError.writeFailed("cannot write \(temporaryPath): \(error)")
        }
        dataBytes += bytes.count
    }

    /// Writes the final sizes and moves the file over the destination.
    func commit() throws {
        guard let descriptor else { throw ToolError.internalError("WAV writer used after commit or discard") }
        do {
            try descriptor.writeAll(toAbsoluteOffset: 0, WAVFormat.header(dataBytes: dataBytes))
            self.descriptor = nil
            try descriptor.close()
        } catch {
            throw ToolError.writeFailed("cannot write \(temporaryPath): \(error)")
        }
        guard rename(temporaryPath, destination) == 0 else {
            let reason = String(cString: strerror(errno))
            throw ToolError.writeFailed("cannot move the WAV to \(destination): \(reason)")
        }
        committed = true
    }

    /// Closes and removes the temporary file (nothing after `commit()`).
    func discard() {
        if let descriptor {
            try? descriptor.close()
            self.descriptor = nil
        }
        if !committed {
            unlink(temporaryPath)
        }
    }
}

/// A 16 kHz mono 16-bit PCM WAV opened for reading frames by index (constant
/// memory, safe from any task). Accepts the PCM tag (1) or
/// WAVE_FORMAT_EXTENSIBLE with the PCM sub-format, chunks in any order and
/// odd-size chunk padding; anything else is `input_format`.
final class WAVReader: Sendable {
    let path: String
    let frameCount: Int
    let dataOffset: Int64
    private let descriptor: FileDescriptor

    var durationSec: Double { WAVFormat.seconds(frames: frameCount) }

    init(path: String) throws {
        let descriptor = try InputFile.open(path)
        do {
            let (dataOffset, dataBytes) = try Self.locateData(descriptor, path: path)
            self.dataOffset = dataOffset
            frameCount = Int(dataBytes) / WAVFormat.bytesPerFrame
        } catch {
            try? descriptor.close()
            throw error
        }
        self.path = path
        self.descriptor = descriptor
    }

    deinit {
        try? descriptor.close()
    }

    /// Reads up to `buffer.count` frames from `frame`; returns the number read
    /// (0 at the end of the data).
    func readFrames(at frame: Int, into buffer: UnsafeMutableBufferPointer<Int16>) throws -> Int {
        let count = max(0, min(buffer.count, frameCount - frame))
        guard count > 0 else { return 0 }
        let raw = UnsafeMutableRawBufferPointer(start: buffer.baseAddress, count: count * WAVFormat.bytesPerFrame)
        var done = 0
        while done < raw.count {
            let offset = dataOffset + Int64(frame * WAVFormat.bytesPerFrame + done)
            let got: Int
            do {
                got = try descriptor.read(fromAbsoluteOffset: offset, into: UnsafeMutableRawBufferPointer(rebasing: raw[done...]))
            } catch {
                throw ToolError.inputUnreadable("cannot read \(path): \(error)")
            }
            guard got > 0 else {
                throw ToolError.inputUnreadable("\(path) ended before its data chunk did")
            }
            done += got
        }
        #if _endian(big)
        for index in 0 ..< count {
            buffer[index] = Int16(littleEndian: buffer[index])
        }
        #endif
        return count
    }

    private static let pcmSubFormat: [UInt8] = [
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
    ]

    /// Walks the RIFF chunks; returns where the samples start and how many
    /// bytes of them the file really holds.
    private static func locateData(_ descriptor: FileDescriptor, path: String) throws -> (Int64, Int64) {
        func read(_ count: Int, at offset: Int64) throws -> [UInt8] {
            var bytes = [UInt8](repeating: 0, count: count)
            var done = 0
            while done < count {
                let got: Int
                do {
                    got = try bytes.withUnsafeMutableBytes { raw in
                        try descriptor.read(
                            fromAbsoluteOffset: offset + Int64(done),
                            into: UnsafeMutableRawBufferPointer(rebasing: raw[done...])
                        )
                    }
                } catch {
                    throw ToolError.inputUnreadable("cannot read \(path): \(error)")
                }
                if got == 0 { break }
                done += got
            }
            return Array(bytes[0 ..< done])
        }
        func tag(_ bytes: [UInt8], _ offset: Int) -> String {
            String(decoding: bytes[offset ..< offset + 4], as: UTF8.self)
        }
        func le16(_ bytes: [UInt8], _ offset: Int) -> Int {
            Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
        }
        func le32(_ bytes: [UInt8], _ offset: Int) -> Int64 {
            Int64(le16(bytes, offset)) | Int64(le16(bytes, offset + 2)) << 16
        }

        let expected = "expected a 16 kHz mono 16-bit PCM WAV (convert's output)"
        let fileSize: Int64
        do {
            fileSize = try descriptor.seek(offset: 0, from: .end)
        } catch {
            throw ToolError.inputUnreadable("cannot read \(path): \(error)")
        }
        let riff = try read(12, at: 0)
        guard riff.count == 12, tag(riff, 0) == "RIFF", tag(riff, 8) == "WAVE" else {
            throw ToolError.inputFormat("\(path) is not a WAV file; \(expected)")
        }
        var format: [UInt8]?
        var data: (offset: Int64, bytes: Int64)?
        var offset: Int64 = 12
        while offset + 8 <= fileSize, format == nil || data == nil {
            let header = try read(8, at: offset)
            guard header.count == 8 else { break }
            let size = le32(header, 4)
            let body = offset + 8
            switch tag(header, 0) {
            case "fmt ":
                format = try read(Int(min(size, 40)), at: body)
            case "data":
                // Streaming writers may leave a placeholder size: trust the file.
                data = (body, max(0, min(size, fileSize - body)))
            default:
                break
            }
            offset = body + size + (size & 1)
        }
        guard let format, format.count >= 16 else {
            throw ToolError.inputFormat("\(path) has no complete fmt chunk; \(expected)")
        }
        guard let data else {
            throw ToolError.inputFormat("\(path) has no data chunk; \(expected)")
        }
        let formatTag = le16(format, 0)
        let channels = le16(format, 2)
        let sampleRate = Int(le32(format, 4))
        let blockAlign = le16(format, 12)
        let bitsPerSample = le16(format, 14)
        let isPCM = formatTag == 1
            || (formatTag == 0xFFFE && format.count >= 40 && Array(format[24 ..< 40]) == pcmSubFormat)
        guard isPCM, channels == 1, sampleRate == WAVFormat.sampleRate, bitsPerSample == 16,
              blockAlign == WAVFormat.bytesPerFrame
        else {
            let encoding = isPCM ? "PCM" : String(format: "format tag 0x%04X", formatTag)
            throw ToolError.inputFormat(
                "\(path) is \(encoding), \(sampleRate) Hz, \(channels) channel(s), \(bitsPerSample)-bit; \(expected)"
            )
        }
        return (data.offset, data.bytes)
    }
}
