import { neon } from "@neondatabase/serverless";

const DATABASE_URL =
  process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    "WARNING: DATABASE_URL is not configured."
  );
}

const sql = neon(
  DATABASE_URL || ""
);

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

let initializationPromise = null;

async function initializeDatabase() {
  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not configured."
    );
  }

  await sql`
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      type TEXT NOT NULL,
      item TEXT,
      quantity DOUBLE PRECISION,
      unit_price DOUBLE PRECISION,
      total DOUBLE PRECISION NOT NULL DEFAULT 0,
      amount_paid DOUBLE PRECISION NOT NULL DEFAULT 0,
      customer_name TEXT,
      raw_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS inventory (
      business_id TEXT NOT NULL,
      item TEXT NOT NULL,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, item),
      FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS customers (
      business_id TEXT NOT NULL,
      name TEXT NOT NULL,
      total_debt DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (business_id, name),
      FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_transactions_business
    ON transactions(business_id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_transactions_created
    ON transactions(created_at)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_transactions_business_created
    ON transactions(business_id, created_at)
  `;
}

async function ensureDatabase() {
  if (!initializationPromise) {
    initializationPromise =
      initializeDatabase().catch(
        (error) => {
          initializationPromise = null;
          throw error;
        }
      );
  }

  return initializationPromise;
}

/* =========================================================
   BUSINESSES
========================================================= */

export async function getOrCreateBusiness(
  email,
  name
) {
  await ensureDatabase();

  const existing =
    await sql`
      SELECT *
      FROM businesses
      WHERE email = ${email}
      LIMIT 1
    `;

  if (existing.length > 0) {
    return existing[0];
  }

  const id =
    Buffer.from(email)
      .toString("base64url");

  const businessName =
    name ||
    email.split("@")[0];

  await sql`
    INSERT INTO businesses (
      id,
      email,
      name
    )
    VALUES (
      ${id},
      ${email},
      ${businessName}
    )
    ON CONFLICT (email)
    DO NOTHING
  `;

  const created =
    await sql`
      SELECT *
      FROM businesses
      WHERE email = ${email}
      LIMIT 1
    `;

  return created[0];
}

export async function getBusiness(
  id
) {
  await ensureDatabase();

  const result =
    await sql`
      SELECT *
      FROM businesses
      WHERE id = ${id}
      LIMIT 1
    `;

  return result[0] || null;
}

export async function setBusinessPlan(
  id,
  plan
) {
  await ensureDatabase();

  await sql`
    UPDATE businesses
    SET plan = ${plan}
    WHERE id = ${id}
  `;
}

export async function setStripeCustomer(
  id,
  stripeCustomerId
) {
  await ensureDatabase();

  await sql`
    UPDATE businesses
    SET stripe_customer_id =
      ${stripeCustomerId}
    WHERE id = ${id}
  `;
}

export async function findBusinessByStripeCustomer(
  stripeCustomerId
) {
  await ensureDatabase();

  const result =
    await sql`
      SELECT *
      FROM businesses
      WHERE stripe_customer_id =
        ${stripeCustomerId}
      LIMIT 1
    `;

  return result[0] || null;
}

export async function getAllBusinesses() {
  await ensureDatabase();

  return await sql`
    SELECT *
    FROM businesses
    ORDER BY created_at DESC
  `;
}

/* =========================================================
   TRANSACTIONS
========================================================= */

