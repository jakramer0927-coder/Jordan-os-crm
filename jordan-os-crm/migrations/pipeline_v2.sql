-- ─────────────────────────────────────────────────────────────────────────────
-- Pipeline v2 migration
-- Run this in your Supabase SQL editor (safe to run multiple times)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Extend deals table
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS opp_type         text NOT NULL DEFAULT 'buyer',
  ADD COLUMN IF NOT EXISTS buyer_stage      text,
  ADD COLUMN IF NOT EXISTS seller_stage     text,
  ADD COLUMN IF NOT EXISTS pipeline_status  text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS budget_min       numeric,
  ADD COLUMN IF NOT EXISTS budget_max       numeric,
  ADD COLUMN IF NOT EXISTS target_areas     text,
  ADD COLUMN IF NOT EXISTS pre_approval_amount numeric,
  ADD COLUMN IF NOT EXISTS pre_approval_lender text,
  ADD COLUMN IF NOT EXISTS motivation       text,
  ADD COLUMN IF NOT EXISTS timeline_notes   text,
  ADD COLUMN IF NOT EXISTS list_price       numeric,
  ADD COLUMN IF NOT EXISTS estimated_value  numeric,
  ADD COLUMN IF NOT EXISTS market_notes     text,
  ADD COLUMN IF NOT EXISTS cma_link         text,
  ADD COLUMN IF NOT EXISTS target_list_date date,
  ADD COLUMN IF NOT EXISTS commission_pct   numeric,
  ADD COLUMN IF NOT EXISTS referral_fee_pct numeric,
  ADD COLUMN IF NOT EXISTS referral_fee_contact_id uuid REFERENCES contacts(id),
  ADD COLUMN IF NOT EXISTS co_agent_contact_id     uuid REFERENCES contacts(id);

-- 2. Migrate existing deals into new stage model
UPDATE deals SET
  opp_type = CASE
    WHEN role = 'seller'   THEN 'seller'
    WHEN role = 'landlord' THEN 'investor'
    WHEN role = 'tenant'   THEN 'investor'
    ELSE 'buyer'
  END,
  buyer_stage = CASE
    WHEN role NOT IN ('seller', 'landlord', 'tenant') THEN
      CASE status
        WHEN 'lead'           THEN 'initial_meeting'
        WHEN 'showing'        THEN 'actively_searching'
        WHEN 'offer_in'       THEN 'offer'
        WHEN 'under_contract' THEN 'under_contract'
        WHEN 'closed_won'     THEN 'closed'
        ELSE 'initial_meeting'
      END
    ELSE NULL
  END,
  seller_stage = CASE
    WHEN role = 'seller' THEN
      CASE status
        WHEN 'lead'           THEN 'initial_meeting'
        WHEN 'showing'        THEN 'listing_prepped'
        WHEN 'offer_in'       THEN 'on_market'
        WHEN 'under_contract' THEN 'in_contract'
        WHEN 'closed_won'     THEN 'sold'
        ELSE 'initial_meeting'
      END
    ELSE NULL
  END,
  pipeline_status = CASE
    WHEN status = 'closed_won'  THEN 'past_client'
    WHEN status = 'closed_lost' THEN 'lost'
    ELSE 'active'
  END
WHERE opp_type = 'buyer' OR buyer_stage IS NULL; -- only migrate un-migrated rows

-- 3. Offers table
CREATE TABLE IF NOT EXISTS offers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id                 uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_address        text NOT NULL,
  offer_price             numeric,
  asking_price            numeric,
  terms_notes             text,
  competing_offers_count  int,
  seller_agent_contact_id uuid REFERENCES contacts(id),
  seller_agent_name       text,
  outcome                 text NOT NULL DEFAULT 'pending',
  -- outcome: pending | accepted | countered | rejected | withdrawn
  accepted_price          numeric,
  cma_link                text,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS offers_deal_id_idx    ON offers(deal_id);
CREATE INDEX IF NOT EXISTS offers_user_id_idx    ON offers(user_id);
CREATE INDEX IF NOT EXISTS offers_seller_agent_idx ON offers(seller_agent_contact_id)
  WHERE seller_agent_contact_id IS NOT NULL;

ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage their own offers" ON offers;
CREATE POLICY "Users manage their own offers"
  ON offers FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 4. Listing prep items
CREATE TABLE IF NOT EXISTS listing_prep_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_name         text NOT NULL,
  vendor_contact_id uuid REFERENCES contacts(id),
  vendor_name       text,
  cost              numeric,
  status            text NOT NULL DEFAULT 'planned',
  -- status: planned | in_progress | completed
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listing_prep_deal_id_idx ON listing_prep_items(deal_id);

ALTER TABLE listing_prep_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage their own listing prep items" ON listing_prep_items;
CREATE POLICY "Users manage their own listing prep items"
  ON listing_prep_items FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 5. Opportunity contacts (multiple contacts per deal)
CREATE TABLE IF NOT EXISTS opportunity_contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id    uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'primary',
  -- role: primary | co-buyer | co-seller | secondary
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(deal_id, contact_id)
);

CREATE INDEX IF NOT EXISTS opp_contacts_deal_idx    ON opportunity_contacts(deal_id);
CREATE INDEX IF NOT EXISTS opp_contacts_contact_idx ON opportunity_contacts(contact_id);

ALTER TABLE opportunity_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage their own opportunity contacts" ON opportunity_contacts;
CREATE POLICY "Users manage their own opportunity contacts"
  ON opportunity_contacts FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
