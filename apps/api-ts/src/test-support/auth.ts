import type { INestApplication } from "@nestjs/common";
import { createAuthContextMiddleware } from "../common/auth-context.js";

const TEST_TOKEN_PREFIX = "test-citizen";

export function testBearer(citizenId: string, assuranceTier = "T3"): string {
  return `Bearer ${TEST_TOKEN_PREFIX}:${citizenId}:${assuranceTier}`;
}

export function installTestAuth(app: INestApplication): void {
  app.use(
    createAuthContextMiddleware(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      const match = authorization?.match(/^Bearer test-citizen:([^:]+):(T[123])$/);
      if (!match) {
        return new Response(null, { status: 401 });
      }
      return new Response(
        JSON.stringify({ citizen_id: match[1], session_id: `test-session:${match[1]}`, assurance_tier: match[2] }),
        { status: 200 },
      );
    }, "http://test-auth"),
  );
}