export async function recordTransaction(
  businessId,
  parsed,
  rawText
) {
  await ensureDatabase();

  const {
    type,
    item,
    quantity,
    unit_price,
    total,
    amount_paid,
    customer_name,
  } = parsed;

  const safeQuantity =
    Number.isFinite(
      Number(quantity)
    )
      ? Number(quantity)
      : 0;

  const safeUnitPrice =
    Number.isFinite(
      Number(unit_price)
    )
      ? Number(unit_price)
      : 0;

  const safeTotal =
    Number.isFinite(
      Number(total)
    )
      ? Number(total)
      : 0;

  const safeAmountPaid =
    Number.isFinite(
      Number(amount_paid)
    )
      ? Number(amount_paid)
      : 0;

  const transaction =
    await sql`
      INSERT INTO transactions (
        business_id,
        type,
        item,
        quantity,
        unit_price,
        total,
        amount_paid,
        customer_name,
        raw_text
      )
      VALUES (
        ${businessId},
        ${type},
        ${item || null},
        ${safeQuantity || null},
        ${safeUnitPrice || null},
        ${safeTotal},
        ${safeAmountPaid},
        ${customer_name || null},
        ${rawText}
      )
      RETURNING id
    `;

  /*
   * Inventory
   */

  if (
    item &&
    (type === "sale" ||
      type === "purchase")
  ) {
    const delta =
      type === "sale"
        ? -safeQuantity
        : safeQuantity;

    const inventory =
      await sql`
        SELECT quantity
        FROM inventory
        WHERE business_id =
          ${businessId}
        AND item = ${item}
        LIMIT 1
      `;

    const currentQuantity =
      inventory.length > 0
        ? Number(
            inventory[0].quantity
          )
        : 0;

    const newQuantity =
      currentQuantity + delta;

    await sql`
      INSERT INTO inventory (
        business_id,
        item,
        quantity,
        updated_at
      )
      VALUES (
        ${businessId},
        ${item},
        ${newQuantity},
        NOW()
      )
      ON CONFLICT (
        business_id,
        item
      )
      DO UPDATE SET
        quantity =
          EXCLUDED.quantity,
        updated_at = NOW()
    `;
  }

  /*
   * Customer debt
   */

  if (
    type === "sale" &&
    customer_name
  ) {
    const debtDelta =
      safeTotal -
      safeAmountPaid;

    if (debtDelta !== 0) {
      const customer =
        await sql`
          SELECT total_debt
          FROM customers
          WHERE business_id =
            ${businessId}
          AND name =
            ${customer_name}
          LIMIT 1
        `;

      const currentDebt =
        customer.length > 0
          ? Number(
              customer[0].total_debt
            )
          : 0;

      const newDebt =
        currentDebt +
        debtDelta;

      await sql`
        INSERT INTO customers (
          business_id,
          name,
          total_debt,
          updated_at
        )
        VALUES (
          ${businessId},
          ${customer_name},
          ${newDebt},
          NOW()
        )
        ON CONFLICT (
          business_id,
          name
        )
        DO UPDATE SET
          total_debt =
            EXCLUDED.total_debt,
          updated_at = NOW()
      `;
    }
  }

  return Number(
    transaction[0].id
  );
}

/* =========================================================
   MONTHLY TRANSACTION COUNT
========================================================= */

export async function getTransactionCountThisMonth(
  businessId
) {
  await ensureDatabase();

  const result =
    await sql`
      SELECT COUNT(*)::int AS count
      FROM transactions
      WHERE business_id =
        ${businessId}
      AND created_at >=
        DATE_TRUNC(
          'month',
          NOW()
        )
    `;

  return Number(
    result[0]?.count || 0
  );
}

/* =========================================================
   SNAPSHOT
========================================================= */

