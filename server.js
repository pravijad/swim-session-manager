// server.js
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('./db');
const { sendMail } = require('./mailer');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// =========================
// Setup
// =========================
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// =========================
// File uploads (achievement photos / certificates)
// =========================
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'achievements');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_UPLOAD_TYPES = {
    'image/jpeg': { ext: '.jpg', kind: 'image' },
    'image/png': { ext: '.png', kind: 'image' },
    'image/webp': { ext: '.webp', kind: 'image' },
    'application/pdf': { ext: '.pdf', kind: 'pdf' }
};

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => {
            // Never trust the client's filename — generate our own to avoid
            // path traversal / overwrite issues, keeping only a safe extension.
            const meta = ALLOWED_UPLOAD_TYPES[file.mimetype];
            const ext = meta ? meta.ext : '';
            cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (ALLOWED_UPLOAD_TYPES[file.mimetype]) return cb(null, true);
        cb(new Error('Only JPG, PNG, WEBP, or PDF files are allowed'));
    }
});

if (!process.env.SESSION_SECRET) {
    console.error('SESSION_SECRET is not set. Copy .env.example to .env and set a strong secret before running in production.');
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: isProd,       // requires HTTPS in production
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 4 // 4 hours
    }
}));

// Test DB connection
pool.query('SELECT NOW()', (err) => {
    if (err) console.error('DB ERROR:', err.message);
    else console.log('DB Connected');
});

// =========================
// CSRF protection (simple synchronizer token pattern)
// =========================
app.use((req, res, next) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.username = req.session.user ? req.session.user.username : null;
    res.locals.role = req.session.role || null;
    next();
});

function verifyCsrf(req, res, next) {
    const token = req.body._csrf;
    if (!token || token !== req.session.csrfToken) {
        return res.status(403).send('Invalid or missing CSRF token. Please go back and try again.');
    }
    next();
}

// =========================
// Rate limiting for auth routes
// =========================
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many attempts. Please try again in a few minutes.'
});

// =========================
// Auth middleware
// =========================
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

function isAdmin(req, res, next) {
    if (req.session.role === 'admin') return next();
    res.status(403).send('Access Denied');
}

function isUser(req, res, next) {
    if (req.session.role === 'user') return next();
    res.status(403).send('Access Denied');
}

// =========================
// Validation helpers
// =========================
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidAge(age) {
    const n = Number(age);
    return Number.isInteger(n) && n > 0 && n < 130;
}

function isValidCapacity(capacity) {
    const n = Number(capacity);
    return Number.isInteger(n) && n > 0 && n <= 1000;
}

// HH:MM (24h) as produced by <input type="time">.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function isValidTime(t) {
    return typeof t === 'string' && TIME_RE.test(t);
}

// YYYY-MM-DD as produced by <input type="date">.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateString(d) {
    if (typeof d !== 'string' || !DATE_RE.test(d)) return false;
    const parsed = new Date(d);
    return !Number.isNaN(parsed.getTime());
}

// Looks up a saved swimmer by id, scoped to the logged-in user, so nobody
// can book/edit using a swimmer_id that belongs to someone else.
async function getOwnedSwimmer(userId, swimmerId) {
    const result = await pool.query(
        'SELECT * FROM swimmers WHERE id=$1 AND user_id=$2',
        [swimmerId, userId]
    );
    return result.rows[0] || null;
}

