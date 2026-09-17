// @dd/api-client — typed API client shared by web + mobile (ADR-021).
// CC-08: this is a hand-written fetch helper, not a generated client, and
// there is currently no `generate` script -- the pre-pivot generator
// (scripts/generate.mjs) was deleted in commit 33848ae and codegen against
// apps/api-ts isn't viable yet regardless: per tp-001 §0.2, most of its
// services' openapi.yaml files document only /healthz+/readyz (or don't
// exist at all, e.g. iam) rather than their real routes. Generating a
// client from apps/api-go/openapi/*.yaml (which IS accurate) is real,
// scoped future work -- not promised by this file until it exists.

export interface ApiError {
  code: string;
  message: string;
}

export async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T | { error: ApiError };
  if (!res.ok) {
    throw new Error((body as { error: ApiError }).error?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}
