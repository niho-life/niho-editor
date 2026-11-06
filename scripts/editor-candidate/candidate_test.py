#!/usr/bin/env python3
"""Synthetic tests for the public editor candidate DATA contract."""
from __future__ import annotations

import io
import json
import os
import plistlib
import subprocess
import tarfile
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

import candidate


SOURCE_SHA = "a" * 40
CONTROLLER_SHA = "b" * 40
VERSION = "1.2.3"
RUN_ID = "41"
RUN_ATTEMPT = "2"


def add_file(archive: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    archive.addfile(info, io.BytesIO(data))


def make_tar(file: Path, *, bad: str | None = None) -> None:
    root = f"{candidate.APP_NAME}.app"
    plist = plistlib.dumps({
        "CFBundleIdentifier": candidate.APP_IDENTIFIER,
        "CFBundleName": candidate.APP_NAME,
        "CFBundleExecutable": candidate.APP_NAME,
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
    })
    with tarfile.open(file, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        add_file(archive, f"{root}/Contents/Info.plist", plist)
        add_file(archive, f"{root}/Contents/MacOS/{candidate.APP_NAME}", b"main", 0o755)
        add_file(archive, f"{root}/Contents/MacOS/{candidate.SIDECAR}", b"sidecar", 0o755)
        if bad == "traversal":
            add_file(archive, f"{root}/../escape", b"bad")
        elif bad == "symlink":
            info = tarfile.TarInfo(f"{root}/Contents/link")
            info.type = tarfile.SYMTYPE
            info.linkname = "/tmp/escape"
            archive.addfile(info)
        elif bad == "collision":
            add_file(archive, f"{root}/Contents/Readme", b"one")
            add_file(archive, f"{root}/Contents/README", b"two")
        elif bad == "special-mode":
            add_file(archive, f"{root}/Contents/suid", b"bad", 0o4755)
        elif bad == "sparse":
            info = tarfile.TarInfo(f"{root}/Contents/sparse")
            info.size = 3
            info.pax_headers = {"GNU.sparse.map": "0,3"}
            archive.addfile(info, io.BytesIO(b"bad"))


def validated_fixture(directory: Path) -> dict:
    (directory / candidate.DMG_NAME).write_bytes(b"synthetic dmg")
    (directory / candidate.TAR_NAME).write_bytes(b"synthetic tar")
    dmg = candidate.asset_record(directory / candidate.DMG_NAME, candidate.DMG_NAME)
    tar = candidate.asset_record(directory / candidate.TAR_NAME, candidate.TAR_NAME)
    inventory_hash = "c" * 64
    receipt = {
        "schemaVersion": 1,
        "repository": candidate.REPOSITORY,
        "product": candidate.PRODUCT,
        "sourceSha": SOURCE_SHA,
        "controllerSha": CONTROLLER_SHA,
        "version": VERSION,
        "run": {"id": RUN_ID, "attempt": RUN_ATTEMPT, "workflow": candidate.WORKFLOW},
        "tarSha256": tar["sha256"],
        "dmgSha256": dmg["sha256"],
        "inventorySha256": inventory_hash,
        "files": 3,
        "expandedBytes": 12,
        "checks": ["tar-safe-data", "tar-codesign", "dmg-readonly-nobrowse", "dmg-tar-inventory", "dmg-codesign"],
        "dmg": {"format": "UDZO", "inventorySha256": inventory_hash},
    }
    (directory / candidate.MAC_NAME).write_bytes(candidate.stable_json_bytes(receipt))
    values = {"version": VERSION, "sourceSha": SOURCE_SHA, "controllerSha": CONTROLLER_SHA, "runId": RUN_ID, "runAttempt": RUN_ATTEMPT}
    build = {
        "app": {"identifier": candidate.APP_IDENTIFIER, "name": candidate.APP_NAME},
        "sidecarLockSha256": "d" * 64,
        "updaterPublicKeySha256": "e" * 64,
        "clientConfigSha256": "f" * 64,
    }
    manifest = candidate.expected_manifest(values, build, candidate.file_sha256(directory / candidate.MAC_NAME), {"dmg": dmg, "tar": tar})
    (directory / candidate.MANIFEST_NAME).write_bytes(candidate.stable_json_bytes(manifest))
    return manifest


def validate_args(directory: Path, **changes: str) -> Namespace:
    values = dict(directory=str(directory), version=VERSION, source_sha=SOURCE_SHA, controller_sha=CONTROLLER_SHA, run_id=RUN_ID, run_attempt=RUN_ATTEMPT)
    values.update(changes)
    return Namespace(**values)


class CandidateTest(unittest.TestCase):
    def test_plan_uses_controller_head_and_source_contract(self) -> None:
        root = Path(__file__).resolve().parents[2]
        head = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
        version = json.loads((root / "apps/docs/package.json").read_text())["version"]
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "7", "GITHUB_RUN_ATTEMPT": "3"}):
            output = Path(temporary) / "output"
            result = candidate.command_plan(Namespace(repository=str(root), source_sha=head, controller_sha=head, version=version, github_output=str(output)))
            self.assertEqual(result["release-tag"], f"editor-candidate-v{version}-{head}-run-7-attempt-3")
            self.assertIn(f"source-sha={head}\n", output.read_text())

    def test_safe_tar_is_data_only_and_inventory_is_sorted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "app.tar.gz"
            make_tar(file)
            proof = candidate.inspect_tar(file, VERSION)
            self.assertEqual(proof["fileCount"], 3)
            self.assertEqual([entry["path"] for entry in proof["inventory"]], sorted(entry["path"] for entry in proof["inventory"]))

    def test_dangerous_archives_are_rejected(self) -> None:
        for danger in ("traversal", "symlink", "collision", "special-mode", "sparse"):
            with self.subTest(danger=danger), tempfile.TemporaryDirectory() as temporary:
                file = Path(temporary) / "app.tar.gz"
                make_tar(file, bad=danger)
                with self.assertRaises(candidate.CandidateError):
                    candidate.inspect_tar(file, VERSION)

    def test_validate_binds_all_four_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = validated_fixture(directory)
            self.assertEqual(candidate.command_validate(validate_args(directory)), manifest)
            (directory / candidate.DMG_NAME).write_bytes(b"tampered")
            with self.assertRaises(candidate.CandidateError):
                candidate.command_validate(validate_args(directory))

    def test_validate_rejects_receipt_identity_and_extra_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            validated_fixture(directory)
            with self.assertRaises(candidate.CandidateError):
                candidate.command_validate(validate_args(directory, source_sha="1" * 40))
            (directory / "extra").write_text("x")
            with self.assertRaises(candidate.CandidateError):
                candidate.command_validate(validate_args(directory))

    def test_invalid_identity_is_rejected_before_file_access(self) -> None:
        for changes in (
            {"version": "1.2.3-beta"}, {"source_sha": "A" * 40}, {"controller_sha": "../controller"},
            {"run_id": "1;id"}, {"run_attempt": "0"},
        ):
            with self.subTest(changes=changes), self.assertRaises(candidate.CandidateError):
                candidate.command_validate(validate_args(Path("/nonexistent"), **changes))

    def test_validate_rejects_receipt_and_manifest_tampering(self) -> None:
        for name in (candidate.MAC_NAME, candidate.MANIFEST_NAME):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                validated_fixture(directory)
                with (directory / name).open("ab") as target:
                    target.write(b" ")
                with self.assertRaises(candidate.CandidateError):
                    candidate.command_validate(validate_args(directory))


if __name__ == "__main__":
    unittest.main()
