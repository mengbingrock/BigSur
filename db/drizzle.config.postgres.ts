import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema/postgres.ts",
  out: "./db/postgres/migrations",
  dbCredentials: {
    url: process.env.LABEE_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/labee",
  },
});
