enum Tool {
    static let name = "niho-speech"
    /// 0.1.0: probe / download / convert / silence / transcribe (S1-C #18403).
    /// 0.2.0: record / mic-status (#18590).
    /// 0.3.0: fixed offline diarization model, diarize, and speaker-map alignment.
    /// 0.3.1: speaker evidence ignores the leading silence SpeechTranscriber attaches to a result's first run.
    /// 0.3.2: fail when the detected speaker count contradicts an explicit constraint.
    static let version = "0.3.2"
}
