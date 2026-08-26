import { CHANNELS, type Channel, type PreferenceMap } from "../domain/types.js";
import type { Store } from "../store.js";
import { validation } from "../errors.js";

export interface PreferencesUpdateBody {
  channel?: unknown;
  enabled?: unknown;
  [key: string]: unknown;
}

function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

export function updatePreferences(store: Store, citizenId: string, body: PreferencesUpdateBody): PreferenceMap {
  if (body.channel !== undefined) {
    if (!isChannel(body.channel) || typeof body.enabled !== "boolean") {
      throw validation(`channel must be one of ${CHANNELS.join("|")} and enabled must be a boolean`);
    }
    store.setPreference(citizenId, body.channel, body.enabled);
    return store.getPreferences(citizenId);
  }

  const entries = Object.entries(body).filter(([key]) => key !== "enabled");
  if (entries.length === 0) {
    throw validation("preferences body must be either {channel, enabled} or a channel->enabled map");
  }
  for (const [key, value] of entries) {
    if (!isChannel(key) || typeof value !== "boolean") {
      throw validation(`invalid preference entry "${key}"`);
    }
  }
  for (const [key, value] of entries) {
    store.setPreference(citizenId, key as Channel, value as boolean);
  }
  return store.getPreferences(citizenId);
}
