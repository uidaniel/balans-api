/**
 * The Flow JSON Balans publishes to Meta.
 *
 * ---------------------------------------------------------------------------
 * When a Flow, when a button, when a plain sentence
 * ---------------------------------------------------------------------------
 *
 * A Flow is a form. It is the right shape when somebody has to hand over
 * several things they already know — their bank, their account number, their
 * email — and the only work is transcription. Six messages to collect four
 * facts is six chances to drift off, and every one of them is a chargeable
 * message from October 2026.
 *
 * It is the wrong shape for a decision. "Send it?" has three answers and needs
 * no form; three reply buttons are one tap where a Flow is a tap, a screen, a
 * choice and a submit.
 *
 * And it is emphatically wrong for the thing this product exists to do. The
 * promise is that you type "Invoice Tunde 20k for logo" and an invoice comes
 * back. Putting that behind a form with a client field, an amount field and a
 * date picker would rebuild exactly the app nobody wanted to open. The
 * conversation is the feature; the Flow is for the paperwork around it.
 *
 * So:
 *   - Flow    — onboarding, editing business details. Several known facts.
 *   - Buttons — a decision with up to three answers.
 *   - List    — a choice among four to ten fixed options.
 *   - Words   — anything that is the user's own expression of what they want.
 *
 * ---------------------------------------------------------------------------
 * The exception: an invoice with terms on it
 * ---------------------------------------------------------------------------
 *
 * "Invoice Tunde 20k for logo" must never open a form, for the reason above.
 * But this arrived from a real user:
 *
 *   "Invoice daniel 250k for website development, it is project running from
 *    1st of october to like the 3rd week and there will be milestones,
 *    3 payment shared equally"
 *
 * The draft that came back had the whole sentence as its description, the
 * wrong date, and no milestones at all. Every correction is another sentence
 * to misread, so it stayed wrong.
 *
 * That is where a form earns its place — not as the front door, but as what
 * the front door falls back to. The invoice Flow below is never the first
 * thing anybody sees. It opens when somebody asks for it by name, or when
 * they are correcting a draft that has terms on it. Simple invoices, which
 * are most invoices, never meet it.
 *
 * ---------------------------------------------------------------------------
 * Why navigate rather than data_exchange
 * ---------------------------------------------------------------------------
 *
 * A Flow can call our server between screens, which would let the bank
 * account be resolved and its name shown before the form closes. That needs a
 * published RSA key, signed request decryption and an endpoint Meta can reach,
 * and it buys one thing: confirming the account name inside the form instead
 * of in the chat a second later.
 *
 * The chat can do that confirmation with two buttons, which already work. So
 * these Flows are `navigate`: they collect, they close, and the verification
 * happens in the conversation where it is already understood.
 */

import { bankOptions } from "./banks.ts";
import { env } from "../../config.ts";

/** The marketing site, which owns the legal documents. */
const site = env.SITE_URL.replace(/[/]$/, "");

/*
 * Meta validates against this and rejects anything it has retired.
 *
 * Probed against the live API on 22 September 2026: 5.0 and below are refused,
 * 5.1 through 7.1 are accepted. Taking the newest, because the floor keeps
 * rising and a Flow pinned to the oldest thing that still works is a Flow that
 * stops working without anybody touching it.
 */
const VERSION = "7.1";

export type FlowDefinition = {
  /** Our name for it, and the key we store the published id under. */
  key: string;
  /** Shown in the Flows list in Meta's UI. */
  name: string;
  categories: string[];
  json: unknown;
};

/* -------------------------------------------------------------------------- */
/* Onboarding                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Two screens, four fields, one submit — against six back-and-forth messages.
 *
 * The bank lookup deliberately stays outside. What comes back from this is a
 * bank and ten digits; turning that into "Is this ADA OKON?" is a Monnify call
 * and a yes, and the chat already asks that well.
 */
