// Shared flat ESLint config for every TypeScript package in the monorepo.
// Service/app-level eslint.config.js files extend this and add
// framework-specific plugins (next, react-native) on top.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node globals cover CommonJS config files (babel.config.js, etc.);
    // browser globals cover apps/web and apps/mobile UI code. Allowing
    // both everywhere is simpler than splitting configs per file type
    // and no-undef only ever permits a reference, never requires one.
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.es2021 },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["dist/**", ".next/**", ".expo/**", "node_modules/**"],
  },
);
