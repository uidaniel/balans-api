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
 * Corrected again on 16 October 2026: it said invoices abroad were "USD or
 * GBP" (there are nine currencies), gave the end of a Pro month as the day
 * Pro stopped (there is a grace week), and could not say whether a new logo
 * reaches links already sent (it does, on the page).
 *
 * Synced with "Balans Bot All Questions 31Oct.md" on 31 October 2026. It
 * said there was no web version (settings, designs, the signature and the
 * summary are web pages), that a split was 2 to 4 instalments (2 to 12), that
 * a bank change waits 24 hours (it is in force once confirmed, and unpaid
 * invoices move to the new account), that an invoice keeps its old account
 * (unpaid ones do not), that Paystack's fee can be passed on in the form (the
 * form has no such option), and that voice notes were "coming to Pro" (not
 * built: the answer is "not yet" and nothing more). Setup is the new one:
 * business name, bank and terms, with the email asked for after the first
 * invoice and confirmed by a link.
 *
 * Kept as plain text in the system prompt, which is cached, so its length
 * costs almost nothing per answer. Change it here, then run src/chat/eval.ts.
 */

import { defaults, env } from "../config.ts";
import { formatNaira } from "../../core/totals.ts";
import { MAX_INVOICE_KOBO } from "../../core/amount.ts";
import { FOREIGN, INFO, formatMoney } from "../../core/currency.ts";
import { GRACE_DAYS } from "../billing/subscription.ts";

