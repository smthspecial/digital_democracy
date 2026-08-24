// Generates a TypeScript type module (src/generated/<service>.d.ts) from
// every service's openapi.yaml, via openapi-typescript. Run with
// `pnpm --filter @dd/api-client generate` after editing any service's
// openapi.yaml. Generated files are not committed -- see .gitignore.
import { readdirSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const serviceDirs = [
  ...readdirSync(path.join(root, "services/ts")).map((name) => ["ts", name]),
  ...readdirSync(path.join(root, "services/go")).map((name) => ["go", name]),
];

const outDir = path.join(root, "packages/api-client/src/generated");
mkdirSync(outDir, { recursive: true });

for (const [lang, name] of serviceDirs) {
  const specPath = path.join(root, "services", lang, name, "openapi.yaml");
  const outPath = path.join(outDir, `${name}.d.ts`);
  console.log(`Generating types for ${name} from ${specPath}`);
  execSync(`pnpm exec openapi-typescript ${specPath} -o ${outPath}`, {
    stdio: "inherit",
  });
}
