import { defineConfig } from "vitest/config";

// Used only by `npm run eval`: the golden-set evaluation, which calls the real
// model. The normal `npm test` never runs these files.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    // One question at a time, so the AI quota and the in-memory store stay simple.
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
