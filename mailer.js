// mailer.js
// Sends real email if SMTP_* env vars are set; otherwise falls back to
// logging the message to the console so you can develop/test locally
// without needing a mail provider.
const nodemailer = require('nodemailer');

const smtpConfigured = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;

let transporter = null;
if (smtpConfigured) {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
}

async function sendMail({ to, subject, text, html }) {
    if (!transporter) {
        console.log('\n--- SMTP not configured: would have sent this email ---');
        console.log(`To: ${to}`);
        console.log(`Subject: ${subject}`);
        console.log(text);
        console.log('--------------------------------------------------------\n');
        return { delivered: false };
    }

    await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject,
        text,
        html
    });
    return { delivered: true };
}

module.exports = { sendMail };
