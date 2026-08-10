# AI Business Manager — backend

Natural-language bookkeeping: owners type a sentence, the AI extracts structured data,
the backend does all the math and storage. See REQUIREMENTS.md for the full spec.

## Run it
```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY, JWT_SECRET, etc.
npm run dev
```
This creates `bizmanager.sqlite` in the project folder on first run — a real, persistent
database file (survives restarts, unlike an in-memory store).

## Try it
```bash
# 1. Log in (demo auth — replace before real launch)
curl -X POST localhost:3000/api/auth/dev-login -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","businessName":"Maya Fashions"}'
# → save the returned token

TOKEN="paste-token-here"

# 2. Record a transaction from plain text
curl -X POST localhost:3000/api/entry -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"I sold 3 shirts at K150 each, customer Grace paid K300"}'

# 3. Ask a question
curl -X POST localhost:3000/api/ask -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"question":"Who owes me money?"}'

# 4. Check plan / usage
curl localhost:3000/api/plan -H "Authorization: Bearer $TOKEN"
```

## Where you log in and manage everything (the owner, michaelchilano07@gmail.com)
- **As a business owner** using the app: the frontend's login screen (see
  `business-manager.jsx`), same as any customer — you'd have your own business record.
- **As the platform admin**: `/api/admin/*` is locked to the emails in `ADMIN_EMAILS`
  in `.env` — defaults to `michaelchilano07@gmail.com`. Deploy `admin-dashboard.jsx`
  at a private path on your domain, e.g. `https://yourapp.com/admin`, and log in there
  with that email. The real gate is server-side: even if someone finds that URL, the
  server rejects any email not on the list.
- Change or add admin emails only via your hosting provider's environment variable
  settings — never commit them to a public repo.

## Endpoints
| Route | Purpose |
|---|---|
| `POST /api/auth/dev-login` | demo login, issues JWT |
| `POST /api/entry` | free text → recorded transaction |
| `POST /api/ask` | free text question → answer grounded in real numbers |
| `GET /api/reports/snapshot` | week/month sales, expenses, profit, top products, debts, inventory |
| `GET /api/transactions` | recent transaction log |
| `GET /api/plan` | current plan + usage |
| `POST /api/billing/checkout` | Stripe checkout session (swap for Flutterwave/Paystack for K billing) |
| `GET /api/admin/overview` | admin-only: totals across all businesses |
| `GET /api/admin/businesses` | admin-only: every business + plan + usage |
| `POST /api/admin/businesses/:id/plan` | admin-only: manually change a business's plan |

## Before charging real customers
- Replace the demo login with a real auth provider (Clerk, Supabase Auth, Firebase Auth).
- Move billing to Flutterwave or Paystack if collecting Kwacha directly (Stripe doesn't
  pay out to Zambia).
- Move `bizmanager.sqlite` to a managed Postgres instance once you have concurrent
  servers or want automatic backups.
- Put `ANTHROPIC_API_KEY`, `JWT_SECRET`, `ADMIN_EMAILS`, and Stripe keys in your host's
  environment variable settings, never in source control.
