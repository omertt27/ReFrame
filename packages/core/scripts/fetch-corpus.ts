#!/usr/bin/env node
/**
 * Populates test/fixtures/corpus/<name>/ from the pinned upstream commits in
 * test/corpus.manifest.json -- one shallow `git fetch` of a specific SHA per
 * repo, then a filtered copy of only .ts/.tsx files out of the configured
 * subdir. Nothing here gets committed to this repo (test/fixtures/corpus is
 * gitignored): this script is what makes `pnpm test:corpus` reproducible on
 * a fresh clone without vendoring third-party source into our git history.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = join(__dirname, "../test/fixtures/corpus");
const MANIFEST_PATH = join(__dirname, "../test/corpus.manifest.json");

interface CorpusEntry {
  name: string;
  repo: string;
  commit: string;
  subdir: string;
}

function copyFiltered(srcDir: string, destDir: string) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    if (entry.isDirectory()) {
      copyFiltered(srcPath, join(destDir, entry.name));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      mkdirSync(destDir, { recursive: true });
      cpSync(srcPath, join(destDir, entry.name));
    }
  }
}

function fetchOne(entry: CorpusEntry) {
  console.log(`[corpus] fetching ${entry.name} @ ${entry.commit.slice(0, 12)} ...`);
  const clone = mkdtempSync(join(tmpdir(), "reframe-corpus-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: clone });
    execFileSync("git", ["remote", "add", "origin", entry.repo], { cwd: clone });
    execFileSync("git", ["fetch", "--quiet", "--depth", "1", "origin", entry.commit], { cwd: clone });
    execFileSync("git", ["checkout", "--quiet", "FETCH_HEAD"], { cwd: clone });

    const subdirPath = join(clone, entry.subdir);
    if (!statSync(subdirPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`"${entry.subdir}" not found in ${entry.repo}@${entry.commit}`);
    }

    const destDir = join(CORPUS_ROOT, entry.name);
    rmSync(destDir, { recursive: true, force: true });
    copyFiltered(subdirPath, destDir);

    const fileCount = countFiles(destDir);
    console.log(`[corpus] ${entry.name}: ${fileCount} files -> test/fixtures/corpus/${entry.name}/`);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
    else count++;
  }
  return count;
}

function main() {
  const manifest: CorpusEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const only = process.argv[2];
  const entries = only ? manifest.filter((e) => e.name === only) : manifest;
  if (only && entries.length === 0) {
    console.error(`No corpus entry named "${only}" in corpus.manifest.json`);
    process.exit(1);
  }
  for (const entry of entries) fetchOne(entry);
}

main();
