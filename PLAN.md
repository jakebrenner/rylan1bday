# Coupon & Pricing Review — Implementation Plan

## Overview
Modernize the coupon system to support free event grants, clean up deprecated plan references, and add a user-facing credit ledger for auditability.

---

## Phase 1: SQL Migration — New Coupon Fields + Credit Ledger

**File: `supabase/migrate_coupon_events.sql`**

### 1a. Add `event_credits` to `coupons` table
- New column: `event_credits integer default 0` — number of free events this coupon grants (0 = monetary discount only)
- New column: `coupon_type text default 'discount' check (coupon_type in ('discount', 'event_credits', 'both'))` — determines coupon behavior
- Existing monetary fields (`discount_type`, `discount_value`) stay for percent/fixed discounts
- `max_uses` = global cap (total redemptions across all users)
- `max_uses_per_user` = per-user cap (times one user can redeem)
- `times_used` tracks global redemptions

### 1b. Create `credit_ledger` table
Audit trail showing every credit movement:
```
credit_ledger:
  id              uuid pk
  user_id         uuid fk profiles
  entry_type      text check ('credit_added', 'credit_used', 'credit_refunded', 'credit_expired')
  amount          integer not null  -- positive = credits added, negative = credits used
  balance_after   integer not null  -- running balance after this entry
  source          text check ('first_event', 'coupon', 'purchase', 'admin_grant', 'event_publish', 'refund')
  reference_id    text              -- coupon code, event ID, stripe payment ID, etc.
  reference_label text              -- human-readable: event title, coupon description, etc.
  created_at      timestamptz default now()
  notes           text
```
Indexes: `user_id`, `(user_id, created_at)`

### 1c. Update `coupon_redemptions`
- Add `events_granted integer default 0` — how many event credits were granted in this redemption
- Drop the unique constraint on `(coupon_id, user_id, subscription_id)` since users can redeem same coupon multiple times if max_uses_per_user allows

---

## Phase 2: API Changes

### 2a. Update `api/v2/billing.js`

**validateCoupon endpoint** — update to return `eventCredits` field alongside existing discount info

**New endpoint: `action=redeemCoupon`** (POST, authenticated)
- Validate coupon (reuse existing logic)
- If coupon grants event credits: add to `profiles.free_event_credits`, insert `credit_ledger` entry, insert `coupon_redemptions` row
- If coupon grants monetary discount: store for use at checkout (existing flow)
- Increment `coupons.times_used`
- Return: `{ success, creditsAdded, newBalance, discount }`

**Update `action=subscription` endpoint** — add `ledger` array to response (last 50 ledger entries)

**Update checkout flow** — when coupon with event_credits is used at checkout, apply credits instead of/in addition to monetary discount

### 2b. Update `api/v2/events.js`

**Event creation** — when credits are consumed (first event free, purchased credits, free credits), write a `credit_ledger` entry with `entry_type: 'credit_used'`, `source: 'event_publish'`

**When credits are added** (coupon redemption, purchase, admin grant) — write `credit_ledger` entry with `entry_type: 'credit_added'`

### 2c. Update `api/v2/admin.js`

**Update `createCoupon`** — accept new fields: `eventCredits`, `couponType`
**Update `listCoupons`** — return new fields
**Remove** subscription/plan CRUD endpoints (or mark deprecated)

---

## Phase 3: Admin UI Cleanup

### 3a. Remove Billing tab (`v2/admin/index.html`)
- Remove sidebar item for "Billing" (line 555)
- Remove `tab-subscriptions` div (lines 1031-1081) — Pricing Tiers, Subscriptions table, Grant Complimentary Plan
- Remove related JS: `loadBillingTab()`, `loadPricingTiers()`, plan modal functions, subscription loading
- Remove plan modal HTML (lines ~945-1029)

### 3b. Update Coupons tab
- Replace "Discount Type" dropdown with "Coupon Type": Discount / Free Events / Both
- When "Free Events" or "Both" selected: show "Number of Free Events" input
- When "Discount" or "Both" selected: show existing percent/fixed fields
- Update coupons table to show event credits column
- Update coupon list rendering to display new fields

---

## Phase 4: Pricing Page Cleanup

**File: `v2/pricing/index.html`**
- Remove "Coming Soon: Unlimited Plan $24.99/year" section (lines 151-154)

---

## Phase 5: User Profile — Credit Ledger

### 5a. Update `v2/profile/index.html`

**Add "Redeem Coupon" section** in the billing area:
- Input field for coupon code + "Redeem" button
- Shows result: "5 free event credits added!" or discount info

**Add "Activity Ledger" section** below credits display:
- Table showing: Date | Type | Description | Amount | Balance
- Green rows for credits added, red/coral rows for credits used
- Sources labeled clearly: "Free first event", "Coupon: FRIEND5", "Purchased 3 credits", "Event: Sarah's Birthday"

### 5b. Update billing data loading
- Call new ledger data from `action=subscription` response
- Render ledger table with running balance

---

## Phase 6: Event Creation — Coupon Input

**File: `v2/create/index.html`**
- Add optional coupon code input during the payment/publish step
- When entered, validate and apply:
  - If event credits coupon: redeem credits, skip payment
  - If monetary discount: apply to checkout price

---

## Phase 7: Cleanup Remaining Old References

- `api/v2/auth.js` — remove subscription fetching from profile endpoint (lines 194-234)
- `supabase/migration.sql` — note: don't modify base migration (it's historical), but the new migration should ALTER the tier CHECK constraint to remove 'pro'/'business' if still enforced at DB level

---

## Files Changed (Summary)

| File | Changes |
|------|---------|
| `supabase/migrate_coupon_events.sql` | NEW — migration for coupon fields + credit_ledger |
| `api/v2/billing.js` | Add redeemCoupon, update validateCoupon, add ledger to subscription |
| `api/v2/events.js` | Write credit_ledger entries on event create |
| `api/v2/admin.js` | Update createCoupon to accept event_credits fields |
| `v2/admin/index.html` | Remove Billing tab, update Coupons tab UI |
| `v2/profile/index.html` | Add coupon redemption + activity ledger |
| `v2/create/index.html` | Add coupon input at payment step |
| `v2/pricing/index.html` | Remove "Coming Soon: Unlimited Plan" |
| `api/v2/auth.js` | Remove subscription fetching |
