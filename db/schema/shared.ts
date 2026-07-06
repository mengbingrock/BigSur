// Constants shared across the SQLite (local/desktop) and Postgres (server
// deployment) schemas. Keep both dialect schemas structurally in sync.

/** Columns of the users table, documented once. */
export interface UserRow {
  email: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: string;
}
