-- Migration 0002: ensure pgcrypto extension is enabled (idempotent) so that
-- digest() / gen_salt() are available for any Supabase-side password hashing
-- logic if the DB login path is used later.
--
-- IMPORTANT: We no longer seed admin_users here. BuiltByBakes admin
-- authentication is handled via Netlify environment variables
-- (BBB_ADMIN_USERNAME / BBB_ADMIN_PASSWORD) read by netlify/functions/admin-gateway.ts
-- — never commit real passwords, hashes, or seed creds into source control;
-- Netlify/GitHub secret scanners will fail the deploy.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
