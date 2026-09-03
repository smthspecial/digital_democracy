import { connectEventBus, ensureStream } from "@dd/event-bus";
import { buildServer } from "./server.js";
import { config } from "./config.js";
import {
  AUDIT_APPEND_STREAM,
  AUDIT_APPEND_SUBJECT,
  createHttpApprovalGate,
  createNatsAuditEmitter,
} from "./services/interfaces.js";

let natsAuditOverride = {};
if (config.natsUrl) {
  const bus = await connectEventBus(config.natsUrl);
  await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });
  natsAuditOverride = { auditEmitter: createNatsAuditEmitter(bus) };
}

const app = buildServer({
  ...(config.governanceRoleServiceUrl
    ? { approvalGate: createHttpApprovalGate(config.governanceRoleServiceUrl) }
    : {}),
  ...natsAuditOverride,
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
