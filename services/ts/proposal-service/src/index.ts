import { connectEventBus, ensureStream } from "@dd/event-bus";
import { buildServer } from "./server.js";
import { config } from "./config.js";
import {
  AUDIT_APPEND_STREAM,
  AUDIT_APPEND_SUBJECT,
  createHttpAuditEmitter,
  createHttpConstitutionalReviewer,
  createHttpJurisdictionClient,
  createHttpProblemStatusNotifier,
  createNatsAuditEmitter,
} from "./integrations.js";

// natsUrl takes priority over auditServiceUrl for AuditEmitter specifically
// (ADR-023) -- see config.ts's comment on natsUrl for why.
let natsAuditEmitterOverride = {};
if (config.natsUrl) {
  const bus = await connectEventBus(config.natsUrl);
  await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });
  natsAuditEmitterOverride = { auditEmitter: createNatsAuditEmitter(bus) };
}

const app = buildServer({
  ...(config.auditServiceUrl
    ? {
        auditEmitter: createHttpAuditEmitter(config.auditServiceUrl),
        constitutionalReviewer: createHttpConstitutionalReviewer(
          config.auditServiceUrl,
        ),
      }
    : {}),
  ...(config.jurisdictionServiceUrl
    ? { jurisdictionClient: createHttpJurisdictionClient(config.jurisdictionServiceUrl) }
    : {}),
  ...(config.problemServiceUrl
    ? { problemStatusNotifier: createHttpProblemStatusNotifier(config.problemServiceUrl) }
    : {}),
  ...natsAuditEmitterOverride,
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
