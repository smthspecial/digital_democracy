import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectMobileBundles } from "./mobile-bundle-audit.mjs";

function fixture(t, sources) {
  const directory = mkdtempSync(join(tmpdir(), "dd-bundle-test-"));
  t.after(() => rmSync(directory, { recursive: true }));
  writeFileSync(
    join(directory, "metadata.json"),
    JSON.stringify({
      bundler: "metro",
      fileMetadata: {
        android: { bundle: "android.hbc" },
        ios: { bundle: "ios.js" },
      },
    }),
  );
  for (const file of ["android.hbc", "ios.js"]) {
    writeFileSync(join(directory, file), "fixture bundle");
    writeFileSync(
      join(directory, `${file}.map`),
      JSON.stringify({
        version: 3,
        sources: ["/apps/mobile/App.tsx", ...sources],
      }),
    );
  }
  return directory;
}

test("both native exports are inspected and identified by digest", (t) => {
  const report = inspectMobileBundles(
    fixture(t, ["/node_modules/react/index.js"]),
  );
  assert.equal(report.platforms.android.format, "hermes");
  assert.equal(report.platforms.ios.format, "javascript");
  assert.equal(report.platforms.android.sha256.length, 64);
});

for (const name of ["node-forge", "braces", "sprintf-js"]) {
  test(`a bundled ${name} fails the gate`, (t) => {
    assert.throws(
      () =>
        inspectMobileBundles(
          fixture(t, [
            `/node_modules/.pnpm/${name}@1/node_modules/${name}/index.js`,
          ]),
        ),
      /runtime includes patched packages/,
    );
  });
}

test("missing source maps cannot produce an absence claim", (t) => {
  const directory = fixture(t, []);
  rmSync(join(directory, "ios.js.map"));
  assert.throws(() => inspectMobileBundles(directory));
});

test("empty inventories and unrelated maps fail closed", (t) => {
  const directory = fixture(t, []);
  for (const sources of [[], ["/node_modules/react/index.js"]]) {
    writeFileSync(
      join(directory, "android.hbc.map"),
      JSON.stringify({ version: 3, sources }),
    );
    assert.throws(() => inspectMobileBundles(directory));
  }
});

test("bundle paths cannot escape the export directory", (t) => {
  const directory = fixture(t, []);
  writeFileSync(
    join(directory, "metadata.json"),
    JSON.stringify({
      bundler: "metro",
      fileMetadata: { android: { bundle: "../outside.js" } },
    }),
  );
  assert.throws(
    () => inspectMobileBundles(directory),
    /outside export directory/,
  );
});
