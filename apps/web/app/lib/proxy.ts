import { createHash } from "node:crypto";

// Only public routes. The web process never has service signing credentials.
const publicRoutes = [
  /^POST \/auth\/passkeys\/(registration|login)\/(begin|finish)$/,
  /^GET \/auth\/(validate|events)$/,
  /^POST \/auth\/(refresh|logout)$/,
  /^POST \/identity\/citizens$/,
  /^GET \/identity\/citizens\/[\w-]+$/,
  /^GET \/jurisdiction\/jurisdictions$/,
  /^POST \/jurisdiction\/(residencies|memberships)$/,
  /^GET \/jurisdiction\/residencies(?:\/pending)?$/,
  /^POST \/jurisdiction\/residencies\/[\w-]+\/review$/,
  /^POST \/proposal\/proposals\/[\w-]+\/scope$/,
  /^(GET|POST) \/problem\/problems(?:\/[\w-]+(?:\/(support|evidence|comments))?)?$/,
  /^(GET|POST) \/proposal\/proposals(?:\/[\w-]+(?:\/(constraints|budget|advance|details))?)?$/,
  /^GET \/journey\/proposals\/[\w-]+$/,
  /^GET \/voting\/sessions(?:\/[\w-]+)?$/,
  /^GET \/voting\/ballots\/verify$/,
  /^POST \/voting\/ballots$/,
  /^GET \/projects(?:\/[\w-]+(?:\/(milestones|evaluations))?)?$/,
];

export async function proxy(
  request: Request,
  segments: string[],
  auth = false,
): Promise<Response> {
  if (segments.some((part) => !/^[\w-]+$/.test(part)))
    return new Response(null, { status: 404 });
  const path = `/${auth ? "auth/" : ""}${segments.join("/")}`;
  if (
    !publicRoutes.some((pattern) => pattern.test(`${request.method} ${path}`))
  ) {
    return Response.json({ message: "Route unavailable" }, { status: 404 });
  }
  if (
    request.method !== "GET" &&
    request.headers.get("origin") !== new URL(request.url).origin
  ) {
    return Response.json(
      { message: "Same-origin request required" },
      { status: 403 },
    );
  }
  const base =
    auth || path.startsWith("/voting/")
      ? (process.env.API_GO_URL ?? "http://127.0.0.1:5000")
      : (process.env.API_TS_URL ?? "http://127.0.0.1:4000");
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of ["authorization", "cookie"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const fingerprint = createHash("sha256")
    .update(request.headers.get("user-agent") ?? "browser")
    .digest("hex");
  headers.set("x-device-fingerprint", fingerprint);
  let body: string | undefined;
  if (request.method !== "GET") {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 64 * 1024) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(part.value);
      }
    }
    body = Buffer.concat(chunks).toString("utf8");
    if (path === "/auth/passkeys/login/begin") {
      try {
        body = JSON.stringify({
          ...JSON.parse(body),
          device_fingerprint: fingerprint,
          ip_subnet: "",
        });
      } catch {
        return Response.json({ message: "Invalid JSON" }, { status: 400 });
      }
    }
  }
  try {
    const upstream = await fetch(
      `${base}${path}${new URL(request.url).search}`,
      {
        method: request.method,
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const outgoing = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    for (const cookie of upstream.headers.getSetCookie())
      outgoing.append("set-cookie", cookie);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outgoing,
    });
  } catch {
    return Response.json(
      { message: "Service unavailable. Please try again." },
      { status: 503 },
    );
  }
}