// =========================
// Booking logic (shared by /add and /sessions/book/:id)
// Wrapped in a transaction with a row lock on the session so concurrent
// bookings for the last spot can't both succeed (no race condition).
// =========================
async function bookEntry({ userId, sessionId, name, age, swimmerId, creditId }) {
    if (!name || !name.trim()) return { ok: false, message: 'Name is required ❌' };
    if (!isValidAge(age)) return { ok: false, message: 'Enter a valid age ❌' };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const sessionRes = await client.query('SELECT * FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
        const swimSession = sessionRes.rows[0];
        if (!swimSession) {
            await client.query('ROLLBACK');
            return { ok: false, message: 'Session not found ❌' };
        }

        const bookedCountRes = await client.query('SELECT COUNT(*) FROM entries WHERE session_id=$1', [sessionId]);
        const bookedCount = parseInt(bookedCountRes.rows[0].count, 10);
        if (bookedCount >= swimSession.capacity) {
            await client.query('ROLLBACK');
            return { ok: false, message: 'Session Full ❌' };
        }

        const duplicate = await client.query(
            'SELECT 1 FROM entries WHERE session_id=$1 AND name=$2',
            [sessionId, name.trim()]
        );
        if (duplicate.rows.length > 0) {
            await client.query('ROLLBACK');
            return { ok: false, message: 'Swimmer already booked for this session ⚠️' };
        }

        const clash = await client.query(`
            SELECT s.id
            FROM entries e
            JOIN sessions s ON e.session_id = s.id
            WHERE e.user_id = $1
              AND s.date = $2
              AND s.start_time < $3
              AND s.end_time > $4
        `, [userId, swimSession.date, swimSession.end_time, swimSession.start_time]);
        if (clash.rows.length > 0) {
            await client.query('ROLLBACK');
            return { ok: false, message: 'Time Clash with another booking ❌' };
        }

        // Optionally redeem a make-up credit as part of this same booking. Locked
        // and re-checked here (not just when the form was rendered) so it can't be
        // redeemed twice by submitting two booking forms at once.
        if (creditId) {
            const creditRes = await client.query(
                `SELECT * FROM makeup_credits
                 WHERE id=$1 AND swimmer_id=$2 AND user_id=$3 AND status='available'
                 FOR UPDATE`,
                [creditId, swimmerId, userId]
            );
            if (creditRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return { ok: false, message: "That make-up credit isn't available for this swimmer ❌" };
            }
        }

        await client.query(
            'INSERT INTO entries (name, age, user_id, session_id, swimmer_id) VALUES ($1,$2,$3,$4,$5)',
            [name.trim(), age, userId, sessionId, swimmerId || null]
        );

        if (creditId) {
            await client.query(
                `UPDATE makeup_credits SET status='used', used_at=NOW(), used_session_id=$1 WHERE id=$2`,
                [sessionId, creditId]
            );
        }

        await client.query('COMMIT');
        return { ok: true };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Available (unredeemed) make-up credits for a user's swimmers, newest first.
async function getAvailableCredits(userId) {
    const result = await pool.query(`
        SELECT mc.id, mc.swimmer_id, mc.source_title, mc.source_date, mc.created_at,
               sw.name AS swimmer_name
        FROM makeup_credits mc
        JOIN swimmers sw ON mc.swimmer_id = sw.id
        WHERE mc.user_id = $1 AND mc.status = 'available'
        ORDER BY mc.created_at ASC
    `, [userId]);
    return result.rows;
}

// =========================
// Routes
// =========================

app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.role === 'admin') return res.redirect('/admin/dashboard');
    return res.redirect('/dashboard');
});

// -------- LOGIN --------
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { error: null, username: null });
});

app.post('/login', authLimiter, verifyCsrf, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.render('login', { error: 'Username and password are required ❌', username });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
        // Always compare against a hash, even on a missing user, so login
        // takes a consistent amount of time and doesn't leak which usernames exist.
        const user = result.rows[0];
        const hash = user ? user.password : '$2b$10$invalidsaltinvalidsaltinvalidsaltinvalidsal';
        const match = await bcrypt.compare(password, hash);

        if (!user || !match) {
            return res.render('login', { error: 'Invalid username or password ❌', username });
        }

        req.session.regenerate((err) => {
            if (err) {
                console.error(err);
                return res.render('login', { error: 'Something went wrong ❌', username });
            }
            req.session.user = user;
            req.session.user_id = user.id;
            req.session.role = user.role;
            req.session.csrfToken = crypto.randomBytes(24).toString('hex');

            if (user.role === 'admin') return res.redirect('/admin/dashboard');
            return res.redirect('/dashboard');
        });
    } catch (err) {
        console.error(err);
        res.render('login', { error: 'Something went wrong ❌', username });
    }
});

// -------- SIGNUP --------
app.get('/signup', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('signup', { error: null, username: null, email: null });
});

app.post('/signup', authLimiter, verifyCsrf, async (req, res) => {
    const { username, email, password, confirmPassword } = req.body;

    if (!username || !email || !password) {
        return res.render('signup', { error: 'All fields are required ❌', username, email });
    }
    if (!EMAIL_RE.test(email)) {
        return res.render('signup', { error: 'Enter a valid email address ❌', username, email });
    }
    if (password.length < 8) {
        return res.render('signup', { error: 'Password must be at least 8 characters ❌', username, email });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
        return res.render('signup', { error: 'Passwords do not match ❌', username, email });
    }

    try {
        const userCheck = await pool.query('SELECT 1 FROM users WHERE username=$1 OR email=$2', [username, email]);
        if (userCheck.rows.length > 0) {
            return res.render('signup', { error: 'Username or email already exists ❌', username, email });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const insertResult = await pool.query(
            'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING *',
            [username, email, hashedPassword, 'user']
        );
        const newUser = insertResult.rows[0];

        req.session.regenerate((err) => {
            if (err) {
                console.error(err);
                return res.render('signup', { error: 'Something went wrong ❌', username, email });
            }
            req.session.user = newUser;
            req.session.user_id = newUser.id;
            req.session.role = newUser.role;
            req.session.csrfToken = crypto.randomBytes(24).toString('hex');
            res.redirect('/dashboard');
        });
    } catch (err) {
        console.error(err);
        res.render('signup', { error: 'Something went wrong ❌', username, email });
    }
});

// -------- FORGOT PASSWORD --------
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

app.get('/forgot-password', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('forgotPassword', { error: null, sent: false });
});

