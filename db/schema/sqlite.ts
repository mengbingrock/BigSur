import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Local/desktop user store. The running server uses a zero-native-dep
 *  adapter over bun:sqlite / node:sqlite against this same shape; drizzle-kit
 *  uses this definition to generate migrations. */
export const users = sqliteTable("users", {
  email: text("email").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export type SqliteUser = typeof users.$inferSelect;
