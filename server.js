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

/* =========================================================
   CONFIGURATION
========================================================= */

const JWT_SECRET = process.env.JWT_SECRET;

const CURRENCY = process.env.CURRENCY || "K";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || "sk_test_placeholder"
);

const ADMIN_EMAILS = (
  process.env.ADMIN_EMAILS ||
  "michaelchilano07@gmail.com"
)
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const PLAN_LIMITS = {
  free: 30,
  basic: 300,
  pro: 2000,
  business: Infinity,
};

/* =========================================================
   REQUIRED ENVIRONMENT VARIABLES
========================================================= */

if (!JWT_SECRET) {
  console.warn(
    "WARNING: JWT_SECRET is not configured."
  );
}

/* =========================================================
   CORS
========================================================= */

const allowedOrigins = [
  "https://ai-business-manager-frontend-azfs.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      /*
       * Allow requests without an Origin header.
       * This is useful for server-to-server requests,
       * health checks and direct requests.
       */
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("Blocked CORS origin:", origin);

      return callback(
        new Error("Not allowed by CORS")
      );
    },

    credentials: true,

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Stripe-Signature",
    ],
  })
);

/* =========================================================
   SECURITY
========================================================= */

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

/* =========================================================
   STRIPE WEBHOOK
   IMPORTANT:
   MUST COME BEFORE express.json()
========================================================= */

app.post(
  "/api/billing/webhook",
  express.raw({
    type: "application/json",
  }),
  (req, res) => {
    let event;

    try {
      const signature =
        req.headers["stripe-signature"];

      if (!signature) {
        return res.status(400).send(
          "Missing Stripe signature"
        );
      }

      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(500).send(
          "Stripe webhook secret not configured"
        );
      }

      event =
        stripe.webhooks.constructEvent(
          req.body,
          signature,
          process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
      console.error(
        "Stripe webhook verification failed:",
        err.message
      );

      return res
        .status(400)
        .send(
          `Webhook signature verification failed: ${err.message}`
        );
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session =
            event.data.object;

          const businessId =
            session.client_reference_id;

          const plan =
            session.metadata?.plan || "basic";

          if (businessId) {
            setStripeCustomer(
              businessId,
              session.customer
            );

            setBusinessPlan(
              businessId,
              plan
            );
          }

          break;
        }

        case "customer.subscription.deleted": {
          const subscription =
            event.data.object;

          const business =
            findBusinessByStripeCustomer(
              subscription.customer
            );

          if (business) {
            setBusinessPlan(
              business.id,
              "free"
            );
          }

          break;
        }

        default:
          console.log(
            "Unhandled Stripe event:",
            event.type
          );
      }

      return res.json({
        received: true,
      });
    } catch (err) {
      console.error(
        "Webhook processing error:",
        err
      );

      return res.status(500).json({
        error:
          "webhook_processing_failed",
      });
    }
  }
);

/* =========================================================
   JSON BODY PARSER
========================================================= */

app.use(
  express.json({
    limit: "1mb",
  })
);

/* =========================================================
   RATE LIMITERS
========================================================= */

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,

  standardHeaders: true,

  legacyHeaders: false,

  message: {
    error: "too_many_requests",
    message:
      "Too many AI requests. Please try again later.",
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,

  standardHeaders: true,

  legacyHeaders: false,

  message: {
    error:
      "too_many_login_attempts",
    message:
      "Too many login attempts. Please try again later.",
  },
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",

    message:
      "AI Business Manager backend is running",

    environment:
      process.env.NODE_ENV ||
      "production",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

/* =========================================================
   AUTHENTICATION
========================================================= */

app.post(
  "/api/auth/dev-login",
  authLimiter,
  (req, res) => {
    try {
      const {
        email,
        businessName,
      } = req.body;

      if (
        !email ||
        typeof email !== "string"
      ) {
        return res.status(400).json({
          error: "email_required",

          message:
            "Email is required.",
        });
      }

      if (!JWT_SECRET) {
        return res.status(500).json({
          error:
            "server_configuration_error",

          message:
            "JWT_SECRET is not configured.",
        });
      }

      const normalizedEmail =
        email
          .toLowerCase()
          .trim();

      const business =
        getOrCreateBusiness(
          normalizedEmail,
          businessName
        );

      const token = jwt.sign(
        {
          id: business.id,
          email:
            business.email,
        },

        JWT_SECRET,

        {
          expiresIn: "30d",
        }
      );

      return res.json({
        token,
        business,
      });
    } catch (err) {
      console.error(
        "Login error:",
        err
      );

      return res.status(500).json({
        error: "login_failed",

        message:
          "Unable to log in.",
      });
    }
  }
);

/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

function requireAuth(
  req,
  res,
  next
) {
  const authorization =
    req.headers.authorization || "";

  const token =
    authorization.startsWith(
      "Bearer "
    )
      ? authorization.slice(7)
      : null;

  if (!token) {
    return res.status(401).json({
      error: "missing_token",

      message:
        "Authentication token is required.",
    });
  }

  if (!JWT_SECRET) {
    return res.status(500).json({
      error:
        "server_configuration_error",

      message:
        "JWT_SECRET is not configured.",
    });
  }

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    req.business =
      decoded;

    next();
  } catch (err) {
    console.error(
      "JWT verification failed:",
      err.message
    );

    return res.status(401).json({
      error: "invalid_token",

      message:
        "Your session is invalid or expired.",
    });
  }
}

