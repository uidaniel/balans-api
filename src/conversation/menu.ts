/**
 * What "/" and "help" answer with (PRD F3's discoverability problem).
 *
 * A product whose entire surface is a text box has to tell people what it can
 * do, and it has three ways to say it. They are not alternatives; each covers
 * a moment the others cannot.
 *
 *   The native "/" popup   Drawn by WhatsApp above the keyboard as you type,
 *                          before you send anything. Registered once on the
 *                          phone number, costs nothing, and is the only one
 *                          that helps somebody who has not thought of asking
 *                          for help. See `register-commands.ts`.
 *
 *   The cheat sheet        This. All ten commands at once, grouped, legible,
 *                          and saveable — somebody can scroll back to it or
 *                          screenshot it, which a message of text is worse at.
 *
 *   The typed menu         The fallback, for when the image cannot be sent.
 *
 * The picture cannot be tapped, so three buttons ride under it. Three is the
 * limit, which is a useful constraint: it forces the question of which three
 * things somebody actually opens this to do, rather than listing ten and
 * making them read.
 *
 * A list message was the obvious shape and is not available: probed against
 * the live API, an image header on `type: "list"` is rejected outright, while
 * `type: "button"` takes one. So the ten live in the picture and the three
 * live under it.
 *
 * Every button id is the command it stands for, so tapping and typing arrive
 * at the same place by the same path — the trick `draftButtons` and
 * `settingsList` already use, and what stops the tappable surface becoming a
 * second implementation of the typed one.
 */

import type { ReplyButton } from "../whatsapp/client.ts";

/**
 * The three, and why these three.
 *
 * Billing somebody is the product. Chasing money is the reason anyone opens
 * an invoicing tool a second time. The month is the question every freelancer
 * asks themselves and cannot usually answer.
 *
 * Everything else is on the picture above and in the "/" popup.
 */
export const helpButtons = (): ReplyButton[] => [
  { id: "/invoice", title: "New invoice" },
  { id: "/owed", title: "Who owes me" },
  { id: "/summary", title: "This month" },
];
