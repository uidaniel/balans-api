/**
 * The menu behind "/" (PRD F3's discoverability problem).
 *
 * A product whose entire surface is a text box has to tell people what it can
 * do. WhatsApp has no autocomplete, so "/" cannot pop up a list the way it
 * does in Slack — but an interactive list is the closest thing, and it is
 * tappable, which a wall of slash commands is not.
 *
 * Every row's id is the command it stands for, so tapping "Bill a client" and
 * typing "/invoice" arrive at the same place by the same path. That is the
 * same trick `draftButtons` and `settingsList` use, and it is what keeps the
 * tappable surface from becoming a second implementation of the typed one.
 *
 * The description on each row carries the command in plain sight. Somebody who
 * taps it once has learnt the word, and the second time they will type it —
 * which is faster than the list and costs us nothing.
 *
 * A list holds ten rows. There are nine here, and the tenth is being held for
 * the next thing that earns a place rather than spent on something that does
 * not. If a tenth is ever needed, the answer is not an eleventh: it is that
 * two of these belong under one row.
 */

export type MenuList = {
  body: string;
  button: string;
  sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[];
  header?: string;
  footer?: string;
};

export function mainMenuList(): MenuList {
  return {
    header: "What I can do",
    body: "Tap one, or just say it in your own words.",
    button: "See everything",
    footer: "Invoice Tunde 20k for logo, due Friday",
    sections: [
      {
        title: "Getting paid",
        rows: [
          {
            id: "/invoice",
            title: "Bill a client",
            description: "/invoice — an invoice with a payment link on it",
          },
          {
            id: "/quote",
            title: "Send a quote",
            description: "/quote — turns into an invoice when they accept",
          },
          {
            id: "/collect",
            title: "Request a payment",
            description: "/collect — a quick link, no invoice",
          },
        ],
      },
      {
        title: "Keeping track",
        rows: [
          {
            id: "/owed",
            title: "Who owes me",
            description: "/owed — everything unpaid, oldest first",
          },
          {
            id: "/summary",
            title: "How this month went",
            description: "/summary — what you billed and what landed",
          },
          {
            id: "/status",
            title: "Check one invoice",
            description: "/status — whether it was seen, and whether it was paid",
          },
        ],
      },
      {
        title: "Your account",
        rows: [
          {
            id: "/settings",
            title: "Settings",
            description: "/settings — your name, your bank, your due days",
          },
          {
            id: "/design",
            title: "Invoice design",
            description: "/design — how your invoices look to a client",
          },
          {
            id: "/pro",
            title: "Go Pro",
            description: "/pro — unlimited invoices and your own logo",
          },
        ],
      },
    ],
  };
}
