import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const scan = spawnSync(
  "pnpm",
  ["why", "-r", "--json", "node-forge", "braces", "sprintf-js"],
  { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
);
assert.equal(scan.status, 0, "Could not inventory resolved dependency copies");
const copies = JSON.parse(scan.stdout);
const checked = [];
function patchedCopies(name, version) {
  const hash = createHash("sha256")
    .update(readFileSync(`patches/${name}@${version}.patch`))
    .digest("hex");
  const paths = new Set(
    copies
      .filter((copy) => copy.name === name)
      .map((copy) => {
        assert.equal(
          copy.version,
          version,
          `Unreviewed version: ${name}@${copy.version}`,
        );
        const expected = resolve(
          "node_modules/.pnpm",
          `${name}@${version}_patch_hash=${hash}`,
          "node_modules",
          name,
        );
        assert.equal(
          resolve(copy.path),
          expected,
          `Missing or changed applied patch: ${name}`,
        );
        return expected;
      }),
  );
  assert(paths.size > 0, `Missing resolved dependency: ${name}`);
  checked.push({
    package: name,
    version,
    copies: paths.size,
    patchSha256: hash,
  });
  return [...paths].map((path) => require(path));
}
for (const forge of patchedCopies("node-forge", "1.4.0")) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 3 });
  const md = forge.md.sha256.create().update("security regression");
  assert(
    keys.publicKey.verify(md.digest().getBytes(), keys.privateKey.sign(md)),
  );
  const a = forge.asn1;
  const create = (type, constructed, value) =>
    a.create(a.Class.UNIVERSAL, type, constructed, value);
  const algorithm = create(a.Type.SEQUENCE, true, [
    create(a.Type.OID, false, a.oidToDer(forge.oids.sha256).getBytes()),
    create(a.Type.NULL, false, ""),
    create(a.Type.NULL, false, ""),
  ]);
  const malformed = a
    .toDer(
      create(a.Type.SEQUENCE, true, [
        algorithm,
        create(a.Type.OCTETSTRING, false, md.digest().getBytes()),
      ]),
    )
    .getBytes();
  const signature = forge.pki.rsa.encrypt(malformed, keys.privateKey, 0x01);
  assert.throws(
    () => keys.publicKey.verify(md.digest().getBytes(), signature),
    /DigestInfo/,
  );
}
for (const braces of patchedCopies("braces", "3.0.3")) {
  assert.deepEqual(braces.expand("a{b,c}"), ["ab", "ac"]);
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(
      () => operation("{".repeat(5000) + "a" + "}".repeat(5000)),
      SyntaxError,
    );
  }
  let ast = { type: "root", nodes: [{ type: "text", value: "a" }] };
  for (let i = 0; i < 1000; i++) ast = { type: "root", nodes: [ast] };
  assert.throws(() => braces.compile(ast), SyntaxError);
}
for (const { sprintf } of patchedCopies("sprintf-js", "1.0.3")) {
  assert.equal(sprintf("%.2f", 1.234), "1.23");
  assert.equal(sprintf("%.1000000000f", 1).length, 22);
  assert.equal(sprintf("%1000000000s", "a").length, 10000);
}
console.log(JSON.stringify({ passed: 10, checked }));
