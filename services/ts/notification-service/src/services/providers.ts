import type { Channel } from "../domain/types.js";

export interface NotificationProvider {
  send(citizenId: string, eventType: string, payload: Record<string, unknown>): Promise<boolean>;
}

export type Providers = Record<Channel, NotificationProvider>;

// Real email/push/in-app delivery integrations (SRV-015 external dependencies) don't exist yet in
// this codebase; each channel is modeled as an injectable provider seam so a real implementation
// can be wired in later without changing dispatch logic. Defaults always succeed.
function alwaysSucceedProvider(): NotificationProvider {
  return {
    async send() {
      return true;
    },
  };
}

export function defaultProviders(): Providers {
  return {
    email: alwaysSucceedProvider(),
    push: alwaysSucceedProvider(),
    in_app: alwaysSucceedProvider(),
  };
}