app.post('/forgot-password', authLimiter, verifyCsrf, async (req, res) => {
    const { email } = req.body;
    if (!email || !EMAIL_RE.test(email)) {
        return res.render('forgotPassword', { error: 'Enter a valid email address ❌', sent: false });
    }

    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
        const user = userResult.rows[0];

        // Only generate/send a token if the account exists, but always show the
        // same success message either way — this stops the form being used to
        // check which emails are registered.
        if (user) {
            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

            await pool.query(
                'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
                [user.id, tokenHash, expiresAt]
            );

            const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
            const resetLink = `${baseUrl}/reset-password/${rawToken}`;

            await sendMail({
                to: user.email,
                subject: 'Reset your Swimming Pool password',
                text: `We received a request to reset your password. This link expires in 1 hour:\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`
            });
        }

        res.render('forgotPassword', { error: null, sent: true });
    } catch (err) {
        console.error(err);
        res.render('forgotPassword', { error: 'Something went wrong ❌', sent: false });
    }
});

app.get('/reset-password/:token', async (req, res) => {
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
    try {
        const result = await pool.query(
            'SELECT * FROM password_reset_tokens WHERE token_hash=$1 AND used=FALSE AND expires_at > NOW()',
            [tokenHash]
        );
        if (result.rows.length === 0) {
            return res.render('resetPassword', { token: null, error: 'This reset link is invalid or has expired ❌', success: false });
        }
        res.render('resetPassword', { token: req.params.token, error: null, success: false });
    } catch (err) {
        console.error(err);
        res.render('resetPassword', { token: null, error: 'Something went wrong ❌', success: false });
    }
});

