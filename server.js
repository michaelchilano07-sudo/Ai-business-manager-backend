import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import {
  getOrCreateBusiness,
  getBusiness,
  setBusinessPlan,
  setStripeCustomer,
  findBusinessByStripeCustomer,
  getAllBusinesses,
  recordTransaction,
  getTransactionCountThisMonth,
  getSnapshot,
  getRecentTransactions,
} from "./db.js";
import { parseEntry, answerQuestion } from "./ai.js";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");
const CURRENCY = process.env.CURRENCY || "K";

// Real access control for /api/admin/* — set in your host's env vars, never in source.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "michaelchilano07@gmail.com")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

const PLAN_LIMITS = { free: 30, basic: 300, pro: 2000, business: Infinity };

// Stripe webhook needs the raw body — registered before express.json()
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const businessId = session.client_reference_id;
    const plan = session.metadata?.plan || "basic";
    if (businessId) {
      setStripeCustomer(businessId, session.customer);
      setBusinessPlan(businessId, plan);
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const biz = findBusinessByStripeCustomer(sub.customer);
    if (biz) setBusinessPlan(biz.id, "free");
  }
  res.json({ received: true });
});

app.use(helmet());
app.use(cors({ origin: process.env.APP_URL || "*" }));
app.use(express.json());

const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// --- Auth -------------------------------------------------------------
// Demo-only: issues a token for any email, no password. Swap for a real provider before launch.
app.post("/api/auth/dev-login", authLimiter, (req, res) => {
  const { email, businessName } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });
  const biz = getOrCreateBusiness(email.toLowerCase().trim(), businessName);
  const token = jwt.sign({ id: biz.id, email: biz.email }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, business: biz });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });
  try {
    req.business = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_EMAILS.includes((req.business.email || "").toLowerCase())) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

// --- Core: log a transaction from free text ------------------------------
app.post("/api/entry", requireAuth, aiLimiter, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text required" });

  const biz = getBusiness(req.business.id);
  const used = getTransactionCountThisMonth(biz.id);
  const limit = PLAN_LIMITS[biz.plan] ?? PLAN_LIMITS.free;
  if (used >= limit) {
    return res.status(402).json({ error: "limit_reached", message: `Monthly transaction limit (${limit}) reached for the ${biz.plan} plan.` });
  }

  const parsed = await parseEntry(text);
  if (parsed.type === "unknown") {
    return res.json({ recorded: false, message: "I couldn't tell what business event that was — try rephrasing, e.g. 'sold 3 shirts at K150 each'." });
  }
  const id = recordTransaction(biz.id, parsed, text);
  res.json({ recorded: true, id, parsed });
});

// --- Core: ask a question, answered from real computed numbers -----------
app.post("/api/ask", requireAuth, aiLimiter, async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: "question required" });
  const snapshot = getSnapshot(req.business.id);
  const answer = await answerQuestion(question, snapshot, CURRENCY);
  res.json({ answer, snapshot });
});

// --- Reports / raw data ----------------------------------------------------
app.get("/api/reports/snapshot", requireAuth, (req, res) => {
  res.json(getSnapshot(req.business.id));
});

app.get("/api/transactions", requireAuth, (req, res) => {
  res.json({ transactions: getRecentTransactions(req.business.id, 50) });
});

app.get("/api/plan", requireAuth, (req, res) => {
  const biz = getBusiness(req.business.id);
  const used = getTransactionCountThisMonth(biz.id);
  res.json({ plan: biz.plan, used, limit: PLAN_LIMITS[biz.plan] ?? PLAN_LIMITS.free });
});

// --- Billing ----------------------------------------------------------------
// NOTE: Stripe payouts don't reach Zambia directly — for K billing use Flutterwave
// or Paystack instead; the shape of these two routes stays the same either way.
app.post("/api/billing/checkout", requireAuth, async (req, res) => {
  const { plan } = req.body; // 'basic' | 'pro'
  const priceId = plan === "pro" ? process.env.STRIPE_PRICE_ID_PRO : process.env.STRIPE_PRICE_ID_BASIC;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: req.business.id,
    customer_email: req.business.email,
    metadata: { plan },
    success_url: `${process.env.APP_URL}/billing/success`,
    cancel_url: `${process.env.APP_URL}/billing/cancel`,
  });
  res.json({ url: session.url });
});

// --- Admin (michaelchilano07@gmail.com by default) -------------------------
app.get("/api/admin/overview", requireAuth, requireAdmin, (req, res) => {
  const businesses = getAllBusinesses();
  const byPlan = businesses.reduce((acc, b) => ({ ...acc, [b.plan]: (acc[b.plan] || 0) + 1 }), {});
  res.json({ totalBusinesses: businesses.length, byPlan });
});

app.get("/api/admin/businesses", requireAuth, requireAdmin, (req, res) => {
  const businesses = getAllBusinesses().map((b) => ({
    id: b.id,
    email: b.email,
    name: b.name,
    plan: b.plan,
    usedThisMonth: getTransactionCountThisMonth(b.id),
    createdAt: b.created_at,
  }));
  res.json({ businesses });
});

app.post("/api/admin/businesses/:id/plan", requireAuth, requireAdmin, (req, res) => {
  const { plan } = req.body;
  if (!["free", "basic", "pro", "business"].includes(plan)) return res.status(400).json({ error: "invalid_plan" });
  setBusinessPlan(req.params.id, plan);
  res.json({ ok: true });
});
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "AI Business Manager backend is running"
  });
});
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AI Business Manager backend running on :${port}`));
