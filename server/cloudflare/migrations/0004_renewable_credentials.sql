ALTER TABLE probe_credentials ADD COLUMN renew_until INTEGER;
UPDATE probe_credentials
SET renew_until = expires_at + 89 * 24 * 60 * 60
WHERE renew_until IS NULL;
