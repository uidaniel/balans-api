-- Settings on a web page, and a brand colour for Pro.
--
-- `brand_color` is the accent on a Pro user's invoices, pay page and client
-- emails, in place of Balans marigold. Upper-case #RRGGBB or nothing.
--
-- The settings page is opened from a WhatsApp button, like the signature
-- page, and can change a payout account. So its link is a stored token that
-- expires, not the permanent design-picker token: a link forwarded or found
-- in a chat export a week later opens nothing. The bank change itself still
-- needs the code emailed to the verified address.

ALTER TABLE users
  ADD COLUMN brand_color TEXT CHECK (brand_color ~ '^#[0-9A-F]{6}$'),
  ADD COLUMN settings_token TEXT UNIQUE,
  ADD COLUMN settings_token_expires_at TIMESTAMPTZ;
