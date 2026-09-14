import base from "@dd/eslint-config";
import tseslint from "typescript-eslint";

// The shared base (@dd/eslint-config) declares only ignores, no TS parser/plugin -- without an explicit `files`
// glob and parser, eslint's flat config silently skips every .ts file ("File ignored because no matching
// configuration was supplied"), so `pnpm lint` was a no-op. Non-type-checked recommended rules only (no
// `parserOptions.project`) so spec files stay lintable even though tsconfig.json excludes them from the `tsc`
// program.
export default [
  ...base,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
  },
];
