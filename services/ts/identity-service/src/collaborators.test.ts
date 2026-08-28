import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpSessionRevoker } from "./collaborators.js";

// Exercises the real HTTP seam implementation against a minimal stand-in
// for auth-service's actual wire contract (SRV-017's
// POST /auth/internal/revoke-all/:citizenId) -- see proposal-service's
// integrations.test.ts for the sibling pattern this follows.

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function listen(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a network address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("createHttpSessionRevoker (integration)", () => {
  it("POSTs to /auth/internal/revoke-all/:citizenId", async () => {
    let received: { method?: string; url?: string } = {};
    const baseUrl = await listen((req, res) => {
      received = { method: req.method, url: req.url };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count: 2 }));
    });

    const revoker = createHttpSessionRevoker(baseUrl);
    revoker.revokeAllSessions("citizen-1");

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received.method).toBe("POST");
    expect(received.url).toBe("/auth/internal/revoke-all/citizen-1");
  });

  it("URL-encodes the citizen id", async () => {
    let receivedUrl: string | undefined;
    const baseUrl = await listen((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count: 0 }));
    });

    const revoker = createHttpSessionRevoker(baseUrl);
    revoker.revokeAllSessions("citizen with spaces");

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(receivedUrl).toBe("/auth/internal/revoke-all/citizen%20with%20spaces");
  });

  it("swallows a failed call without throwing (fire-and-forget)", () => {
    const revoker = createHttpSessionRevoker("http://127.0.0.1:1");
    expect(() => revoker.revokeAllSessions("citizen-1")).not.toThrow();
  });
});
