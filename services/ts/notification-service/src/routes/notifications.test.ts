import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { Providers, NotificationProvider } from "../services/providers.js";

function succeedProvider(): NotificationProvider {
  return { async send() { return true; } };
}

function failProvider(): NotificationProvider & { calls: number } {
  const provider = {
    calls: 0,
    async send() {
      provider.calls += 1;
      return false;
    },
  };
  return provider;
}

function countingProvider(): NotificationProvider & { calls: number } {
  const provider = {
    calls: 0,
    async send() {
      provider.calls += 1;
      return true;
    },
  };
  return provider;
}

function allSucceed(): Providers {
  return { email: succeedProvider(), push: succeedProvider(), in_app: succeedProvider() };
}

describe("notification routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe("POST /notifications/dispatch", () => {
    it.each([
      "ballot_choice",
      "legal_identity",
      "government_id",
      "legal_identity_hash",
      "raw_legal_identifier",
    ])("rejects a payload with banned key %s at the top level", async (key) => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: {
          citizen_id: "citizen-1",
          event_type: "vote_open",
          channel: "email",
          payload: { [key]: "secret" },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty("error");
    });

    it("rejects a payload with a banned key nested inside the payload object", async () => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: {
          citizen_id: "citizen-1",
          event_type: "vote_open",
          channel: "email",
          payload: { meta: { nested: { legal_identity: "x" } } },
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 202 with status='skipped' and never calls the provider for a disabled channel", async () => {
      const store = createStore();
      store.setPreference("citizen-1", "email", false);
      const email = countingProvider();
      app = buildServer({ store, providers: { ...allSucceed(), email } });

      const res = await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: { citizen_id: "citizen-1", event_type: "vote_open", channel: "email", payload: {} },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ status: "skipped" });
      expect(email.calls).toBe(0);
    });

    it("treats a channel with no stored preference as enabled by default", async () => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: { citizen_id: "citizen-1", event_type: "vote_open", channel: "push", payload: {} },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ status: "delivered" });
    });

    it("never returns 500 for a failing provider, and eventually marks the notification failed after retries", async () => {
      const store = createStore();
      const email = failProvider();
      app = buildServer({ store, providers: { ...allSucceed(), email } });

      const dispatchRes = await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: { citizen_id: "citizen-1", event_type: "vote_open", channel: "email", payload: {} },
      });
      expect(dispatchRes.statusCode).toBe(202);
      const dispatched = dispatchRes.json();
      expect(dispatched.status).toBe("retrying");

      let last = dispatched;
      for (let i = 0; i < 2; i += 1) {
        const retryRes = await app.inject({ method: "POST", url: `/notifications/${dispatched.id}/retry` });
        expect(retryRes.statusCode).toBe(200);
        last = retryRes.json();
      }
      expect(last.status).toBe("failed");
      expect(email.calls).toBe(3);

      const finalRetry = await app.inject({ method: "POST", url: `/notifications/${dispatched.id}/retry` });
      expect(finalRetry.statusCode).toBe(200);
      expect(finalRetry.json().status).toBe("failed");
      expect(email.calls).toBe(3);
    });

    it("rejects a request missing required fields with 400", async () => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: { citizen_id: "citizen-1" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an invalid channel with 400", async () => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: { citizen_id: "citizen-1", event_type: "vote_open", channel: "sms", payload: {} },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /notifications/:id/retry", () => {
    it("returns 404 for an unknown notification id", async () => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({ method: "POST", url: "/notifications/does-not-exist/retry" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PUT /notifications/preferences/:citizenId", () => {
    it("updates a single channel and returns the full preference map", async () => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({
        method: "PUT",
        url: "/notifications/preferences/citizen-1",
        payload: { channel: "push", enabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().preferences).toEqual({ email: true, push: false, in_app: true });
    });

    it("updates several channels via a channel->enabled map", async () => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({
        method: "PUT",
        url: "/notifications/preferences/citizen-1",
        payload: { email: false, in_app: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().preferences).toEqual({ email: false, push: true, in_app: false });
    });

    it("a disabled preference set here is honored by a later dispatch", async () => {
      const store = createStore();
      app = buildServer({ store, providers: allSucceed() });
      await app.inject({
        method: "PUT",
        url: "/notifications/preferences/citizen-1",
        payload: { channel: "email", enabled: false },
      });
      const res = await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: { citizen_id: "citizen-1", event_type: "vote_open", channel: "email", payload: {} },
      });
      expect(res.json().status).toBe("skipped");
    });
  });

  describe("GET /notifications/citizens/:id", () => {
    it("returns a citizen's notification records", async () => {
      const store = createStore();
      app = buildServer({ store, providers: allSucceed() });
      await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: { citizen_id: "citizen-1", event_type: "vote_open", channel: "in_app", payload: {} },
      });
      await app.inject({
        method: "POST",
        url: "/notifications/dispatch",
        payload: { citizen_id: "citizen-2", event_type: "vote_open", channel: "in_app", payload: {} },
      });

      const res = await app.inject({ method: "GET", url: "/notifications/citizens/citizen-1" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ citizen_id: "citizen-1", event_type: "vote_open", channel: "in_app" });
    });

    it("returns an empty list for a citizen with no notifications", async () => {
      app = buildServer({ store: createStore(), providers: allSucceed() });
      const res = await app.inject({ method: "GET", url: "/notifications/citizens/unknown-citizen" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });
});
