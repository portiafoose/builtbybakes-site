-- Migration 0002: guarantee admin_users row is seeded correctly with UPSERT (not DO NOTHING)
-- + also ensure pgcrypto is enabled (idempotent) so digest() in verify_admin_login RPC works.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Force-reset the portia user password hash using the exact same expression
-- that verify_admin_login() computes, so the two sides definitely agree.
INSERT INTO public.admin_users (username, password_hash, display_name, created_at)
VALUES (
  'portia',
  encode(digest('portia||beRICH$$||bbb-admin-salt-v1', 'sha256'), 'hex'),
  'Portia',
  NOW()
)
ON CONFLICT (username) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  display_name  = EXCLUDED.display_name;
