import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Thresholds set to the current observed baseline (as of cycle-2 polish
      // audit: 86% statements, 81% branches, 93% functions) — rounded DOWN
      // slightly so the gate is a floor, not a ceiling. Intent: catch a
      // regression that removes test coverage, NOT force uncovered paths to
      // be trivially tested. Adjust upward only when a feature ships with
      // meaningfully higher real coverage. `src/index.ts` is excluded because
      // it is the CLI entry and is exercised end-to-end by orchestrator tests
      // rather than unit-level assertions.
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 90,
        lines: 85,
      },
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "scripts/**",
        "dist/**",
        "**/*.config.*",
        "**/*.test.ts",
      ],
    },
  },
});
