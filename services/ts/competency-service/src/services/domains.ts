import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { ExpertDomain } from "../domain/types.js";
import { notFound } from "../errors.js";

export function createDomain(
  store: Store,
  input: { name: string; description: string },
): ExpertDomain {
  const domain: ExpertDomain = {
    id: randomUUID(),
    name: input.name,
    description: input.description,
  };
  store.domains.set(domain.id, domain);
  return domain;
}

export function listDomains(store: Store): ExpertDomain[] {
  return [...store.domains.values()];
}

export function requireDomain(store: Store, domainId: string): ExpertDomain {
  const domain = store.domains.get(domainId);
  if (!domain) {
    throw notFound(`domain ${domainId} not found`);
  }
  return domain;
}
