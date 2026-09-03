import { connectEventBus, ensureStream } from "@dd/event-bus";
import { buildServer } from "./server.js";
import { config } from "./config.js";
import { AUDIT_APPEND_STREAM, AUDIT_APPEND_SUBJECT, createNatsAuditEmitter } from "./collaborators.js";

let natsAuditOverride = {};
if (config.natsUrl) {
  const bus = await connectEventBus(config.natsUrl);
  await ensureStream(bus, { name: AUDIT_APPEND_STREAM, subjects: [AUDIT_APPEND_SUBJECT] });
  natsAuditOverride = { audit: createNatsAuditEmitter(bus) };
}

const app = buildServer(natsAuditOverride);

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
