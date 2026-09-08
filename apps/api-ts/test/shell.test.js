import test from "node:test";
import assert from "node:assert/strict";
import { createServer, SERVICE_PREFIXES } from "../src/index.js";

function get(port, path) {
  return fetch(`http://localhost:${port}${path}`).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));
}

test("health probes", async () => {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, resolve));
  try {
    const port = srv.address().port;
    for (const path of ["/healthz", "/readyz"]) {
      const { status, body } = await get(port, path);
      assert.equal(status, 200);
      assert.equal(body.status === "ok" || body.status === "ready", true);
    }
  } finally {
    srv.close();
  }
});

test("every service prefix answers 501 with its spec id", async () => {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, resolve));
  try {
    const port = srv.address().port;
    assert.equal(Object.keys(SERVICE_PREFIXES).length, 13);
    for (const [prefix, spec] of Object.entries(SERVICE_PREFIXES)) {
      const { status, body } = await get(port, prefix + "/example");
      assert.equal(status, 501, prefix);
      assert.equal(body.spec, spec, prefix);
    }
  } finally {
    srv.close();
  }
});

test("unknown routes are 404", async () => {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, resolve));
  try {
    const { status } = await get(srv.address().port, "/nope");
    assert.equal(status, 404);
  } finally {
    srv.close();
  }
});
