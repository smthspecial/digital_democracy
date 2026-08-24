import createClient from "openapi-fetch";

// Base URL of the API gateway (ARCH-006) -- clients never talk to a
// service directly, only through the gateway.
export const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ??
  process.env.EXPO_PUBLIC_GATEWAY_URL ??
  "http://localhost:8080";

/**
 * Creates a typed client for one service's API, given the generated
 * paths type produced by `pnpm generate` (see scripts/generate.mjs) from
 * that service's openapi.yaml. Usage once a service has generated types:
 *
 *   import type { paths } from "./generated/voting-service";
 *   export const votingClient = makeClient<paths>("/voting");
 */
export function makeClient<Paths extends object>(basePath: string) {
  return createClient<Paths>({ baseUrl: `${GATEWAY_URL}${basePath}` });
}
