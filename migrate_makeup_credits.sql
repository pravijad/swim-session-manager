-- Adds the "make-up credit" feature to a database that was created before it existed.
-- Safe to run more than once. Run with:
--   psql -d swimming_pool -f migrate_makeup_credits.sql

ALTER TABLE entries ADD COLUMN IF NOT EXISTS swimmer_id INTEGER REFERENCES swimmers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_entries_swimmer_id ON entries(swimmer_id);

CREATE TABLE IF NOT EXISTS makeup_credits (
    id                SERIAL PRIMARY KEY,
    swimmer_id        INTEGER NOT NULL REFERENCES swimmers(id) ON DELETE CASCADE,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_title      VARCHAR(255) NOT NULL,
    source_date       DATE NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'used')),
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    used_at           TIMESTAMP,
    used_session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_makeup_credits_swimmer_id ON makeup_credits(swimmer_id);
CREATE INDEX IF NOT EXISTS idx_makeup_credits_user_id ON makeup_credits(user_id);

-- Note: bookings made before this migration have swimmer_id = NULL (we have no
-- reliable way to match old name/age snapshots back to a specific swimmer row).
-- Marking one of those old bookings "can't attend" will still cancel it, it just
-- won't be able to issue a make-up credit since we don't know which swimmer to credit.
