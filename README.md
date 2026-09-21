# balans-api

The Balans backend: the WhatsApp bot, documents, and payments.

Balans lets Nigerian freelancers and service businesses quote, invoice and get
paid in one WhatsApp chat. You type one line — *"Invoice Zenith Homes 350k for
duplex 3D render, due Friday"* — and get back a branded PDF and a payment link.
When the client pays, the money settles to your own bank account.

The marketing site and invoice pages live in a separate repository.

## Two rules that are never up for interpretation

These come from the platform PRD, and everything here is shaped by them.

**1. Balans never holds user money.** Funds move through provider subaccounts
and splits. Nothing is ever routed through a Balans balance or a transfers API.

**2. The language model never does money maths, and never marks anything paid.**
It only turns a sentence into structured fields. Deterministic code computes
every amount, and only a verified payment event changes a payment's status.

## Running it

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run migrate                # applies db/migrations in order
npm run dev                    # http://localhost:4000
npm test
```

Node 22 or newer. TypeScript runs directly through `--experimental-strip-types`;
there is no build step.

## Walking onboarding again

Onboarding has six steps and a real bank lookup in the middle, so testing it
means walking it repeatedly.

```bash
npm run reset -- 2348107408438     # same user, back to the first message
npm run reset -- --last            # whoever messaged most recently
npm run reset -- 2348107408438 --hard   # delete the user outright
```

From the chat itself, `restart` works too — but only mid-onboarding. Once
someone is set up there is nothing to cancel, and the script is the way.

Note the reset clears `messages` as well. Without that the next "Hi" carries a
`wa_message_id` already on file, and is correctly ignored as a redelivery.

If the database schema was created by hand — pasted into a SQL editor, say —
record it without re-running the files:

```bash
npm run migrate -- --baseline
```

## Layout

```
core/         Money rules shared with the web app. See the warning below.
src/
  config.ts   Everything that changes without a deploy (PRD section 14)
  db/         Pool, migration runner, and the schema as plain .sql
  http/       Fastify server and routes
  whatsapp/   Cloud API client, inbound envelope parsing
  conversation/  The state machine (PRD section 5)
  lib/        Encryption, signature checking
```

## `core/` and the web app

`core/amount.ts` exists in both this repository and the web app, because the
two are deployed separately. The PRD says the backend owns the authoritative
copy and that the two must not drift — the invoice generator and the bot have
to agree on what "350k" means.

`core/amount-vectors.json` is how that is enforced. Both repositories keep a
copy and run it from their test suites, so a disagreement fails a test instead
of reaching a client's invoice. **If you change the parser, change it here
first, update the vectors, and copy both files across.**

## Webhooks

Both inbound webhooks verify a signature over the *raw* request body before
anything else happens. Unsigned requests are rejected (PRD section 11).

- `GET /webhooks/whatsapp/` — Meta's subscription handshake
- `POST /webhooks/whatsapp/` — inbound messages and delivery statuses

Handlers record the event and return 200 quickly. Meta retries anything it does
not see acknowledged, so the work happens after the acknowledgement, not before
it. Every event carries a provider-unique id, and a repeat collides on a unique
index rather than creating a second invoice.

To point Meta at a local server:

```bash
npx ngrok http 4000
# Callback URL: https://<id>.ngrok.app/webhooks/whatsapp/
# Verify Token: whatever you set as WA_VERIFY_TOKEN
```

## Money

All amounts are integer kobo, everywhere, with no exceptions. `BIGINT` in the
database, `number` in TypeScript, never a float and never a decimal string.
`core/amount.ts` parses shorthand through `BigInt` for the same reason:
`1.2 * 1_000_000 * 100` is not exactly `120000000` in floating point.

## Status

Built: project skeleton, configuration, schema and migrations, WhatsApp webhook
in and out, conversation state machine.

Not yet: the parser, onboarding side effects, documents and PDFs, payments,
the fee engine, reminders, reconciliation.

The payment provider is Monnify. Anything in here still naming Paystack is
stale and migrates separately.
