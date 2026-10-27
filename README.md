# Swim Session Manager

A swim school booking app where parents enrol their children in swim sessions and manage bookings, and admins run the timetable, track attendance and record swimmers' achievements.

Built with **Node.js, Express 5, EJS and PostgreSQL**.

<!-- Add screenshots here, for example:
![Session booking page](docs/screenshots/sessions.png)
![Admin dashboard](docs/screenshots/admin-dashboard.png)
-->

## Features

### For parents

- **Sign up and log in**, with password reset by email.
- **Saved swimmers**: add each child once (name and age), then pick them from a dropdown when booking.
- **Browse and book sessions**, see a weekly schedule, and view upcoming bookings on a personal dashboard.
- **Can't attend?** Mark a booking as missed and receive a **make-up credit**, which can be redeemed against any future session.
- **Achievements gallery**: view the photos and certificates the swim school has recorded for each swimmer.

### For admins

- **Session management**: create, edit and delete sessions, including times and capacity.
- **Admin dashboard and reports**: bookings, attendance and make-up credit usage at a glance.
- **Swimmer directory**: see every swimmer across all accounts.
- **Achievements**: upload photos (JPG, PNG, WEBP) and certificates (PDF, max 5 MB) for any swimmer. Only admins can add or remove these, so they stay an official record.

## Security and reliability

- Passwords hashed with **bcrypt**; login gives a generic error and uses a constant-time comparison, so it doesn't reveal which usernames exist.
- **CSRF tokens** on every form, and **rate limiting** on login, signup and password reset.
- Booking runs inside a **database transaction with a row lock**, so two people can't both take the last spot in a full session.
- Users can only cancel or change their own bookings.
- Password reset links are **single-use** and expire after one hour.
- Database credentials and the session secret are read from environment variables, never stored in the code.
- Uploaded files get random filenames, preventing path-traversal and overwrite issues.

## Tech stack

| Layer | Technology |
| --- | --- |
| Server | Node.js, Express 5 |
| Views | EJS templates |
| Database | PostgreSQL (`pg`) |
| Auth | `express-session`, bcrypt |
| Uploads | Multer |
| Email | Nodemailer (SMTP) |

## Getting started

**Prerequisites:** Node.js 18 or later, and PostgreSQL.

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create the database and load the schema**

   ```bash
   createdb swimming_pool
   psql -d swimming_pool -f schema.sql
   ```

3. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in your database credentials and a random `SESSION_SECRET`. You can generate one with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. **Run the app**

   ```bash
   npm run dev     # development, restarts on changes
   npm start       # production
   ```

   Then open `http://localhost:3000`.

5. **Create an admin account.** Sign up at `/signup`, then promote yourself in `psql`:

   ```sql
   UPDATE users SET role = 'admin' WHERE username = 'your_username';
   ```

### Email (optional)

Without SMTP settings, password reset links are printed to the server terminal, which is handy for local development. To send real emails, fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` in `.env`, and set `APP_BASE_URL` to the address the app is reachable at. For Gmail, use an [App Password](https://myaccount.google.com/apppasswords) rather than your real password.

## Project structure

```
server.js                 Express app and all routes
db.js                     PostgreSQL connection pool
mailer.js                 Email sending (password reset)
schema.sql                Database tables
migrate_makeup_credits.sql  Migration that adds make-up credits
dedupe_sessions.sql       One-off clean-up of duplicate sessions
views/                    EJS templates
public/                   Static files and uploaded achievements
```

## Deployment note

Achievement uploads are stored on the local disk under `public/uploads/achievements/`. That works locally, but on most hosting platforms the disk is wiped on every restart or redeploy. Before deploying, move uploads to persistent storage such as Azure Blob Storage, AWS S3 or a mounted volume.

## Roadmap

- Coach profiles and assigning coaches to sessions
- Online payments for session bookings
- Automated tests and a CI pipeline
