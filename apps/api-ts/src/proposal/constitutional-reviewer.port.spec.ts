import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpConstitutionalReviewer, NoopConstitutionalReviewer } from "./constitutional-reviewer.port.js";

describe("NoopConstitutionalReviewer", () => {
  it("never clears (fail-closed)", async () => {
    expect(await new NoopConstitutionalReviewer().isCleared("p1")).toBe(false);
  });
});

// Real local HTTP server standing in for audit-service's POST /audit/reviews
// (apps/api-go/internal/audit/handlers.go's triggerReview) -- same "no
// mocked fetch" approach as audit-emitter.spec.ts.
describe("HttpConstitutionalReviewer (HTTP)", () => {
  let server: Server;
  let baseUrl: string;
  let received: { method?: string; path?: string; body?: unknown } | undefined;
  let responseStatus = 201;
  let responseBody: unknown = { reviews: [], blocked: false };

  beforeEach(async () => {
    received = undefined;
    responseStatus = 201;
    responseBody = { reviews: [], blocked: false };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received = {
          method: req.method,
          path: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        };
        res.writeHead(responseStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("expected server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
    process.env.AUDIT_SERVICE_URL = baseUrl;
  });

  afterEach(async () => {
    delete process.env.AUDIT_SERVICE_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POSTs /audit/reviews with an empty affected_right_ids and the proposal id", async () => {
    const reviewer = new HttpConstitutionalReviewer();
    await reviewer.isCleared("proposal-1");
    expect(received?.method).toBe("POST");
    expect(received?.path).toBe("/audit/reviews");
    expect(received?.body).toEqual({
      proposal_id: "proposal-1",
      affected_right_ids: [],
      reviewer_ref: "proposal-service",
    });
  });

  it("clears when the review is not blocked", async () => {
    responseBody = { reviews: [], blocked: false };
    const reviewer = new HttpConstitutionalReviewer();
    expect(await reviewer.isCleared("proposal-1")).toBe(true);
  });

  it("fails closed when the review is blocked", async () => {
    responseBody = { reviews: [{ result: "blocked" }], blocked: true };
    const reviewer = new HttpConstitutionalReviewer();
    expect(await reviewer.isCleared("proposal-1")).toBe(false);
  });

  it("fails closed on a non-2xx response", async () => {
    responseStatus = 500;
    const reviewer = new HttpConstitutionalReviewer();
    expect(await reviewer.isCleared("proposal-1")).toBe(false);
  });

  it("fails closed when audit-service is unreachable", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const reviewer = new HttpConstitutionalReviewer();
    expect(await reviewer.isCleared("proposal-1")).toBe(false);
  });

  it("fails closed when AUDIT_SERVICE_URL is unset", async () => {
    delete process.env.AUDIT_SERVICE_URL;
    const reviewer = new HttpConstitutionalReviewer();
    expect(await reviewer.isCleared("proposal-1")).toBe(false);
    expect(received).toBeUndefined();
  });
});
