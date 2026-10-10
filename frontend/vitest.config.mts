import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@exercises": path.resolve(__dirname, "../exercises"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
