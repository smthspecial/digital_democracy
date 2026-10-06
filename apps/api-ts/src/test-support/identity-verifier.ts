import { createHash, createHmac } from "node:crypto";

export function testVerifierHeaders(path: string, body: unknown, timestamp = Math.floor(Date.now() / 1000).toString()) {
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const signature = createHmac("sha256", "test-verifier-secret").update(`POST\n${path}\n${timestamp}\n${hash}`).digest("hex");
  return { "x-dd-service": "identity-verifier", "x-dd-timestamp": timestamp, "x-dd-signature": signature };
}
