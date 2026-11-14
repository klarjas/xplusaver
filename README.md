# EcomStore — Full-Stack Multi-Vendor Marketplace

A Cambodia + international multi-vendor marketplace.

## Stack
- Frontend: Next.js App Router, TypeScript, Tailwind CSS
- Backend: Node.js 20+, Express 5
- Database/Auth: Supabase PostgreSQL and Auth
- Product image storage: Telegram Channel (backend-only bot token)
- Hosting: One Render Web Service

## Repository layout
- `frontend/` — customer-facing Next.js application
- `backend/` — Express API and Telegram image proxy
- `supabase/schema.sql` — database schema and Row Level Security

## Supabase setup
1. Create a Supabase project.
2. Run `supabase/schema.sql` in Supabase SQL Editor.
3. Add the Supabase URL and keys as Render environment variables. Never commit real keys to GitHub.

## Render — ONE service
Create one **Web Service** for this repository.

- Root Directory: leave blank (repository root)
- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Runtime: Node 20 or newer

### Environment variables
- `NODE_ENV` = `production`
- `SUPABASE_URL` = Supabase Project URL
- `SUPABASE_SERVICE_ROLE_KEY` = Supabase Secret key (backend only)
- `NEXT_PUBLIC_SUPABASE_URL` = Supabase Project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` = Supabase Publishable/anon key
- `TELEGRAM_BOT_TOKEN` = Telegram bot token (backend only)
- `TELEGRAM_CHANNEL_ID` = Telegram image storage channel ID
- `AUTO_APPROVE_PRODUCTS` = `false`

Render supplies `PORT` automatically. The frontend calls the API using same-origin `/api` paths, so no separate frontend URL or CORS origin is required.

**Security:** Never put `SUPABASE_SERVICE_ROLE_KEY` or `TELEGRAM_BOT_TOKEN` in a `NEXT_PUBLIC_*` variable, frontend code, or GitHub. Keep real secrets only in Render Environment.

## Local development
Install all workspace dependencies from the repository root with `npm install`. Run the Next.js frontend and Express API separately for local development, or run the production start command after building.

## Current scope
The current code is a marketplace foundation: public product browsing, vendor registration and product APIs, Telegram image upload/proxy, and admin moderation APIs. Customer authentication screens, checkout/payment flows, and complete vendor/admin dashboards are not yet implemented.