app.post('/reset-password/:token', verifyCsrf, async (req, res) => {
    const { password, confirmPassword } = req.body;
    const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

    if (!password || password.length < 8) {
        return res.render('resetPassword', { token: req.params.token, error: 'Password must be at least 8 characters ❌', success: false });
    }
    if (password !== confirmPassword) {
        return res.render('resetPassword', { token: req.params.token, error: 'Passwords do not match ❌', success: false });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tokenResult = await client.query(
            'SELECT * FROM password_reset_tokens WHERE token_hash=$1 AND used=FALSE AND expires_at > NOW() FOR UPDATE',
            [tokenHash]
        );
        const tokenRow = tokenResult.rows[0];
        if (!tokenRow) {
            await client.query('ROLLBACK');
            return res.render('resetPassword', { token: null, error: 'This reset link is invalid or has expired ❌', success: false });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await client.query('UPDATE users SET password=$1 WHERE id=$2', [hashedPassword, tokenRow.user_id]);
        await client.query('UPDATE password_reset_tokens SET used=TRUE WHERE id=$1', [tokenRow.id]);
        // Invalidate any other outstanding reset tokens for this user.
        await client.query(
            'UPDATE password_reset_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE',
            [tokenRow.user_id]
        );

        await client.query('COMMIT');
        res.render('resetPassword', { token: null, error: null, success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.render('resetPassword', { token: req.params.token, error: 'Something went wrong ❌', success: false });
    } finally {
        client.release();
    }
});

// -------- LOGOUT --------
app.post('/logout', verifyCsrf, (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});
// Keep GET working too since the original UI links to it as <a href="/logout">.
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// =========================
// DASHBOARDS
// =========================
app.get('/admin/dashboard', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const users = await pool.query(
            'SELECT id, username, email, role, full_name, created_at FROM users ORDER BY id'
        );
        const bookings = await pool.query(`
            SELECT e.id, e.name, e.age, e.entry_time, s.title, s.date, u.username
            FROM entries e
            JOIN sessions s ON e.session_id = s.id
            JOIN users u ON e.user_id = u.id
            ORDER BY s.date DESC
        `);
        res.render('adminDashboard', {
            username: req.session.user.username,
            users: users.rows,
            bookings: bookings.rows
        });
    } catch (err) {
        console.error(err);
        res.send('Error loading admin dashboard ❌');
    }
});

app.get('/admin/swimmers', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT sw.*, u.username AS owner_username,
                   (SELECT COUNT(*) FROM achievements a WHERE a.swimmer_id = sw.id) AS achievement_count
            FROM swimmers sw
            JOIN users u ON sw.user_id = u.id
            ORDER BY u.username ASC, sw.name ASC
        `);
        res.render('adminSwimmers', { swimmers: result.rows });
    } catch (err) {
        console.error(err);
        res.send('Error loading swimmers ❌');
    }
});

app.get('/admin/reports', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [
            overview,
            sessionAttendance,
            popularSessions,
            bookingsByDay,
            bookingTrend,
            signupTrend,
            achievementTrend,
            topSwimmers
        ] = await Promise.all([
            pool.query(`
                SELECT
                    (SELECT COUNT(*) FROM users)        AS total_users,
                    (SELECT COUNT(*) FROM swimmers)      AS total_swimmers,
                    (SELECT COUNT(*) FROM sessions)      AS total_sessions,
                    (SELECT COUNT(*) FROM entries)       AS total_bookings,
                    (SELECT COUNT(*) FROM achievements)  AS total_achievements,
                    (SELECT COALESCE(SUM(capacity), 0) FROM sessions) AS total_capacity,
                    (SELECT COUNT(*) FROM makeup_credits WHERE status='available') AS credits_available,
                    (SELECT COUNT(*) FROM makeup_credits WHERE status='used') AS credits_used
            `),
            pool.query(`
                SELECT s.id, s.title, s.date, s.start_time, s.end_time, s.capacity,
                       COUNT(e.id) AS booked
                FROM sessions s
                LEFT JOIN entries e ON e.session_id = s.id
                GROUP BY s.id
                ORDER BY s.date DESC, s.start_time DESC
            `),
            pool.query(`
                SELECT s.title,
                       COUNT(DISTINCT s.id) AS times_offered,
                       COUNT(e.id) AS total_bookings
                FROM sessions s
                LEFT JOIN entries e ON e.session_id = s.id
                GROUP BY s.title
                ORDER BY total_bookings DESC, s.title ASC
            `),
            pool.query(`
                SELECT TRIM(to_char(s.date, 'Day')) AS day_name,
                       EXTRACT(DOW FROM s.date)::int AS dow,
                       COUNT(e.id) AS bookings
                FROM sessions s
                LEFT JOIN entries e ON e.session_id = s.id
                GROUP BY dow, day_name
                ORDER BY dow
            `),
            pool.query(`
                SELECT to_char(date_trunc('month', entry_time), 'YYYY-MM') AS month,
                       COUNT(*) AS bookings
                FROM entries
                GROUP BY 1
                ORDER BY 1
            `),
            pool.query(`
                SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                       COUNT(*) AS signups
                FROM users
                GROUP BY 1
                ORDER BY 1
            `),
            pool.query(`
                SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                       COUNT(*) AS achievements
                FROM achievements
                GROUP BY 1
                ORDER BY 1
            `),
            pool.query(`
                SELECT sw.name, u.username,
                       COUNT(a.id) AS achievement_count
                FROM swimmers sw
                JOIN users u ON sw.user_id = u.id
                LEFT JOIN achievements a ON a.swimmer_id = sw.id
                GROUP BY sw.id, u.username
                HAVING COUNT(a.id) > 0
                ORDER BY achievement_count DESC, sw.name ASC
                LIMIT 10
            `)
        ]);

        const withFillRate = sessionAttendance.rows.map(row => ({
            ...row,
            booked: Number(row.booked),
            fillRate: row.capacity > 0 ? Math.round((Number(row.booked) / row.capacity) * 100) : 0
        }));

        const ov = overview.rows[0];
        const overallFillRate = ov.total_capacity > 0
            ? Math.round((Number(ov.total_bookings) / Number(ov.total_capacity)) * 100)
            : 0;

        // Merge every monthly series onto a single sorted list of months so
        // the template can render one aligned table instead of three.
        const monthSet = new Set([
            ...bookingTrend.rows.map(r => r.month),
            ...signupTrend.rows.map(r => r.month),
            ...achievementTrend.rows.map(r => r.month)
        ]);
        const bookingsByMonth = Object.fromEntries(bookingTrend.rows.map(r => [r.month, Number(r.bookings)]));
        const signupsByMonth = Object.fromEntries(signupTrend.rows.map(r => [r.month, Number(r.signups)]));
        const achievementsByMonth = Object.fromEntries(achievementTrend.rows.map(r => [r.month, Number(r.achievements)]));
        const monthlyTrend = [...monthSet].sort().map(month => ({
            month,
            bookings: bookingsByMonth[month] || 0,
            signups: signupsByMonth[month] || 0,
            achievements: achievementsByMonth[month] || 0
        }));

        res.render('adminReports', {
            overview: ov,
            overallFillRate,
            sessionAttendance: withFillRate,
            popularSessions: popularSessions.rows,
            bookingsByDay: bookingsByDay.rows,
            monthlyTrend,
            topSwimmers: topSwimmers.rows
        });
    } catch (err) {
        console.error(err);
        res.send('Error loading reports ❌');
    }
});

// =========================
// ADMIN: manage swim sessions (create/edit/delete)
// This is the only way sessions get into the app going forward — the rows
// in schema.sql are a one-time seed and go stale as their dates pass.
// =========================

async function loadSessionsForAdmin() {
    const result = await pool.query(`
        SELECT s.*,
               (SELECT COUNT(*) FROM entries e WHERE e.session_id = s.id) AS booked_count
        FROM sessions s
        ORDER BY s.date ASC, s.start_time ASC
    `);
    return result.rows;
}

app.get('/admin/sessions', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const sessions = await loadSessionsForAdmin();
        res.render('adminSessions', { sessions, error: null });
    } catch (err) {
        console.error(err);
        res.send('Error loading sessions ❌');
    }
});

app.post('/admin/sessions', isAuthenticated, isAdmin, verifyCsrf, async (req, res) => {
    const { title, date, start_time, end_time, capacity } = req.body;

    if (!title || !title.trim() || !isValidDateString(date) || !isValidTime(start_time) ||
        !isValidTime(end_time) || !isValidCapacity(capacity)) {
        const sessions = await loadSessionsForAdmin();
        return res.render('adminSessions', { sessions, error: 'Fill in all fields with valid values ❌' });
    }
    if (start_time >= end_time) {
        const sessions = await loadSessionsForAdmin();
        return res.render('adminSessions', { sessions, error: 'End time must be after start time ❌' });
    }

    try {
        await pool.query(
            'INSERT INTO sessions (title, date, start_time, end_time, capacity) VALUES ($1, $2, $3, $4, $5)',
            [title.trim(), date, start_time, end_time, capacity]
        );
        res.redirect('/admin/sessions');
    } catch (err) {
        const sessions = await loadSessionsForAdmin();
        const message = err.code === '23505'
            ? 'A session with that title, date, and start time already exists ❌'
            : 'Something went wrong ❌';
        res.render('adminSessions', { sessions, error: message });
    }
});

app.post('/admin/sessions/:id/edit', isAuthenticated, isAdmin, verifyCsrf, async (req, res) => {
    const { title, date, start_time, end_time, capacity } = req.body;
    const sessionId = req.params.id;

    if (!title || !title.trim() || !isValidDateString(date) || !isValidTime(start_time) ||
        !isValidTime(end_time) || !isValidCapacity(capacity)) {
        const sessions = await loadSessionsForAdmin();
        return res.render('adminSessions', { sessions, error: 'Fill in all fields with valid values ❌' });
    }
    if (start_time >= end_time) {
        const sessions = await loadSessionsForAdmin();
        return res.render('adminSessions', { sessions, error: 'End time must be after start time ❌' });
    }

    try {
        // Don't let capacity drop below the number of people already booked in.
        const bookedResult = await pool.query('SELECT COUNT(*) FROM entries WHERE session_id=$1', [sessionId]);
        const booked = Number(bookedResult.rows[0].count);
        if (Number(capacity) < booked) {
            const sessions = await loadSessionsForAdmin();
            return res.render('adminSessions', {
                sessions,
                error: `Capacity can't be less than the ${booked} spot(s) already booked ❌`
            });
        }

        await pool.query(
            'UPDATE sessions SET title=$1, date=$2, start_time=$3, end_time=$4, capacity=$5 WHERE id=$6',
            [title.trim(), date, start_time, end_time, capacity, sessionId]
        );
        res.redirect('/admin/sessions');
    } catch (err) {
        const sessions = await loadSessionsForAdmin();
        const message = err.code === '23505'
            ? 'A session with that title, date, and start time already exists ❌'
            : 'Something went wrong ❌';
        res.render('adminSessions', { sessions, error: message });
    }
});

