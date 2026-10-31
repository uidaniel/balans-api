-- Business names that were a greeting, for people still setting up
-- (31 October 2026).
--
-- While the setup form was open, anything typed that was not a bare "hi" was
-- taken as the business name, so accounts are called "Hi Balans", "I want to
-- try it" and the like. conversation/machine.ts now asks the question instead.
-- This clears those names for everybody who has not finished setup, and puts
-- their conversation back at the form, so the name is asked for properly when
-- they return. The patterns are the ones `NOT_A_NAME` uses.
--
-- Accounts that finished setup are left alone: the name is on invoices they
-- have sent, and changing it is theirs to do in settings.

WITH bad AS (
  SELECT id FROM users
   WHERE activated_setup_at IS NULL
     AND consented_at IS NULL
     AND business_name IS NOT NULL
     AND (
          business_name ~* '^(hi+|hello|hey+|hiya|hola|howfa|how far|good (morning|afternoon|evening|day)|greetings)([[:space:],.!?]|$)'
       OR business_name ~* '\mbalans\M'
       OR business_name ~* '^(i want|i''?d like|i would like|i need|how (do|does|can|far)|what (is|does|do)|can i|is it|please|pls)\M'
       OR business_name ~* '^(ok(ay)?|thanks?|thank you|sure|alright)[.!]*$'
       OR business_name ~ '[[:alpha:]].*\?\s*$'
     )
),
cleared AS (
  UPDATE users u SET business_name = NULL FROM bad WHERE u.id = bad.id RETURNING u.id
)
UPDATE conversations c
   SET state = 'onboarding:form',
       context_json = c.context_json - 'businessName'
  FROM cleared
 WHERE c.user_id = cleared.id
   AND c.state LIKE 'onboarding%';
