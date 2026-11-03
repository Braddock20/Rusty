-- Additive reliability migration. Existing collection history and observations are preserved.
ALTER TABLE collection_lock ADD COLUMN IF NOT EXISTS owner_token TEXT;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS source_health_cooldown_idx ON source_health(source, cooldown_until);
