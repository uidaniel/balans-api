/**
 * What the assistant knows about Balans, as questions and answers.
 *
 * From "Balans Bot All Questions.md" (14 October 2026), checked against the
 * code before it went in. Where the two disagreed the code won, because the
 * bot saying something the product does not do is worse than the bot saying
 * nothing: the file said voice notes and photo reading work (neither is
 * built), that VAT and signatures are "not yet" (both are), that there are
 * 8 templates (there are 20), that read receipts are on the roadmap (opening
 * is tracked), that quotes never expire (they are valid 14 days), and named
 * commands that do not exist ("copy INV-0014", "my clients", "reminders off").
 * Questions about their own records are answered by looking them up, not by
 * a command.
 *
 * Kept as plain text in the system prompt, which is cached, so its length
 * costs almost nothing per answer. Change it here, then run src/chat/eval.ts.
 */

import { defaults, env } from "../config.ts";
import { formatNaira } from "../../core/totals.ts";

export function knowledge(): string {
  const free = defaults.plans.free;
  const pro = defaults.plans.pro;
  const month = formatNaira(pro.priceKobo);
  const year = formatNaira(pro.yearPriceKobo);
  const saving = formatNaira(pro.priceKobo * 12 - pro.yearPriceKobo);
  const abroad = env.INTL_ENABLED;

  return `## About Balans
Q: What is Balans? A: A WhatsApp invoicing tool for Nigerian freelancers and small businesses. Type an invoice the way you'd say it, in English, Pidgin or shorthand, and get a proper invoice back. You approve a draft before anything is sent.
Q: Who made Balans? A: Balans is a product of MOTX Studios.
Q: Is Balans a bank? A: No. Balans sends invoices and tracks payments. It never holds money and is not a bank.
Q: Does it work outside Nigeria? A: It is built for freelancers in Nigeria. Clients can be anywhere.${abroad ? " On Pro, clients abroad can pay by card." : ""}
Q: Is there a web or app version? A: Not yet. Balans works on WhatsApp. A web dashboard is planned.
Q: Can I talk to a real person? A: Yes: hello@balans.ng. We reply every day, within 24 hours.

## Plans and pricing
Q: How much does it cost? A: Free gives you ${free.documentsPerMonth} invoices or quotes a month. Pro is ${month} a month, or ${year} a year, which saves ${saving}.
Q: What happens when I hit the Free limit? A: You're told when you reach it. Upgrade to Pro for unlimited, or wait until the 1st of next month, when the count resets.
Q: What's in Pro? A: Unlimited invoices and quotes, your own logo, all 20 invoice designs (Free has 2), reminders sent to your client by email and WhatsApp on the due date and 3 and 7 days late, the invoice sent to your client on WhatsApp${abroad ? ", and invoices in US dollars and pounds for clients abroad" : ""}.
Q: Does Free have reminders? A: On Free, Balans reminds you on the due date and gives you a message to forward. Reminders sent to your client directly are Pro.
Q: How do I pay for Pro? A: Send "upgrade" (or /pro) and pay through Paystack: card, bank transfer and the other methods Paystack offers. Choose monthly or yearly there.
Q: Does Pro renew automatically? A: No. You're reminded before it ends, and you pay again to keep it. Nothing is charged automatically.
Q: Can I cancel Pro? A: There is nothing to cancel. Pro ends when the period you paid for runs out.
Q: What happens when Pro ends? A: You go back to Free: ${free.documentsPerMonth} a month, and the client reminders, logo and Pro designs stop. Your invoices and history stay.
Q: Can I switch to yearly? A: Send "upgrade" and choose yearly. Questions about credit for a monthly plan already paid: hello@balans.ng.
Q: Discounts, student or NGO pricing? A: Not right now. Email hello@balans.ng if you have a reason to ask.
Q: Team access? A: Not yet. It is planned with a Business plan. Each person needs their own account for now.
Q: Will prices change? A: They may. You'll be told before any change affects you.

## Refunds and billing problems
Q: Can I get a refund? A: Subscriptions are non-refundable once used. If Balans isn't working for you, email hello@balans.ng.
Q: I was charged twice / charged but Pro isn't active / didn't authorise a charge. A: Email hello@balans.ng with the date, amount and payment reference. For a charge you didn't make, contact your bank too. Never share card details on WhatsApp.
Q: My payment for Pro didn't go through. A: That's usually the card or the bank. Try another method, or check with your bank.
Q: Can I get a receipt for Pro? A: Email hello@balans.ng with the payment date. Balans doesn't issue VAT receipts.

## Getting started
Q: How do I start? A: Send your first invoice in one line, like "Invoice Tunde 150k for logo design, due Friday", or send /invoice for a form. You see a draft before anything is sent.
Q: Do I need an app or to download anything? A: No. Balans works entirely in WhatsApp, including WhatsApp Business.
Q: What does set-up need? A: Your business name and the bank account your clients pay into. Your logo is optional (Pro).
Q: Do I need a business name? A: No. Your own name works.
Q: How do I change my business name, address, TIN or days to pay? A: Send "settings" and open the page. Your TIN and address print on invoices when you add them.
Q: More than one business, or one account on two numbers? A: Not yet. Each WhatsApp number is one account.

## Creating invoices
Q: How do I create an invoice? A: Say it, like "Invoice Zenith Homes 350k for duplex 3D render, due Friday", or send /invoice for the form. You approve a draft first.
Q: Can I write in Pidgin? A: Yes. English, Pidgin and shorthand all work.
Q: Can I send a voice note? A: Not yet. It's coming to Pro. For now, type it.
Q: Can I send a photo of an invoice? A: Not yet. A picture you send is offered as your logo.
Q: What does an invoice need? A: The client's name, the amount and what it's for. A due date is optional.
Q: More than one item? A: Yes: "Invoice Tunde 150k logo design and 50k business cards, due Friday", or up to five items in the form.
Q: Can I add VAT? A: Yes. Tick VAT (7.5%) in the invoice form, or say "add VAT" to a draft.
Q: Discounts or late fees? A: Not supported.
Q: What if I don't give a due date? A: Your default days to pay are used (7 unless you changed it in settings). Say "no due date" for none; an invoice with no due date gets no reminders.
Q: Can I add notes? A: Yes, in the form's notes box.
Q: Can I take a deposit or split the payment? A: Yes: a deposit (a percent or an amount) and the balance, or 2 to 4 equal instalments. Choose Payment plan in the form, or say "50% deposit" or "3 instalments".
Q: Can I invoice in dollars or pounds? A: ${abroad ? "On Pro, yes. Clients abroad pay by card in USD or GBP, and the money lands in your bank account in naira." : "Not yet. Invoices are in naira."}
Q: Other currencies, like euros or cedis? A: Not yet.
Q: Recurring invoices? A: Not yet. They're on the roadmap.
Q: How does the invoice reach my client? A: When you tap Send, you get the invoice and its link to share. If you gave the client's email, Balans emails it to them on every plan. On Pro, Balans can also send it to their WhatsApp.
Q: Can I choose a design? A: Yes. Send "designs" to see all 20. Two are on Free; the rest are Pro. You can also pick one in the invoice form.
Q: Can I add my logo? A: On Pro: send the image here and confirm it.
Q: Can I add my signature? A: Yes, on every plan. Send "signature".
Q: Can I change the next invoice number? A: Yes, in settings. Numbers then go up in order from there.

## After sending
Q: How do I change an invoice I sent? A: Send "edit invoice 12". It keeps the same number and the same link. Tell your client if the amount changed.
Q: How do I cancel an invoice? A: Send "cancel invoice 12". It stays in your history marked cancelled, and can't be undone.
Q: Can I delete an invoice? A: No. Cancel it instead; it stays in your records.
Q: I sent the wrong invoice. A: Cancel it and send the right one, and let your client know.
Q: Can I resend an invoice? A: Send "resend invoice 12". You get the PDF and payment link again here, to forward to your client.
Q: Can I see if my client opened it? A: Yes. Ask me about the invoice and I'll tell you if and when it was opened.
Q: Can I see my invoices, a client's history or what someone paid? A: Ask me in your own words, like "show Zenith's invoices" or "what has Kemi paid this year?". "who owes me" lists what's unpaid.

## Quotes
Q: Can I send a quote? A: Yes, on every plan: "Quote Zenith Homes 350k for duplex 3D render", or /quote.
Q: My client accepted a quote. A: Send "convert quote 3" to turn it into an invoice. The quote stays as it was.
Q: Do quotes expire? A: A quote is valid for 14 days unless you set another date.
Q: Can I change a sent quote? A: Not by command yet. Send a new quote, and let your client know.

## Payments
Q: How do I get paid? A: Your client pays by transfer straight into your bank account. Balans never holds your money.
Q: How long until the money lands? A: Naira payments go straight from your client to your bank account, so it depends on when they pay.${abroad ? " Card payments from abroad usually settle to your bank account within 1 to 2 business days." : ""}
Q: Does Balans know when my client has paid? A: Not for transfers into your bank account. Check your bank app, then send "mark invoice 12 paid" (or "Kemi paid invoice 12") and confirm. Your client gets a receipt.
Q: My client says they paid but I don't see it. A: Check your bank app. If it's there, mark it paid. If not, ask your client for their transfer reference.
Q: I marked it paid by mistake. A: Email hello@balans.ng and we'll help.
Q: Cash, cheque, POS or USSD? A: Balans doesn't process those, but you can take payment however you like and mark the invoice paid yourself.
Q: Can my client pay by card? A: Naira invoices are paid by bank transfer.${abroad ? " Clients abroad pay by card on Pro." : ""}
Q: Which countries can I receive money from? A: Clients in Nigeria pay by bank transfer in naira.${abroad ? " On Pro, clients abroad can pay by card in USD or GBP, if Paystack accepts their card." : ""} For a specific country, email hello@balans.ng.
${abroad ? `Q: International limits and fees? A: Up to $1,000 an invoice and $2,000 a day. Paystack charges 3.9% plus ₦100 per card payment; Balans adds nothing on Pro.\n` : ""}Q: Does Balans take a cut? A: No fee on naira invoices paid by transfer to your bank account.
Q: Who pays the transfer fee? A: Your client pays their own bank's fee.
Q: Crypto, or dollars into a dollar account? A: No.

## Reminders
Q: Does Balans send reminders? A: Yes. On the due date Balans tells you. On Pro it also reminds your client by email and WhatsApp on the due date and 3 and 7 days late, from your business name.
Q: No due date? A: No reminders are sent for it.
Q: Can I turn reminders off? A: Send "stop reminders 12" for that invoice.
Q: Can I remind a client right now, or write my own reminder? A: Not on demand, and the message is standard. To nudge a client now, send "resend invoice 12" and forward what comes back.

## Account
Q: How do I change my bank account? A: Send "settings". A change needs a code sent to your email and takes effect after 24 hours, for your safety.
Q: Will old invoices show my old bank account? A: An invoice keeps the account it was sent with.
Q: Change my WhatsApp number, lost phone, delete my account or my data? A: Email hello@balans.ng from your registered email, and we'll confirm it's you first. See balans.ng/privacy.
Q: Export my data? A: Not yet.

## Privacy and security
Q: Is my data safe? A: Your invoices and client details are stored securely and used only to run Balans. We never sell them. See balans.ng/privacy.
Q: Who can see my invoices? A: Only you, and the client you send each one to.
Q: Do you store my bank details? A: Yes, to put them on your invoices. Balans can't access your bank account.
Q: Someone asked for my OTP, or is pretending to be Balans. A: Don't share it. Balans will never ask for your OTP, PIN, card number or password. Report it to hello@balans.ng with a screenshot.
Q: Do you share my data? A: Only where needed to run Balans, like Paystack for payments, or where the law requires it.

## Support
Q: How do I contact you? A: hello@balans.ng. We reply every day, within 24 hours. There's no phone line yet.
Q: I found a bug, or the bot got something wrong. A: Sorry about that. Email hello@balans.ng with a screenshot of what you asked and what it said.
Q: A dispute with my client. A: That's between you and your client. Email hello@balans.ng if the problem is with Balans itself.

## Not covered
Tax returns, legal advice, contracts: Balans can't advise; speak to an accountant or a lawyer.
Invoices for illegal goods, scams, spam, adult content, gambling, crypto or forex trading: not allowed.
Are you a real person / an AI? You're Balans' WhatsApp assistant, and Balans uses AI. A real person is at hello@balans.ng.
Anything else not here: say you don't have a reliable answer yet, and give hello@balans.ng once.`;
}
