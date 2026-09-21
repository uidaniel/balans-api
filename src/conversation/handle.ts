/**
 * Ties an inbound WhatsApp message to a reply.
 *
 *   inbound -> user -> current state -> machine -> effects -> replies -> saved
 *
 * The machine decides; this performs. Nothing here makes a product decision,
 * which is why the interesting logic stays testable without a database.
 */

import type { FastifyBaseLogger } from "fastify";
import { legalConsentVersion } from "../config.ts";
import { markRead, sendText } from "../whatsapp/client.ts";
import { createSubAccount, listBanks, matchBank, resolveAccount } from "../payments/monnify.ts";
import { checkCode, issueCode } from "../lib/codes.ts";
import { sendEmail, transport, verificationEmail } from "../email/send.ts";
import { markEmailVerified, setEmail, recordConsent, saveBankAccount, activateBankAccount, getPendingBank } from "./store.ts";
import type { Inbound } from "../whatsapp/inbound.ts";
import { step, type Effect, type State } from "./machine.ts";
import {
  loadConversation,
  recordInbound,
  recordOutbound,
  saveConversation,
  setBusinessName,
  upsertUser,
} from "./store.ts";

export async function handleInbound(msg: Inbound, log: FastifyBaseLogger): Promise<void> {
  const user = await upsertUser(msg.from);

  // Meta redelivers on any doubt. Storing the id first means a repeat stops
  // here rather than producing a second reply to the same sentence.
  const first = await recordInbound(user.id, msg.waMessageId, msg.kind);
  if (!first) {
    log.info({ waMessageId: msg.waMessageId }, "duplicate delivery ignored");
    return;
  }

  if (user.status === "closed") {
    log.warn({ userId: user.id }, "message from a closed account, ignored");
    return;
  }

  // Blue ticks and the typing bubble, before the thinking starts. Not awaited:
  // it is decoration, and the reply must not wait on a read receipt.
  void markRead(msg.waMessageId, { typing: true });

  const saved = await loadConversation(user.id);
  // A paused account is paused whatever the conversation last said.
  const state: State = user.status === "paused" ? "paused" : saved.state;

  // Anything that is not text has no words to act on yet. Say so rather than
  // letting it fall through the machine as an empty message.
  if (msg.kind !== "text" && msg.kind !== "interactive" && !msg.text) {
    await reply(user.id, msg.from, ["I can only read text messages at the moment."], log);
    return;
  }

  const result = step(state, saved.context, { text: msg.text ?? "", profileName: msg.profileName }, legalConsentVersion);

  const outcome = await runEffects(result.effects, user.id, result.context.businessName, log);

  // An effect can refuse to let the conversation move on: a wrong code must not
  // reach the consent step just because the machine hoped it would.
  const next = outcome.holdAt ?? result.next;

  // And when it refuses, the machine's own replies describe a future that did
  // not happen. Sending them anyway produces the worst kind of message pair -
  // "what is your email?" immediately followed by "I could not set up your
  // payouts" — so the effect's account of events replaces them.
  const replies = outcome.holdAt ? outcome.lines : [...result.replies, ...outcome.lines];

  // The resolved name is what the next turn asks them to confirm.
  const context = outcome.resolvedName
    ? { ...result.context, resolvedAccountName: outcome.resolvedName }
    : result.context;

  await saveConversation(user.id, next, context);
  await reply(user.id, msg.from, replies, log);

  log.info(
    { userId: user.id, from: state, to: next, effects: result.effects.map((e) => e.type) },
    "conversation advanced",
  );
}

/**
 * Performs what the machine asked for.
 *
 * Several of these depend on parts that do not exist yet. Rather than fail
 * silently or pretend, each returns a line saying plainly where it stops —
 * the design system's rule is that we never promise what the product cannot
 * do yet.
 */
type EffectOutcome = { lines: string[]; holdAt?: State; resolvedName?: string };

