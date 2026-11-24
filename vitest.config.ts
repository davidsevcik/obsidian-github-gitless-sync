import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Obsidian ships only types, the tests use the same mocks as the benchmark
      obsidian: path.resolve(__dirname, "mock-obsidian.ts"),
      src: path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
