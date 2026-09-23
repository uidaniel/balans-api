/**
 * The page that closes itself after a Pro payment.
 *
 * The checkout runs in WhatsApp's own browser, so when it finishes the person
 * is left looking at a web page on top of the chat they started in, with the
 * confirmation they actually want sitting in the chat underneath it.
 *
 * WhatsApp gives a page no way to dismiss that browser. What it does do is
 * intercept its own links: navigating to `wa.me` hands control back to the
 * app and the browser goes away. So that is the close — a redirect to the
 * chat, with `window.close()` tried first for the browsers where it works.
 *
 * Both of those can fail, and on a phone that is holding somebody's money a
 * blank screen is the wrong failure. So the page says what happened and
 * offers the link, and would be a perfectly good page if neither trick ever
 * fired.
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderProDone(o: {
  /** Our own number, for the way back. Null when Meta would not say. */
  waNumber: string | null;
  /** False while the webhook is still in flight. */
  active: boolean;
}): string {
  const back = o.waNumber ? `https://wa.me/${esc(o.waNumber)}` : null;

  const heading = o.active ? "You're on Pro." : "Payment received.";
  const line = o.active
    ? "Taking you back to the chat."
    : "We are confirming it now, and we will message you the moment it is through.";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Pro</title>
<style>
  :root { color-scheme: light }
  * { margin: 0; padding: 0; box-sizing: border-box }
  body {
    min-height: 100dvh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    padding: 32px; text-align: center; background: #F6F1E7; color: #10231C;
    font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  }
  .mark { width: 54px; height: 54px; border-radius: 50%; background: #F5B82E }
  h1 { font-size: 22px; letter-spacing: -0.02em }
  p { font-size: 15px; line-height: 1.55; color: rgba(16,35,28,.7); max-width: 22rem }
  a.back {
    margin-top: 6px; padding: 13px 22px; border-radius: 12px;
    background: #10231C; color: #F6F1E7; text-decoration: none; font-weight: 600;
  }
</style></head>
<body>
  <div class="mark"></div>
  <h1>${esc(heading)}</h1>
  <p>${esc(line)}</p>
  ${back ? `<a class="back" href="${back}">Back to WhatsApp</a>` : ""}
${
  back
    ? `<script>
  // Tried in order, because neither works everywhere and the page behind
  // them is a fine outcome on its own.
  try { window.close(); } catch (e) {}
  setTimeout(function () { location.replace(${JSON.stringify(back)}); }, 400);
</script>`
    : ""
}
</body></html>`;
}