/* =========================================================
   ADMIN MIDDLEWARE
========================================================= */

function requireAdmin(
  req,
  res,
  next
) {
  const email = (
    req.business?.email || ""
  )
    .toLowerCase()
    .trim();

  if (
    !ADMIN_EMAILS.includes(email)
  ) {
    return res.status(403).json({
      error: "forbidden",

      message:
        "Administrator access required.",
    });
  }

  next();
}

/* =========================================================
   RECORD TRANSACTION
========================================================= */

app.post(
  "/api/entry",
  requireAuth,
  aiLimiter,
  async (req, res) => {
    try {
      const { text } =
        req.body;

      if (
        !text ||
        typeof text !== "string" ||
        !text.trim()
      ) {
        return res.status(400).json({
          error: "text_required",

          message:
            "Please enter a business transaction.",
        });
      }

      const business =
        getBusiness(
          req.business.id
        );

      if (!business) {
        return res.status(404).json({
          error:
            "business_not_found",
        });
      }

      const used =
        getTransactionCountThisMonth(
          business.id
        );

      const limit =
        PLAN_LIMITS[
          business.plan
        ] ??
        PLAN_LIMITS.free;

      if (used >= limit) {
        return res.status(402).json({
          error:
            "limit_reached",

          message:
            `Monthly transaction limit (${limit}) reached for the ${business.plan} plan.`,
        });
      }

      const parsed =
        await parseEntry(
          text.trim()
        );

      if (
        !parsed ||
        parsed.type ===
          "unknown"
      ) {
        return res.json({
          recorded: false,

          message:
            "I couldn't tell what business event that was. Try something like 'sold 3 shirts at K150 each'.",
        });
      }

      const id =
        recordTransaction(
          business.id,
          parsed,
          text.trim()
        );

      return res.json({
        recorded: true,
        id,
        parsed,
      });
    } catch (err) {
      console.error(
        "Entry error:",
        err
      );

      return res.status(500).json({
        error:
          "entry_failed",

        message:
          "Unable to record the transaction.",
      });
    }
  }
);

/* =========================================================
   ASK AI
========================================================= */

app.post(
  "/api/ask",
  requireAuth,
  aiLimiter,
  async (req, res) => {
    try {
      const { question } =
        req.body;

      if (
        !question ||
        typeof question !== "string" ||
        !question.trim()
      ) {
        return res.status(400).json({
          error:
            "question_required",

          message:
            "Please enter a question.",
        });
      }

      const snapshot =
        getSnapshot(
          req.business.id
        );

      const answer =
        await answerQuestion(
          question.trim(),
          snapshot,
          CURRENCY
        );

      return res.json({
        answer,
        snapshot,
      });
    } catch (err) {
      console.error(
        "AI question error:",
        err
      );

      return res.status(500).json({
        error:
          "question_failed",

        message:
          "Unable to answer the question.",
      });
    }
  }
);

/* =========================================================
   REPORT SNAPSHOT
========================================================= */

app.get(
  "/api/reports/snapshot",
  requireAuth,
  (req, res) => {
    try {
      const snapshot =
        getSnapshot(
          req.business.id
        );

      return res.json(
        snapshot
      );
    } catch (err) {
      console.error(
        "Snapshot error:",
        err
      );

      return res.status(500).json({
        error:
          "snapshot_failed",
      });
    }
  }
);

/* =========================================================
   TRANSACTIONS
========================================================= */

app.get(
  "/api/transactions",
  requireAuth,
  (req, res) => {
    try {
      const transactions =
        getRecentTransactions(
          req.business.id,
          50
        );

      return res.json({
        transactions,
      });
    } catch (err) {
      console.error(
        "Transactions error:",
        err
      );

      return res.status(500).json({
        error:
          "transactions_failed",
      });
    }
  }
);

/* =========================================================
   PLAN
========================================================= */

app.get(
  "/api/plan",
  requireAuth,
  (req, res) => {
    try {
      const business =
        getBusiness(
          req.business.id
        );

      if (!business) {
        return res.status(404).json({
          error:
            "business_not_found",
        });
      }

      const used =
        getTransactionCountThisMonth(
          business.id
        );

      const limit =
        PLAN_LIMITS[
          business.plan
        ] ??
        PLAN_LIMITS.free;

      return res.json({
        plan: business.plan,
        used,
        limit,
      });
    } catch (err) {
      console.error(
        "Plan error:",
        err
      );

      return res.status(500).json({
        error:
          "plan_failed",
      });
    }
  }
);

