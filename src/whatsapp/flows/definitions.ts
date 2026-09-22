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
                  label: "Business name",
                  "helper-text": "Or your own name, if that is how you bill.",
                  required: true,
                  "input-type": "text",
                  "max-chars": 80,
                },
                {
                  type: "TextInput",
                  name: "email",
                  label: "Email address",
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
              text: "Your clients pay Balans, and Balans pays this account.",
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
                  label: "Account number",
                  "helper-text": "The 10 digits on your account.",
                  required: true,
                  "input-type": "number",
                  "max-chars": 10,
                },
                {
                  type: "TextInput",
                  name: "other_bank",
                  label: "If you chose Other, which bank?",
                  "helper-text": "Leave this empty otherwise.",
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
              },
              children: [
                {
                  type: "TextInput",
                  name: "business_name",
                  label: "Business name",
                  required: true,
                  "input-type": "text",
                  "max-chars": 80,
                },
                {
                  type: "TextInput",
                  name: "email",
                  label: "Email address",
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
                  label: "Tax identification number",
                  "helper-text": "Optional. Some clients ask for it.",
                  required: false,
                  "input-type": "text",
                  "max-chars": 30,
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

export const FLOWS: readonly FlowDefinition[] = [onboarding, businessDetails];

export const flowByKey = (key: string): FlowDefinition | undefined =>
  FLOWS.find((f) => f.key === key);
