#!/usr/bin/env bash
set -euo pipefail
# Release assets and checksum come from the official pinned release over HTTPS.
version=0.75.0
output=${1:?Provide a writable installation directory}
mkdir -p "$output"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive="trivy_${version}_Linux-64bit.tar.gz"
base="https://github.com/aquasecurity/trivy/releases/download/v${version}"
curl --fail --location --retry 3 "$base/$archive" --output "$work/$archive"
curl --fail --location --retry 3 "$base/trivy_${version}_checksums.txt" --output "$work/checksums.txt"
(cd "$work"; awk -v filename="$archive" '$2 == filename { print }' checksums.txt > selected.txt; test -s selected.txt; sha256sum --check selected.txt)
tar -xzf "$work/$archive" -C "$output" trivy
chmod 755 "$output/trivy"
"$output/trivy" --version
