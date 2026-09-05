/**
 * Shared test helper: real D1 (miniflare/workerd) with the committed
 * migrations applied. Used by API + queue integration-style tests.
 */
import { Miniflare } from "miniflare";
import type { Env } from "../../worker/env";

export const migrationFiles = import.meta.glob("../../db/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const LOCAL_ORIGIN = "http://localhost:5173";

export interface TestD1 {
  mf: Miniflare;
  d1: D1Database;
  env: Env;
}

export async function createTestDb(overrides: Partial<Env> = {}): Promise<TestD1> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null); } }",
    d1Databases: { DB: "appdb" },
  });
  const d1 = (await mf.getD1Database("DB")) as D1Database;

  const paths = Object.keys(migrationFiles).sort();
  for (const path of paths) {
    for (const statement of migrationFiles[path].split("--> statement-breakpoint")) {
      // D1 exec() splits input on newlines, so each statement must be a
      // single line: drop comment lines and collapse whitespace.
      const lines = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length === 0) continue;
      await d1.exec(lines.join(" "));
    }
  }

  const env = {
    DB: d1,
    APP_ACCESS_MODE: "local",
    APP_ORIGIN: LOCAL_ORIGIN,
    ...overrides,
  } as Env;

  return { mf, d1, env };
}

export async function disposeTestDb(mf: Miniflare): Promise<void> {
  await mf?.dispose();
}

export { Miniflare };
