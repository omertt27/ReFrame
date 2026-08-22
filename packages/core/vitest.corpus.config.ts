import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/corpus.test.ts"],
  },
});
