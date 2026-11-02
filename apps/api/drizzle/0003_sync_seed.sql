-- Hand-written: this server's identity. Apps tag their local copy with it, so
-- pointing an app at a different (or rebuilt) server is noticed.
INSERT INTO "app"."server_info" ("id") VALUES (1) ON CONFLICT DO NOTHING;
