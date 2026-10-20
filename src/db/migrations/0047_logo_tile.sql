-- Whether the logo is a tile: square-ish, with solid corners (20 October 2026).
--
-- A logo cut out on a transparent background is drawn as it is. One that is a
-- filled square, an app-icon style picture or a photo, reads as a hard-edged
-- box on the pay page and in emails, so those get rounded corners. Worked out
-- once, when the logo is saved (brand/user-logo.ts); NULL until it has been,
-- and then filled in the first time the logo is shown.
ALTER TABLE users ADD COLUMN logo_tile BOOLEAN;
