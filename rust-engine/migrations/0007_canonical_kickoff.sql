-- Canonical timezone-aware kickoff storage. Raw provider values remain untouched.
-- Backfill uses explicit epoch/offset-bearing values only; timezone-less strings are
-- intentionally not interpreted or assigned a guessed timezone.
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS kickoff_at TIMESTAMPTZ;

UPDATE fixtures
SET kickoff_at = CASE
  WHEN payload ? 'fixtureDateInMilliseconds'
       AND (payload->>'fixtureDateInMilliseconds') ~ '^[0-9]{13}$'
    THEN to_timestamp((payload->>'fixtureDateInMilliseconds')::numeric / 1000)
  WHEN kickoff_raw ~ '^[0-9]{13}$'
    THEN to_timestamp(kickoff_raw::numeric / 1000)
  WHEN kickoff_raw ~ '^[0-9]{10}$'
    THEN to_timestamp(kickoff_raw::numeric)
  WHEN kickoff_raw ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(Z|[+-][0-9]{2}:?[0-9]{2})$'
    THEN kickoff_raw::timestamptz
  ELSE NULL
END
WHERE kickoff_at IS NULL;

CREATE INDEX IF NOT EXISTS fixtures_kickoff_at_idx ON fixtures(kickoff_at) WHERE kickoff_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS fixtures_upcoming_idx ON fixtures(result_state,kickoff_at) WHERE kickoff_at IS NOT NULL;
