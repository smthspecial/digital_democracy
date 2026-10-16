import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packages = ["node-forge", "braces", "sprintf-js"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Inspect Metro's actual module inventory, not strings in minified output.
// Missing maps/inventories fail; they cannot establish runtime absence.
export function inspectMobileBundles(directory) {
  const metadata = JSON.parse(
    readFileSync(resolve(directory, "metadata.json"), "utf8"),
  );
  assert.equal(metadata.bundler, "metro", "Expected a Metro export");
  const platforms = {};
  for (const platform of ["android", "ios"]) {
    const bundle = metadata.fileMetadata?.[platform]?.bundle;
    assert(
      typeof bundle === "string" && /\.(js|hbc)$/.test(bundle),
      `Missing ${platform} bundle`,
    );
    const path = resolve(directory, bundle);
    const local = relative(resolve(directory), path);
    assert(
      !isAbsolute(local) && !local.startsWith(".."),
      "Bundle is outside export directory",
    );
    const bytes = readFileSync(path);
    assert(bytes.length > 0, "Empty bundle");
    const mapBytes = readFileSync(`${path}.map`);
    const map = JSON.parse(mapBytes);
    assert.equal(map.version, 3, "Expected a v3 source map");
    assert(
      Array.isArray(map.sources) &&
        map.sources.length > 0 &&
        map.sources.every((source) => typeof source === "string"),
      "Missing module inventory",
    );
    assert(
      map.sources.some((source) =>
        /(^|\/)apps\/mobile\/App\.tsx$/.test(source),
      ),
      "Source map does not contain the application",
    );
    const present = packages.filter((name) =>
      map.sources.some((source) =>
        source.replaceAll("\\", "/").split("/").includes(name),
      ),
    );
    platforms[platform] = {
      bundle,
      format: bundle.endsWith(".hbc") ? "hermes" : "javascript",
      bytes: bytes.length,
      sha256: sha256(bytes),
      sourceMapSha256: sha256(mapBytes),
      sourceModules: map.sources.length,
      patchedPackagesPresent: present,
    };
    assert.equal(
      present.length,
      0,
      `${platform} runtime includes patched packages: ${present.join(", ")}`,
    );
  }
  return {
    generatedAt: new Date().toISOString(),
    scope:
      "Metro Android/iOS exports; not signed APK/IPA or native dependency qualification",
    lockfileSha256: sha256(readFileSync("pnpm-lock.yaml")),
    checkedPackages: packages,
    platforms,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [directory, output] = process.argv.slice(2);
  assert(
    directory,
    "Usage: node testing/security/mobile-bundle-audit.mjs EXPORT_DIRECTORY [REPORT_JSON]",
  );
  const report = inspectMobileBundles(directory);
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
