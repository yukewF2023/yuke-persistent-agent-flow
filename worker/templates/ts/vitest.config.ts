import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["out/**/*.test.ts"], testTimeout: 20_000 } });
