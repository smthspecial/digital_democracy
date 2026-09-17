import type { NextFunction, Request, Response } from "express";
import { httpRequestDuration, httpRequestsTotal } from "./metrics.js";

// Labels by the first path segment only (e.g. "/proposal" for
// "/proposal/proposals/:id/budget") -- bounded cardinality without needing
// Nest's matched route pattern, which isn't available this early in the
// Express middleware chain. Mirrors apps/api-go's per-prefix Middleware.
function routeLabel(path: string): string {
  const first = path.split("/").filter(Boolean)[0];
  return first ? `/${first}` : "/";
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const route = routeLabel(req.path);
  res.on("finish", () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe({ route }, seconds);
    httpRequestsTotal.inc({ route, method: req.method, status: String(res.statusCode) });
  });
  next();
}