const onboarding: FlowDefinition = {
  key: "onboarding",
  name: "Balans onboarding",
  categories: ["SIGN_UP"],
  json: {
    version: VERSION,
    screens: [
      {
        id: "BUSINESS",
        title: "Your business",
        terminal: false,
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextSubheading",
              text: "This is what your clients will see on every invoice.",
            },
            {
              type: "Form",
              name: "business_form",
              children: [
                {
                  type: "TextInput",
                  name: "business_name",
                  label: "Business",
                  "helper-text": "Or your own name, if that is how you bill.",
                  required: true,
                  "input-type": "text",
                  "max-chars": 80,
                },
                {
                  type: "TextInput",
                  name: "email",
                  label: "Email",
                  "helper-text": "Receipts and copies of your invoices go here.",
                  required: true,
                  "input-type": "email",
                  "max-chars": 120,
                },
                {
                  type: "Footer",
                  label: "Next",
                  "on-click-action": {
                    name: "navigate",
                    next: { type: "screen", name: "PAYOUT" },
                    payload: {
                      business_name: "${form.business_name}",
                      email: "${form.email}",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        id: "PAYOUT",
        title: "Where money lands",
        terminal: true,
        success: true,
        // Carried through from the first screen so the submit holds all four.
        data: {
          business_name: { type: "string", __example__: "Kemi Adeyemi Studio" },
          email: { type: "string", __example__: "kemi@studio.ng" },
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextSubheading",
              text: "Your client pays, the money is split as they pay, and your share lands here.",
            },
            {
              type: "Form",
              name: "payout_form",
              children: [
                {
                  type: "Dropdown",
                  name: "bank",
                  label: "Bank",
                  required: true,
                  "data-source": bankOptions(),
                },
                {
                  type: "TextInput",
                  name: "account_number",
                  label: "Account",
                  "helper-text": "The 10 digits on your account.",
                  required: true,
                  "input-type": "number",
                  "max-chars": 10,
                },
                {
                  type: "TextInput",
                  name: "other_bank",
                  label: "Other bank",
                  "helper-text": "Only if you chose Other above. Leave it empty otherwise.",
                  required: false,
                  "input-type": "text",
                  "max-chars": 60,
                },
                {
                  type: "Footer",
                  label: "Finish",
                  "on-click-action": {
                    name: "complete",
                    payload: {
                      business_name: "${data.business_name}",
                      email: "${data.email}",
                      bank: "${form.bank}",
                      other_bank: "${form.other_bank}",
                      account_number: "${form.account_number}",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Editing business details                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One screen. Everything that prints on an invoice but the bank.
 *
 * Changing these through the chat means naming the field, then giving the
 * value, then doing it again for the next one. A form shows what is there now
 * and lets somebody fix the one thing that is wrong — which is what "edit"
 * means and what the conversational version never quite managed.
 *
 * The current values arrive as `data`, so the fields open filled in.
 */
const businessDetails: FlowDefinition = {
  key: "business_details",
  name: "Balans business details",
  categories: ["OTHER"],
  json: {
    version: VERSION,
    screens: [
      {
        id: "DETAILS",
        title: "Business details",
        terminal: true,
        success: true,
        data: {
          business_name: { type: "string", __example__: "Kemi Adeyemi Studio" },
          email: { type: "string", __example__: "kemi@studio.ng" },
          address: { type: "string", __example__: "Lekki Phase 1, Lagos" },
          tin: { type: "string", __example__: "" },
          invoice_start: { type: "number", __example__: 1 },
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextSubheading",
              text: "Change anything here and it shows on your next invoice.",
            },
            {
              type: "Form",
              name: "details_form",
              // Starting values belong to the form, not to each input: at 7.1
              // `init-value` on a TextInput is rejected outright.
              "init-values": {
                business_name: "${data.business_name}",
                email: "${data.email}",
                address: "${data.address}",
                tin: "${data.tin}",
                invoice_start: "${data.invoice_start}",
              },
              children: [
                {
                  type: "TextInput",
                  name: "business_name",
                  label: "Business",
                  required: true,
                  "input-type": "text",
                  "max-chars": 80,
                },
                {
                  type: "TextInput",
                  name: "email",
                  label: "Email",
                  required: true,
                  "input-type": "email",
                  "max-chars": 120,
                },
                {
                  type: "TextInput",
                  name: "address",
                  label: "Address",
                  "helper-text": "Optional. Printed under your name.",
                  required: false,
                  "input-type": "text",
                  "max-chars": 120,
                },
                {
                  type: "TextInput",
                  name: "tin",
                  label: "Tax ID",
                  "helper-text": "Optional. Your TIN, if clients ask for it.",
                  required: false,
                  "input-type": "text",
                  "max-chars": 30,
                },
                {
                  type: "TextInput",
                  name: "invoice_start",
                  label: "Invoice no",
                  // The reason anybody touches this, said plainly. Somebody
                  // moving from a paper book or another tool needs their
                  // numbering to carry on rather than restart at 1.
                  "helper-text": "The number your next invoice takes. Raise it to carry on from another tool.",
                  required: false,
                  "input-type": "number",
                  "max-chars": 10,
                },
                {
                  type: "Footer",
                  label: "Save",
                  "on-click-action": {
                    name: "complete",
                    payload: {
                      business_name: "${form.business_name}",
                      email: "${form.email}",
                      address: "${form.address}",
                      tin: "${form.tin}",
                      invoice_start: "${form.invoice_start}",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* An invoice with terms on it                                                */
/* -------------------------------------------------------------------------- */

/**
 * How the money is broken up, as a fixed list rather than a number field.
 *
 * A percentage box and a "how many payments" box would need conditional
 * visibility to avoid asking for both at once, and a free number field invites
 * "0", "1" and "150" — every one of which `shapeFor` has to refuse after the
 * form has already closed and the user has stopped paying attention. A fixed
 * list cannot express a refusable answer.
 *
 * It is short on purpose. An unusual split — 35% up front, seven stages — is
 * exactly what a sentence is better at, and the sentence still works.
 */
export const PLANS = [
  { id: "one", title: "One payment" },
  { id: "deposit_25", title: "25% deposit, then the balance" },
  { id: "deposit_50", title: "50% deposit, then the balance" },
  { id: "split_2", title: "2 equal payments" },
  { id: "split_3", title: "3 equal payments" },
  { id: "split_4", title: "4 equal payments" },
  { id: "split_6", title: "6 equal payments" },
] as const;

export type PlanId = (typeof PLANS)[number]["id"];

/** What a chosen plan means, in the words `shapeFor` already reads. */
export function splitForPlan(id: string | null | undefined): {
  depositPercent: number | null;
  instalments: number | null;
} {
  const deposit = /^deposit_(\d+)$/.exec(id ?? "");
  if (deposit) return { depositPercent: Number(deposit[1]), instalments: null };

  const split = /^split_(\d+)$/.exec(id ?? "");
  if (split) return { depositPercent: null, instalments: Number(split[1]) };

  return { depositPercent: null, instalments: null };
}

/** The list id for a plan, so an edit form opens on the answer already given. */
export function planIdFor(o: { depositPercent?: number | null; instalments?: number | null }): PlanId {
  const known = new Set<string>(PLANS.map((p) => p.id));

  if (o.depositPercent != null) {
    const id = `deposit_${o.depositPercent}`;
    // A 35% deposit typed as a sentence has no entry here. The form opens on
    // "One payment" rather than on a wrong answer, and the draft keeps its 35%
    // unless the user actually picks something else.
    if (known.has(id)) return id as PlanId;
  }

  if (o.instalments != null) {
    const id = `split_${o.instalments}`;
    if (known.has(id)) return id as PlanId;
  }

  return "one";
}

/* -------------------------------------------------------------------------- */
/* Line items                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The items after the first, one screen each.
 *
 * Words rather than digits because a Flow screen id and a field name may only
 * contain letters and underscores — `ITEM_2` is refused on upload.
 *
 * Four extra is a judgement, not a limit of the format. It covers the invoices
 * people actually build a line at a time, and the sentence path still takes up
 * to twenty for anything longer. Every screen exists in the JSON whether it is
 * reached or not, so the cost of raising this is paid by every invoice.
 */
export const EXTRA_ITEMS = ["two", "three", "four", "five"] as const;

/**
 * How many items the invoice has, as a word.
 *
 * A word because a Switch case key that looks like a number is refused on
 * upload, with "Cannot read property 'type' of undefined" and no line number.
 * "one" is the form with no extra items on it, which is where a removal can
 * land you.
 */
const COUNTS = ["one", ...EXTRA_ITEMS] as const;

/** Field names for one item, in the order they appear on the screen. */
export const itemFields = (w: string): { description: string; amount: string } => ({
  description: `item_${w}_description`,
  amount: `item_${w}_amount`,
});

/** The screen that collects one item. Letters and underscores only. */
export const itemScreenId = (w: string): string => `ITEM_${w.toUpperCase()}`;

/**
 * The number that fills an item's Amount box when its screen opens.
 *
 * A second name for the same money, and not redundancy.
 *
 * `item_two_amount` has to be a string on every screen, because that is what
 * comes back out of a form and there is no cast in Flow JSON — one screen
 * sending a number to a key another screen declares a string is an error on
 * the phone, not at publish. But the Amount box is `input-type: "number"`, and
 * Meta refuses to publish a number input initialised from a string:
 *
 *   Expected property 'item_two_amount' to be of type 'number' but found
 *   'string'.
 *
 * Probed against Meta on 23 September 2026, both directions. There is no type
 * that satisfies both, so the starting value travels under its own name and is
 * dropped once the screen that needs it has been through.
 *
 * Zero means empty. A blank Amount cannot be expressed as a number, and an
 * init of 0 renders as an empty box rather than a "0" — which is just as well,
 * since a ₦0 line is not a line.
 */
export const initField = (w: string): string => `item_${w}_amount_init`;

/**
 * Every item in a payload; the screen's own two read from the form.
 *
 * `at` is the index in EXTRA_ITEMS of the item this screen collects, or null
 * on WORK, which collects none of them. Everything else is passed straight
 * through, so whatever a correction arrived with survives a route that never
 * visits it.
 */
function itemPayload(at: number | null): Record<string, string> {
  const out: Record<string, string> = {};
  EXTRA_ITEMS.forEach((w, index) => {
    const f = itemFields(w);
    const source = index === at ? "form" : "data";
    out[f.description] = `\${${source}.${f.description}}`;
    out[f.amount] = `\${${source}.${f.amount}}`;
  });
  return out;
}

/**
 * Every item, with the ones on screen read from the form.
 *
 * The form lists all of them once they exist, and every one of them can be
 * typed in, so every one of them has to leave in whatever state it is now in.
 * Reading them from `data` instead would show an edit, accept it, and then
 * send the old value — which is the same failure as losing an item, wearing a
 * disguise.
 *
 * `upTo` is the last item with boxes on screen. The ones past it have no
 * fields rendered, so there is nothing to read from the form and they travel
 * as they arrived.
 */
function itemPayloadUpTo(upTo: number | null): Record<string, string> {
  const out: Record<string, string> = {};
  EXTRA_ITEMS.forEach((w, index) => {
    const f = itemFields(w);
    const source = upTo !== null && index <= upTo ? "form" : "data";
    out[f.description] = `\${${source}.${f.description}}`;
    out[f.amount] = `\${${source}.${f.amount}}`;
  });
  return out;
}

/**
 * Whether an item exists, as its own field.
 *
 * One flag each rather than one count, because the count cannot drive the
 * boxes. A Form refuses a field name it has already seen — "Duplicate name
 * found for Form components" — so a Switch on the count would have to repeat
 * item two's fields in the branch for three items, and four, and five. With a
 * flag apiece, each item gets a Switch of its own whose single case renders
 * its two fields once, and four independent Switches can all be open at the
 * same time. Which is what a list is.
 */
export const flagField = (w: string): string => `has_${w}`;

/** All four flags as data. */
function flagData(): Record<string, unknown> {
  return Object.fromEntries(
    EXTRA_ITEMS.map((w) => [flagField(w), { type: "string", __example__: "no" }]),
  );
}

/**
 * The flags in a payload.
 *
 * `at` is the item this screen has just collected, which is the one turning
 * on. Null on the form, which turns none on and passes them all through, and
 * "fresh" at the very start, where nothing exists yet and there is no data to
 * pass through from.
 */
function flagPayload(at: number | null | "fresh"): Record<string, string> {
  return Object.fromEntries(
    EXTRA_ITEMS.map((w, index) => [
      flagField(w),
      at === "fresh" ? "no" : index === at ? "yes" : `\${data.${flagField(w)}}`,
    ]),
  );
}

/** The starting numbers still ahead of us. Consumed ones are not passed on. */
function initPayload(from: number): Record<string, string> {
  const out: Record<string, string> = {};
  EXTRA_ITEMS.forEach((w, index) => {
    if (index >= from) out[initField(w)] = `\${data.${initField(w)}}`;
  });
  return out;
}

/**
 * The item half of a screen's data.
 *
 * `from` is the first starting number this screen still carries — 0 on WORK,
 * its own index on an item screen, and null on TERMS, which is the end of the
 * road and initialises nothing.
 */
function itemData(from: number | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  EXTRA_ITEMS.forEach((w, index) => {
    const f = itemFields(w);
    out[f.description] = { type: "string", __example__: "" };
    out[f.amount] = { type: "string", __example__: "" };
    if (from != null && index >= from) out[initField(w)] = { type: "number", __example__: 0 };
  });
  return out;
}

/**
 * Two screens: who and what, then how it is paid.
 *
 * Split there because the first screen is the invoice and the second is the
 * terms. Somebody who wants no terms fills four fields, taps twice and is
 * done — the second screen already reads "one payment, no VAT", which is the
 * invoice a sentence would have produced anyway.
 *
 * Amounts are digits, not "250k". The number pad is already open on that field
 * and there is nothing to abbreviate; the sentence keeps the shorthand.
 *
 * Dates stay words — "Friday", "end of the month" — because a date picker
 * cannot say "the third week of October" and somebody will mean exactly that.
 * The same reader that handles the sentence handles this.
 *
 * Currency is deliberately absent. Payment confirmation rejects anything that
 * is not NGN, so a dropdown offering USD would carry an invoice all the way to
 * a payment that cannot be made.
 */
/**
 * What separates a quote from an invoice, which is almost nothing.
 *
 * The same four fields, the same terms, the same shape. Only the date means
 * something different — one is when money is due, the other is when the offer
 * stops standing — and the words on screen have to say so, because "Due" on a
 * quote is a promise nobody made.
 *
 * One factory rather than two files of near-identical JSON. They are published
 * as separate Flows because Meta needs a form per entry point, but a change to
 * the fields has to reach both or they drift, and drift here means a quote
 * that quietly collects something an invoice does not.
 */
type DocumentFlow = {
  key: "invoice" | "quote";
  /** Shown in Meta's list of Flows. */
  name: string;
  /** The first screen's title. */
  title: string;
  /** Ten characters or fewer, or it wraps. See the label test. */
  dateLabel: string;
  dateHelp: string;
};

/**
 * One extra item, on its own screen.
 *
 * Reached only by tapping "Add another item", so an invoice with one line
 * never shows it — which is most invoices. The back arrow is the remove: the
 * screen is popped and its two fields go with it, and the screen somebody
 * taps Next on is the number of items the invoice has.
 *
 * Everything the document has collected so far rides along in `data` and is
 * handed on untouched. Only this screen's own two fields are read from the
 * form.
 */
function itemScreen(index: number, o: DocumentFlow): Record<string, unknown> {
  const word = EXTRA_ITEMS[index]!;
  const f = itemFields(word);
  const next = EXTRA_ITEMS[index + 1];

  /* What a document is, minus the items. `amount` is a string here and a
   * number on WORK: WORK initialises a number input with it, this screen only
   * passes it on, and what came out of WORK's form is a string. */
  const carried = {
    client_name: { type: "string", __example__: "Daniel Uwak" },
    client_email: { type: "string", __example__: "" },
    description: { type: "string", __example__: "Website design" },
    amount: { type: "string", __example__: "250000" },
    due_date: { type: "string", __example__: "" },
    plan: { type: "string", __example__: "one" },
    notes: { type: "string", __example__: "" },
    vat: { type: "boolean", __example__: false },
    pass_fees: { type: "boolean", __example__: false },
  };

  const carriedPayload = {
    client_name: "${data.client_name}",
    client_email: "${data.client_email}",
    description: "${data.description}",
    amount: "${data.amount}",
    due_date: "${data.due_date}",
    plan: "${data.plan}",
    notes: "${data.notes}",
    vat: "${data.vat}",
    pass_fees: "${data.pass_fees}",
  };

  return {
    id: itemScreenId(word),
    title: o.title,
    terminal: false,
    // Every starting number rides on every screen now. The form can be
    // reached again after any item, so there is no longer a point in the
    // journey where one of them is safely behind us.
    data: { ...carried, ...flagData(), ...itemData(0) },
    layout: {
      type: "SingleColumnLayout",
      children: [
        {
          type: "TextSubheading",
          // "Item two" rather than "Item 2": the screen ids have to be words,
          // and the two reading the same way is worth more than the digit.
          text: `Item ${index + 2}`,
        },
        {
          type: "Form",
          name: "item_form",
          "init-values": {
            [f.description]: `\${data.${f.description}}`,
            // The starting number, not `data.item_two_amount`, which is a
            // string by the time it reaches here. See initField.
            [f.amount]: `\${data.${initField(word)}}`,
          },
          children: [
            /*
             * Both required, which is what greys Save out until they are
             * filled in.
             *
             * They used to be optional, on the reasoning that a screen
             * somebody opened by accident should not trap them. What happened
             * instead is that a half-filled item saved, and the form came back
             * showing a line with no price on it. The back arrow is still the
             * way out of a screen opened by mistake — it leaves the item
             * unsaved, which is what blank fields used to mean and is clearer
             * about it.
             */
            {
              type: "TextInput",
              name: f.description,
              label: "Item",
              "helper-text": "What this line is for.",
              required: true,
              "input-type": "text",
              "max-chars": 100,
            },
            {
              type: "TextInput",
              name: f.amount,
              label: "Amount",
              "helper-text": "Naira, before VAT. Digits only.",
              required: true,
              "input-type": "number",
              "max-chars": 12,
            },
            /*
             * Remove, on the screen that owns the item.
             *
             * This is where it fits in the budget: a screen may hold two
             * EmbeddedLinks counted across every Switch branch, and the form
             * spends its allowance on Add. It is also where somebody is when
             * they change their mind about a line they are in the middle of
             * adding.
             *
             * A link rather than a second button, because a screen has one
             * Footer and that one is Save. And a link is not blocked by the
             * required fields, which is what lets it out of a screen the
             * Footer will not leave.
             */
            {
              type: "EmbeddedLink",
              text: `Remove item ${index + 2}`,
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: "REMOVED" },
                payload: {
                  ...carriedPayload,
                  // Everything from data, including this item: what this
                  // screen holds is not saved until the Footer saves it, so
                  // leaving by this door leaves nothing behind.
                  ...itemPayload(null),
                  ...initPayload(0),
                  ...flagPayload(null),
                  [f.description]: "",
                  [f.amount]: "",
                  [flagField(word)]: "no",
                  /*
                   * The count goes back one, not to this item's own word.
                   *
                   * It said `word`, which claimed three items on an invoice
                   * that had just lost its third. The boxes on the form run
                   * off the flags and the Next button runs off the count, so
                   * a count that overstates them sends Next to read an item
                   * out of a form that is not showing it — the same death as
                   * above, one screen along.
                   *
                   * Removing the only extra item leaves "one", which is the
                   * form with no extras on it.
                   */
                  item_count: index === 0 ? "one" : EXTRA_ITEMS[index - 1]!,
                },
              },
            },
            {
              /*
               * Back to the form, not onwards to the terms.
               *
               * The chain used to run ITEM_TWO to ITEM_THREE to TERMS, which
               * meant the only screen that ever knew about every item was the
               * last one. Somebody who tapped back to check the client name
               * landed on a screen holding none of them, and its Next threw
               * them away without a word.
               *
               * Handing the item back instead makes the form the one place
               * that holds the whole invoice. It lists what has been added
               * and offers the next slot, so adding a third item is a tap
               * from there rather than a chain nobody can leave.
               */
              type: "Footer",
              label: "Save item",
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: "WORK_AGAIN" },
                payload: {
                  ...carriedPayload,
                  ...itemPayload(index),
                  ...initPayload(0),
                  // This item now exists, which is what puts its two boxes on
                  // the form. The others keep whatever they were.
                  ...flagPayload(index),
                  // A literal, because this is the screen that knows: saving
                  // item three is what makes the invoice three items long.
                  // The word, not the digit: a Switch case key that looks
                  // like a number is refused on upload.
                  item_count: word,
                },
              },
            },
          ],
        },
      ],
    },
  };
}

/**
 * The main screen of the form, and the screen you come back to.
 *
 * Two instances of one builder. `again` is the copy the extra-item screens
 * return to, and it exists because of something a user hit within an hour of
 * the item screens going live: add a second item, tap back to check the
 * client name, tap Next, and the second item is gone.
 *
 * That is not a slip, it is the shape. A Flow with no data endpoint has no
 * memory across the back arrow — the earlier screen is restored with the
 * data it was pushed with, which for this screen is no extra items at all.
 * And a Footer's destination is fixed when the Flow is published, so Next
 * cannot decide to visit item two only when there is one.
 *
 * So the item screens no longer carry on forwards. They hand their item back
 * here, and this screen then holds every item, lists them, and sends them on.
 * Nobody has to press back, and the screen somebody is looking at is the
 * screen that knows everything.
 *
 * The one difference between the two copies is the Amount box. The first
 * declares `amount` a number, so the phone opens a number pad on it; what
 * comes back out of that box is a string and there is no cast in Flow JSON,
 * so the copy that receives it declares a string and takes a text keyboard.
 * The alternative was a text keyboard for everybody on the field they type
 * most often, to spare the return trip a worse one.
 */
function workScreen(o: DocumentFlow, again: boolean): Record<string, unknown> {
  /*
   * What leaves this screen, whichever way somebody leaves it.
   *
   * `at` is the extra item this screen currently has boxes for, or null on
   * the first copy, which has none. That item is read from the form so an
   * edit to it counts; the rest are passed along from data untouched.
   */
  const leaving = (upTo: number | null, flags = true) => ({
    client_name: "${form.client_name}",
    client_email: "${form.client_email}",
    description: "${form.description}",
    amount: "${form.amount}",
    due_date: "${form.due_date}",
    plan: "${data.plan}",
    notes: "${data.notes}",
    vat: "${data.vat}",
    pass_fees: "${data.pass_fees}",
    ...itemPayloadUpTo(upTo),
    /*
     * The flags travel between the form and the item screens and stop there.
     *
     * TERMS does not declare them, and a payload carrying a key the screen it
     * lands on has never heard of is not ignored — the Flow dies with
     * "Something went wrong. Try again later.", on the tap after the one that
     * caused it. Adding them to TERMS would work too, and would mean sending
     * the form's own bookkeeping on to the screen that submits the invoice.
     */
    ...(flags ? (again ? flagPayload(null) : flagPayload("fresh")) : {}),
  });

  /*
   * Where "Add another item" goes, and everything it takes with it.
   *
   * A screen may hold two EmbeddedLinks and no more \u2014 "Maximum number of
   * EmbeddedLink allowed per screen is 2 but found 8" \u2014 and the count is
   * taken across every branch of every Switch, not across what is on screen
   * at once. That limit is not enforced on publish in a way that helps: the
   * Flow went out with eight links on the form and the phone answered
   * "Something went wrong. Try again later." on open.
   *
   * So the form has one Add link with one fixed target, and the screen it
   * lands on does the routing with a Footer per count. Footers are not
   * rationed.
   */
  const addLink = (target: string, at: number | null) => ({
    type: "EmbeddedLink",
    text: "Add another item",
    "on-click-action": {
      name: "navigate",
      next: { type: "screen", name: target },
      payload: {
        ...leaving(at),
        ...initPayload(0),
        // The router needs the count to know which slot is next. The item
        // screens do not, and a key a screen does not declare kills the Flow.
        ...(again ? { item_count: "${data.item_count}" } : {}),
      },
    },
  });

  /* Onward to the terms, carrying the same. */
  const onward = (at: number | null) => ({
    type: "Footer",
    label: "Next",
    "on-click-action": {
      name: "navigate",
      next: { type: "screen", name: "TERMS" },
      payload: leaving(at, false),
    },
  });

  /**
   * The item just added, in two boxes somebody can type in.
   *
   * Not a line of text. Dynamic text does not resolve on a handset: the first
   * attempt was a caption reading `Item 2: ${data.item_two_description}`, and
   * that is precisely what the phone showed — the words, not the value. Meta's
   * validator accepts it, which by now counts for nothing on its own.
   *
   * `init-values` does resolve, because it is how the client's own name comes
   * back when a correction reopens the form. So the value goes into an input,
   * which then shows it — and an input is a thing you can fix. The first
   * version disabled them, which put the item on screen behind glass: you
   * could read the typo and not touch it, and the only way to change a price
   * was to send the whole invoice and correct the draft.
   *
   * Neither is required, and that is the remove. Clearing both leaves an item
   * with no description and no amount, which is not an item, and the reader
   * that builds the document drops it. Adding one still demands both, on the
   * screen that adds it — you cannot create half an item, only delete a whole
   * one.
   *
   * One item per branch rather than all of them, because a Form refuses a
   * field name it has already seen — "Duplicate name found for Form
   * components" — and a cumulative list would repeat item two in every branch
   * after the second. What is shown is the one just saved, which is the one
   * somebody is looking for.
   */
  const savedFields = (index: number) => {
    const f = itemFields(EXTRA_ITEMS[index]!);
    return [
      {
        type: "TextInput",
        name: f.description,
        label: `Item ${index + 2}`,
        required: false,
        "input-type": "text",
        "max-chars": 100,
      },
      {
        type: "TextInput",
        name: f.amount,
        label: "Amount",
        "helper-text": "Clear both to drop this item.",
        required: false,
        "input-type": "text",
        "max-chars": 12,
      },
    ];
  };

  /*
   * What has been added, and where the next one goes.
   *
   * A `Switch` rather than five slots behind `visible`: that property is
   * accepted by Meta's validator and ignored on a handset, which is how four
   * empty Item/Amount pairs once appeared under a one-line invoice. A Switch
   * renders one branch, and the branch carries both the list and the link, so
   * the two cannot disagree about how many items there are.
   *
   * Flow JSON has no default case, so every count is spelled out. One item
   * never reaches this screen and five is the last of them.
   *
   * The cases are keyed by the item's word for the same reason the screens
   * are. Meta's validator refuses a Switch whose case keys look like numbers,
   * with "Cannot read property 'type' of undefined" and no line number —
   * probed on 23 September 2026 against a throwaway Flow, one variant at a
   * time, because the message says nothing about which key it choked on.
   */
  const cases: Record<string, unknown[]> = {};

  /*
   * The Next button, once per branch, and for the same reason.
   *
   * It has to read the item on screen out of the *form* rather than out of
   * data, or an edit made here is discarded the moment somebody taps it —
   * which is the bug this whole screen exists to prevent, one level down. The
   * payload differs per branch, so the button does too, and a Footer inside a
   * Switch cannot coexist with one outside it.
   */
  const footers: Record<string, unknown[]> = {};

  /*
   * No running total on this screen.
   *
   * There was a line reading "3 items on this invoice", and a removal makes
   * it a lie: the count stays where it is so that Add keeps walking forwards
   * into unused slots rather than refilling a hole. A number that is wrong
   * after an ordinary action is worse than no number, and the items are all
   * listed above it anyway.
   */
  /*
   * One item back to nothing: the form with no extras on it.
   *
   * Reached by removing the only extra item. Without this case the Switch
   * would match nothing, and a screen whose Footer lives inside a Switch and
   * matches nothing has no way forward at all.
   */
  cases.one = [];
  footers.one = [onward(null)];

  EXTRA_ITEMS.forEach((_, index) => {
    cases[EXTRA_ITEMS[index]!] = [];
    footers[EXTRA_ITEMS[index]!] = [onward(index)];
  });

  /*
   * One Switch per item, each on its own flag, so they can all be open.
   *
   * The first version keyed everything off the count, which meant only the
   * item just saved could be shown: repeating item two's fields in the branch
   * for three items would have been the same field name twice, and a Form
   * refuses that. A flag each gives every item a Switch whose single case
   * renders its two boxes once, and four of them open together are a list.
   */
  const itemBoxes = EXTRA_ITEMS.map((w, index) => ({
    type: "Switch",
    value: `\${data.${flagField(w)}}`,
    cases: { yes: savedFields(index) },
  }));

  /*
   * Starting values for those boxes.
   *
   * Every declared key has to match a field that exists somewhere on the
   * screen — "declared but not used in the init-values" is a publish error —
   * and each field appears in exactly one branch, so the two lists are the
   * same length by construction.
   */
  const savedInit: Record<string, string> = {};
  if (again) {
    for (const w of EXTRA_ITEMS) {
      const f = itemFields(w);
      savedInit[f.description] = `\${data.${f.description}}`;
      savedInit[f.amount] = `\${data.${f.amount}}`;
    }
  }

  return {
    id: again ? "WORK_AGAIN" : "WORK",
    title: o.title,
    terminal: false,
    // Declared so a correction can open the form on what is already there.
    data: {
      client_name: { type: "string", __example__: "Daniel Uwak" },
      client_email: { type: "string", __example__: "" },
      description: { type: "string", __example__: "Website design" },
      // A number on the way in, because the input is `input-type: "number"`
      // and Meta checks the declared type against the field it initialises. A
      // string on the way back, because that is what a form returns.
      amount: again
        ? { type: "string", __example__: "250000" }
        : { type: "number", __example__: 250000 },
      due_date: { type: "string", __example__: "" },
      plan: { type: "string", __example__: "one" },
      notes: { type: "string", __example__: "" },
      vat: { type: "boolean", __example__: false },
      pass_fees: { type: "boolean", __example__: false },
      // How many items exist, as the string a Switch can match on.
      ...(again ? { item_count: { type: "string", __example__: "two" }, ...flagData() } : {}),
      ...itemData(0),
    },
    layout: {
      type: "SingleColumnLayout",
      children: [
        {
          type: "TextSubheading",
          text: again ? "Your invoice so far." : "Who it is for, and what it is for.",
        },
        {
          type: "Form",
          name: "work_form",
          // Starting values belong to the form, not to each input: at 7.1
          // `init-value` on a TextInput is rejected outright.
          "init-values": {
            client_name: "${data.client_name}",
            client_email: "${data.client_email}",
            description: "${data.description}",
            amount: "${data.amount}",
            due_date: "${data.due_date}",
            ...savedInit,
          },
          children: [
            {
              type: "TextInput",
              name: "client_name",
              label: "Client",
              required: true,
              "input-type": "text",
              "max-chars": 80,
            },
            {
              type: "TextInput",
              name: "client_email",
              label: "Email",
              "helper-text": "Optional. They get a copy by email too.",
              required: false,
              "input-type": "email",
              "max-chars": 120,
            },
            {
              type: "TextInput",
              name: "description",
              label: "Item",
              "helper-text": "What you are billing for. This is the line they read.",
              required: true,
              "input-type": "text",
              "max-chars": 100,
            },
            {
              type: "TextInput",
              name: "amount",
              label: "Amount",
              "helper-text": "Naira, before VAT. Digits only.",
              required: true,
              "input-type": again ? "text" : "number",
              "max-chars": 12,
            },
            /*
             * Straight after the first item's amount, because that is where
             * somebody realises there is a second thing to bill for.
             *
             * A link rather than a checkbox, and a screen rather than a row,
             * because Flow JSON has no repeater and nothing on a screen can
             * add one. `update_data` is not an action at 7.1, so a control
             * that changes what is on screen would need a data endpoint,
             * which these Flows deliberately do not have.
             */
            ...(again
              ? [
                  ...itemBoxes,
                  { type: "Switch", value: "${data.item_count}", cases },
                  /*
                   * One link, one target. ADD_NEXT works out which item
                   * screen that means.
                   *
                   * `null`, so every item travels from data rather than from
                   * the form — and that is not tidiness, it is the whole
                   * bug. A payload cannot vary by branch here: a link's
                   * payload is fixed at publish and the screen may hold two
                   * links in total, counted across every Switch, so there is
                   * no per-count version of this one. Reading `${form.x}`
                   * for an item whose boxes are not on screen therefore
                   * happens on every count below five — and a form field
                   * that was never rendered has no value to read. The Flow
                   * died one tap later, on ADD_NEXT, with "Something went
                   * wrong. Try again later."
                   *
                   * What it costs: an edit typed into an item box and not
                   * followed by Next is lost by tapping Add. The always-on
                   * fields above — client, item, amount, date — are read
                   * from the form and survive, because those are rendered
                   * whatever the count is. Next reads the item boxes from
                   * the form, and Next is inside the Switch that knows how
                   * many of them there are, which is why it is allowed to.
                   */
                  addLink("ADD_NEXT", null),
                ]
              : [addLink(itemScreenId(EXTRA_ITEMS[0]!), null)]),
            {
              type: "TextInput",
              name: "due_date",
              label: o.dateLabel,
              "helper-text": o.dateHelp,
              required: false,
              "input-type": "text",
              "max-chars": 40,
            },
            /*
             * Next, once per branch on the form you come back to.
             *
             * Its payload has to read every item that has boxes on screen out
             * of the form, so an edit made here counts, and how many that is
             * depends on the count — so the button itself does. A Footer
             * inside a Switch cannot coexist with one outside it, which is
             * why the plain button below belongs to the first copy alone.
             */
            ...(again
              ? [{ type: "Switch", value: "${data.item_count}", cases: footers }]
              : [onward(null)]),
          ],
        },
      ],
    },
  };
}

/**
 * Which item screen "Add another item" means.
 *
 * The form cannot decide this itself. A link's target is fixed when the Flow
 * is published, so one link per possible target would be four links — and a
 * screen may hold two, counted across every branch of every Switch. Eight of
 * them published without complaint and then failed to open on the phone, with
 * "Something went wrong. Try again later." and nothing else.
 *
 * Footers are not rationed, so the routing happens here instead: one Footer
 * per count, each pointing at the first empty slot. It costs a tap, which is
 * the price of the limit.
 */
function addNextScreen(): Record<string, unknown> {
  const carried = {
    client_name: { type: "string", __example__: "Daniel Uwak" },
    client_email: { type: "string", __example__: "" },
    description: { type: "string", __example__: "Website design" },
    amount: { type: "string", __example__: "250000" },
    due_date: { type: "string", __example__: "" },
    plan: { type: "string", __example__: "one" },
    notes: { type: "string", __example__: "" },
    vat: { type: "boolean", __example__: false },
    pass_fees: { type: "boolean", __example__: false },
    item_count: { type: "string", __example__: "two" },
  };
  const data = { ...carried, ...flagData(), ...itemData(0) };

  /** Everything, untouched. This screen decides a direction and nothing else. */
  const through = Object.fromEntries(
    Object.keys(data)
      .filter((k) => k !== "item_count")
      .map((k) => [k, `\${data.${k}}`]),
  );

  const footer = (label: string, target: string) => ({
    type: "Footer",
    label,
    "on-click-action": {
      name: "navigate",
      next: { type: "screen", name: target },
      payload: through,
    },
  });

  /*
   * One branch per count. The count says how many items exist, so the next
   * one is the slot after that \u2014 and on five there is no next one, so the
   * only way out is back.
   */
  const cases: Record<string, unknown[]> = {
    one: [footer("Add item 2", itemScreenId(EXTRA_ITEMS[0]!))],
  };
  EXTRA_ITEMS.forEach((w, index) => {
    const next = EXTRA_ITEMS[index + 1];
    cases[w] = next
      ? [footer(`Add item ${index + 3}`, itemScreenId(next))]
      : [
          {
            type: "TextBody",
            text: "Five items is the most this form takes. Send a sentence for a longer invoice.",
          },
          {
            type: "Footer",
            label: "Back to the invoice",
            "on-click-action": {
              name: "navigate",
              next: { type: "screen", name: "WORK_AGAIN" },
              payload: { ...through, item_count: `\${data.item_count}` },
            },
          },
        ];
  });

  return {
    id: "ADD_NEXT",
    title: "Another item",
    terminal: false,
    data,
    layout: {
      type: "SingleColumnLayout",
      children: [
        { type: "TextSubheading", text: "Another line on this invoice." },
        { type: "Form", name: "add_form", children: [{ type: "Switch", value: "${data.item_count}", cases }] },
      ],
    },
  };
}

/**
 * Where Remove goes, so that it can come back.
 *
 * A screen cannot navigate to itself — "Same screen navigation is not allowed.
 * Loop detected" — so taking an item off the invoice cannot simply redraw the
 * form. A cycle through another screen is allowed, so this is that screen: it
 * says what happened, hands everything back, and has no opinion of its own.
 *
 * It collects nothing, which is why there is no Form on it. Everything it
 * holds arrived in the payload of the link that removed the item, already
 * blanked, and leaves again untouched.
 */
function removedScreen(): Record<string, unknown> {
  const carried = {
    client_name: { type: "string", __example__: "Daniel Uwak" },
    client_email: { type: "string", __example__: "" },
    description: { type: "string", __example__: "Website design" },
    // A string: it came out of a form on the way here.
    amount: { type: "string", __example__: "250000" },
    due_date: { type: "string", __example__: "" },
    plan: { type: "string", __example__: "one" },
    notes: { type: "string", __example__: "" },
    vat: { type: "boolean", __example__: false },
    pass_fees: { type: "boolean", __example__: false },
    item_count: { type: "string", __example__: "two" },
  };

  const back = Object.fromEntries(
    Object.keys({ ...carried, ...flagData(), ...itemData(0) }).map((k) => [k, `\${data.${k}}`]),
  );

  return {
    id: "REMOVED",
    title: "Item removed",
    terminal: false,
    data: { ...carried, ...flagData(), ...itemData(0) },
    layout: {
      type: "SingleColumnLayout",
      children: [
        { type: "TextSubheading", text: "That item is off the invoice." },
        { type: "TextCaption", text: "Everything else is as you left it." },
        {
          /*
           * A Form with nothing in it but the button.
           *
           * Every other screen puts its Footer inside one, and this screen
           * collects nothing, so it did not need one. Being the only screen
           * shaped differently is not a difference worth having when the
           * failure it would cause looks like "Something went wrong."
           */
          type: "Form",
          name: "removed_form",
          children: [
            {
              type: "Footer",
              label: "Back to the invoice",
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: "WORK_AGAIN" },
                payload: back,
              },
            },
          ],
        },
      ],
    },
  };
}

function documentFlow(o: DocumentFlow): FlowDefinition {
  return {
  key: o.key,
  name: o.name,
  categories: ["OTHER"],
  json: {
    version: VERSION,
    screens: [
      workScreen(o, false),
      workScreen(o, true),
      addNextScreen(),
      ...EXTRA_ITEMS.map((_, index) => itemScreen(index, o)),
      removedScreen(),
      {
        id: "TERMS",
        title: "How it is paid",
        terminal: true,
        success: true,
        data: {
          client_name: { type: "string", __example__: "Daniel Uwak" },
          client_email: { type: "string", __example__: "" },
          description: { type: "string", __example__: "Website design" },
          // A string, and not a mistake.
          //
          // WORK declares this a number, because it initialises a
          // `input-type: "number"` field and Meta checks the declared type
          // against the input it fills. But the value that comes back out of
          // that same field — ${form.amount} in WORK's Footer payload — is a
          // string, so this screen receives a string.
          //
          // Declaring it a number here passes the publish validator and then
          // fails on a real phone, at the moment somebody taps Next:
          //
          //   Data Validation Error
          //   [key=data.amount] in object should be of type <number>, but got
          //   <string>.
          //
          // Nothing in the JSON connects those two declarations, which is why
          // definitions.test.ts now checks this specific direction.
          amount: { type: "string", __example__: "250000" },
          due_date: { type: "string", __example__: "" },
          plan: { type: "string", __example__: "one" },
          notes: { type: "string", __example__: "" },
          vat: { type: "boolean", __example__: false },
          pass_fees: { type: "boolean", __example__: false },
          // Strings, like everywhere. TERMS initialises none of them, so it
          // carries no starting numbers either. See itemData.
          ...itemData(null),
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextSubheading",
              text: "Leave this alone for one payment on the due date.",
            },
            {
              type: "Form",
              name: "terms_form",
              "init-values": {
                plan: "${data.plan}",
                notes: "${data.notes}",
                vat: "${data.vat}",
                pass_fees: "${data.pass_fees}",
              },
              children: [
                {
                  type: "Dropdown",
                  name: "plan",
                  label: "Payment",
                  required: true,
                  "data-source": PLANS.map((p) => ({ id: p.id, title: p.title })),
                },
                {
                  type: "OptIn",
                  name: "vat",
                  label: "Add 7.5% VAT",
                },
                {
                  type: "OptIn",
                  name: "pass_fees",
                  label: "Client pays the transaction fee",
                },
                {
                  type: "TextArea",
                  name: "notes",
                  label: "Notes",
                  "helper-text": "Optional. Printed at the bottom of the invoice.",
                  required: false,
                  "max-length": 500,
                },
                {
                  type: "Footer",
                  label: "See the draft",
                  "on-click-action": {
                    name: "complete",
                    payload: {
                      client_name: "${data.client_name}",
                      client_email: "${data.client_email}",
                      description: "${data.description}",
                      amount: "${data.amount}",
                      ...itemPayload(null),
                      due_date: "${data.due_date}",
                      plan: "${form.plan}",
                      vat: "${form.vat}",
                      pass_fees: "${form.pass_fees}",
                      notes: "${form.notes}",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  },
  };
}

const invoice = documentFlow({
  key: "invoice",
  name: "Balans invoice",
  title: "New invoice",
  dateLabel: "Due",
  dateHelp: "Optional. Friday, 30 September, in two weeks.",
});

const quote = documentFlow({
  key: "quote",
  name: "Balans quote",
  title: "New quote",
  // "Valid until" is eleven characters and wraps. "Valid to" says the same
  // thing in eight, and the helper carries the rest.
  dateLabel: "Valid to",
  dateHelp: "Optional. How long the price stands — 30 September, in two weeks.",
});

/**
 * A payment request: one screen, three fields.
 *
 * Not the factory above, because a request is genuinely a different shape
 * rather than the same one with different words. F8 calls it "a lightweight
 * payable with no PDF" — there is no due date to set, no VAT to add and no
 * payment plan to choose, because there is no document for any of it to
 * print on. Giving it a second screen would be inventing terms for something
 * whose whole point is not having any.
 *
 * The email is here and optional for the same reason it is on an invoice: a
 * link in a chat is easy to lose, and a copy in an inbox is not.
 */
const request: FlowDefinition = {
  key: "request",
  name: "Balans payment request",
  categories: ["OTHER"],
  json: {
    version: VERSION,
    screens: [
      {
        id: "WORK",
        title: "Request a payment",
        terminal: true,
        success: true,
        data: {
          client_name: { type: "string", __example__: "Daniel Uwak" },
          client_email: { type: "string", __example__: "" },
          description: { type: "string", __example__: "Studio session" },
          amount: { type: "number", __example__: 20000 },
        },
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextSubheading",
              text: "Who owes it, and what for.",
            },
            {
              type: "Form",
              name: "request_form",
              "init-values": {
                client_name: "${data.client_name}",
                client_email: "${data.client_email}",
                description: "${data.description}",
                amount: "${data.amount}",
              },
              children: [
                {
                  type: "TextInput",
                  name: "client_name",
                  label: "Client",
                  required: true,
                  "input-type": "text",
                  "max-chars": 80,
                },
                {
                  type: "TextInput",
                  name: "client_email",
                  label: "Email",
                  "helper-text": "Optional. They get the link by email too.",
                  required: false,
                  "input-type": "email",
                  "max-chars": 120,
                },
                {
                  type: "TextInput",
                  name: "description",
                  label: "Item",
                  "helper-text": "What the money is for. This is the line they read.",
                  required: true,
                  "input-type": "text",
                  "max-chars": 100,
                },
                {
                  type: "TextInput",
                  name: "amount",
                  label: "Amount",
                  "helper-text": "Naira. Digits only.",
                  required: true,
                  "input-type": "number",
                  "max-chars": 12,
                },
                {
                  type: "Footer",
                  label: "See the draft",
                  "on-click-action": {
                    name: "complete",
                    payload: {
                      client_name: "${form.client_name}",
                      client_email: "${form.client_email}",
                      description: "${form.description}",
                      amount: "${form.amount}",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  },
};

/**
 * Agreeing to the terms, without leaving the chat to do it.
 *
 * It used to be two URLs and a button. Nobody opens a link to a legal page on
 * their phone in the middle of signing up, so in practice people agreed to
 * something they had not seen \u2014 which is exactly the situation consent is
 * supposed to avoid.
 *
 * So the screen says, in plain words, the five things that actually affect
 * somebody: we are not a bank, the money is theirs, what it costs, that they
 * can stop, and what we do with their data. The full documents are one tap
 * away for anyone who wants them.
 *
 * The summary is a summary and the documents are the agreement, which is why
 * the text is not duplicated here: a second copy of a legal document is a
 * copy that will eventually disagree with the first, and then somebody has
 * agreed to words nobody can produce. The site stays the only source.
 */
const consent: FlowDefinition = {
  key: "consent",
  name: "Balans terms",
  categories: ["SIGN_UP"],
  json: {
    version: VERSION,
    screens: [
      {
        id: "TERMS",
        title: "Before you finish",
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: "SingleColumnLayout",
          children: [
            {
              type: "TextSubheading",
              text: "What you are agreeing to",
            },
            {
              type: "TextBody",
              text: "Balans is not a bank and never holds your money. Payments settle straight to your own bank account.",
            },
            {
              type: "TextBody",
              text: "Free covers 5 documents a month with a 1% fee on payments. Pro is \u20a64,000 a month with no fee. Cancel any time \u2014 your invoices and records stay where they are.",
            },
            {
              type: "TextBody",
              text: "We keep what you send us to make your invoices and to meet Nigerian record-keeping law. We never sell it.",
            },
            {
              type: "EmbeddedLink",
              text: "Read the full Terms of use",
              "on-click-action": { name: "open_url", url: `${site}/terms` },
            },
            {
              type: "EmbeddedLink",
              text: "Read the Privacy Notice",
              "on-click-action": { name: "open_url", url: `${site}/privacy` },
            },
            {
              type: "Form",
              name: "consent_form",
              children: [
                {
                  type: "OptIn",
                  name: "agreed",
                  label: "I agree to the Terms and the Privacy Notice",
                  required: true,
                },
                {
                  type: "Footer",
                  label: "Agree and finish",
                  "on-click-action": {
                    name: "complete",
                    payload: { agreed: "${form.agreed}" },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  },
};

export const FLOWS: readonly FlowDefinition[] = [
  onboarding,
  businessDetails,
  invoice,
  quote,
  request,
  consent,
];

export const flowByKey = (key: string): FlowDefinition | undefined =>
  FLOWS.find((f) => f.key === key);