/* =========================================================
   STRIPE CHECKOUT
========================================================= */

app.post(
  "/api/billing/checkout",
  requireAuth,
  async (req, res) => {
    try {
      const { plan } =
        req.body;

      if (
        !["basic", "pro"].includes(
          plan
        )
      ) {
        return res.status(400).json({
          error:
            "invalid_plan",

          message:
            "Plan must be basic or pro.",
        });
      }

      const priceId =
        plan === "pro"
          ? process.env
              .STRIPE_PRICE_ID_PRO
          : process.env
              .STRIPE_PRICE_ID_BASIC;

      if (!priceId) {
        return res.status(500).json({
          error:
            "stripe_price_not_configured",

          message:
            "Stripe price is not configured.",
        });
      }

      const business =
        getBusiness(
          req.business.id
        );

      if (!business) {
        return res.status(404).json({
          error:
            "business_not_found",
        });
      }

      const appUrl =
        process.env.APP_URL ||
        "https://ai-business-manager-frontend-azfs.vercel.app";

      const session =
        await stripe.checkout.sessions.create(
          {
            mode:
              "subscription",

            payment_method_types: [
              "card",
            ],

            line_items: [
              {
                price:
                  priceId,

                quantity: 1,
              },
            ],

            client_reference_id:
              business.id,

            customer_email:
              business.email,

            metadata: {
              plan,
            },

            success_url:
              `${appUrl}/billing/success`,

            cancel_url:
              `${appUrl}/billing/cancel`,
          }
        );

      return res.json({
        url: session.url,
      });
    } catch (err) {
      console.error(
        "Stripe checkout error:",
        err
      );

      return res.status(500).json({
        error:
          "checkout_failed",

        message:
          "Unable to create checkout session.",
      });
    }
  }
);

/* =========================================================
   ADMIN OVERVIEW
========================================================= */

app.get(
  "/api/admin/overview",
  requireAuth,
  requireAdmin,
  (req, res) => {
    try {
      const businesses =
        getAllBusinesses();

      const byPlan =
        businesses.reduce(
          (acc, business) => {
            acc[business.plan] =
              (acc[
                business.plan
              ] || 0) + 1;

            return acc;
          },
          {}
        );

      return res.json({
        totalBusinesses:
          businesses.length,

        byPlan,
      });
    } catch (err) {
      console.error(
        "Admin overview error:",
        err
      );

      return res.status(500).json({
        error:
          "admin_overview_failed",
      });
    }
  }
);

/* =========================================================
   ADMIN BUSINESSES
========================================================= */

app.get(
  "/api/admin/businesses",
  requireAuth,
  requireAdmin,
  (req, res) => {
    try {
      const businesses =
        getAllBusinesses().map(
          (business) => ({
            id:
              business.id,

            email:
              business.email,

            name:
              business.name,

            plan:
              business.plan,

            usedThisMonth:
              getTransactionCountThisMonth(
                business.id
              ),

            createdAt:
              business.created_at,
          })
        );

      return res.json({
        businesses,
      });
    } catch (err) {
      console.error(
        "Admin businesses error:",
        err
      );

      return res.status(500).json({
        error:
          "admin_businesses_failed",
      });
    }
  }
);

/* =========================================================
   ADMIN CHANGE PLAN
========================================================= */

app.post(
  "/api/admin/businesses/:id/plan",
  requireAuth,
  requireAdmin,
  (req, res) => {
    try {
      const { plan } =
        req.body;

      const validPlans = [
        "free",
        "basic",
        "pro",
        "business",
      ];

      if (
        !validPlans.includes(
          plan
        )
      ) {
        return res.status(400).json({
          error:
            "invalid_plan",
        });
      }

      const business =
        getBusiness(
          req.params.id
        );

      if (!business) {
        return res.status(404).json({
          error:
            "business_not_found",
        });
      }

      setBusinessPlan(
        req.params.id,
        plan
      );

      return res.json({
        ok: true,
      });
    } catch (err) {
      console.error(
        "Admin plan update error:",
        err
      );

      return res.status(500).json({
        error:
          "plan_update_failed",
      });
    }
  }
);

/* =========================================================
   404 HANDLER
========================================================= */

app.use(
  (req, res) => {
    return res.status(404).json({
      error: "not_found",

      message:
        `Route ${req.method} ${req.originalUrl} not found.`,
    });
  }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "Unhandled server error:",
      err
    );

    if (
      err.message ===
      "Not allowed by CORS"
    ) {
      return res.status(403).json({
        error:
          "cors_error",

        message:
          "This website is not allowed to access the API.",
      });
    }

    return res.status(500).json({
      error:
        "internal_server_error",

      message:
        "An unexpected server error occurred.",
    });
  }
);

/* =========================================================
   VERCEL EXPORT
   DO NOT USE app.listen()
========================================================= */

export default app;
