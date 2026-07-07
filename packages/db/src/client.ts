// Drizzle client over the postgres.js driver. Works identically against Supabase
// (cloud) and a plain Postgres container (self-hosted) — same schema, same code.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  // prepare:false is the safe default for Supabase's transaction pooler (pgBouncer).
  const client = postgres(databaseUrl, { prepare: false });
  return drizzle(client, { schema });
}
