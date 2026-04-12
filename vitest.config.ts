import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["config/**/*.ts", "core/**/*.ts", "resilience/**/*.ts", "db/**/*.ts", "output/**/*.ts"],
      exclude: ["node_modules", "dist", "tests"],
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
