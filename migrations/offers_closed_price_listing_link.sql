-- Add closed_price and listing_link to offers table
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS closed_price numeric,
  ADD COLUMN IF NOT EXISTS listing_link text;
