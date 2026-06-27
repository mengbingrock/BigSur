import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Server-deployment (Postgres) user store — mirrors the SQLite schema. */
export const users = pgTable("users", {
  email: text("email").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Google OAuth subject (`sub`) when the account was created/linked via Google;
  // null for password-only accounts. Accounts are linked by email.
  googleId: text("google_id"),
});

export type PostgresUser = typeof users.$inferSelect;
