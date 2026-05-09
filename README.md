# 1800Soles Stock Management System

A full-stack stock management system for 1800Soles built with Node.js, Express, MySQL, and vanilla HTML/CSS/JavaScript.

## Tech

- Frontend: Vanilla HTML/CSS/JS, Chart.js (CDN), Font Awesome, Google Fonts (Poppins)
- Backend: Node.js, Express.js, express-session with MySQL store, bcrypt, Nodemailer
- Database: MySQL (`db_1800soles_stock_management`)

## Setup

1. Create a local `.env` file from the template:

   ```bash
   cp .env.example .env
   ```

   Set your own `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `DB_NAME`, `SESSION_SECRET`, and SMTP values. Do not commit `.env`.

2. Install dependencies:

   ```bash
   npm install
   ```

3. Initialize DB:

   ```bash
   npm run db:init
   ```

   This creates or updates the schema and seeds sample inventory data. User accounts are not reset by the seed file, so the first account can be created through the initial registration flow.

4. Run the dev server:

   ```bash
   npm run dev
   ```

   The server runs on `http://localhost:4000` by default.

## Scripts

- `npm start` - start Express.
- `npm run dev` - start Express with nodemon.
- `npm run db:init` - apply schema and seed data.
- `npm test` - placeholder command; automated tests are not configured yet.

## Notes

- Auth uses server-side sessions stored in MySQL.
- Passwords are hashed with bcrypt.
- Inventory status auto-updates based on target quantity. Items at or below 25% of target quantity are classified as Waiting Stock.
- The system uses a simplified stock model: active items are shown as either In Stock or Waiting Stock. Zero available stock is also shown as Waiting Stock because it requires restocking.
- All inventory actions log into `activity_log` for activity and analytics views.
- Password reset emails require SMTP settings in `.env`.
