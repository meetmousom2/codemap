import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { scan } from "../src/scanner";
import { resolve, join } from "node:path";
import { symlink, unlink, mkdir } from "node:fs/promises";

const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/sample-project");

describe("scanner", () => {
  test("finds .ts and .tsx files", async () => {
    const files = await scan(FIXTURE_ROOT);
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/utils.ts");
    expect(files).toContain("src/component.tsx");
  });

  test("skips node_modules and dist (with real files present)", async () => {
    const files = await scan(FIXTURE_ROOT);
    // node_modules/dep/index.ts and dist/output.ts exist but should be skipped
    const hasNodeModules = files.some((f) => f.includes("node_modules"));
    const hasDist = files.some((f) => f.includes("dist"));
    expect(hasNodeModules).toBe(false);
    expect(hasDist).toBe(false);
  });

  test("respects .gitignore patterns (*.generated.ts exists but is filtered)", async () => {
    const files = await scan(FIXTURE_ROOT);
    // src/types.generated.ts exists in the fixture but .gitignore has *.generated.ts
    const hasGenerated = files.some((f) => f.includes(".generated."));
    expect(hasGenerated).toBe(false);
  });

  test("returns sorted results", async () => {
    const files = await scan(FIXTURE_ROOT);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  test("supports exclude patterns", async () => {
    const files = await scan(FIXTURE_ROOT, { exclude: ["**/*.tsx"] });
    expect(files).not.toContain("src/component.tsx");
    expect(files).toContain("src/index.ts");
  });

  test("supports include patterns", async () => {
    const files = await scan(FIXTURE_ROOT, { include: ["src/index.ts"] });
    expect(files).toEqual(["src/index.ts"]);
  });

  test("handles empty directories", async () => {
    // empty/ dir exists in fixture — should not cause errors
    const files = await scan(FIXTURE_ROOT);
    expect(Array.isArray(files)).toBe(true);
  });

  describe("symlinks", () => {
    const symlinkPath = join(FIXTURE_ROOT, "src", "linked.ts");

    beforeAll(async () => {
      // Create a symlink pointing to utils.ts
      try { await unlink(symlinkPath); } catch {}
      await symlink(join(FIXTURE_ROOT, "src", "utils.ts"), symlinkPath);
    });

    afterAll(async () => {
      try { await unlink(symlinkPath); } catch {}
    });

    test("skips symlinks by default", async () => {
      const files = await scan(FIXTURE_ROOT);
      expect(files).not.toContain("src/linked.ts");
    });

    test("follows symlinks when followSymlinks is true", async () => {
      const files = await scan(FIXTURE_ROOT, { followSymlinks: true });
      expect(files).toContain("src/linked.ts");
    });
  });
});
