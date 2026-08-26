import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import { updatePreferences } from "./preferences.js";

describe("updatePreferences", () => {
  it("defaults every channel to enabled before any preference is set", () => {
    const store = createStore();
    expect(store.getPreferences("citizen-1")).toEqual({ email: true, push: true, in_app: true });
  });

  it("updates a single channel via {channel, enabled}", () => {
    const store = createStore();
    const result = updatePreferences(store, "citizen-1", { channel: "email", enabled: false });
    expect(result).toEqual({ email: false, push: true, in_app: true });
  });

  it("updates multiple channels via a channel->enabled map", () => {
    const store = createStore();
    const result = updatePreferences(store, "citizen-1", { email: false, push: false });
    expect(result).toEqual({ email: false, push: false, in_app: true });
  });

  it("rejects an invalid channel name", () => {
    const store = createStore();
    expect(() => updatePreferences(store, "citizen-1", { channel: "sms", enabled: true })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects a non-boolean enabled value", () => {
    const store = createStore();
    expect(() =>
      updatePreferences(store, "citizen-1", { channel: "email", enabled: "yes" as unknown as boolean }),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("rejects an empty body", () => {
    const store = createStore();
    expect(() => updatePreferences(store, "citizen-1", {})).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("rejects a map entry with a non-boolean value", () => {
    const store = createStore();
    expect(() =>
      updatePreferences(store, "citizen-1", { email: "no" as unknown as boolean }),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