async function runEffects(
  effects: Effect[],
  userId: string,
  businessName: string | undefined,
  log: FastifyBaseLogger,
): Promise<EffectOutcome> {
  const extra: string[] = [];
  let holdAt: State | undefined;
  // The bank's answer, so the machine's context carries it into the next turn.
  let resolvedName: string | undefined;

  for (const effect of effects) {
    switch (effect.type) {
      case "show_help":
        break;

      case "resolve_account": {
        // F17: the name comes from the bank, never from the user. It is what
        // they confirm, and what the name check in F26 compares against.
        const banks = await listBanks();
        const bank = matchBank(effect.bankQuery, banks);

        if (!bank) {
          extra.push(
            `I do not recognise "${effect.bankQuery}" as a bank. Send the bank and account number again, like "GTBank 0123456789".`,
          );
          holdAt = "onboarding:bank";
          break;
        }

        const resolved = await resolveAccount(effect.accountNumber, bank.code);

        if (!resolved.ok) {
          log.warn({ userId, reason: resolved.reason }, "account resolution failed");
          extra.push(
            resolved.reason === "invalid_details"
              ? `${bank.name} did not recognise ${effect.accountNumber}. Check the number and send it again.`
              : "I could not reach the bank just now. Send it again in a moment.",
          );
          holdAt = "onboarding:bank";
          break;
        }

        // Stored pending; it only becomes active once they confirm the name.
        await saveBankAccount(userId, {
          bankCode: bank.code,
          bankName: bank.name,
          accountNumber: effect.accountNumber,
          accountName: resolved.account.accountName,
        });

        resolvedName = resolved.account.accountName;
        extra.push(`That account is ${resolved.account.accountName} at ${bank.name}. Is that right?`);
        break;
      }

      case "create_subaccount": {
        const pending = await getPendingBank(userId);
        if (!pending) {
          log.error({ userId }, "confirmed an account that is not on file");
          extra.push("Something went wrong saving that account. Send the bank and number again.");
          holdAt = "onboarding:bank";
          break;
        }

        const created = await createSubAccount({
          accountNumber: pending.accountNumber,
          bankCode: pending.bankCode,
          email: pending.email ?? `${userId}@users.balans.ng`,
        });

        if (!created.ok) {
          log.error({ userId, message: created.message }, "subaccount creation failed");
          extra.push("I could not set up your payouts just now. Send the bank and number again in a moment.");
          holdAt = "onboarding:bank";
          break;
        }

        await activateBankAccount(userId, created.account.subAccountCode);
        log.info(
          { userId, subAccount: created.account.subAccountCode, reused: created.reused ?? false },
          created.reused ? "reused an existing subaccount" : "subaccount created",
        );
        break;
      }

      case "send_email_code": {
        await setEmail(userId, effect.email);
        const issued = await issueCode(userId, "email_verify", effect.email);

        if (!issued.ok) {
          extra.push(
            `That is a lot of codes in a short time. Wait ${issued.retryAfterMinutes} minutes and reply "resend".`,
          );
          holdAt = "onboarding:verify_email";
          break;
        }

        const sent = await sendEmail(
          { to: effect.email, ...verificationEmail(issued.code, businessName) },
          log,
        );

        if (!sent.ok) {
          log.error({ userId, reason: sent.reason }, "could not send the verification code");
          extra.push(
            'That email would not send. Check the address, or reply "change" to use another one.',
          );
          holdAt = "onboarding:verify_email";
          break;
        }

        // Without a provider the code only reached the server log, so say so
        // rather than leaving someone waiting on an email that is not coming.
        if (!sent.delivered) {
          extra.push(
            "Email sending is not connected on this environment yet, so the code is in the server log.",
          );
        }
        break;
      }

      case "verify_email_code": {
        const check = await checkCode(userId, "email_verify", effect.email, effect.code);

        if (check.ok) {
          await markEmailVerified(userId, effect.email);
          break;
        }

        // Hold the conversation where it was; the machine had hoped to move on.
        holdAt = "onboarding:verify_email";
        switch (check.reason) {
          case "expired":
            extra.push('That code has expired. Reply "resend" and I will send another.');
            break;
          case "too_many_attempts":
            extra.push('Too many tries on that code. Reply "resend" for a new one.');
            break;
          case "no_code":
            extra.push('I have no code waiting for that address. Reply "resend".');
            break;
          default:
            extra.push(
              check.left
                ? `That code is not right. ${check.left} ${check.left === 1 ? "try" : "tries"} left, or reply "resend".`
                : 'That code is not right. Reply "resend" for a new one.',
            );
        }
        break;
      }

      case "record_consent":
        await recordConsent(userId, effect.version);
        log.info({ userId, version: effect.version }, "consent recorded");
        break;
    }
  }

  if (businessName) {
    // Worth persisting the moment we have it: if someone drops out halfway,
    // we still know who they are.
    await setBusinessName(userId, businessName).catch((e: unknown) =>
      log.error({ err: e, userId }, "could not save business name"),
    );
  }

  return { lines: extra, holdAt, resolvedName };
}

/** Reported at boot so nobody wonders why no email arrived. */
export function emailTransport(): string {
  return transport();
}

const PAUSE_BETWEEN_LINES_MS = 700;

async function reply(
  userId: string,
  to: string,
  lines: string[],
  log: FastifyBaseLogger,
): Promise<void> {
  const send = lines.filter((l) => l.trim());

  for (const [i, body] of send.entries()) {
    // A beat between lines. Two messages landing in the same instant read as a
    // dump; a short gap reads as someone typing the second one.
    //
    // The typing bubble is not re-sent here: it hangs off a read receipt for a
    // specific inbound message, and re-marking one already read is not what
    // that call is for. It is shown once when the message arrives, which is
    // when there is actually something to wait for.
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_LINES_MS));

    const res = await sendText(to, body);
    if (res.ok) {
      await recordOutbound(userId, res.waMessageId, "sent");
    } else {
      // Outside the 24-hour window is a product condition, not an outage: it
      // needs an approved template, and retrying free text cannot help.
      log.error(
        { userId, reason: res.reason, code: res.code, outsideWindow: res.outsideWindow },
        res.outsideWindow ? "cannot reply outside the service window" : "send failed",
      );
      await recordOutbound(userId, null, res.outsideWindow ? "outside_window" : "failed");
      break; // No point sending line two if line one did not land.
    }
  }
}
