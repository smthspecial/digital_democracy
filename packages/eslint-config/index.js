// Shared flat ESLint config (minimal base; per-app files extend it).
// Full rule set is follow-up work alongside the first lint pass.
export default [
  {
    ignores: ["node_modules/**", "dist/**", ".next/**", ".expo/**"],
  },
];
