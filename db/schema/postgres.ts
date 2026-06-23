import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Server-deployment (Postgres) user store — mirrors the SQLite schema. */
export const users = pgTable("users", {
  email: text("email").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PostgresUser = typeof users.$inferSelect;
