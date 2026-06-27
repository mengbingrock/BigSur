CREATE TABLE "users" (
	"email" text PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"google_id" text
);
