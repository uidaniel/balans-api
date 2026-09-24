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
/**
 * The items after the first, and the screens that hold them.
 *
 * The shape of this changed completely on 23 September 2026, after three
 * rounds of "Something went wrong. Try again later." on a real phone, and the
 * reason is worth writing down because Meta's validator will not tell you.
 *
 * The form used to be one screen that reshaped itself: a `Switch` per item
 * decided which boxes appeared, a count decided which button, and the Form's
 * `init-values` named all eight item fields so the boxes would come back
 * filled. That last part is the bug. `init-values` may only name fields that
 * are *on the screen*, and a field inside a `Switch` branch that did not match
 * is not on the screen. Publishing is happy \u2014 every name exists somewhere in
 * the JSON, which is all the validator checks, confirmed by probe. The phone
 * is not, and it does not say so until the next tap, which is what made this
 * so hard to see: the screen you are staring at when it breaks is not the
 * screen that broke it.
 *
 * So nothing is conditional any more. There is one screen per number of items
 * \u2014 WORK_ONE through WORK_FIVE \u2014 and each renders exactly the boxes it has,
 * names exactly those in `init-values`, and reads exactly those back out of
 * the form. Adding an item is a move to the next screen; removing one is a
 * move to the previous. No Switch, no flags, no count field, no second copy of
 * an amount to work around a type, and no router screen in the middle \u2014 which
 * also gives back the tap that used to cost.
 *
 * Eleven screens instead of nine. Fifteen publish fine (probed), and screen
 * ids may hold letters and underscores only, which is why they are words.
 */
export const EXTRA_ITEMS = ["two", "three", "four", "five"] as const;

/** Item counts as words, for screen ids. `TOTALS[n - 1]` names n items. */
const TOTALS = ["ONE", "TWO", "THREE", "FOUR", "FIVE"] as const;

/** Field names for one item, in the order they appear on the screen. */
export const itemFields = (w: string): { description: string; amount: string } => ({
  description: `item_${w}_description`,
  amount: `item_${w}_amount`,
});

/** The screen that collects one item. Letters and underscores only. */
export const itemScreenId = (w: string): string => `ITEM_${w.toUpperCase()}`;

/**
 * The form screen that shows exactly this many items.
 *
 * `items` counts the first one too, so it runs 1 to 5. WORK is the separate
 * entry copy; see `formScreen`.
 */
export const formScreenId = (items: number): string => `WORK_${TOTALS[items - 1]}`;

/** The extra items a screen showing `items` items has: 0 to 4 of them. */
const extrasOf = (items: number): readonly string[] => EXTRA_ITEMS.slice(0, items - 1);

/** What a document is, minus the items. */
const carriedData = (amount: "string" | "number"): Record<string, unknown> => ({
  client_name: { type: "string", __example__: "Daniel Uwak" },
  client_email: { type: "string", __example__: "" },
  description: { type: "string", __example__: "Website design" },
  amount:
    amount === "number"
      ? { type: "number", __example__: 250000 }
      : { type: "string", __example__: "250000" },
  due_date: { type: "string", __example__: "" },
  plan: { type: "string", __example__: "one" },
  notes: { type: "string", __example__: "" },
  vat: { type: "boolean", __example__: false },
  pass_fees: { type: "boolean", __example__: false },
});

/** Those same fields in a payload, from wherever this screen holds them. */
const carriedPayload = (from: "form" | "data"): Record<string, string> => ({
  // The five somebody types are read from the form wherever there is one, so
  // an edit made on the way past is an edit that counts.
  client_name: `\${${from}.client_name}`,
  client_email: `\${${from}.client_email}`,
  description: `\${${from}.description}`,
  amount: `\${${from}.amount}`,
  due_date: `\${${from}.due_date}`,
  // These four are only ever set on TERMS, at the end, so every screen before
  // it is simply carrying them.
  plan: "${data.plan}",
  notes: "${data.notes}",
  vat: "${data.vat}",
  pass_fees: "${data.pass_fees}",
});

/** Some number of extra items, declared. Always strings: a form returns strings. */
function itemData(count: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of EXTRA_ITEMS.slice(0, count)) {
    const f = itemFields(w);
    out[f.description] = { type: "string", __example__: "" };
    out[f.amount] = { type: "string", __example__: "" };
  }
  return out;
}

