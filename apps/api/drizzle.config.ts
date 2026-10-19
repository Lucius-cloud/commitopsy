import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
   url: process.env.DATABASE_URL
  ?? "postgres://commitopsy_dev:commitopsy_dev_local_only@127.0.0.1:5433/commitopsy_dev"
  },
  strict: true,
  verbose: true
});