app.post('/admin/sessions/:id/delete', isAuthenticated, isAdmin, verifyCsrf, async (req, res) => {
    const sessionId = req.params.id;
    try {
        // Deleting a session cascades to its bookings (see schema.sql); the
        // confirm() dialog in the UI already warns the admin how many will go.
        await pool.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
        res.redirect('/admin/sessions');
    } catch (err) {
        console.error(err);
        res.send('Error deleting session ❌');
    }
});

app.get('/dashboard', isAuthenticated, isUser, async (req, res) => {
    const userId = req.session.user_id;
    try {
        const bookings = await pool.query(`
            SELECT e.id AS booking_id, e.name, e.age, s.title, s.date, s.start_time, s.end_time
            FROM entries e
            JOIN sessions s ON e.session_id = s.id
            WHERE e.user_id = $1
            ORDER BY s.date ASC
        `, [userId]);
        res.render('userDashboard', {
            username: req.session.user.username,
            bookings: bookings.rows
        });
    } catch (err) {
        console.error(err);
        res.send('Error loading dashboard ❌');
    }
});

// =========================
// SWIMMERS (saved profiles, so name/age don't need retyping every booking)
// =========================
app.get('/swimmers', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT sw.*,
                   (SELECT COUNT(*) FROM makeup_credits mc WHERE mc.swimmer_id = sw.id AND mc.status = 'available') AS credit_count
            FROM swimmers sw
            WHERE sw.user_id=$1
            ORDER BY sw.name ASC
        `, [req.session.user_id]);
        res.render('swimmers', { swimmers: result.rows, error: null });
    } catch (err) {
        console.error(err);
        res.send('Error loading swimmers ❌');
    }
});

app.post('/swimmers', isAuthenticated, verifyCsrf, async (req, res) => {
    const { name, age } = req.body;
    const userId = req.session.user_id;

    if (!name || !name.trim() || !isValidAge(age)) {
        const result = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [userId]);
        return res.render('swimmers', { swimmers: result.rows, error: 'Enter a valid name and age ❌' });
    }

    try {
        await pool.query(
            'INSERT INTO swimmers (user_id, name, age) VALUES ($1, $2, $3)',
            [userId, name.trim(), age]
        );
        res.redirect('/swimmers');
    } catch (err) {
        const result = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [userId]);
        const message = err.code === '23505' ? 'You already have a swimmer with that name ❌' : 'Something went wrong ❌';
        res.render('swimmers', { swimmers: result.rows, error: message });
    }
});

app.post('/swimmers/:id/edit', isAuthenticated, verifyCsrf, async (req, res) => {
    const { name, age } = req.body;
    const userId = req.session.user_id;
    const swimmerId = req.params.id;

    if (!name || !name.trim() || !isValidAge(age)) {
        const result = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [userId]);
        return res.render('swimmers', { swimmers: result.rows, error: 'Enter a valid name and age ❌' });
    }

    try {
        // Scoped to user_id so nobody can edit another user's swimmer by guessing the id.
        await pool.query(
            'UPDATE swimmers SET name=$1, age=$2 WHERE id=$3 AND user_id=$4',
            [name.trim(), age, swimmerId, userId]
        );
        res.redirect('/swimmers');
    } catch (err) {
        const result = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [userId]);
        const message = err.code === '23505' ? 'You already have a swimmer with that name ❌' : 'Something went wrong ❌';
        res.render('swimmers', { swimmers: result.rows, error: message });
    }
});

app.post('/swimmers/:id/delete', isAuthenticated, verifyCsrf, async (req, res) => {
    const userId = req.session.user_id;
    const swimmerId = req.params.id;
    try {
        // Clean up any uploaded files for this swimmer before the DB cascade
        // deletes the achievement rows, so we don't leave orphan files on disk.
        const filesResult = await pool.query(
            'SELECT file_path FROM achievements WHERE swimmer_id=$1 AND user_id=$2',
            [swimmerId, userId]
        );
        filesResult.rows.forEach((row) => {
            const fullPath = path.join(UPLOAD_DIR, path.basename(row.file_path));
            fs.unlink(fullPath, () => {}); // best-effort; ignore if already gone
        });

        await pool.query('DELETE FROM swimmers WHERE id=$1 AND user_id=$2', [swimmerId, userId]);
        res.redirect('/swimmers');
    } catch (err) {
        console.error(err);
        res.send('Error deleting swimmer ❌');
    }
});

// =========================
// ACHIEVEMENTS (photos / certificates per swimmer)
// Only admins upload/remove achievements — they're an official record from
// the swim school, not something a parent should be able to self-certify.
// Parents get read-only access to their own swimmer's gallery.
// =========================

// Wraps multer so a bad upload (wrong file type, too large) shows a friendly
// error on the page instead of crashing the request.
function uploadSingle(fieldName) {
    return (req, res, next) => {
        upload.single(fieldName)(req, res, (err) => {
            if (err) req.uploadError = err.message || 'Upload failed ❌';
            next();
        });
    };
}

// Admins can view/manage any swimmer; everyone else only their own.
async function getSwimmerForViewing(req) {
    if (req.session.role === 'admin') {
        const result = await pool.query(
            'SELECT sw.*, u.username AS owner_username FROM swimmers sw JOIN users u ON sw.user_id = u.id WHERE sw.id=$1',
            [req.params.id]
        );
        return result.rows[0] || null;
    }
    return getOwnedSwimmer(req.session.user_id, req.params.id);
}

app.get('/swimmers/:id/achievements', isAuthenticated, async (req, res) => {
    const swimmer = await getSwimmerForViewing(req);
    if (!swimmer) return res.status(404).send('Swimmer not found ❌');

    try {
        const result = await pool.query(
            'SELECT * FROM achievements WHERE swimmer_id=$1 ORDER BY created_at DESC',
            [swimmer.id]
        );
        res.render('achievements', {
            swimmer,
            achievements: result.rows,
            canManage: req.session.role === 'admin',
            error: null
        });
    } catch (err) {
        console.error(err);
        res.send('Error loading achievements ❌');
    }
});

app.post('/swimmers/:id/achievements', isAuthenticated, isAdmin, uploadSingle('file'), verifyCsrf, async (req, res) => {
    const swimmerResult = await pool.query('SELECT * FROM swimmers WHERE id=$1', [req.params.id]);
    const swimmer = swimmerResult.rows[0];
    if (!swimmer) return res.status(404).send('Swimmer not found ❌');

    const { title, description } = req.body;
    const rerender = async (error) => {
        const result = await pool.query('SELECT * FROM achievements WHERE swimmer_id=$1 ORDER BY created_at DESC', [swimmer.id]);
        res.render('achievements', { swimmer, achievements: result.rows, canManage: true, error });
    };

    if (req.uploadError) return rerender(req.uploadError);
    if (!req.file) return rerender('Choose a photo or certificate to upload ❌');
    if (!title || !title.trim()) {
        fs.unlink(req.file.path, () => {});
        return rerender('Enter a title for this achievement ❌');
    }

    try {
        const meta = ALLOWED_UPLOAD_TYPES[req.file.mimetype];
        await pool.query(
            'INSERT INTO achievements (swimmer_id, user_id, title, description, file_path, file_type) VALUES ($1,$2,$3,$4,$5,$6)',
            [swimmer.id, swimmer.user_id, title.trim(), description ? description.trim() : null, `/uploads/achievements/${req.file.filename}`, meta.kind]
        );
        res.redirect(`/swimmers/${swimmer.id}/achievements`);
    } catch (err) {
        console.error(err);
        fs.unlink(req.file.path, () => {});
        rerender('Something went wrong ❌');
    }
});

app.post('/swimmers/:id/achievements/:achievementId/delete', isAuthenticated, isAdmin, verifyCsrf, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM achievements WHERE id=$1 AND swimmer_id=$2',
            [req.params.achievementId, req.params.id]
        );
        const achievement = result.rows[0];
        if (achievement) {
            const fullPath = path.join(UPLOAD_DIR, path.basename(achievement.file_path));
            fs.unlink(fullPath, () => {});
            await pool.query('DELETE FROM achievements WHERE id=$1', [achievement.id]);
        }
        res.redirect(`/swimmers/${req.params.id}/achievements`);
    } catch (err) {
        console.error(err);
        res.send('Error deleting achievement ❌');
    }
});

// =========================
// PROFILE
// =========================
app.get('/profile', isAuthenticated, async (req, res) => {
    const userId = req.session.user_id;
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
        const bookingsResult = await pool.query(`
            SELECT e.id AS booking_id, e.name, e.age,
                   s.id AS session_id, s.title, s.date, s.start_time, s.end_time
            FROM entries e
            JOIN sessions s ON e.session_id = s.id
            WHERE e.user_id=$1
            ORDER BY s.date ASC
        `, [userId]);

        const sessionsResult = await pool.query(`
            SELECT s.*,
                   (SELECT COUNT(*) FROM entries e WHERE e.session_id=s.id) AS booked_count
            FROM sessions s
            WHERE s.date >= CURRENT_DATE
            ORDER BY s.date ASC, s.start_time ASC
        `);

        const swimmersResult = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [userId]);
        const credits = await getAvailableCredits(userId);

        res.render('profile', {
            user: userResult.rows[0],
            bookings: bookingsResult.rows,
            sessions: sessionsResult.rows,
            swimmers: swimmersResult.rows,
            credits,
            username: req.session.user.username
        });
    } catch (err) {
        console.error(err);
        res.send('Error loading profile ❌');
    }
});

app.get('/profile/edit', isAuthenticated, async (req, res) => {
    try {
        const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.user_id]);
        res.render('editProfile', { user: userResult.rows[0], error: null, success: null });
    } catch (err) {
        console.error(err);
        res.send('Error loading profile ❌');
    }
});

app.post('/profile/edit', isAuthenticated, verifyCsrf, async (req, res) => {
    const { full_name, email, phone } = req.body;
    const userId = req.session.user_id;

    if (!full_name || !full_name.trim() || !email || !email.trim()) {
        const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
        return res.render('editProfile', {
            user: { ...userResult.rows[0], full_name, email, phone },
            error: 'Full name and email are required ❌',
            success: null
        });
    }
    if (!EMAIL_RE.test(email)) {
        const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
        return res.render('editProfile', {
            user: { ...userResult.rows[0], full_name, email, phone },
            error: 'Enter a valid email ❌',
            success: null
        });
    }
    if (phone && !/^[0-9]{8,15}$/.test(phone)) {
        const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
        return res.render('editProfile', {
            user: { ...userResult.rows[0], full_name, email, phone },
            error: 'Enter a valid phone number ❌',
            success: null
        });
    }

    try {
        const emailTaken = await pool.query('SELECT 1 FROM users WHERE email=$1 AND id<>$2', [email, userId]);
        if (emailTaken.rows.length > 0) {
            const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
            return res.render('editProfile', {
                user: { ...userResult.rows[0], full_name, email, phone },
                error: 'That email is already in use ❌',
                success: null
            });
        }

        const updated = await pool.query(
            'UPDATE users SET full_name=$1, email=$2, phone=$3 WHERE id=$4 RETURNING *',
            [full_name.trim(), email.trim(), phone ? phone.trim() : null, userId]
        );
        req.session.user = updated.rows[0]; // keep session in sync with the new data
        res.render('editProfile', { user: updated.rows[0], error: null, success: 'Profile updated ✅' });
    } catch (err) {
        console.error(err);
        const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
        res.render('editProfile', { user: userResult.rows[0], error: 'Something went wrong ❌', success: null });
    }
});

// =========================
// SESSIONS / BOOKING
// =========================
app.get('/sessions', isAuthenticated, async (req, res) => {
    try {
        const sessionsResult = await pool.query(`
            SELECT s.*,
                   (SELECT COUNT(*) FROM entries e WHERE e.session_id=s.id) AS booked_count
            FROM sessions s
            WHERE s.date >= CURRENT_DATE
            ORDER BY s.date ASC, s.start_time ASC
        `);
        const swimmersResult = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [req.session.user_id]);
        const credits = await getAvailableCredits(req.session.user_id);
        res.render('sessions', {
            sessions: sessionsResult.rows,
            swimmers: swimmersResult.rows,
            credits,
            username: req.session.user.username
        });
    } catch (err) {
        console.error(err);
        res.send('Error loading sessions ❌');
    }
});

app.post('/sessions/book/:id', isAuthenticated, verifyCsrf, async (req, res) => {
    const sessionId = req.params.id;
    const { swimmer_id, credit_id } = req.body;
    const userId = req.session.user_id;

    try {
        const swimmer = await getOwnedSwimmer(userId, swimmer_id);
        if (!swimmer) return res.send('Select a valid swimmer ❌');

        const result = await bookEntry({
            userId, sessionId, name: swimmer.name, age: swimmer.age,
            swimmerId: swimmer.id, creditId: credit_id || null
        });
        if (!result.ok) return res.send(result.message);
        res.redirect('/profile');
    } catch (err) {
        console.error(err);
        res.send('Booking error ❌');
    }
});

app.get('/schedule', isAuthenticated, async (req, res) => {
    try {
        const sessionsResult = await pool.query(`
            SELECT s.*,
                   (SELECT COUNT(*) FROM entries e WHERE e.session_id=s.id) AS booked_count
            FROM sessions s
            WHERE s.date >= CURRENT_DATE
            ORDER BY s.date ASC, s.start_time ASC
        `);

        // Group sessions by ISO week number for the week-by-week schedule view.
        const schedule = {};
        sessionsResult.rows.forEach((s) => {
            const d = new Date(s.date);
            const firstJan = new Date(d.getFullYear(), 0, 1);
            const weekNum = Math.ceil((((d - firstJan) / 86400000) + firstJan.getDay() + 1) / 7);
            if (!schedule[weekNum]) schedule[weekNum] = [];
            schedule[weekNum].push(s);
        });

        const swimmersResult = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [req.session.user_id]);
        const credits = await getAvailableCredits(req.session.user_id);

        res.render('schedule', { schedule, swimmers: swimmersResult.rows, credits, username: req.session.user.username });
    } catch (err) {
        console.error(err);
        res.send('Error loading schedule ❌');
    }
});

// -------- ADD ENTRY (booking via a direct form, same underlying logic) --------
app.get('/add', isAuthenticated, async (req, res) => {
    try {
        const sessionsResult = await pool.query(`
            SELECT s.*,
                   (SELECT COUNT(*) FROM entries e WHERE e.session_id=s.id) AS booked_count
            FROM sessions s
            WHERE s.date >= CURRENT_DATE
            ORDER BY s.date ASC, s.start_time ASC
        `);
        const swimmersResult = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [req.session.user_id]);
        const credits = await getAvailableCredits(req.session.user_id);
        res.render('add', {
            sessions: sessionsResult.rows,
            swimmers: swimmersResult.rows,
            credits,
            error: null,
            username: req.session.user.username
        });
    } catch (err) {
        console.error(err);
        res.send('Error loading sessions ❌');
    }
});

app.post('/add', isAuthenticated, verifyCsrf, async (req, res) => {
    const { swimmer_id, session_id, credit_id } = req.body;
    const userId = req.session.user_id;

    try {
        const swimmer = await getOwnedSwimmer(userId, swimmer_id);
        const sessionsResult = await pool.query(`
            SELECT s.*,
                   (SELECT COUNT(*) FROM entries e WHERE e.session_id=s.id) AS booked_count
            FROM sessions s
            WHERE s.date >= CURRENT_DATE
            ORDER BY s.date ASC, s.start_time ASC
        `);
        const swimmersResult = await pool.query('SELECT * FROM swimmers WHERE user_id=$1 ORDER BY name ASC', [userId]);
        const credits = await getAvailableCredits(userId);

        if (!swimmer) {
            return res.render('add', {
                sessions: sessionsResult.rows,
                swimmers: swimmersResult.rows,
                credits,
                error: 'Select a valid swimmer ❌',
                username: req.session.user.username
            });
        }

        const result = await bookEntry({
            userId, sessionId: session_id, name: swimmer.name, age: swimmer.age,
            swimmerId: swimmer.id, creditId: credit_id || null
        });
        if (!result.ok) {
            return res.render('add', {
                sessions: sessionsResult.rows,
                swimmers: swimmersResult.rows,
                credits,
                error: result.message,
                username: req.session.user.username
            });
        }
        res.redirect('/profile');
    } catch (err) {
        console.error(err);
        res.send('Booking error ❌');
    }
});

// -------- CAN'T ATTEND (cancel a booking + issue a make-up credit) --------
app.post('/bookings/cant-attend/:id', isAuthenticated, verifyCsrf, async (req, res) => {
    const bookingId = req.params.id;
    const userId = req.session.user_id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Scoped to the logged-in user so nobody can cancel someone else's booking
        // by guessing/changing the id in the request.
        const bookingRes = await client.query(`
            SELECT e.id, e.swimmer_id, s.title, s.date
            FROM entries e
            JOIN sessions s ON e.session_id = s.id
            WHERE e.id=$1 AND e.user_id=$2
            FOR UPDATE
        `, [bookingId, userId]);
        const booking = bookingRes.rows[0];

        if (!booking) {
            await client.query('ROLLBACK');
            return res.redirect('/profile');
        }

        await client.query('DELETE FROM entries WHERE id=$1', [bookingId]);

        // Only issue a credit if we know which swimmer to credit. Bookings made
        // before the swimmer_id column existed won't have one — see
        // migrate_makeup_credits.sql for details.
        if (booking.swimmer_id) {
            await client.query(`
                INSERT INTO makeup_credits (swimmer_id, user_id, source_title, source_date)
                VALUES ($1, $2, $3, $4)
            `, [booking.swimmer_id, userId, booking.title, booking.date]);
        }

        await client.query('COMMIT');
        res.redirect('/profile');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.send("Error marking booking as can't attend ❌");
    } finally {
        client.release();
    }
});

// =========================
// 404
// =========================
app.use((req, res) => {
    res.status(404).send('Page not found ❌');
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