/**
 * Some number of extra items in a payload, read from one place.
 *
 * There is no longer a choice to get wrong. A screen showing `count` items
 * reads all `count` of them out of its own form; a screen that is only passing
 * them through reads all of them out of data. The old version took "read the
 * first n from the form and the rest from data", and getting n wrong by one is
 * how the form died last time.
 */
function itemPayload(count: number, from: "form" | "data"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of EXTRA_ITEMS.slice(0, count)) {
    const f = itemFields(w);
    out[f.description] = `\${${from}.${f.description}}`;
    out[f.amount] = `\${${from}.${f.amount}}`;
  }
  return out;
}

/** The slots past `count`, as the empty strings TERMS declares. */
function emptyItems(count: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of EXTRA_ITEMS.slice(count)) {
    const f = itemFields(w);
    out[f.description] = "";
    out[f.amount] = "";
  }
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
/**
 * One extra item, on a screen of its own.
 *
 * `index` is its place among the extras, so 0 is item 2. It is reached from
 * the form that already has `index` extras on it, and it hands its item back
 * to the form that has `index + 1`.
 *
 * Nothing is pre-filled here, which is why there are no `init-values` and no
 * second copy of the amount under another name. This screen is only ever
 * opened to add an item that does not exist yet; editing one that does happens
 * in its boxes on the form.
 */
