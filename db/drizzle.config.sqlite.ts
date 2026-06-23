import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema/sqlite.ts",
  out: "./db/sqlite/migrations",
  dbCredentials: {
    url: process.env.LABEE_DB_PATH ?? "./data/labee.sqlite",
  },
});
