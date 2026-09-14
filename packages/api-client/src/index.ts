// @dd/api-client — typed API client shared by web + mobile (ADR-021).
// Placeholder: real clients are generated from each app's openapi documents
// (`pnpm --filter @dd/api-client generate`) once service implementations land.
// Anything importing this package today gets the tiny fetch helper below.

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
