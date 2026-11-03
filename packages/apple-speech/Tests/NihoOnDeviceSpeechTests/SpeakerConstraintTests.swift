import XCTest
@testable import NihoOnDeviceSpeech

final class SpeakerConstraintTests: XCTestCase {
    private func turns(_ ids: [Int]) throws -> [SpeakerTurn] {
        try ids.enumerated().map { try SpeakerTurn(start: Double($0.offset), end: Double($0.offset + 1), id: $0.element) }
    }

    func testAutomaticKeepsAnEmptyOrSingleSpeakerResult() throws {
        XCTAssertNoThrow(try SpeakerConstraint.automatic.validateDetectedSpeakers([]))
        XCTAssertNoThrow(try SpeakerConstraint.automatic.validateDetectedSpeakers(turns([1, 1])))
    }

    func testExactCountRejectsCollapsedAndExcessSpeakers() throws {
        XCTAssertThrowsError(try SpeakerConstraint.exactly(2).validateDetectedSpeakers(turns([1, 1])))
        XCTAssertThrowsError(try SpeakerConstraint.exactly(2).validateDetectedSpeakers(turns([1, 2, 3])))
        XCTAssertThrowsError(try SpeakerConstraint.exactly(2).validateDetectedSpeakers([]))
        XCTAssertNoThrow(try SpeakerConstraint.exactly(2).validateDetectedSpeakers(turns([1, 2, 1])))
    }

    func testMinimumCountRejectsTooFewWithoutRequiringAnExactMatch() throws {
        XCTAssertThrowsError(try SpeakerConstraint.atLeast(2).validateDetectedSpeakers(turns([1])))
        XCTAssertNoThrow(try SpeakerConstraint.atLeast(2).validateDetectedSpeakers(turns([1, 2, 3])))
    }

    func testInvalidConstraintsAreRejectedEvenWhenTheCountMatches() throws {
        XCTAssertThrowsError(try SpeakerConstraint.exactly(1).validateDetectedSpeakers(turns([1])))
        XCTAssertThrowsError(try SpeakerConstraint.atLeast(21).validateDetectedSpeakers(turns([1, 2])))
    }
}
