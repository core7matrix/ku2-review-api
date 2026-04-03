# Shopify Review Average Webhook

Receives **products/update** webhooks from Shopify, reads review JSON from a third-party review app metafield, calculates the average approved-review rating, and writes the rounded integer back into a custom **Average Review** metafield on the product.

---

## Project Structure

```
review-api/
├── app.js          ← Express server + webhook handler
├── .env.example    ← Template for environment variables
├── .gitignore
├── package.json
└── README.md
```

---

## Quick Start

```bash
# 1 – Clone / enter the project
cd review-api

# 2 – Install dependencies
npm install

# 3 – Create your .env from the template
cp .env.example .env     # Linux/macOS
copy .env.example .env   # Windows

# 4 – Fill in .env with your real Shopify credentials (see below)

# 5 – Run
npm start
```

The server starts on `http://localhost:3000`. The webhook endpoint is:

```
POST /webhooks/products/update
```

---

## Shopify Store Setup (Step-by-Step)

### A. Create the "Average Review" Metafield Definition

1. In Shopify Admin go to **Settings → Custom data → Products**.
2. Click **Add definition**.
3. Fill in:
   - **Name**: `Average Review`
   - **Namespace and key**: `custom.average_review`
   - **Type**: **Integer**
   - (Optional) Set **Validation**: min `1`, max `5`.
4. Click **Save**.

> The namespace (`custom`) and key (`average_review`) must match the values in your `.env` file.

### B. Create a Custom App (for the Access Token)

1. Go to **Settings → Apps and sales channels → Develop apps**.
2. Click **Create an app** → give it a name like "Review Average Bot".
3. Under **Configuration → Admin API integration**:
   - Enable scopes: **`read_products`** and **`write_products`**.
4. Click **Save**, then **Install app**.
5. Go to the **API credentials** tab and copy the **Admin API access token** (`shpat_…`).
6. Paste it into your `.env` as `SHOPIFY_ACCESS_TOKEN`.

### C. Register the Webhook

#### Option 1 – Via Shopify Admin UI

1. Go to **Settings → Notifications** → scroll to **Webhooks**.
2. Click **Create webhook**.
3. Select event: **Product update**.
4. Format: **JSON**.
5. URL: `https://your-server.com/webhooks/products/update` (your deployed URL).
6. API version: same as your `.env` (`2025-04`).
7. Click **Save**.
8. Copy the **Webhook secret** shown at the top of the Webhooks section → paste into `.env` as `WEBHOOK_SECRET`.

#### Option 2 – Via one-time cURL command

```bash
curl -X POST \
  "https://YOUR-STORE.myshopify.com/admin/api/2025-04/webhooks.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: shpat_YOUR_TOKEN" \
  -d '{
    "webhook": {
      "topic": "products/update",
      "address": "https://your-server.com/webhooks/products/update",
      "format": "json"
    }
  }'
```

### D. Identify Your Review App's Metafield

Every review app stores data differently. To find yours:

1. Install a browser extension or use the Shopify Admin API to list metafields on a product that has reviews.
2. Look for a metafield whose **value** is JSON containing an array of review objects.
3. Note the **namespace** and **key** – set them in `.env`:
   ```
   REVIEW_METAFIELD_NAMESPACE=reviews
   REVIEW_METAFIELD_KEY=customer_reviews_json
   ```
4. Open `app.js` and scroll to the `calculateAverageReview` function. Adapt the filter conditions and rating field names if your app uses different property names (see comments in code).

---

## Deployment

### Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Set environment variables in the Railway dashboard. Your public URL will be `https://xxx.up.railway.app`.

### Fly.io

```bash
fly launch          # creates fly.toml
fly secrets set SHOPIFY_STORE_URL=your-store.myshopify.com ...
fly deploy
```

### Vercel (Serverless)

Vercel runs serverless functions. Wrap the Express app with `@vercel/node`:

```bash
npm i @vercel/node
```

Create `vercel.json`:

```json
{
  "builds": [{ "src": "app.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "app.js" }]
}
```

Then `vercel --prod`. Set env vars in the Vercel dashboard.

### Any VPS / Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "app.js"]
```

```bash
docker build -t review-api .
docker run -d --env-file .env -p 3000:3000 review-api
```

---

## How It Works

```
Shopify Store
    │
    │ products/update webhook (JSON + HMAC)
    ▼
┌──────────────────────────────┐
│  POST /webhooks/products/update  │
│                              │
│  1. Verify HMAC signature    │
│  2. Extract product ID       │
│  3. GraphQL → fetch product  │
│     metafields               │
│  4. Find review JSON         │
│     metafield                │
│  5. Parse, filter approved,  │
│     calculate average        │
│  6. GraphQL → write          │
│     "Average Review"         │
│     metafield                │
└──────────────────────────────┘
```

---

## Customising for Your Review App

Open `app.js` and find the `calculateAverageReview` function. The comments explain exactly which lines to change:

| Review App | Likely status value | Likely rating field |
|------------|--------------------|--------------------|
| Judge.me   | `"published"`      | `rating`           |
| Loox       | `"approved"`       | `rating`           |
| Yotpo      | `"pub"`            | `score`            |
| Stamped.io | `"published"`      | `rating`           |
| Ali Reviews| `"active"`         | `star`             |

The default code already accepts `"approved"`, `"published"`, and `"pub"`, and reads `rating`, `score`, or `stars` – so it works out-of-the-box with most apps.

---

## Testing

1. Deploy the server (or use [ngrok](https://ngrok.com/) for local testing):
   ```bash
   ngrok http 3000
   ```
   Use the ngrok HTTPS URL as your webhook address.

2. In Shopify Admin, edit any product (e.g. change the description) and **Save**.

3. Watch the server logs – you should see the webhook arrive, the review metafield being read, and the average being written.

4. Verify: go to the product in Shopify Admin → scroll to **Metafields** → you should see the **Average Review** value updated.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` in logs | `WEBHOOK_SECRET` doesn't match. Re-copy it from Shopify. |
| `Product not found` | Check `SHOPIFY_ACCESS_TOKEN` has `read_products` scope. |
| No review metafield found | Confirm the namespace/key match your review app. Use the Admin API to list metafields. |
| Metafield update errors | Ensure the "Average Review" definition type is **Integer** and the token has `write_products`. |
| Shopify not sending webhooks | Webhook URL must be HTTPS and publicly reachable. Use ngrok for local testing. |

---

## License

MIT
