/**
 * The "we're live" message: everything the waitlist will see, in one place.
 *
 * The WhatsApp template submitted to Meta, the email, the sender and the
 * admin's preview all read from here — so what staff preview is what goes
 * out, and changing the copy is one edit. The admin cannot import this file
 * (it is another application), so the service writes it to `config` at boot
 * as `broadcast.launch_setup`, and the preview renders that.
 *
 * Once Meta approves the template its words are fixed. Changing `whatsapp`
 * below after approval needs a new template name, or the preview and the
 * message people receive will disagree.
 */

import { env } from "../config.ts";
import { button, layout, paragraph, steps, type InlineImage } from "../email/layout.ts";

const site = env.SITE_URL.replace(/\/$/, "");

export const LAUNCH = {
  /**
   * The template's name at Meta, and the campaign's id in `broadcasts`.
   *
   * `launch_setup`, not the first `launch_live`: that one's button opened the
   * website, and a template's button cannot be changed once submitted. This
   * one opens the setup form inside WhatsApp, so somebody who taps it is
   * signing up without ever leaving the chat.
   */
  campaign: "launch_setup",

  /** 1080×1350, from the poster; public so WhatsApp and email can fetch it. */
  image: `${site}/broadcast/launch-2cdf09d77fed.jpg`,

  whatsapp: {
    body: [
      "Balans is live 🎉",
      "",
      "You joined the waitlist, and we are open. Send one line like *invoice Tunde 50k for logo design* and get back a branded invoice with a link that pays straight into your bank.",
      "",
      "Tap below to set up. It takes about 3 minutes.",
    ].join("\n"),
    footer: "You are getting this because you joined our waitlist",
    /** Opens the setup form (the `onboarding` Flow) on its first screen. */
    button: { text: "Set me up", flow: "onboarding", screen: "BUSINESS" },
  },

  email: {
    subject: "Balans is live. You're in.",
    preheader: "You joined the waitlist. Set up in the chat in about 3 minutes.",
    heading: "Balans is live, and you are in",
    intro: "You joined the waitlist, so you are first through the door. Everything happens in WhatsApp: there is no app to install and nothing to log in to.",
    steps: [
      {
        title: "Set up in the chat",
        text: "Your business name, your email and the bank account you want paid into. About three minutes.",
      },
      {
        title: "Send one line",
        text: "Type something like <em>Invoice Tunde 50k for logo design</em>. You get back a branded invoice and a link to send your client.",
      },
      {
        title: "Get paid straight to your bank",
        text: "Your client pays into your own account, and you hear about it on WhatsApp the moment it lands.",
      },
    ],
    button: "Set me up on WhatsApp",
    link: `${site}/start?ref=email-launch`,
    footer: "You are getting this because you joined the Balans waitlist. Reply to this email and we will take you off.",
  },
} as const;

/** The banner at the top of the email. Drawn in assets/email/launch-banner.html. */
export const LAUNCH_BANNER: InlineImage = {
  cid: "launch-banner",
  file: "launch-banner.png",
  alt: "Balans is live. You're in.",
  width: 536,
  height: 214,
};

/**
 * The email, built on the same layout as every other Balans email: the coin,
 * a drawn banner, the heading, three numbered steps and the marigold button.
 */
export function launchEmail(): { subject: string; text: string; html: string; images: InlineImage[] } {
  const e = LAUNCH.email;
  const plain = (h: string) => h.replace(/<[^>]+>/g, "");
  const text = [
    e.heading + ".",
    "",
    e.intro,
    "",
    ...e.steps.flatMap((st, i) => [`${i + 1}. ${st.title}`, `   ${plain(st.text)}`, ""]),
    `${e.button}: ${e.link}`,
    "",
    "—",
    e.footer,
  ].join("\n");

  const html = layout({
    preheader: e.preheader,
    banner: LAUNCH_BANNER,
    heading: e.heading,
    body: [paragraph(e.intro), steps([...e.steps]), button(e.button, e.link), paragraph(e.footer, true)].join("\n"),
  });

  return { subject: e.subject, text, html, images: [LAUNCH_BANNER] };
}
