-- schema.sql
-- Run with: psql -U <user> -d swimming_pool -f schema.sql

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password      VARCHAR(255) NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    full_name     VARCHAR(255),
    phone         VARCHAR(20),
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id            SERIAL PRIMARY KEY,
    title         VARCHAR(255) NOT NULL,
    date          DATE NOT NULL,
    start_time    TIME NOT NULL,
    end_time      TIME NOT NULL,
    capacity      INTEGER NOT NULL CHECK (capacity > 0),
    CONSTRAINT valid_time_range CHECK (end_time > start_time),
    CONSTRAINT sessions_unique_slot UNIQUE (title, date, start_time)
);

CREATE TABLE IF NOT EXISTS swimmers (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    age           INTEGER NOT NULL CHECK (age > 0 AND age < 130),
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_swimmers_user_id ON swimmers(user_id);

CREATE TABLE IF NOT EXISTS achievements (
    id            SERIAL PRIMARY KEY,
    swimmer_id    INTEGER NOT NULL REFERENCES swimmers(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         VARCHAR(255) NOT NULL,
    description   TEXT,
    file_path     VARCHAR(500) NOT NULL,
    file_type     VARCHAR(20) NOT NULL CHECK (file_type IN ('image', 'pdf')),
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_achievements_swimmer_id ON achievements(swimmer_id);

CREATE TABLE IF NOT EXISTS entries (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    age           INTEGER NOT NULL CHECK (age > 0 AND age < 130),
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    swimmer_id    INTEGER REFERENCES swimmers(id) ON DELETE SET NULL,
    entry_time    TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, name)
);

-- Lets an admin/parent mark a booking as "can't attend" and immediately issue a
-- make-up credit to that swimmer, which can later be redeemed against any future
-- booking instead of just losing the spot outright.
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

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    VARCHAR(255) NOT NULL UNIQUE,
    expires_at    TIMESTAMP NOT NULL,
    used          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_entries_session_id ON entries(session_id);
CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id);
CREATE INDEX IF NOT EXISTS idx_entries_swimmer_id ON entries(swimmer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);

-- Seed a few upcoming sessions so /sessions and /profile aren't empty on first run.
INSERT INTO sessions (title, date, start_time, end_time, capacity)
VALUES
    ('Morning Lap Swim',  CURRENT_DATE + INTERVAL '2 day', '07:00', '08:00', 20),
    ('Beginner Lessons',  CURRENT_DATE + INTERVAL '3 day', '10:00', '11:00', 10),
    ('Evening Lap Swim',  CURRENT_DATE + INTERVAL '4 day', '18:00', '19:30', 25)
ON CONFLICT ON CONSTRAINT sessions_unique_slot DO NOTHING;

-- NOTE: no admin user is seeded here on purpose (a hardcoded password hash in a
-- shared schema file is itself a security smell). Create your admin account by
-- signing up normally, then promote it:
--   UPDATE users SET role = 'admin' WHERE username = 'your_username';
