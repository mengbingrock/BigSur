import { Schema } from "effect";

/** Public-facing user record. The password hash never crosses the wire. */
export const User = Schema.Struct({
  email: Schema.String,
  isAdmin: Schema.Boolean,
  createdAt: Schema.optional(Schema.String),
});
export type User = typeof User.Type;

/** Session payload sealed into the auth cookie. */
export const Session = Schema.Struct({
  email: Schema.String,
  isAdmin: Schema.Boolean,
});
export type Session = typeof Session.Type;

export const Credentials = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
});
export type Credentials = typeof Credentials.Type;

export const AuthResult = Schema.Struct({
  ok: Schema.Boolean,
  email: Schema.String,
  isAdmin: Schema.Boolean,
});
export type AuthResult = typeof AuthResult.Type;
