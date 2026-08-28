import { buildServer } from "./server.js";
import { config } from "./config.js";
import { createHttpSessionRevoker } from "./collaborators.js";

const app = buildServer(
  config.authServiceUrl
    ? { sessionRevoker: createHttpSessionRevoker(config.authServiceUrl) }
    : {},
);

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
