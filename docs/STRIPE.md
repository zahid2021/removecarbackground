# Stripe live setup

1. Create account: https://dashboard.stripe.com/register
2. Developers → API keys → copy **Secret key** (`sk_test_...` first)
3. Put in `.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_xxxx
   PUBLIC_BASE_URL=https://your-domain.com
   ```
4. Restart server (`./run.sh`)
5. Account page → **Pay with Stripe** → test card `4242 4242 4242 4242`
6. For production: switch to `sk_live_...`, set webhook:
   - Endpoint: `https://your-domain.com/api/billing/webhook`
   - Event: `checkout.session.completed`
   - Copy signing secret → `STRIPE_WEBHOOK_SECRET`

Without keys, **Demo +100 credits** still works for client demos.
