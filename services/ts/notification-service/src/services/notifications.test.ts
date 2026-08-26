import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import type { Providers, NotificationProvider } from "./providers.js";
import { dispatchNotification, retryNotification, MAX_DELIVERY_ATTEMPTS } from "./notifications.js";

function providersWith(overrides: Partial<Providers>, base: Providers): Providers {
  return { ...base, ...overrides };
}

function allSucceedProviders(): Providers {
  const succeed: NotificationProvider = { async send() { return true; } };
  return { email: succeed, push: succeed, in_app: succeed };
}

describe("dispatchNotification", () => {
  it("rejects a payload containing a banned key without calling any provider", async () => {
    const store = createStore();
    let calls = 0;
    const providers = providersWith(
      { email: { async send() { calls += 1; return true; } } },
      allSucceedProviders(),
    );

    await expect(
      dispatchNotification(store, providers, {
        citizenId: "citizen-1",
        eventType: "vote_open",
        channel: "email",
        payload: { ballot_choice: "yes" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toBe(0);
  });

  it("records status='skipped' and never calls the provider when the channel is disabled", async () => {
    const store = createStore();
    store.setPreference("citizen-1", "email", false);
    let calls = 0;
    const providers = providersWith(
      { email: { async send() { calls += 1; return true; } } },
      allSucceedProviders(),
    );

    const record = await dispatchNotification(store, providers, {
      citizenId: "citizen-1",
      eventType: "vote_open",
      channel: "email",
      payload: { title: "Vote open" },
    });

    expect(record.status).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("defaults an unconfigured channel to enabled", async () => {
    const store = createStore();
    const record = await dispatchNotification(store, allSucceedProviders(), {
      citizenId: "citizen-1",
      eventType: "vote_open",
      channel: "push",
      payload: {},
    });
    expect(record.status).toBe("delivered");
  });

  it("marks status='delivered' when the provider succeeds", async () => {
    const store = createStore();
    const record = await dispatchNotification(store, allSucceedProviders(), {
      citizenId: "citizen-1",
      eventType: "vote_open",
      channel: "in_app",
      payload: { title: "Vote open" },
    });
    expect(record.status).toBe("delivered");
    expect(record.attempts).toBe(0);
  });

  it("moves to 'retrying' then 'failed' as a failing provider is retried past the max attempts", async () => {
    const store = createStore();
    let calls = 0;
    const providers = providersWith(
      { email: { async send() { calls += 1; return false; } } },
      allSucceedProviders(),
    );

    let record = await dispatchNotification(store, providers, {
      citizenId: "citizen-1",
      eventType: "vote_open",
      channel: "email",
      payload: {},
    });
    expect(record.status).toBe("retrying");
    expect(record.attempts).toBe(1);
    expect(calls).toBe(1);

    record = await retryNotification(store, providers, record.id);
    expect(record.status).toBe("retrying");
    expect(record.attempts).toBe(2);

    record = await retryNotification(store, providers, record.id);
    expect(record.status).toBe("failed");
    expect(record.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(calls).toBe(3);

    record = await retryNotification(store, providers, record.id);
    expect(record.status).toBe("failed");
    expect(record.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(calls).toBe(3);
  });

  it("never throws back to the caller when the provider rejects", async () => {
    const store = createStore();
    const providers = providersWith(
      {
        push: {
          async send() {
            throw new Error("provider outage");
          },
        },
      },
      allSucceedProviders(),
    );

    const record = await dispatchNotification(store, providers, {
      citizenId: "citizen-1",
      eventType: "vote_open",
      channel: "push",
      payload: {},
    });
    expect(record.status).toBe("retrying");
    expect(record.attempts).toBe(1);
  });
});

describe("retryNotification", () => {
  it("throws a 404 DomainError for an unknown id", async () => {
    const store = createStore();
    await expect(retryNotification(store, allSucceedProviders(), "missing-id")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("is a no-op for an already delivered notification", async () => {
    const store = createStore();
    const record = await dispatchNotification(store, allSucceedProviders(), {
      citizenId: "citizen-1",
      eventType: "vote_open",
      channel: "email",
      payload: {},
    });
    let calls = 0;
    const providers = providersWith(
      { email: { async send() { calls += 1; return true; } } },
      allSucceedProviders(),
    );
    const retried = await retryNotification(store, providers, record.id);
    expect(retried.status).toBe("delivered");
    expect(calls).toBe(0);
  });

  it("is a no-op for a skipped notification", async () => {
    const store = createStore();
    store.setPreference("citizen-1", "email", false);
    const record = await dispatchNotification(store, allSucceedProviders(), {
      citizenId: "citizen-1",
      eventType: "vote_open",
      channel: "email",
      payload: {},
    });
    let calls = 0;
    const providers = providersWith(
      { email: { async send() { calls += 1; return true; } } },
      allSucceedProviders(),
    );
    const retried = await retryNotification(store, providers, record.id);
    expect(retried.status).toBe("skipped");
    expect(calls).toBe(0);
  });
});
