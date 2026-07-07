import { config as loadDotenv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Loads DATABASE_URL from the repo-root .env so `pnpm --filter @oxyqa/db db:push` works.
loadDotenv({ path: "../../.env" });

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
