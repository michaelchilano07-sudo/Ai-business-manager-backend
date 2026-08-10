# AI Business Manager — Requirements

## 1. What it does
A small business owner types plain sentences ("I sold 3 shirts at K150 each, customer
paid K300") or asks questions ("Who owes me money?"). The AI extracts structured data;
the backend does all arithmetic, storage, and reporting — the AI never invents numbers,
it only interprets language and reads back what the backend already computed.

## 2. Core entities (data model)
- **Business** — one per owner/shop. Has a plan (free/basic/pro/business) and a
  transaction quota.
- **Transaction** — a sale, expense, or purchase (restock). Sales link to a customer
  name and track amount paid vs. total, so partial payments become debt automatically.
- **Inventory item** — stock count per product, adjusted automatically: sales decrement
  it, purchases increment it.
- **Customer** — derived from transactions; aggregate debt per name.

## 3. Functional requirements
- Free-text entry → structured transaction, recorded with no manual form-filling.
- Free-text question → answered using real computed numbers (sales, profit, debts,
  top-selling products, affordability checks), not model guesses.
- Daily and monthly reports (revenue, expenses, profit).
- Debt list per customer.
- Inventory levels, with a fast-moving/slow-moving view.
- Plan-based transaction limits enforced server-side.
- Owner-only admin console to see all businesses, usage, and revenue.

## 4. Non-functional / security requirements
- AI API key stays server-side only.
- Every write is tied to an authenticated business — no cross-business data leakage.
- Admin routes gated by an email allowlist, checked server-side on every request.
- Rate limiting on entry/question endpoints (they call a paid API).
- Data persisted in a real database (SQLite file to start — swap for Postgres at scale).

## 5. Business model → enforcement
| Plan | Price | Transactions/month | Enforced by |
|---|---|---|---|
| Free | K0 | 30 | `PLAN_LIMITS.free` in server.js |
| Basic | K50–100/mo | 300 | Stripe subscription → webhook sets plan |
| Pro | K150–300/mo | 2,000 | Stripe subscription → webhook sets plan |
| Business | custom | unlimited | manually set via admin console |

Note: Stripe doesn't support payouts to Zambia directly. For K (Kwacha) billing,
**Flutterwave** or **Paystack** are the standard alternatives and support mobile money
(MTN/Airtel) — the billing routes in `server.js` are written against Stripe's API since
it's the most portable to demonstrate, but swapping the `stripe.*` calls for
Flutterwave's equivalent endpoints is a contained change, isolated to `server.js`'s
billing section.

## 6. Tech stack
- Backend: Node.js + Express
- Database: SQLite via `better-sqlite3` (single file, no separate DB server to run)
- AI: Claude API (parsing + question-answering), called server-side only
- Billing: Stripe (swap for Flutterwave/Paystack for Zambia — see above)
- Frontend: React app (chat-style entry + dashboard), separate admin console
