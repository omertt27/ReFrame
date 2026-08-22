import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // corpus.test.ts runs against real, larger third-party fixtures and is
    // opt-in via `pnpm test:corpus` -- excluded here so the default `test`
    // (run on every save) stays fast.
    include: ["test/**/*.test.ts"],
    // corpus.test.ts is opt-in via `pnpm test:corpus` (excluded here so the
    // default `test`, run on every save, stays fast); the corpus fixtures
    // themselves include real *.test.ts files vendored from their source
    // repos (e.g. excalidraw's own unit tests) which aren't meant to run
    // under this project's vitest setup at all.
    exclude: ["test/corpus.test.ts", "test/fixtures/corpus/**", "**/node_modules/**"],
  },
});
