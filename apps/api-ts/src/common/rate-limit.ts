import type { NextFunction, Request, Response } from "express";

// A process-local backstop keyed by the actual socket peer. Do not enable
// Express trust-proxy without a separate trusted-proxy allow-list at deployment.
export function createRateLimitMiddleware() {
  const peers = new Map<string, { count: number; expires: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    for (const [key, value] of peers) if (value.expires <= now) peers.delete(key);
    const key = req.socket.remoteAddress ?? "unknown";
    const window = peers.get(key) ?? { count: 0, expires: now + 60000 };
    if (window.count >= 120 || !peers.has(key) && peers.size >= 10000) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: { code: "rate_limited", message: "Too many requests" } });
      return;
    }
    window.count++;
    peers.set(key, window);
    next();
  };
}
