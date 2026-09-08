// @dd/api-ts — single TypeScript app for the 13 I/O-bound services (ADR-027).
// SHELL: routing skeleton only. Every service prefix answers 501 with its
// spec id until the real service implementation lands as follow-up work.
// Zero dependencies by design (node:http only) so the shell never breaks
// the workspace install.
import http from "node:http";

export const SERVICE_PREFIXES = {
  "/identity": "SRV-001",
  "/jurisdiction": "SRV-002",
  "/problems": "SRV-003",
  "/proposals": "SRV-004",
  "/competency": "SRV-005",
  "/deliberation": "SRV-006",
  "/budget": "SRV-007",
  "/civic-duty": "SRV-009",
  "/governance-roles": "SRV-011",
  "/projects": "SRV-013",
  "/reputation": "SRV-014",
  "/notifications": "SRV-015",
  "/ai-synthesis": "SRV-016",
};

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createServer() {
  return http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && path === "/readyz") {
      return send(res, 200, { status: "ready" });
    }
    const prefix = Object.keys(SERVICE_PREFIXES).find((p) => path === p || path.startsWith(p + "/"));
    if (prefix) {
      return send(res, 501, {
        error: { code: "not_implemented", message: `${prefix} is not implemented yet` },
        service: prefix,
        spec: SERVICE_PREFIXES[prefix],
      });
    }
    return send(res, 404, { error: { code: "not_found", message: "unknown route" } });
  });
}

const port = Number(process.env.PORT ?? 4000);
const server = createServer();
if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(JSON.stringify({ msg: "starting api-ts (shell)", port }));
  });
  // Fast container shutdown: stop accepting, drain, exit (no 10s SIGKILL wait).
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
