import Database from "better-sqlite3";

// A single file on disk — persists across restarts, no separate DB server needed.
// For >1 server instance or heavier load, swap this file for Postgres (schema translates directly).
const db = new Database("bizmanager.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL,
  type TEXT NOT NULL,             -- 'sale' | 'expense' | 'purchase'
  item TEXT,
  quantity REAL,
  unit_price REAL,
  total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  customer_name TEXT,
  raw_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS inventory (
  business_id TEXT NOT NULL,
  item TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_id, item)
);

CREATE TABLE IF NOT EXISTS customers (
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  total_debt REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_id, name)
);
`);

// --- Businesses -----------------------------------------------------------
export function getOrCreateBusiness(email, name) {
  const existing = db.prepare("SELECT * FROM businesses WHERE email = ?").get(email);
  if (existing) return existing;
  const id = Buffer.from(email).toString("base64url");
  db.prepare("INSERT INTO businesses (id, email, name) VALUES (?, ?, ?)").run(id, email, name || email.split("@")[0]);
  return db.prepare("SELECT * FROM businesses WHERE id = ?").get(id);
}

export function getBusiness(id) {
  return db.prepare("SELECT * FROM businesses WHERE id = ?").get(id);
}

export function setBusinessPlan(id, plan) {
  db.prepare("UPDATE businesses SET plan = ? WHERE id = ?").run(plan, id);
}

export function setStripeCustomer(id, stripeCustomerId) {
  db.prepare("UPDATE businesses SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, id);
}

export function findBusinessByStripeCustomer(stripeCustomerId) {
  return db.prepare("SELECT * FROM businesses WHERE stripe_customer_id = ?").get(stripeCustomerId);
}

export function getAllBusinesses() {
  return db.prepare("SELECT * FROM businesses ORDER BY created_at DESC").all();
}

// --- Transactions + side effects (inventory, debt) -------------------------
export function recordTransaction(businessId, parsed, rawText) {
  const { type, item, quantity, unit_price, total, amount_paid, customer_name } = parsed;

  const insert = db.prepare(`
    INSERT INTO transactions (business_id, type, item, quantity, unit_price, total, amount_paid, customer_name, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insert.run(
    businessId, type, item || null, quantity || null, unit_price || null,
    total || 0, amount_paid || 0, customer_name || null, rawText
  );

  if (item && (type === "sale" || type === "purchase")) {
    const delta = type === "sale" ? -(quantity || 0) : (quantity || 0);
    const row = db.prepare("SELECT quantity FROM inventory WHERE business_id = ? AND item = ?").get(businessId, item);
    const newQty = (row?.quantity || 0) + delta;
    db.prepare(`
      INSERT INTO inventory (business_id, item, quantity, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(business_id, item) DO UPDATE SET quantity = ?, updated_at = datetime('now')
    `).run(businessId, item, newQty, newQty);
  }

  if (type === "sale" && customer_name) {
    const debtDelta = (total || 0) - (amount_paid || 0);
    if (debtDelta !== 0) {
      const row = db.prepare("SELECT total_debt FROM customers WHERE business_id = ? AND name = ?").get(businessId, customer_name);
      const newDebt = (row?.total_debt || 0) + debtDelta;
      db.prepare(`
        INSERT INTO customers (business_id, name, total_debt, updated_at) VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(business_id, name) DO UPDATE SET total_debt = ?, updated_at = datetime('now')
      `).run(businessId, customer_name, newDebt, newDebt);
    }
  }

  return result.lastInsertRowid;
}

export function getTransactionCountThisMonth(businessId) {
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM transactions
    WHERE business_id = ? AND created_at >= datetime('now', 'start of month')
  `).get(businessId);
  return row.n;
}

// --- Reporting / snapshot for the AI to answer questions from ---------------
export function getSnapshot(businessId) {
  const sumSince = (since, type) =>
    db.prepare(`SELECT COALESCE(SUM(total),0) as s FROM transactions WHERE business_id = ? AND type = ? AND created_at >= ?`)
      .get(businessId, type, since).s;

  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekIso = startOfWeek.toISOString().slice(0, 10);
  const monthIso = startOfMonth.toISOString().slice(0, 10);

  const weekSales = sumSince(weekIso, "sale");
  const weekExpenses = sumSince(weekIso, "expense") + sumSince(weekIso, "purchase");
  const monthSales = sumSince(monthIso, "sale");
  const monthExpenses = sumSince(monthIso, "expense") + sumSince(monthIso, "purchase");

  const topProducts = db.prepare(`
    SELECT item, SUM(quantity) as qty, SUM(total) as revenue
    FROM transactions WHERE business_id = ? AND type = 'sale' AND item IS NOT NULL
    GROUP BY item ORDER BY qty DESC LIMIT 5
  `).all(businessId);

  const debts = db.prepare(`
    SELECT name, total_debt FROM customers WHERE business_id = ? AND total_debt > 0 ORDER BY total_debt DESC
  `).all(businessId);

  const inventory = db.prepare(`
    SELECT item, quantity FROM inventory WHERE business_id = ? ORDER BY item
  `).all(businessId);

  const cashOnHand = db.prepare(`
    SELECT COALESCE(SUM(amount_paid),0) as paid_in, 
           (SELECT COALESCE(SUM(total),0) FROM transactions WHERE business_id = ? AND type IN ('expense','purchase')) as paid_out
    FROM transactions WHERE business_id = ? AND type = 'sale'
  `).get(businessId, businessId);

  return {
    week: { sales: weekSales, expenses: weekExpenses, profit: weekSales - weekExpenses },
    month: { sales: monthSales, expenses: monthExpenses, profit: monthSales - monthExpenses },
    topProducts,
    debts,
    totalDebt: debts.reduce((s, d) => s + d.total_debt, 0),
    inventory,
    estimatedCash: (cashOnHand.paid_in || 0) - (cashOnHand.paid_out || 0),
  };
}

export function getRecentTransactions(businessId, limit = 20) {
  return db.prepare(`SELECT * FROM transactions WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`).all(businessId, limit);
}

export default db;
