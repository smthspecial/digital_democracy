import { createHash, createHmac, randomBytes } from "node:crypto";

export function testVerifierHeaders(path: string, body: unknown, timestamp = Math.floor(Date.now() / 1000).toString()) {
  const nonce = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const signature = createHmac("sha256", "test-verifier-secret").update(`identity-verifier\nPOST\n${path}\n${timestamp}\n${nonce}\n${hash}`).digest("hex");
  return { "x-dd-service": "identity-verifier", "x-dd-timestamp": timestamp, "x-dd-signature": signature, "x-dd-nonce": nonce };
}

export function testInternalHeaders(path: string, method="GET", body="") {
 const timestamp = Math.floor(Date.now()/1000).toString(), nonce=randomBytes(16).toString("hex");
 const hash=createHash("sha256").update(body).digest("hex");
 const signature=createHmac("sha256","test-internal-secret").update(`api-go\n${method}\n${path}\n${timestamp}\n${nonce}\n${hash}`).digest("hex");
 return {"x-dd-service":"api-go","x-dd-timestamp":timestamp,"x-dd-nonce":nonce,"x-dd-signature":signature};
}
