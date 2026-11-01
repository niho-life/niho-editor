#!/usr/bin/env bash
# Checks that the image can install what apps/editor-web depends on (CI's editor-deploy job runs it).
#
# apps/editor-web depends on the repository's own packages through `file:` links. `npm ci` resolves those paths
# inside the image, so every one of them must be COPYed in before the `npm ci` line — otherwise the build fails with
# `ENOENT ... package.json` and the only place it shows is Cloud Build. That is exactly what happened when
# editor-publish and editor-publish-contract were added (#64・#93) and the Dockerfile was not updated: the image could
# not be built for weeks, and nobody noticed because nothing was deployed in between.
#
# This check reads the `file:` dependencies out of package.json and asserts each one is copied before `npm ci`.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dockerfile="$root/apps/editor-web/Dockerfile"
manifest="$root/apps/editor-web/package.json"

failed=0
fail() {
  printf 'FAIL  %s\n' "$1"
  failed=1
}

[[ -f "$dockerfile" ]] || { printf 'FAIL  %s is missing\n' "$dockerfile"; exit 1; }
[[ -f "$manifest" ]] || { printf 'FAIL  %s is missing\n' "$manifest"; exit 1; }

# The `file:` targets, as paths relative to the repository root (file:../../packages/x -> packages/x).
needed="$(node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const out = new Set();
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const spec of Object.values(m[field] ?? {})) {
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    out.add(spec.slice("file:".length).replace(/^(\.\.\/)+/, ""));
  }
}
process.stdout.write([...out].sort().join("\n"));
' "$manifest")"

[[ -n "$needed" ]] || { printf 'FAIL  no file: dependencies found in %s (did the manifest change shape?)\n' "$manifest"; exit 1; }

# Everything copied before the first `npm ci` line is available to it.
ci_line="$(grep -n 'npm -C apps/editor-web ci' "$dockerfile" | head -1 | cut -d: -f1)"
[[ -n "$ci_line" ]] || fail "no 'npm -C apps/editor-web ci' line in the Dockerfile"
before="$(head -n "${ci_line:-0}" "$dockerfile")"

# BuildKit reads <Dockerfile>.dockerignore in preference to the repository's .dockerignore, and this one is an
# allowlist (`*` then `!path`). A package that is COPYed but not allowed here is simply absent from the build context:
# the build then fails with `"/packages/x" not found`, not with ENOENT. Both lists have to name every file: dependency.
ignore="$dockerfile.dockerignore"
[[ -f "$ignore" ]] || fail "$ignore is missing (the build context would carry the whole repository)"

while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  if printf '%s' "$before" | grep -qE "^COPY ${path}(/| )"; then
    printf 'ok    %s is copied before npm ci\n' "$path"
  else
    fail "$path is a file: dependency of apps/editor-web but is not COPYed before npm ci (the image build would fail with ENOENT)"
  fi
  if [[ -f "$ignore" ]]; then
    if grep -qxF "!$path" "$ignore"; then
      printf 'ok    %s is allowed into the build context\n' "$path"
    else
      fail "$path is COPYed but not allowed in $(basename "$ignore") (the build would fail with \"/$path\" not found)"
    fi
  fi
done <<< "$needed"

# Photo server code imports the shared v1 contract directly by relative path. It is not a `file:` dependency,
# but the Next build still needs its source in the Docker context.
path="packages/photo-library-contract"
if printf '%s' "$before" | grep -qE "^COPY ${path}(/| )"; then
  printf 'ok    %s is copied before npm ci (relative source import)\n' "$path"
else
  fail "$path is imported by editor-web source but is not COPYed before npm ci"
fi
if [[ -f "$ignore" ]] && grep -qxF "!$path" "$ignore"; then
  printf 'ok    %s is allowed into the build context\n' "$path"
else
  fail "$path is COPYed but not allowed in $(basename "$ignore")"
fi

[[ $failed -eq 0 ]] || { printf 'dockerfile-test: failed\n' >&2; exit 1; }
printf 'dockerfile-test: all passed\n'
