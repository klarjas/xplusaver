# EcomStore — Multi-Vendor Marketplace

A Cambodia + international multi-vendor marketplace.

## Stack
- Frontend: Next.js App Router, TypeScript, Tailwind CSS
- Backend: Node.js 20+, Express 5, Supabase
- Database/Auth: Supabase PostgreSQL and Auth
- Product image storage: Telegram Channel (backend only)
- Hosting: Render

## Repository layout
- `frontend/` — customer-facing marketplace
- `backend/` — API and Telegram image upload service
- `supabase/schema.sql` — database schema and Row Level Security
- `backend/.env.example`, `frontend/.env.example` — variable names only

## Supabase setup
1. Create a Supabase project.
2. Open SQL Editor and run `supabase/schema.sql`.
3. Add the Supabase URL and keys as Render environment variables. Never commit real keys to GitHub.

## Render environment variables

Backend service (Root Directory: `backend`, Build: `npm install`, Start: `npm start`):
- `PORT` (Render supplies this automatically)
- `FRONTEND_ORIGIN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHANNEL_ID`
- `AUTO_APPROVE_PRODUCTS` (optional, default false)

Frontend service (Root Directory: `frontend`, Build: `npm install && npm run build`, Start: `npm start`):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_API_URL`

The service-role key and Telegram bot token belong only in the backend Render environment. Do not expose them to the browser.

## Local development
Run the backend and frontend in separate terminals. Copy the example env files to local `.env` files and fill in your own values.

## Current scope
This repository starts with a secure marketplace foundation: public product browsing, vendor registration, vendor product creation, image upload endpoints, and admin moderation endpoints. Configure Supabase and Render before expecting live data.
