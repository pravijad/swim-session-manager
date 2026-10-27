# Swimming Pool Booking App

Node/Express + EJS + PostgreSQL app for browsing swim sessions and booking spots.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Create the database and load the schema:
   ```
   createdb swimming_pool
   psql -d swimming_pool -f schema.sql
   ```

3. Copy `.env.example` to `.env` and fill in your real DB credentials and a
   random `SESSION_SECRET`:
   ```
   cp .env.example .env
   ```
   Generate a secret with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. Run it:
   ```
   npm start        # production
   npm run dev       # auto-restart on changes (nodemon)
   ```

5. Sign up for an account at `/signup`, then promote yourself to admin from
   `psql`:
   ```sql
   UPDATE users SET role = 'admin' WHERE username = 'your_username';
   ```

## Achievements (Photos & Certificates)

Achievements are managed by **admins only** — they're an official record from
the swim school, not something a parent should be able to self-certify.

- **Admins**: go to `/admin/swimmers` (linked from the admin dashboard and
  nav bar) to see every swimmer across every account, then click
  **🏆 Manage** to upload photos/certificates for that swimmer or remove
  existing ones.
- **Parents**: go to `/swimmers` → **🏆 View** on their own swimmer to see a
  read-only gallery. No upload or delete controls are shown to them.

Supported uploads: **photos** (JPG, PNG, WEBP) shown inline as a gallery, or
**certificates** (PDF) shown as a "View Certificate" link. Max 5MB per file.

Files are stored on disk under `public/uploads/achievements/` with
randomly-generated filenames (never the original filename, to avoid
path-traversal or overwrite issues).

**Note for deployment:** this stores files on the local filesystem, which
works fine for local development but **will not persist** on most hosting
platforms (e.g. Heroku's filesystem is ephemeral, wiped on every restart/
redeploy). If you deploy this app, swap the storage for something like AWS
S3, Cloudinary, or a persistent volume before relying on uploads sticking
around.

## Saved Swimmers

`/swimmers` lets each account save swimmer profiles (name + age) once, instead
of retyping them on every booking. Booking forms across the app
(`/sessions`, `/schedule`, `/profile`, `/add`) now show a dropdown of your
saved swimmers rather than free-text name/age fields. If you haven't added
any swimmers yet, the booking forms prompt you to add one first.

Editing a swimmer's saved age only affects future bookings — past bookings
keep the name/age that was recorded at the time, same as before.

## Forgot Password

`/forgot-password` lets a user request a reset link, valid for 1 hour and
single-use. By default (no SMTP credentials set), the link is **printed to
the server's terminal** instead of emailed — handy for local development.

To actually send emails, fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, and `SMTP_FROM` in `.env`. For Gmail, use an
[App Password](https://myaccount.google.com/apppasswords) rather than your
real password (`SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`). Also set
`APP_BASE_URL` to whatever URL the app is actually reachable at, so the
generated reset links are correct (e.g. `http://localhost:3000` locally, or
your real domain once deployed).

## What changed from the original version

- Fixed view-name mismatches that crashed `/admin/dashboard` and `/dashboard`.
- Added the missing `/profile/edit`, `/bookings/cancel/:id`, `/add`, and
  `/schedule` routes that the templates already linked to.
- Added the missing `email` field to signup (the route required it but the
  form never collected it).
- Moved DB credentials and the session secret out of source code and into
  `.env` (see `.env.example`).
- Booking now runs inside a DB transaction with a row lock, so two people
  can't both grab the last spot in a full session.
- Added CSRF tokens to every form and a `/login` + `/signup` rate limiter.
- Login no longer reveals whether a username exists (generic error message,
  constant-time comparison even for unknown usernames).
- Cancelling a booking is scoped to the logged-in user's own bookings.
- Added `schema.sql` since none existed — a fresh clone couldn't create
  any tables before.
- Cleaned up `package.json` (`start`/`dev` scripts, correct `main`, dropped
  the redundant `body-parser` dependency in favor of Express 5's built-in
  `express.urlencoded()`), added `.gitignore`.
