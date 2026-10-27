-- Move any bookings on duplicate sessions onto the canonical (lowest-id) session
WITH canonical AS (
    SELECT title, date, start_time, MIN(id) AS keep_id
    FROM sessions
    GROUP BY title, date, start_time
)
UPDATE entries e
SET session_id = c.keep_id
FROM sessions s
JOIN canonical c ON s.title = c.title AND s.date = c.date AND s.start_time = c.start_time
WHERE e.session_id = s.id AND s.id <> c.keep_id
  AND NOT EXISTS (
      -- avoid violating the (session_id, name) uniqueness if the same
      -- swimmer somehow got booked into two duplicate sessions
      SELECT 1 FROM entries e2 WHERE e2.session_id = c.keep_id AND e2.name = e.name
  );

-- Delete now-orphaned duplicate entries that couldn't be merged (rare)
DELETE FROM entries e
USING sessions s
WHERE e.session_id = s.id
  AND s.id NOT IN (SELECT MIN(id) FROM sessions GROUP BY title, date, start_time);

-- Now safe to remove the duplicate session rows
DELETE FROM sessions s
WHERE s.id NOT IN (SELECT MIN(id) FROM sessions GROUP BY title, date, start_time);

-- Prevent this from ever happening again
ALTER TABLE sessions ADD CONSTRAINT sessions_unique_slot UNIQUE (title, date, start_time);
