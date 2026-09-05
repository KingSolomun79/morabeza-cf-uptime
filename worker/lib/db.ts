/**
 * Drizzle instance helpers for D1 (PRD §29.8: prepared statements / ORM
 * parameter binding only — all access goes through Drizzle).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import type { Env } from "../env";

export type AppDatabase = DrizzleD1Database<typeof schema>;

export function getDb(env: Env): AppDatabase {
  return drizzle(env.DB, { schema });
}