function itemScreen(index: number, o: DocumentFlow): Record<string, unknown> {
  const word = EXTRA_ITEMS[index]!;
  const f = itemFields(word);
  const held = { ...carriedPayload("data"), ...itemPayload(index, "data") };

  return {
    id: itemScreenId(word),
    title: o.title,
    terminal: false,
    data: { ...carriedData("string"), ...itemData(index) },
    layout: {
      type: "SingleColumnLayout",
      children: [
        { type: "TextSubheading", text: `Item ${index + 2}` },
        {
          type: "Form",
          name: "item_form",
          children: [
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
            {
              /*
               * A link rather than a second button, because a screen has one
               * Footer and that one is Save. A link is also not blocked by the
               * two required fields above, which is what lets somebody out of
               * a screen the Footer will not leave.
               */
              type: "EmbeddedLink",
              text: `Remove item ${index + 2}`,
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: formScreenId(index + 1) },
                // Straight back to the form it came from, carrying only what
                // it arrived with. Nothing typed here was ever saved.
                payload: held,
              },
            },
            {
              type: "Footer",
              label: "Save item",
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: formScreenId(index + 2) },
                payload: {
                  ...held,
                  [f.description]: `\${form.${f.description}}`,
                  [f.amount]: `\${form.${f.amount}}`,
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
 * The form, once per number of items on it.
 *
 * `items` counts the first, so it runs 1 to 5. `entry` is the copy a Flow
 * opens on, and it exists for one reason: its Amount is a number input, so the
 * number pad is what comes up on the field people type most. A form only ever
 * returns strings and Flow JSON has no cast, so every screen after that
 * declares a string and takes a text keyboard. Nothing navigates to the entry
 * copy \u2014 removing an item from the two-item form lands on WORK_ONE, which is
 * the same screen with a string in it.
 *
 * What is on this screen is decided here and nowhere else. No Switch decides
 * what to render, so `init-values` can name every box and be right, and the
 * payloads can read every box and be right.
 */
function formScreen(o: DocumentFlow, items: number, entry: boolean): Record<string, unknown> {
  const extras = extrasOf(items);
  const mine = { ...carriedPayload("form"), ...itemPayload(extras.length, "form") };

  /** The boxes for the items after the first, in the order they were added. */
  const itemBoxes = extras.flatMap((w, i) => {
    const f = itemFields(w);
    return [
      {
        type: "TextInput",
        name: f.description,
        label: `Item ${i + 2}`,
        required: false,
        "input-type": "text",
        "max-chars": 100,
      },
      {
        type: "TextInput",
        name: f.amount,
        label: "Amount",
        "helper-text": "Naira, before VAT. Digits only.",
        required: false,
        "input-type": "text",
        "max-chars": 12,
      },
    ];
  });

  /*
   * Two links, and two is the ceiling.
   *
   * Probed against Meta on 23 September 2026: a screen may render at most two
   * EmbeddedLinks, and the count is per rendered screen rather than per Flow
   * \u2014 two links in each of four Switch branches publishes fine, three in one
   * branch does not. The error reports the total across every branch, which is
   * what made this look like a Flow-wide budget before. There is no `enabled`
   * property, so a link cannot be greyed out, and NavigationList is refused
   * outright at 7.1.
   *
   * So the form gets Add and one Remove. Remove takes the last item and sits
   * directly under that item's Amount, which is where somebody looking at a
   * line they did not want will look for it. Any other item is cleared by
   * emptying its two boxes \u2014 what the helper text says, and what the reader
   * that builds the document acts on.
   */
  const links = [
    ...(items < 5
      ? [
          {
            type: "EmbeddedLink",
            text: "Add another item",
            "on-click-action": {
              name: "navigate",
              next: { type: "screen", name: itemScreenId(EXTRA_ITEMS[extras.length]!) },
              payload: mine,
            },
          },
        ]
      : []),
    ...(extras.length > 0
      ? [
          {
            type: "EmbeddedLink",
            text: `Remove item ${items}`,
            "on-click-action": {
              name: "navigate",
              next: { type: "screen", name: formScreenId(items - 1) },
              // One item shorter, so the last one is simply not sent. The
              // screen it lands on does not declare it, which is the whole
              // removal: no blanking, no flag, nothing to fall out of step.
              payload: {
                ...carriedPayload("form"),
                ...itemPayload(extras.length - 1, "form"),
              },
            },
          },
        ]
      : []),
  ];

  return {
    id: entry ? "WORK" : formScreenId(items),
    title: o.title,
    terminal: false,
    data: { ...carriedData(entry ? "number" : "string"), ...itemData(extras.length) },
    layout: {
      type: "SingleColumnLayout",
      children: [
        {
          type: "TextSubheading",
          text: entry ? "Who it is for, and what it is for." : "Your invoice so far.",
        },
        {
          type: "Form",
          name: "work_form",
          /*
           * Every name here is a box on this screen, and every box on this
           * screen is named here. That is the invariant the old form broke,
           * and definitions.test.ts now checks it on every screen.
           *
           * Starting values belong to the Form, not to each input: at 7.1
           * `init-value` on a TextInput is rejected outright.
           */
          "init-values": {
            client_name: "${data.client_name}",
            client_email: "${data.client_email}",
            description: "${data.description}",
            amount: "${data.amount}",
            due_date: "${data.due_date}",
            ...Object.fromEntries(
              extras.flatMap((w) => {
                const f = itemFields(w);
                return [
                  [f.description, `\${data.${f.description}}`],
                  [f.amount, `\${data.${f.amount}}`],
                ];
              }),
            ),
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
              // No helper text. "Item" over a box on a form called New
              // invoice does not need explaining, and the line sat between
              // the first item and its amount — a sentence of instruction
              // wedged into the middle of the thing being filled in. The
              // second item has never had one and reads better for it.
              label: "Item",
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
              "input-type": entry ? "number" : "text",
              "max-chars": 12,
            },
            ...itemBoxes,
            ...(items === 5
              ? [
                  {
                    type: "TextCaption",
                    text: "Five items is the most this form takes. Send a sentence for a longer invoice.",
                  },
                ]
              : []),
            ...links,
            {
              type: "TextInput",
              name: "due_date",
              label: o.dateLabel,
              "helper-text": o.dateHelp,
              required: false,
              "input-type": "text",
              "max-chars": 40,
            },
            {
              type: "Footer",
              label: "Next",
              "on-click-action": {
                name: "navigate",
                next: { type: "screen", name: "TERMS" },
                // TERMS holds all five slots whichever way somebody got there,
                // so the ones this screen does not have go as the empty
                // strings it declares.
                payload: { ...mine, ...emptyItems(extras.length) },
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
      formScreen(o, 1, true),
      ...TOTALS.map((_, i) => formScreen(o, i + 1, false)),
      ...EXTRA_ITEMS.map((_, index) => itemScreen(index, o)),
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
          ...itemData(EXTRA_ITEMS.length),
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
                      ...itemPayload(EXTRA_ITEMS.length, "data"),
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