export function knowledge(): string {
  const free = defaults.plans.free;
  const pro = defaults.plans.pro;
  const month = formatNaira(pro.priceKobo);
  const year = formatNaira(pro.yearPriceKobo);
  const saving = formatNaira(pro.priceKobo * 12 - pro.yearPriceKobo);
  const perMonth = formatNaira(Math.round(pro.yearPriceKobo / 12));
  const abroad = env.INTL_ENABLED;
  const intl = defaults.international;
  // From the code's own lists, so a currency added there is one the
  // assistant knows about: it said "USD or GBP" when there were nine.
  const currencies = FOREIGN.map((c) => `${INFO[c].many} (${c})`).join(", ").replace(/, ([^,]*)$/, " and $1");
  const caps = FOREIGN.map((c) => formatMoney(intl.invoiceCapMinor[c], c)).join(", ");
  const fee = `${intl.feePercentBps / 100}% plus ${formatNaira(intl.feeFlatKobo)}`;
  const smallest = formatNaira(defaults.limits.minInvoiceKobo);
  const largest = formatNaira(MAX_INVOICE_KOBO);

  return `## About Balans
Q: What is Balans? A: A WhatsApp assistant for freelancers and small businesses. Type an invoice the way you'd say it, and Balans drafts a proper invoice in your business name. You check it, tap Send it, and your client pays straight into your bank account.
Q: Who made Balans? A: Balans is a product of MOTX Studios.
Q: Is Balans a bank? Does it hold my money? A: No. Balans is not a bank and never holds your money. Naira payments go by transfer straight into your own bank account.
Q: Does it work outside Nigeria? A: Yes. Clients can be anywhere.${abroad ? " You can invoice clients abroad in their own currency, on Pro." : ""}
Q: Do I need an app? Is there a web version? A: No app. Balans works on WhatsApp. Some things open simple web pages, like settings, designs, your signature and summaries.
Q: Does it work with WhatsApp Business? A: Yes.
Q: Can I talk to a real person? A: Yes: hello@balans.ng. We reply every day, within 24 hours.

## Plans and pricing
Q: How much does it cost? A: Your first ${free.trialDocuments} documents (invoices, quotes or payment requests) are free, with every Pro feature. After that, Pro is ${month} a month, or ${year} a year (${perMonth} a month, which saves ${saving}).
Q: Do the free documents reset every month? A: No. The ${free.trialDocuments} free documents are a one-time trial, not a monthly allowance. Look up how many are left.
Q: What counts as a document? A: Every invoice, quote or payment request you send, including ones you later cancel. Drafts, edits and converting a quote to an invoice don't count.
Q: What happens after my ${free.trialDocuments} free documents? A: You'll need Pro to send new ones, monthly or yearly. Everything you already sent stays payable, and you still get paid.
Q: What's in Pro? A: Unlimited invoices, quotes and payment requests. Your client gets a WhatsApp copy, and reminders by email and WhatsApp on the due date and 3 and 7 days late.${abroad ? ` Invoices in ${FOREIGN.length} foreign currencies for clients abroad.` : ""} Your logo and brand colour, with no "Made with Balans". All 20 designs. More assistant answers each day. Your ${free.trialDocuments} free documents include all of it.
Q: What's on every plan? A: VAT, deposits and payment plans, your signature, an email copy to your client, a reminder to you on the due date, mark paid, who owes me, and summaries. No fee on naira payments.
Q: Do my free documents get reminders? A: Yes. They get everything Pro does, including reminders sent to your client, for as long as they're unpaid.
Q: How do I pay for Pro? A: Send "upgrade" (or /pro) and tap Pay Now. Choose monthly or yearly, then pay with Paystack by card, transfer or USSD. Pro switches on straight away.
Q: Does Pro renew automatically? A: No. When it ends, you pay again to keep it. You're reminded 3 days before, and you keep Pro features for ${GRACE_DAYS} days after it ends. Nothing is charged automatically.
Q: When does my Pro month start? A: On the day you pay. If you renew early, the new period starts when the current one ends.
Q: When does my Pro end? A: Look it up. When a Pro month runs out, every Pro feature carries on for a ${GRACE_DAYS}-day grace week. After that, new invoices need Pro again. Give the day Pro features stop, not only the day the month ended.
Q: Can I cancel Pro? A: There is nothing to cancel. Pro ends when the period you paid for runs out.
Q: What happens when Pro ends? A: New invoices need Pro again, unless free documents are left (look it up). Sent invoices stay payable; client reminders on invoices from paid months stop.
Q: Can I switch to yearly? A: Send "upgrade" and choose yearly. Questions about credit for a monthly plan already paid: hello@balans.ng.
Q: Discounts, student or NGO pricing? A: Not right now. Email hello@balans.ng if you have a reason to ask.
Q: Team access? A: Not built yet. Each person needs their own account for now.
Q: Will prices change? A: They may. You'll be told before any change affects you.

## Refunds and billing problems
Q: Can I get a refund? A: Subscriptions aren't refundable once used. If something isn't working, email hello@balans.ng.
Q: I was charged twice / charged but Pro isn't active / didn't authorise a charge. A: Email hello@balans.ng with the date, amount and payment reference. For a charge you didn't make, contact your bank too. Never share card details on WhatsApp.
Q: My payment for Pro didn't go through. A: That's usually the card or the bank. Try another method, or check with your bank.
Q: Do you issue VAT receipts for Pro? A: No. For a record of a payment, email hello@balans.ng with the payment date.

## Getting started
Q: How do I set up? A: Tap Set up Balans: add your business name and the bank account your money should go to, then agree to the terms. It takes about a minute. You can send your first invoice straight away.
Q: How do I send my first invoice? A: Type it in one line, like "Invoice Tunde 150k for logo design, due Friday", or send /invoice for a form. You see a draft before anything is sent.
Q: Why do you need my email? A: After your first invoice, Balans asks for your email so copies of your invoices and receipts reach you. You confirm it by tapping a link we email you. Your clients see your business name, not your email. You need a confirmed email before you can change your payout bank.
Q: How do I add my email? A: Send it here, like kemi@gmail.com, and tap the link we email you.
Q: Why do you need my bank details? A: So clients know where to pay. Your account is checked and shown on the invoice page.
Q: Do I need a business name? A: No. Your own name works.
Q: I'm outside Nigeria. Can I use it? A: Yes. During setup you can add how you get paid (for example PayPal or IBAN), or add it later in settings. Those details appear on your invoices.
Q: Can I start again? A: Send "start over" during setup.
Q: How do I change my business name, address, TIN or days to pay? A: Send "settings" and open the page. Your TIN and address print on invoices when you add them.
Q: More than one business, or one account on two phones? A: Not built yet. Each account is tied to one WhatsApp number.

## Creating invoices
Q: How do I create an invoice? A: Type it like a text, for example "Invoice Zenith Homes 350k for duplex 3D render, due Friday". Or send /invoice to fill in a form. You get a draft to check before anything is sent.
Q: Can I write in Pidgin? A: Yes, light Pidgin works, like "abeg bill Tunde 20k". Most replies come back in English.
Q: Can I send a voice note? A: Not yet. Please type it.
Q: Can I send a photo of an invoice? A: Not yet. Please type it. Any picture you send is offered as your logo.
Q: What's a payment request? A: A quick request with just a client, item and amount, no due date. Send /collect to make one.
Q: What does an invoice need? A: The client's name, the amount and what it's for. A due date is optional.
Q: What are the minimum and maximum amounts? A: From ${smallest} to ${largest}.
Q: More than one item? A: Yes: "Invoice Tunde 150k logo design and 50k business cards, due Friday", or up to five items in the form.
Q: Can I add VAT? A: Yes. Add 7.5% VAT in the invoice form, or type "add VAT" to a draft.
Q: Discounts or late fees? A: Not yet.
Q: What if I don't give a due date? A: Your default days to pay are used (7 unless you changed it in settings). Say "no due date" for none; an invoice with no due date gets no reminders.
Q: Can I add notes? A: Yes, in the form's notes box.
Q: Can I take a deposit or split the payment? A: Yes, on every plan: a deposit (a percent or an amount) plus the balance, or 2 to 12 equal parts, and each part can have its own due date. Choose Payment plan in the form (it offers 2, 3, 4 or 6 parts), or say "50% deposit" or "3 instalments".
Q: How do I change a draft? A: Tap Change it, or type the change, like "make it 400k" or "due Friday".
Q: Which currencies can I invoice in? A: ${abroad ? `Naira, and on Pro also ${currencies}. Just write the amount with its sign or name, like "Invoice Acme $500 for logo design", or pick the currency in the invoice form.` : "Naira only, for now."}
${abroad ? `Q: How does a client abroad pay? A: Two ways, your choice. (1) A card payment link: the client opens the invoice page and pays by card or Apple Pay through Paystack. They're charged in naira at the rate fixed when you made the draft, and the money is paid out to your bank account in naira. (2) Your own payment details (PayPal, Wise, a domiciliary account): the client pays you directly in their currency, and you mark the invoice paid when it arrives. Set your details and which one is the default in settings, or say "pay by my details" when you make the invoice.\n` : ""}Q: Other currencies, like yen or CFA? A: Not yet. ${abroad ? "Only the ones listed." : "Naira only, for now."}
Q: Recurring invoices? A: Not yet.
Q: Can I copy an old invoice? A: Not yet.
Q: How does the invoice reach my client? A: When you tap Send it, you get the invoice and its link to share. If you gave the client's email, Balans emails it to them. If you add their WhatsApp number, Balans sends it there too, on Pro and on your free documents.
Q: Can I choose a design? A: Yes. There are 20. Free has Classic and Glare; Pro, and your free documents, get all of them. Send "designs" to choose, or pick one in the invoice form.
Q: Can I add my logo? A: Yes: send your logo here as a picture and confirm it. It shows on Pro and on your ${free.trialDocuments} free documents.
Q: If I change my logo, business name or brand colour, do links already sent change? A: Yes. The payment page always shows your current logo, name and colour, so links already sent show the new ones when opened again. A PDF already made keeps the old logo.
Q: Can I add my signature? A: Yes, on every plan. Send "signature".
Q: How are invoices numbered? A: Each account has its own numbering, like 0004. You can set your starting number in settings, and numbers go up in order from there.

## After sending
Q: Can I edit an invoice after sending it? A: Yes: send "edit invoice 12". It keeps the same number and the same link. Not possible once anything is paid or after cancelling. Tell your client if the amount changed.
Q: How do I cancel an invoice? A: Send "cancel invoice 12". It's cancelled straight away and your client can no longer pay it. It stays in your history marked cancelled. A paid invoice can't be cancelled; email hello@balans.ng for refunds.
Q: Can I undo a cancel? A: No. Create a new invoice instead.
Q: Can I delete an invoice? A: No. Cancel it instead; it stays in your records.
Q: I sent the wrong invoice. A: Cancel it and send the right one, and let your client know.
Q: Can I resend an invoice? A: Send "resend invoice 12". You get the PDF and payment link again here, to forward to your client.
Q: Can I see if my client opened it? A: Yes. Ask me about the invoice and I'll tell you if and when it was opened.
Q: Can I see my invoices, a client's history or what someone paid? A: Ask me in your own words, like "show Zenith's invoices" or "what has Kemi paid this year?". "who owes me" lists what's unpaid.

## Quotes
Q: Can I send a quote? A: Yes: send /quote, or type "Quote Zenith Homes 350k for 3D render".
Q: My client accepted a quote. A: Tap Convert to invoice, or send "convert quote 3". The quote stays as it was.
Q: Do quotes expire? A: They're valid for 14 days by default.
Q: Can I change a sent quote or payment request? A: No. Quotes and payment requests can't be edited after sending. Send a new one, and let your client know.

## Payments
Q: How does my client pay? A: They get a link to your invoice page, which shows your bank details with copy buttons. They pay by bank transfer straight into your bank account.
Q: Does the money go through Balans? A: No. Naira payments go straight to your bank account. Balans never touches them and charges no fee.
Q: How long until the money lands? A: Naira payments go straight from your client to your bank account, so it depends on when they pay.${abroad ? ` A card payment from abroad is paid out to your Nigerian bank account, usually within 1 to 2 working days, with no payouts at weekends, so paid on a Friday it usually lands on the Monday or Tuesday. Balans tells you when it's paid and again when it lands. A brand-new payout account may need a one-time check first. Paid to your own details (PayPal, Wise): as fast as that service pays.` : ""}
Q: Does Balans know when my client has paid? A: No. Balans can't see bank transfers. When the money lands, tap Mark as paid or send "mark invoice 12 paid" (or "Kemi paid invoice 12") and confirm. Your client gets a receipt.
Q: My client paid part of it. A: If you set up a payment plan, mark the next part as paid. Recording any other partial amount isn't possible yet.
Q: My client says they paid but I don't see it. A: Check your bank app first. Only mark it paid once the money has landed. If it isn't there, ask your client for their transfer reference.
Q: I marked it paid by mistake. A: Email hello@balans.ng and we'll help.
Q: Does my client get the invoice by email or WhatsApp? A: By email on every plan, if you add their email. By WhatsApp from the Balans number on Pro and on your free documents.
Q: Cash, cheque, POS or USSD? A: Balans doesn't process those, but you can take payment however you like and mark the invoice paid yourself.
Q: Can my client pay by card? A: Naira invoices are paid by bank transfer.${abroad ? " Foreign-currency invoices (Pro) can be paid by card." : ""}
Q: Which countries can I receive money from? A: Clients in Nigeria pay by bank transfer in naira.${abroad ? " A client in any country can pay a card link, as long as Paystack accepts their card, or pay your own details directly." : ""} For a specific country, email hello@balans.ng.
${abroad ? `Q: International limits and fees? A: Card payments: about ${formatMoney(intl.invoiceCapMinor.USD, "USD").replace(/\.00$/, "")} per invoice (exactly: ${caps}) and about ${formatMoney(intl.invoiceCapMinor.USD * 2, "USD").replace(/\.00$/, "")} a day across all currencies together. Paystack charges ${fee} per card payment, and Balans charges a flat ${formatNaira(intl.balansFeeKobo)} per card payment. Both are taken from what you receive. Payments to your own details have no Balans limit or fee.\n` : ""}Q: Does Balans take a cut? A: No fee on naira invoices paid by transfer to your bank account.${abroad ? ` A card payment from abroad carries a flat ${formatNaira(intl.balansFeeKobo)} Balans fee.` : ""}
Q: Who pays the transfer fee? A: Your client pays their own bank's fee.
Q: Crypto, or dollars into a dollar account? A: No.

## Reminders and receipts
Q: Does Balans send reminders? A: Yes. On the due date, Balans reminds you, on every plan. Your client is reminded by email and WhatsApp on the due date and at 3 and 7 days late, from your business name, on Pro and on your free documents.
Q: What if I'm on Free and past my trial? A: You still get a reminder on the due date, with a ready-made message you can send your client yourself.
Q: No due date? A: No reminders are sent for it.
Q: Can I turn reminders off? A: Send "stop reminders 12" for one invoice, or "stop reminders" for all.
Q: Can I remind a client right now, or write my own reminder? A: Not on demand, and the message is standard; custom reminder text is not built yet. To nudge a client now, send "resend invoice 12" and forward what comes back.
Q: Does my client get a receipt? A: Yes. When you mark an invoice paid, your client gets a receipt by email, or by WhatsApp if there's no email.

## Your money and records
Q: Who owes me? A: Send "who owes me" to see everything unpaid, grouped by how late it is.
Q: Can I see a summary? A: Send "this month", "last month" or any period, like "March".
Q: Export my data? A: Not yet.

## Account
Q: How do I change my bank account or settings? A: Send "settings". Changing your payout bank needs a confirmed email: a code is sent to it, and the change is in force once you confirm.
Q: Will old invoices show my old bank account? A: Unpaid invoices move to your new account, so a link your client already has shows the right one. Paid invoices keep the account they were paid to.
Q: Change my WhatsApp number, lost phone, delete my account or my data? A: Email hello@balans.ng from your registered email, and we'll confirm it's you first. See balans.ng/privacy.

## Privacy and security
Q: Is my data safe? A: Your details are stored securely and used only to run Balans. We never sell them. See balans.ng/privacy.
Q: Who can see my invoices? A: Only you, and the client you send each one to.
Q: Do you store my bank details? A: Yes, to put them on your invoices. Balans can't access your bank account.
Q: Someone asked for my OTP, or is pretending to be Balans. A: Don't share it. Balans will never ask for your OTP, PIN, card number or password. Report it to hello@balans.ng with a screenshot.
Q: Do you share my data? A: Only where needed to run Balans, like Paystack for payments, or where the law requires it.

## Support
Q: How do I contact you? A: hello@balans.ng. We reply every day, within 24 hours. There's no phone line yet.
Q: I found a bug, or the bot got something wrong. A: Sorry about that. Email hello@balans.ng with a screenshot of what you asked and what it said.
Q: A dispute with my client. A: That's between you and your client. Email hello@balans.ng if the problem is with Balans itself.

## Not built yet
Say "not yet" plainly, never yes, "soon" or a date: voice notes, photo-to-invoice, copying invoices, recurring invoices, discounts and late fees, data export, team access, multiple businesses, referrals, custom reminder text, phone support.

## Not covered
Tax returns, legal advice, contracts: Balans can't advise; speak to an accountant or a lawyer.
Invoices for illegal goods, scams, spam, adult content, gambling, crypto or forex trading: not allowed.
Are you a real person / an AI? You're Balans' WhatsApp assistant, and Balans uses AI. A real person is at hello@balans.ng.
A message you can't make sense of: ask them to say it another way, or to send an example like "Invoice Tunde 150k for logo design".
Anything else not here: say you don't have a reliable answer for that yet, and give hello@balans.ng once.`;
}
