#!/usr/bin/env python3
"""Build-plan and DATA-only verification for the public NIHO editor candidate."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any

REPOSITORY = "niho-life/niho-editor"
PRODUCT = "docs"
WORKFLOW = ".github/workflows/editor-mac-candidate.yml"
APP_NAME = "NIHO editor"
APP_IDENTIFIER = "life.niho.docs"
SIDECAR = "niho-speech"
DMG_NAME = "editor-candidate.dmg"
TAR_NAME = "editor-candidate.app.tar.gz"
BUILD_NAME = "editor-candidate-build.json"
MAC_NAME = "editor-candidate-mac.json"
MANIFEST_NAME = "editor-candidate.json"
SIGSTORE_NAME = "editor-candidate.sigstore.json"
STRICT_SEMVER = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")
POSITIVE = re.compile(r"^[1-9][0-9]*$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILES = 20_000
SOURCE_PATHS = (
    "apps/docs/sidecar/niho-speech/Package.swift",
    "apps/docs/sidecar/niho-speech/Package.resolved",
    "apps/docs/sidecar/niho-speech/Sources",
    "packages/apple-speech/Package.swift",
    "packages/apple-speech/Package.resolved",
    "packages/apple-speech/Sources",
)


class CandidateError(Exception):
    def __init__(self, stage: str, kind: str):
        super().__init__(f"{stage}/{kind}")
        self.stage = stage
        self.kind = kind


def require(condition: bool, stage: str, kind: str) -> None:
    if not condition:
        raise CandidateError(stage, kind)


def stable_json_bytes(value: Any) -> bytes:
    """Canonical project JSON: UTF-8, sorted keys, compact separators, one LF."""
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_sha256(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def ordinary_file(file: Path, stage: str, maximum: int | None = None) -> os.stat_result:
    try:
        item = file.lstat()
    except OSError as error:
        raise CandidateError(stage, "MissingFile") from error
    require(stat.S_ISREG(item.st_mode) and not file.is_symlink(), stage, "NonRegularFile")
    if maximum is not None:
        require(0 < item.st_size <= maximum, stage, "FileSize")
    return item


def read_json_bytes(data: bytes, stage: str) -> Any:
    def no_duplicates(items: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, entry in items:
            require(key not in value, stage, "DuplicateJsonKey")
            value[key] = entry
        return value

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=no_duplicates)
    except CandidateError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CandidateError(stage, "InvalidJson") from error


def read_json_file(file: Path, stage: str, maximum: int = 16 * 1024 * 1024, canonical: bool = False) -> Any:
    ordinary_file(file, stage, maximum)
    data = file.read_bytes()
    value = read_json_bytes(data, stage)
    if canonical:
        require(data == stable_json_bytes(value), stage, "NonCanonicalJson")
    return value


def write_new(file: Path, data: bytes, stage: str) -> None:
    try:
        descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as target:
            target.write(data)
    except OSError as error:
        raise CandidateError(stage, "OutputWrite") from error


def copy_new(source: Path, target: Path, stage: str) -> None:
    ordinary_file(source, stage)
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with source.open("rb") as input_file, os.fdopen(descriptor, "wb") as output_file:
            shutil.copyfileobj(input_file, output_file, 1024 * 1024)
    except OSError as error:
        raise CandidateError(stage, "OutputCopy") from error


def exact_directory(directory: Path, expected: set[str], stage: str) -> None:
    try:
        item = directory.lstat()
        require(stat.S_ISDIR(item.st_mode) and not directory.is_symlink(), stage, "InvalidDirectory")
        names = {entry.name for entry in directory.iterdir()}
    except OSError as error:
        raise CandidateError(stage, "InvalidDirectory") from error
    require(names == expected, stage, "UnexpectedFileSet")


def identity(version: str, source_sha: str, controller_sha: str, run_id: str | None = None, run_attempt: str | None = None) -> None:
    require(bool(STRICT_SEMVER.fullmatch(version or "")), "identity", "InvalidVersion")
    require(bool(COMMIT.fullmatch(source_sha or "")), "identity", "InvalidSourceSha")
    require(bool(COMMIT.fullmatch(controller_sha or "")), "identity", "InvalidControllerSha")
    if run_id is not None or run_attempt is not None:
        require(bool(POSITIVE.fullmatch(run_id or "")) and bool(POSITIVE.fullmatch(run_attempt or "")), "identity", "InvalidRun")


def run_tool(argv: list[str], stage: str, timeout: int = 60, env: dict[str, str] | None = None) -> bytes:
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CandidateError(stage, "ToolFailure") from error
    require(result.returncode == 0, stage, "ToolFailure")
    return result.stdout


def git(repository: Path, args: list[str], stage: str) -> bytes:
    return run_tool(["git", "-C", str(repository), *args], stage, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"})


def git_blob(repository: Path, revision: str, name: str, stage: str) -> bytes:
    return git(repository, ["show", f"{revision}:{name}"], stage)


def cargo_version(data: bytes, stage: str) -> str:
    match = re.search(rb'^version = "([^"]+)"$', data, re.MULTILINE)
    require(match is not None, stage, "InvalidCargoVersion")
    return match.group(1).decode("ascii")


def source_contract(repository: Path, revision: str) -> dict[str, Any]:
    stage = "source_contract"
    config_bytes = git_blob(repository, revision, "apps/docs/src-tauri/tauri.conf.json", stage)
    package_bytes = git_blob(repository, revision, "apps/docs/package.json", stage)
    cargo_bytes = git_blob(repository, revision, "apps/docs/src-tauri/Cargo.toml", stage)
    lock_bytes = git_blob(repository, revision, "apps/docs/sidecar.lock.json", stage)
    config = read_json_bytes(config_bytes, stage)
    package = read_json_bytes(package_bytes, stage)
    lock = read_json_bytes(lock_bytes, stage)
    base_version = package.get("version")
    require(config.get("productName") == APP_NAME and config.get("identifier") == APP_IDENTIFIER, stage, "InvalidAppIdentity")
    require(config.get("version") == base_version == cargo_version(cargo_bytes, stage) and bool(STRICT_SEMVER.fullmatch(str(base_version))), stage, "VersionMismatch")
    updater = config.get("plugins", {}).get("updater", {})
    endpoints = updater.get("endpoints")
    pubkey = updater.get("pubkey")
    require(isinstance(endpoints, list) and len(endpoints) == 1 and isinstance(endpoints[0], str) and endpoints[0].startswith("https://"), stage, "InvalidUpdaterConfig")
    require(isinstance(pubkey, str) and len(pubkey.strip()) > 32 and "REPLACE_" not in pubkey, stage, "InvalidUpdaterKey")
    require(lock.get("schemaVersion") == 1 and lock.get("nihoSpeech", {}).get("signingIdentifier") == SIDECAR, stage, "InvalidSidecarLock")

    names = git(repository, ["ls-tree", "-r", "--name-only", "-z", revision, "--", *SOURCE_PATHS], stage).decode("utf-8").split("\0")
    files = sorted(name for name in names if name and not name.endswith("/.DS_Store"))
    require(bool(files), stage, "MissingSidecarSource")
    listing = b"".join(sha256_bytes(git_blob(repository, revision, name, stage)).encode("ascii") + b"  " + name.encode("utf-8") + b"\n" for name in files)
    sources = lock.get("sources", {})
    require(sources.get("fingerprint") == sha256_bytes(listing) and sources.get("fileCount") == len(files), stage, "StaleSidecarLock")
    return {
        "version": base_version,
        "app": {"identifier": APP_IDENTIFIER, "name": APP_NAME},
        "sidecarLockSha256": sha256_bytes(lock_bytes),
        "updaterPublicKeySha256": sha256_bytes(pubkey.strip().encode("utf-8")),
    }


def semver_parts(value: str) -> tuple[int, int, int]:
    match = STRICT_SEMVER.fullmatch(value)
    require(match is not None, "identity", "InvalidVersion")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def release_tag(version: str, source_sha: str, run_id: str, run_attempt: str) -> str:
    return f"editor-candidate-v{version}-{source_sha}-run-{run_id}-attempt-{run_attempt}"


def command_plan(args: argparse.Namespace) -> dict[str, str]:
    repository = Path(args.repository).resolve()
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    identity(args.version, args.source_sha, args.controller_sha, run_id, run_attempt)
    actual = git(repository, ["rev-parse", "HEAD"], "plan").decode().strip()
    require(actual == args.controller_sha, "plan", "ControllerHeadMismatch")
    resolved = git(repository, ["rev-parse", f"{args.source_sha}^{{commit}}"], "plan").decode().strip()
    require(resolved == args.source_sha, "plan", "SourceCommitMismatch")
    git(repository, ["merge-base", "--is-ancestor", args.source_sha, args.controller_sha], "plan")
    contract = source_contract(repository, args.source_sha)
    require(semver_parts(args.version) >= semver_parts(contract["version"]), "plan", "VersionBelowSource")
    outputs = {"source-sha": args.source_sha, "version": args.version, "release-tag": release_tag(args.version, args.source_sha, run_id, run_attempt), "run-attempt": run_attempt}
    try:
        with Path(args.github_output).open("a", encoding="utf-8") as target:
            for key, value in outputs.items():
                target.write(f"{key}={value}\n")
    except OSError as error:
        raise CandidateError("plan", "OutputWrite") from error
    return outputs


def safe_tar_name(name: str, root: str) -> str | None:
    require(name != "" and len(name.encode("utf-8")) <= 4096 and "\\" not in name and "\0" not in name, "tar", "UnsafePath")
    require(not name.startswith("/") and not re.match(r"^[A-Za-z]:", name), "tar", "UnsafePath")
    raw = name.rstrip("/").split("/")
    require(all(part not in ("", ".", "..") for part in raw), "tar", "UnsafePath")
    parts = PurePosixPath(name.rstrip("/")).parts
    require(bool(parts) and parts[0] == root, "tar", "WrongRoot")
    return "/".join(parts[1:]) or None


def inspect_tar(tar_path: Path, version: str, extract_to: Path | None = None) -> dict[str, Any]:
    ordinary_file(tar_path, "tar", MAX_ARCHIVE_BYTES)
    root = f"{APP_NAME}.app"
    seen: set[str] = set()
    mac_seen: set[str] = set()
    inventory: list[dict[str, Any]] = []
    total = 0
    entries = 0
    info_bytes: bytes | None = None
    try:
        with tarfile.open(tar_path, "r:gz") as archive:
            for member in archive:
                entries += 1
                require(entries <= MAX_FILES * 2, "tar", "EntryLimit")
                relative = safe_tar_name(member.name, root)
                canonical = member.name.rstrip("/")
                require(canonical not in seen, "tar", "DuplicateEntry")
                seen.add(canonical)
                mac_name = unicodedata.normalize("NFD", canonical).casefold()
                require(mac_name not in mac_seen, "tar", "MacNameCollision")
                mac_seen.add(mac_name)
                require(not any(key.lower().startswith("gnu.sparse") for key in member.pax_headers), "tar", "SparseEntry")
                require(not member.mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX), "tar", "SpecialMode")
                if member.isdir():
                    continue
                require(member.isfile() and relative is not None, "tar", "SpecialEntry")
                require(member.size <= MAX_FILE_BYTES and len(inventory) < MAX_FILES, "tar", "FileLimit")
                total += member.size
                require(total <= MAX_TOTAL_BYTES, "tar", "ExpandedLimit")
                source = archive.extractfile(member)
                require(source is not None, "tar", "UnreadableEntry")
                digest = hashlib.sha256()
                data = bytearray() if relative == "Contents/Info.plist" else None
                target = None
                if extract_to is not None:
                    target_path = extract_to.joinpath(root, *relative.split("/"))
                    target_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    descriptor = os.open(target_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755 if member.mode & 0o111 else 0o644)
                    target = os.fdopen(descriptor, "wb")
                count = 0
                try:
                    while chunk := source.read(1024 * 1024):
                        count += len(chunk)
                        require(count <= member.size, "tar", "SizeMismatch")
                        digest.update(chunk)
                        if data is not None:
                            data.extend(chunk)
                        if target is not None:
                            target.write(chunk)
                finally:
                    if target is not None:
                        target.close()
                require(count == member.size, "tar", "SizeMismatch")
                if data is not None:
                    info_bytes = bytes(data)
                inventory.append({"path": relative, "sha256": digest.hexdigest(), "mode": member.mode & 0o777, "size": member.size})
    except CandidateError:
        raise
    except (OSError, tarfile.TarError) as error:
        raise CandidateError("tar", "InvalidArchive") from error
    inventory.sort(key=lambda record: record["path"].encode("utf-8"))
    require(info_bytes is not None and len(info_bytes) <= 1024 * 1024, "tar", "MissingInfoPlist")
    try:
        info = plistlib.loads(info_bytes)
    except Exception as error:
        raise CandidateError("tar", "InvalidInfoPlist") from error
    require(info.get("CFBundleIdentifier") == APP_IDENTIFIER and info.get("CFBundleName") in (None, APP_NAME), "tar", "AppIdentityMismatch")
    require(info.get("CFBundleShortVersionString") == version and str(info.get("CFBundleVersion")) == version, "tar", "AppVersionMismatch")
    executable = info.get("CFBundleExecutable")
    require(isinstance(executable, str) and re.fullmatch(r"[A-Za-z0-9._ -]+", executable or "") is not None, "tar", "InvalidExecutable")
    paths = {record["path"] for record in inventory}
    require(f"Contents/MacOS/{executable}" in paths and f"Contents/MacOS/{SIDECAR}" in paths, "tar", "MissingExecutable")
    return {"inventory": inventory, "inventorySha256": sha256_bytes(stable_json_bytes(inventory)), "fileCount": len(inventory), "expandedBytes": total}


def directory_inventory(app: Path) -> list[dict[str, Any]]:
    require(app.is_dir() and not app.is_symlink(), "dmg", "InvalidAppDirectory")
    records: list[dict[str, Any]] = []
    total = 0
    for root, directories, files in os.walk(app, topdown=True, followlinks=False):
        directories.sort(key=lambda name: name.encode("utf-8"))
        files.sort(key=lambda name: name.encode("utf-8"))
        for name in directories:
            require(not (Path(root) / name).is_symlink(), "dmg", "AppSymlink")
        for name in files:
            file = Path(root) / name
            item = file.lstat()
            require(stat.S_ISREG(item.st_mode) and not file.is_symlink(), "dmg", "SpecialAppFile")
            require(not item.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX), "dmg", "SpecialMode")
            require(item.st_size <= MAX_FILE_BYTES and len(records) < MAX_FILES, "dmg", "FileLimit")
            total += item.st_size
            require(total <= MAX_TOTAL_BYTES, "dmg", "ExpandedLimit")
            records.append({"path": file.relative_to(app).as_posix(), "sha256": file_sha256(file), "mode": item.st_mode & 0o777, "size": item.st_size})
    return sorted(records, key=lambda record: record["path"].encode("utf-8"))


def verify_plist(app: Path, version: str) -> None:
    try:
        with (app / "Contents/Info.plist").open("rb") as source:
            info = plistlib.load(source)
    except (OSError, plistlib.InvalidFileException) as error:
        raise CandidateError("dmg", "InvalidInfoPlist") from error
    require(info.get("CFBundleIdentifier") == APP_IDENTIFIER and info.get("CFBundleName") in (None, APP_NAME), "dmg", "AppIdentityMismatch")
    require(info.get("CFBundleShortVersionString") == version and str(info.get("CFBundleVersion")) == version, "dmg", "AppVersionMismatch")


def verify_codesign(app: Path) -> None:
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": tempfile.gettempdir(), "LC_ALL": "C"}
    run_tool(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], "codesign", 180, env)
    sidecar = app / f"Contents/MacOS/{SIDECAR}"
    run_tool(["/usr/bin/codesign", "--verify", "--strict", str(sidecar)], "codesign", 60, env)
    try:
        result = subprocess.run(["/usr/bin/codesign", "-dv", "--verbose=4", str(sidecar)], stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=60, env=env)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CandidateError("codesign", "ToolFailure") from error
    require(result.returncode == 0 and re.search(rb"(?:^|\n)Identifier=niho-speech(?:\n|$)", result.stdout + result.stderr) is not None, "codesign", "SidecarIdentifier")


def verify_dmg(dmg: Path, scratch: Path, version: str, tar_inventory: list[dict[str, Any]]) -> dict[str, Any]:
    ordinary_file(dmg, "dmg", MAX_ARCHIVE_BYTES)
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": tempfile.gettempdir(), "LC_ALL": "C"}
    run_tool(["/usr/bin/hdiutil", "verify", str(dmg)], "dmg_verify", 180, env)
    try:
        image_info = plistlib.loads(run_tool(["/usr/bin/hdiutil", "imageinfo", "-plist", str(dmg)], "dmg_format", 60, env))
    except plistlib.InvalidFileException as error:
        raise CandidateError("dmg_format", "InvalidToolOutput") from error
    require(image_info.get("Format") == "UDZO", "dmg_format", "WrongFormat")
    mount = (scratch / "mount").resolve()
    mount.mkdir(mode=0o700)
    attached = False
    try:
        result = plistlib.loads(run_tool(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", str(mount), "-plist", str(dmg)], "dmg_mount", 180, env))
        attached = True
        require(any(entity.get("mount-point") == str(mount) for entity in result.get("system-entities", [])), "dmg_mount", "WrongMount")
        require(set(os.listdir(mount)) == {f"{APP_NAME}.app", "Applications"}, "dmg_root", "UnexpectedRoot")
        applications = mount / "Applications"
        require(applications.is_symlink() and os.readlink(applications) == "/Applications", "dmg_root", "InvalidApplicationsLink")
        app = mount / f"{APP_NAME}.app"
        inventory = directory_inventory(app)
        require(inventory == tar_inventory, "dmg_inventory", "InventoryMismatch")
        verify_plist(app, version)
        verify_codesign(app)
        return {"format": "UDZO", "inventorySha256": sha256_bytes(stable_json_bytes(inventory))}
    except CandidateError:
        raise
    except (OSError, plistlib.InvalidFileException) as error:
        raise CandidateError("dmg", "InvalidImage") from error
    finally:
        if attached:
            run_tool(["/usr/bin/hdiutil", "detach", str(mount)], "dmg_detach", 60, env)


def asset_record(file: Path, name: str) -> dict[str, Any]:
    item = ordinary_file(file, "assets")
    return {"file": name, "sha256": file_sha256(file), "bytes": item.st_size}


def expected_manifest(identity_values: dict[str, str], build: dict[str, Any], receipt_sha: str, assets: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "repository": REPOSITORY,
        "product": PRODUCT,
        "sourceSha": identity_values["sourceSha"],
        "controllerSha": identity_values["controllerSha"],
        "version": identity_values["version"],
        "run": {"id": identity_values["runId"], "attempt": identity_values["runAttempt"], "workflow": WORKFLOW},
        "app": build["app"],
        "sidecarLockSha256": build["sidecarLockSha256"],
        "updaterPublicKeySha256": build["updaterPublicKeySha256"],
        "clientConfigSha256": build["clientConfigSha256"],
        "macReceiptSha256": receipt_sha,
        "assets": assets,
    }


def validate_build(build: Any, values: dict[str, str], contract: dict[str, Any]) -> None:
    expected_keys = {"sourceSha", "controllerSha", "version", "run", "app", "sidecarLockSha256", "updaterPublicKeySha256", "clientConfigSha256"}
    require(isinstance(build, dict) and set(build) == expected_keys, "build_receipt", "InvalidSchema")
    require(build.get("sourceSha") == values["sourceSha"] and build.get("controllerSha") == values["controllerSha"] and build.get("version") == values["version"], "build_receipt", "IdentityMismatch")
    require(build.get("run") == {"id": values["runId"], "attempt": values["runAttempt"]}, "build_receipt", "RunMismatch")
    require(build.get("app") == contract["app"], "build_receipt", "AppMismatch")
    for key in ("sidecarLockSha256", "updaterPublicKeySha256"):
        require(build.get(key) == contract[key], "build_receipt", "SourceHashMismatch")
    require(bool(SHA256.fullmatch(build.get("clientConfigSha256", ""))), "build_receipt", "ClientConfigHash")


def command_verify(args: argparse.Namespace) -> dict[str, Any]:
    values = {"version": args.version, "sourceSha": args.source_sha, "controllerSha": args.controller_sha, "runId": args.run_id, "runAttempt": args.run_attempt}
    identity(args.version, args.source_sha, args.controller_sha, args.run_id, args.run_attempt)
    source_repository = Path(args.source_repository).resolve()
    actual = git(source_repository, ["rev-parse", "HEAD"], "verify_source").decode().strip()
    require(actual == args.source_sha, "verify_source", "SourceHeadMismatch")
    contract = source_contract(source_repository, args.source_sha)
    require(semver_parts(args.version) >= semver_parts(contract["version"]), "verify_source", "VersionBelowSource")
    raw = Path(args.directory).resolve()
    exact_directory(raw, {DMG_NAME, TAR_NAME, BUILD_NAME}, "raw_directory")
    build = read_json_file(raw / BUILD_NAME, "build_receipt", canonical=True)
    validate_build(build, values, contract)
    output = Path(args.output).resolve()
    require(not output.exists(), "output", "AlreadyExists")
    output.mkdir(mode=0o700)
    try:
        with tempfile.TemporaryDirectory(prefix="editor-candidate-verify-") as temporary:
            scratch = Path(temporary)
            tar_proof = inspect_tar(raw / TAR_NAME, args.version, scratch / "tar")
            extracted_app = scratch / "tar" / f"{APP_NAME}.app"
            verify_codesign(extracted_app)
            dmg_proof = verify_dmg(raw / DMG_NAME, scratch, args.version, tar_proof["inventory"])
        copy_new(raw / DMG_NAME, output / DMG_NAME, "output")
        copy_new(raw / TAR_NAME, output / TAR_NAME, "output")
        dmg_record = asset_record(output / DMG_NAME, DMG_NAME)
        tar_record = asset_record(output / TAR_NAME, TAR_NAME)
        receipt = {
            "schemaVersion": 1,
            "repository": REPOSITORY,
            "product": PRODUCT,
            "sourceSha": args.source_sha,
            "controllerSha": args.controller_sha,
            "version": args.version,
            "run": {"id": args.run_id, "attempt": args.run_attempt, "workflow": WORKFLOW},
            "tarSha256": tar_record["sha256"],
            "dmgSha256": dmg_record["sha256"],
            "inventorySha256": tar_proof["inventorySha256"],
            "files": tar_proof["fileCount"],
            "expandedBytes": tar_proof["expandedBytes"],
            "checks": ["tar-safe-data", "tar-codesign", "dmg-readonly-nobrowse", "dmg-tar-inventory", "dmg-codesign"],
            "dmg": dmg_proof,
        }
        write_new(output / MAC_NAME, stable_json_bytes(receipt), "output")
        receipt_sha = file_sha256(output / MAC_NAME)
        assets = {"dmg": dmg_record, "tar": tar_record}
        manifest = expected_manifest(values, build, receipt_sha, assets)
        write_new(output / MANIFEST_NAME, stable_json_bytes(manifest), "output")
        validate_values = vars(args).copy()
        validate_values["directory"] = str(output)
        command_validate(argparse.Namespace(**validate_values))
        return manifest
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        raise


def command_validate(args: argparse.Namespace) -> dict[str, Any]:
    values = {"version": args.version, "sourceSha": args.source_sha, "controllerSha": args.controller_sha, "runId": args.run_id, "runAttempt": args.run_attempt}
    identity(args.version, args.source_sha, args.controller_sha, args.run_id, args.run_attempt)
    directory = Path(args.directory).resolve()
    exact_directory(directory, {DMG_NAME, TAR_NAME, MAC_NAME, MANIFEST_NAME}, "validated_directory")
    manifest = read_json_file(directory / MANIFEST_NAME, "manifest", canonical=True)
    receipt = read_json_file(directory / MAC_NAME, "mac_receipt", canonical=True)
    require(manifest.get("app") == {"identifier": APP_IDENTIFIER, "name": APP_NAME}, "manifest", "AppMismatch")
    for key in ("sidecarLockSha256", "updaterPublicKeySha256", "clientConfigSha256", "macReceiptSha256"):
        require(bool(SHA256.fullmatch(manifest.get(key, ""))), "manifest", "InvalidHash")
    build = {
        "app": manifest.get("app"),
        "sidecarLockSha256": manifest.get("sidecarLockSha256"),
        "updaterPublicKeySha256": manifest.get("updaterPublicKeySha256"),
        "clientConfigSha256": manifest.get("clientConfigSha256"),
    }
    assets = {"dmg": asset_record(directory / DMG_NAME, DMG_NAME), "tar": asset_record(directory / TAR_NAME, TAR_NAME)}
    expected = expected_manifest(values, build, file_sha256(directory / MAC_NAME), assets)
    require(manifest == expected, "manifest", "ManifestMismatch")
    expected_receipt_identity = {
        "repository": REPOSITORY, "product": PRODUCT, "sourceSha": args.source_sha, "controllerSha": args.controller_sha,
        "version": args.version, "run": {"id": args.run_id, "attempt": args.run_attempt, "workflow": WORKFLOW},
    }
    require(receipt.get("schemaVersion") == 1 and all(receipt.get(key) == value for key, value in expected_receipt_identity.items()), "mac_receipt", "IdentityMismatch")
    receipt_keys = {"schemaVersion", "repository", "product", "sourceSha", "controllerSha", "version", "run", "tarSha256", "dmgSha256", "inventorySha256", "files", "expandedBytes", "checks", "dmg"}
    require(isinstance(receipt, dict) and set(receipt) == receipt_keys, "mac_receipt", "InvalidSchema")
    require(receipt.get("tarSha256") == assets["tar"]["sha256"] and receipt.get("dmgSha256") == assets["dmg"]["sha256"], "mac_receipt", "AssetMismatch")
    require(bool(SHA256.fullmatch(receipt.get("inventorySha256", ""))) and isinstance(receipt.get("files"), int) and receipt["files"] > 0 and isinstance(receipt.get("expandedBytes"), int) and receipt["expandedBytes"] > 0, "mac_receipt", "InvalidInventory")
    required_checks = {"tar-codesign", "dmg-readonly-nobrowse", "dmg-tar-inventory"}
    require(isinstance(receipt.get("checks"), list) and required_checks.issubset(receipt["checks"]), "mac_receipt", "MissingChecks")
    require(receipt.get("dmg") == {"format": "UDZO", "inventorySha256": receipt["inventorySha256"]}, "mac_receipt", "DmgProofMismatch")
    return manifest


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--repository", required=True)
    plan.add_argument("--source-sha", required=True)
    plan.add_argument("--controller-sha", required=True)
    plan.add_argument("--version", required=True)
    plan.add_argument("--github-output", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--directory", required=True)
    verify.add_argument("--output", required=True)
    verify.add_argument("--source-repository", required=True)
    for command in (verify,):
        command.add_argument("--version", required=True)
        command.add_argument("--source-sha", required=True)
        command.add_argument("--controller-sha", required=True)
        command.add_argument("--run-id", required=True)
        command.add_argument("--run-attempt", required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--directory", required=True)
    validate.add_argument("--version", required=True)
    validate.add_argument("--source-sha", required=True)
    validate.add_argument("--controller-sha", required=True)
    validate.add_argument("--run-id", required=True)
    validate.add_argument("--run-attempt", required=True)
    return root


def main(argv: list[str]) -> int:
    try:
        args = parser().parse_args(argv)
        if args.command == "plan":
            command_plan(args)
        elif args.command == "verify":
            command_verify(args)
        else:
            command_validate(args)
        return 0
    except CandidateError as error:
        print(json.dumps({"stage": error.stage, "kind": error.kind}, separators=(",", ":")), file=sys.stderr)
        return 1
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(json.dumps({"stage": "system", "kind": type(error).__name__}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