export async function getSnapshot(
  businessId
) {
  await ensureDatabase();

  const weekSales =
    await sql`
      SELECT COALESCE(
        SUM(total),
        0
      ) AS total
      FROM transactions
      WHERE business_id =
        ${businessId}
      AND type = 'sale'
      AND created_at >=
        DATE_TRUNC(
          'week',
          NOW()
        )
    `;

  const weekExpenses =
    await sql`
      SELECT COALESCE(
        SUM(total),
        0
      ) AS total
      FROM transactions
      WHERE business_id =
        ${businessId}
      AND type IN (
        'expense',
        'purchase'
      )
      AND created_at >=
        DATE_TRUNC(
          'week',
          NOW()
        )
    `;

  const monthSales =
    await sql`
      SELECT COALESCE(
        SUM(total),
        0
      ) AS total
      FROM transactions
      WHERE business_id =
        ${businessId}
      AND type = 'sale'
      AND created_at >=
        DATE_TRUNC(
          'month',
          NOW()
        )
    `;

  const monthExpenses =
    await sql`
      SELECT COALESCE(
        SUM(total),
        0
      ) AS total
      FROM transactions
      WHERE business_id =
        ${businessId}
      AND type IN (
        'expense',
        'purchase'
      )
      AND created_at >=
        DATE_TRUNC(
          'month',
          NOW()
        )
    `;

  const topProducts =
    await sql`
      SELECT
        item,
        COALESCE(
          SUM(quantity),
          0
        ) AS qty,
        COALESCE(
          SUM(total),
          0
        ) AS revenue
      FROM transactions
      WHERE business_id =
        ${businessId}
      AND type = 'sale'
      AND item IS NOT NULL
      GROUP BY item
      ORDER BY qty DESC
      LIMIT 5
    `;

  const debts =
    await sql`
      SELECT
        name,
        total_debt
      FROM customers
      WHERE business_id =
        ${businessId}
      AND total_debt > 0
      ORDER BY total_debt DESC
    `;

  const inventory =
    await sql`
      SELECT
        item,
        quantity
      FROM inventory
      WHERE business_id =
        ${businessId}
      ORDER BY item
    `;

  const cash =
    await sql`
      SELECT
        COALESCE(
          (
            SELECT SUM(amount_paid)
            FROM transactions
            WHERE business_id =
              ${businessId}
            AND type = 'sale'
          ),
          0
        ) AS paid_in,

        COALESCE(
          (
            SELECT SUM(total)
            FROM transactions
            WHERE business_id =
              ${businessId}
            AND type IN (
              'expense',
              'purchase'
            )
          ),
          0
        ) AS paid_out
    `;

  const weekSalesValue =
    Number(
      weekSales[0]?.total || 0
    );

  const weekExpensesValue =
    Number(
      weekExpenses[0]?.total ||
        0
    );

  const monthSalesValue =
    Number(
      monthSales[0]?.total || 0
    );

  const monthExpensesValue =
    Number(
      monthExpenses[0]?.total ||
        0
    );

  const totalDebt =
    debts.reduce(
      (sum, debt) =>
        sum +
        Number(
          debt.total_debt || 0
        ),
      0
    );

  const paidIn =
    Number(
      cash[0]?.paid_in || 0
    );

  const paidOut =
    Number(
      cash[0]?.paid_out || 0
    );

  return {
    week: {
      sales:
        weekSalesValue,

      expenses:
        weekExpensesValue,

      profit:
        weekSalesValue -
        weekExpensesValue,
    },

    month: {
      sales:
        monthSalesValue,

      expenses:
        monthExpensesValue,

      profit:
        monthSalesValue -
        monthExpensesValue,
    },

    topProducts:
      topProducts.map(
        (product) => ({
          item: product.item,
          qty: Number(
            product.qty || 0
          ),
          revenue: Number(
            product.revenue || 0
          ),
        })
      ),

    debts:
      debts.map((debt) => ({
        name: debt.name,
        total_debt: Number(
          debt.total_debt || 0
        ),
      })),

    totalDebt,

    inventory:
      inventory.map((row) => ({
        item: row.item,
        quantity: Number(
          row.quantity || 0
        ),
      })),

    estimatedCash:
      paidIn - paidOut,
  };
}

/* =========================================================
   RECENT TRANSACTIONS
========================================================= */

export async function getRecentTransactions(
  businessId,
  limit = 20
) {
  await ensureDatabase();

  const safeLimit = Math.min(
    Math.max(
      Number(limit) || 20,
      1
    ),
    100
  );

  return await sql`
    SELECT *
    FROM transactions
    WHERE business_id =
      ${businessId}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
}
