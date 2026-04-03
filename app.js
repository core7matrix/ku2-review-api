require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { URLSearchParams } = require("node:url");

const app = express();

const FETCH_TIMEOUT_MS = 15_000;
const IS_VERCEL = !!process.env.VERCEL;

/** Strip protocol, path, and trailing slash so URLs are always valid. */
function normalizeShopDomain(input) {
  if (!input) return "";
  let s = String(input).trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.split("/")[0] || "";
  s = s.split("?")[0] || "";
  return s.toLowerCase();
}

/**
 * GraphQL needs an exact GID. Webhook JSON parses `id` as a Number — values above
 * MAX_SAFE_INTEGER are corrupted. Prefer `admin_graphql_api_id` or read digits from raw body.
 */
function resolveProductGid(payload, rawBody) {
  if (typeof payload.admin_graphql_api_id === "string") {
    return payload.admin_graphql_api_id;
  }
  if (rawBody && typeof rawBody === "string") {
    const fromRawGid = rawBody.match(
      /"admin_graphql_api_id"\s*:\s*"(gid:\/\/shopify\/Product\/\d+)"/
    );
    if (fromRawGid) return fromRawGid[1];
    const fromRawId = rawBody.match(/"id"\s*:\s*(\d+)/);
    if (fromRawId) return `gid://shopify/Product/${fromRawId[1]}`;
  }
  if (payload.id != null) {
    const n = Number(payload.id);
    if (Number.isSafeInteger(n)) {
      return `gid://shopify/Product/${payload.id}`;
    }
    console.warn(
      "[WEBHOOK] Product id in payload is not a safe integer — add admin_graphql_api_id to webhook or ensure raw body id regex runs."
    );
  }
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONFIGURATION – edit these or set them in .env
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CONFIG = {
  shopifyStoreUrl: normalizeShopDomain(process.env.SHOPIFY_STORE_URL),
  clientId: String(process.env.SHOPIFY_CLIENT_ID || "").trim(),
  clientSecret: String(process.env.SHOPIFY_CLIENT_SECRET || "").trim(),
  apiVersion: process.env.SHOPIFY_API_VERSION || "2026-01",
  webhookSecret: process.env.WEBHOOK_SECRET,

  // ┌──────────────────────────────────────────────────────┐
  // │  REVIEW SOURCE – the metafield where your review     │
  // │  app (Judge.me, Loox, Yotpo, etc.) stores its JSON.  │
  // │  Change namespace + key to match YOUR review app.     │
  // └──────────────────────────────────────────────────────┘
  reviewMetafieldNamespace: process.env.REVIEW_METAFIELD_NAMESPACE || "air_reviews_product",
  reviewMetafieldKey: process.env.REVIEW_METAFIELD_KEY || "data",

  // ┌──────────────────────────────────────────────────────┐
  // │  AVERAGE REVIEW TARGET – the metafield you created    │
  // │  manually in Shopify admin to hold the integer avg.   │
  // └──────────────────────────────────────────────────────┘
  avgReviewMetafieldNamespace: process.env.AVG_REVIEW_METAFIELD_NAMESPACE || "custom",
  avgReviewMetafieldKey: process.env.AVG_REVIEW_METAFIELD_KEY || "average_review",
};

const PORT = process.env.PORT || 3000;

// Fail fast if required env vars are missing.
const REQUIRED_ENV = [
  ["SHOPIFY_STORE_URL", CONFIG.shopifyStoreUrl],
  ["SHOPIFY_CLIENT_ID", CONFIG.clientId],
  ["SHOPIFY_CLIENT_SECRET", CONFIG.clientSecret],
  ["WEBHOOK_SECRET", CONFIG.webhookSecret],
];
for (const [name, value] of REQUIRED_ENV) {
  if (!value || String(value).trim() === "") {
    console.error(`[CONFIG] Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  OAUTH TOKEN MANAGEMENT (client_credentials flow)
//  Tokens expire after 24 h. We cache the token, refresh
//  1 minute before expiry, and run a background timer every
//  23 h so the token stays valid even with no webhook traffic.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  console.log("[AUTH] Requesting new access token via client_credentials…");

  const tokenUrl = `https://${CONFIG.shopifyStoreUrl}/admin/oauth/access_token`;
  let response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    const c = err.cause;
    const extra = c
      ? ` ${c.code ? `[${c.code}] ` : ""}${c.message || c}`
      : "";
    throw new Error(
      `[AUTH] Network error requesting token from ${CONFIG.shopifyStoreUrl}: ${err.message || err}.${extra}`
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[AUTH] Token request failed (${response.status}): ${text}. ` +
        `Verify SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env match ` +
        `the app installed on ${CONFIG.shopifyStoreUrl}.`
    );
  }

  const { access_token, expires_in } = await response.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;

  const expiresInHours = (expires_in / 3600).toFixed(1);
  console.log(`[AUTH] ✔ Token acquired (expires in ${expiresInHours} h)`);
  return cachedToken;
}

/** Proactive background refresh — runs every 23 h so the token never goes stale. */
const REFRESH_INTERVAL_MS = 23 * 60 * 60 * 1000; // 23 hours
let refreshTimer = null;

function startTokenRefreshTimer() {
  if (IS_VERCEL) return; // Timers are useless in serverless; skip.
  if (refreshTimer) clearInterval(refreshTimer);

  refreshTimer = setInterval(async () => {
    try {
      console.log("[AUTH] Background token refresh triggered");
      await getToken();
    } catch (err) {
      console.error("[AUTH] Background refresh failed:", err.message || err);
    }
  }, REFRESH_INTERVAL_MS);

  refreshTimer.unref();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HMAC VERIFICATION MIDDLEWARE
//  Shopify signs every webhook with HMAC-SHA256. We verify
//  the signature before trusting the payload.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function verifyShopifyWebhook(req, res, next) {
  if (!CONFIG.webhookSecret) {
    console.error("[SECURITY] WEBHOOK_SECRET is not set");
    return res.status(503).send("Server misconfiguration");
  }

  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  if (!hmacHeader) {
    console.error("[SECURITY] Missing HMAC header – request rejected");
    return res.status(401).send("Unauthorized");
  }

  const generatedHmac = crypto
    .createHmac("sha256", CONFIG.webhookSecret)
    .update(req.rawBody, "utf8")
    .digest("base64");

  const isValid = crypto.timingSafeEqual(
    Buffer.from(generatedHmac),
    Buffer.from(hmacHeader)
  );

  if (!isValid) {
    console.error("[SECURITY] HMAC mismatch – request rejected");
    return res.status(401).send("Unauthorized");
  }

  next();
}

// Capture the raw body for HMAC verification, then parse JSON.
app.use(
  "/webhooks",
  express.json({
    verify(req, _res, buf) {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GRAPHQL HELPERS
//  Lightweight fetch-based client for Shopify Admin GraphQL.
//  No external SDK required – just native fetch (Node 18+).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const GRAPHQL_URL = () =>
  `https://${CONFIG.shopifyStoreUrl}/admin/api/${CONFIG.apiVersion}/graphql.json`;

async function shopifyGraphQL(query, variables = {}) {
  const url = GRAPHQL_URL();
  const accessToken = await getToken();
  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    const c = err.cause;
    const extra = c
      ? ` ${c.code ? `[${c.code}] ` : ""}${c.message || c}`
      : "";
    throw new Error(
      `Network error calling Shopify (${CONFIG.shopifyStoreUrl}): ${err.message || err}.${extra}`
    );
  }

  if (!res.ok) {
    const text = await res.text();

    // If a 401 happens mid-flight the token may have been revoked — force refresh on next call.
    if (res.status === 401) {
      cachedToken = null;
      tokenExpiresAt = 0;
    }

    throw new Error(`Shopify API ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// Retry wrapper – respects Shopify's rate-limit headers.
async function shopifyGraphQLWithRetry(query, variables = {}, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await shopifyGraphQL(query, variables);
    } catch (err) {
      const msg = err.message || "";
      const isRetryable =
        msg.includes("429") ||
        msg.includes("Throttled") ||
        msg.includes("401") ||
        msg.includes("fetch failed") ||
        msg.includes("Network error") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("abort");
      if (isRetryable && attempt < maxRetries) {
        const backoff = attempt * 2000;
        console.warn(
          `[RETRY] Attempt ${attempt}/${maxRetries} failed: ${msg}. Retrying in ${backoff}ms…`
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GRAPHQL QUERIES & MUTATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const GET_PRODUCT_METAFIELDS = `
  query GetProductMetafields($id: ID!) {
    product(id: $id) {
      id
      title
      metafields(first: 50) {
        edges {
          node {
            id
            namespace
            key
            value
            type
          }
        }
      }
    }
  }
`;

const SET_METAFIELDS = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REVIEW CALCULATION
//
//  Air Reviews stores data as:
//  {
//    "reviews": [],                     ← may be empty (paginated)
//    "reviewSummary": {
//      "one_star":   { "approved": N, "published": N, ... },
//      "two_star":   { ... },
//      "three_star": { ... },
//      "four_star":  { ... },
//      "five_star":  { ... }
//    }
//  }
//
//  We use reviewSummary to compute the weighted average of
//  approved + published reviews per star level.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Star-level keys in reviewSummary mapped to their numeric value.
const STAR_LEVELS = [
  { key: "one_star",   stars: 1 },
  { key: "two_star",   stars: 2 },
  { key: "three_star", stars: 3 },
  { key: "four_star",  stars: 4 },
  { key: "five_star",  stars: 5 },
];

/**
 * Count approved reviews for a single star bucket.
 * We sum "approved" + "published" because both represent
 * reviews visible to customers in Air Reviews.
 */
function countApproved(bucket) {
  if (!bucket || typeof bucket !== "object") return 0;
  return (Number(bucket.approved) || 0) + (Number(bucket.published) || 0);
}

/**
 * Parse the Air Reviews JSON metafield, calculate the weighted
 * average of approved reviews, and return a rounded integer.
 *
 * @param {string} reviewsJson – raw JSON string from the metafield
 * @returns {number|null}      – integer 1-5, or null if no approved reviews
 */
function calculateAverageReview(reviewsJson) {
  let parsed;
  try {
    parsed = JSON.parse(reviewsJson);
  } catch {
    console.error("[PARSE] Failed to parse review JSON");
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    console.warn("[PARSE] Metafield value is not a JSON object – skipping");
    return null;
  }

  console.log("[PARSE] Top-level keys:", Object.keys(parsed).join(", "));

  const summary = parsed.reviewSummary;

  if (!summary || typeof summary !== "object") {
    console.warn("[PARSE] No reviewSummary found in metafield – skipping");
    return null;
  }

  let totalWeighted = 0;  // sum of (stars × count)
  let totalCount = 0;     // sum of approved review counts

  for (const { key, stars } of STAR_LEVELS) {
    const count = countApproved(summary[key]);
    totalWeighted += stars * count;
    totalCount += count;
    if (count > 0) {
      console.log(`[CALC]   ${key}: ${count} approved`);
    }
  }

  if (totalCount === 0) {
    console.log("[CALC] No approved/published reviews found across any star level");
    return null;
  }

  const average = totalWeighted / totalCount;
  const rounded = Math.round(average); // 4.6 → 5, 4.4 → 4

  console.log(
    `[CALC] ${totalCount} total approved reviews, weighted avg ${average.toFixed(2)}, rounded to ${rounded}`
  );

  return rounded;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WEBHOOK ENDPOINT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post("/webhooks/products/update", verifyShopifyWebhook, async (req, res) => {
  // In serverless (Vercel), the function is frozen once the response is sent.
  // ALL processing must complete BEFORE we call res.send().
  try {
    const payload = req.body;
    const productGid = resolveProductGid(payload, req.rawBody);

    if (!productGid) {
      console.error("[WEBHOOK] Could not resolve product GID from payload");
      return res.status(200).send("OK");
    }

    console.log(`[WEBHOOK] Product updated: ${productGid} ("${payload.title || "unknown"}")`);

    // ── Step 1: Fetch all metafields for this product ──────
    const data = await shopifyGraphQLWithRetry(GET_PRODUCT_METAFIELDS, { id: productGid });

    if (!data?.product) {
      console.error(`[WEBHOOK] Product not found: ${productGid}`);
      return res.status(200).send("OK");
    }

    const metafields = data.product.metafields.edges.map((e) => e.node);

    // ── Step 2: Find the review metafield ──────────────────
    const reviewMetafield = metafields.find(
      (mf) =>
        mf.namespace === CONFIG.reviewMetafieldNamespace &&
        mf.key === CONFIG.reviewMetafieldKey
    );

    if (!reviewMetafield) {
      console.log(
        `[WEBHOOK] No review metafield found (${CONFIG.reviewMetafieldNamespace}.${CONFIG.reviewMetafieldKey}) – nothing to do`
      );
      return res.status(200).send("OK");
    }

    // ── Step 3: Calculate the average ──────────────────────
    const averageRating = calculateAverageReview(reviewMetafield.value);

    if (averageRating === null) {
      console.log("[WEBHOOK] Could not compute average – skipping update");
      return res.status(200).send("OK");
    }

    // ── Step 4: Write the "Average Review" metafield ───────
    const mutationResult = await shopifyGraphQLWithRetry(SET_METAFIELDS, {
      metafields: [
        {
          ownerId: productGid,
          namespace: CONFIG.avgReviewMetafieldNamespace,
          key: CONFIG.avgReviewMetafieldKey,
          type: "number_integer",
          value: String(averageRating),
        },
      ],
    });

    const errors = mutationResult?.metafieldsSet?.userErrors;
    if (errors && errors.length > 0) {
      console.error("[WEBHOOK] Metafield update errors:", JSON.stringify(errors));
      return res.status(200).send("OK");
    }

    console.log(
      `[WEBHOOK] ✔ Updated "${CONFIG.avgReviewMetafieldNamespace}.${CONFIG.avgReviewMetafieldKey}" → ${averageRating} for ${data.product.title}`
    );
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[WEBHOOK] Unhandled error:", err.stack || err.message || err);
    return res.status(200).send("OK");
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HEALTH CHECK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get("/", (_req, res) => {
  res.json({
    status: "running",
    service: "shopify-review-average-webhook",
    tokenCached: !!cachedToken,
    tokenExpiresIn: cachedToken
      ? `${Math.max(0, Math.round((tokenExpiresAt - Date.now()) / 60_000))} min`
      : "n/a",
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  START SERVER (local only) / EXPORT FOR VERCEL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if (!IS_VERCEL) {
  app.listen(PORT, async () => {
    console.log(`Review average webhook server listening on port ${PORT}`);
    console.log(`Endpoint: POST /webhooks/products/update`);
    console.log(`Shopify store: ${CONFIG.shopifyStoreUrl}`);
    console.log(`GraphQL API: https://${CONFIG.shopifyStoreUrl}/admin/api/${CONFIG.apiVersion}/graphql.json`);
    console.log(`Review source: ${CONFIG.reviewMetafieldNamespace}.${CONFIG.reviewMetafieldKey}`);
    console.log(`Average target: ${CONFIG.avgReviewMetafieldNamespace}.${CONFIG.avgReviewMetafieldKey}`);

    try {
      await getToken();
      console.log("[AUTH] Initial token ready");
    } catch (err) {
      console.error("[AUTH] Failed to acquire initial token:", err.message || err);
      console.error("[AUTH] The server will retry when the first webhook arrives.");
    }

    startTokenRefreshTimer();
    console.log("[AUTH] Background token refresh scheduled every 23 h");
  });
}

module.exports = app;
