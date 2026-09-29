/**
 * HTML to PDF, through a headless browser (PRD F20).
 *
 * Section 3 picks "HTML template rendered by headless browser", and the reason
 * is worth restating: the invoice a client receives should look exactly like
 * the page they can open, and one template renders both. A separate PDF
 * library means two layouts that drift apart, and the drift shows up on the
 * document somebody is being asked to pay.
 *
 * One browser process, started on first use and kept. Launching Chrome costs
 * most of a second; doing it per invoice would blow F20's budget on process
 * startup alone.
 *
 * Renders run on a small pool of tabs in that one browser (PDF_TABS, three
 * by default), so several people sending invoices at once are drawn side by
 * side rather than queued behind each other.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { env } from "../config.ts";
import { embeddedFonts, FONT_FILES } from "./fonts.ts";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];

export function chromePath(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export const rendererAvailable = (): boolean => chromePath() !== null;

/* -------------------------------------------------------------------------- */

/**
 * A tab: one page in the browser, with its own connection.
 *
 * Renders used to share one page and run one at a time. That was right for a
 * beta, and wrong the moment two people pressed "Send it" together: each
 * invoice is a card and a PDF, and ten people meant the tenth waited for
 * nineteen renders. Now there is a small pool of tabs in the one browser, and
 * a render waits only when every tab is busy.
 */
type Tab = {
  ws: WebSocket;
  frameId: string;
  send: (method: string, params?: unknown) => Promise<any>;
  dead: boolean;
};

type Browser = {
  process: ChildProcess;
  port: number;
  tabs: Set<Tab>;
  idle: Tab[];
};

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;

/** Renders waiting for a tab, first come first served. */
const waiting: ((t: Tab) => void)[] = [];

/**
 * How many renders at once. Three on the 2GB box: each tab holds tens of
 * megabytes while it draws, and more than this buys little on two cores.
 */
const TABS = Math.max(1, Math.min(8, Number(process.env.PDF_TABS ?? 3) || 3));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(): Promise<Browser> {
  const exe = chromePath();
  if (!exe) throw new Error("no Chrome or Chromium found; set CHROME_PATH");

  // Port 0 would be tidier, but Chrome only reports the chosen port to a file,
  // and reading it back is more moving parts than picking a high port.
  const port = env.PDF_DEBUG_PORT;

  const child = spawn(
    exe,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      // Rendering somebody else's invoice text: no extensions, no network
      // beyond what the template needs, nothing that outlives the render.
      "--disable-extensions",
      "--disable-background-networking",
      // Required where the API runs as root in a container, and harmless
      // otherwise: there is no untrusted code in these templates.
      "--no-sandbox",
      // Containers get a 64MB /dev/shm by default, which Chrome runs out of
      // part-way through a render — it dies with no useful error and the
      // invoice never arrives. This moves those allocations to /tmp.
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      /* not up yet */
    }
    if (!up) await sleep(100);
  }
  if (!up) {
    child.kill();
    throw new Error("Chrome did not open a debugging port");
  }

  const b: Browser = { process: child, port, tabs: new Set(), idle: [] };

  // If it dies, forget it: the next render launches a fresh one rather than
  // failing forever against a corpse.
  child.once("exit", () => {
    if (browser === b) browser = null;
    for (const t of b.tabs) t.dead = true;
  });

  return b;
}

async function openTab(b: Browser): Promise<Tab> {
  // A new page for this tab. PUT on current Chrome; GET on older builds.
  let res = await fetch(`http://127.0.0.1:${b.port}/json/new?about:blank`, { method: "PUT" });
  if (!res.ok) res = await fetch(`http://127.0.0.1:${b.port}/json/new?about:blank`);
  const target = (await res.json()) as { webSocketDebuggerUrl: string };

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("could not attach to Chrome")));
  });

  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  });

  const send = (method: string, params: unknown = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`Chrome did not answer ${method}`));
      }, env.PDF_TIMEOUT_MS);
      pending.set(n, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(`${method}: ${m.error.message}`));
        else resolve(m);
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send("Page.enable");
  const tree = await send("Page.getFrameTree");
  const tab: Tab = { ws, frameId: tree.result.frameTree.frame.id, send, dead: false };
  ws.addEventListener("close", () => {
    tab.dead = true;
  });
  return tab;
}

async function ready(): Promise<Browser> {
  if (browser) return browser;
  starting ??= launch()
    .then((b) => {
      browser = b;
      return b;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

/** A free tab: an idle one, a new one while there is room, or the next to come free. */
async function acquire(): Promise<Tab> {
  const b = await ready();
  while (b.idle.length) {
    const t = b.idle.pop()!;
    if (!t.dead) return t;
    b.tabs.delete(t);
  }
  if (b.tabs.size < TABS) {
    const t = await openTab(b);
    b.tabs.add(t);
    return t;
  }
  return new Promise((resolve) => waiting.push(resolve));
}

/** Hands a tab to whoever is waiting, or back to the pool; a broken one is closed. */
function release(t: Tab, broken = false): void {
  const b = browser;
  if (broken || t.dead || !b || !b.tabs.has(t)) {
    t.dead = true;
    b?.tabs.delete(t);
    try {
      t.ws.close();
    } catch {
      /* already gone */
    }
    // Somebody waiting still needs a tab: open one for them.
    const next = waiting.shift();
    if (next) void acquire().then(next, () => waiting.unshift(next));
    return;
  }
  const next = waiting.shift();
  if (next) next(t);
  else b.idle.push(t);
}

/**
 * Waits until the page is ready to capture: its typefaces decoded and its
 * images (a logo, a signature) decoded.
 *
 * This was a flat 300ms on every render. The faces are data URIs, so the
 * real wait is decode time, usually a few milliseconds; waiting on the
 * document itself is both faster and never too early. Capped, so a page that
 * never settles still renders.
 */
async function settled(t: Tab): Promise<void> {
  await t.send("Runtime.evaluate", {
    expression: `Promise.race([
      Promise.all([
        document.fonts.ready,
        ...[...document.images].map((i) => (i.decode ? i.decode().catch(() => 0) : 0)),
      ]).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))),
      new Promise((r) => setTimeout(r, 1500)),
    ]).then(() => 1)`,
    awaitPromise: true,
    returnByValue: true,
  });
}

/** One render on a pooled tab, with one retry on a fresh tab if it breaks. */
async function onTab<T>(work: (t: Tab) => Promise<T>): Promise<T> {
  let t = await acquire();
  try {
    const out = await work(t);
    release(t);
    return out;
  } catch (first) {
    // A browser or tab that died between renders is the ordinary failure
    // here, and it looks like any other protocol error. One fresh tab (and a
    // fresh browser if it is the browser that went), then give up.
    release(t, true);
    if (browser?.process.exitCode !== null && browser?.process.exitCode !== undefined) browser = null;
    t = await acquire();
    try {
      const out = await work(t);
      release(t);
      return out;
    } catch {
      release(t, true);
      throw first;
    }
  }
}

/* -------------------------------------------------------------------------- */

/**
 * The typefaces, served to Chrome from inside this process.
 *
 * Every sheet carries its fonts as data URIs — about 500KB of base64 — so the
 * stored document never depends on anything outside it. But Chrome decodes
 * those afresh on every render, and that was most of each render's time.
 * Here the renderer swaps each embedded font for the same file served on
 * 127.0.0.1, which Chrome fetches once per tab and then keeps. Same bytes,
 * so the same PDF; nothing leaves the machine, and the port is not exposed.
 * If the little server cannot start, renders go out with the fonts embedded
 * exactly as before.
 */
let fontBase: Promise<string | null> | null = null;
let fontMap: Map<string, string> | null = null;

function localFonts(): Promise<string | null> {
  fontBase ??= (async () => {
    try {
      const { createServer } = await import("node:http");
      const { readFile } = await import("node:fs/promises");
      const server = createServer(async (req, res) => {
        const file = decodeURIComponent((req.url ?? "").replace(/^\/f\//, ""));
        const where = FONT_FILES[file];
        if (!where) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-type": "font/ttf",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=31536000, immutable",
        });
        res.end(await readFile(where));
      });
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => ok());
      });
      server.unref();
      const addr = server.address();
      return typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}/f/` : null;
    } catch {
      return null;
    }
  })();
  return fontBase;
}

async function withLocalFonts(html: string): Promise<string> {
  const base = await localFonts();
  if (!base) return html;
  fontMap ??= embeddedFonts();
  let out = html;
  for (const [uri, file] of fontMap) {
    if (out.includes(uri)) out = out.split(uri).join(base + encodeURIComponent(file));
  }
  return out;
}

export type PageSize = { widthInches: number; heightInches: number };
/** A4, which is what a Nigerian printer and a Nigerian accountant expect. */
export const A4: PageSize = { widthInches: 8.27, heightInches: 11.69 };

/**
 * Renders HTML to a PDF.
 *
 * The HTML must be self-contained: styles inline, images as data URIs. Nothing
 * is fetched, so a render cannot hang on somebody else's CDN and cannot leak
 * which invoices are being made by requesting a font.
 */
export async function renderPdf(html: string, size: PageSize = A4): Promise<Buffer> {
  return onTab(async (t) => {
    // A tab that last drew a card has that card's viewport; a PDF wants none.
    await t.send("Emulation.clearDeviceMetricsOverride");
    await t.send("Page.setDocumentContent", { frameId: t.frameId, html: await withLocalFonts(html) });
    await settled(t);
    const res = await t.send("Page.printToPDF", {
      printBackground: true,
      paperWidth: size.widthInches,
      paperHeight: size.heightInches,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      preferCSSPageSize: false,
      generateTaggedPDF: false,
      generateDocumentOutline: false,
    });
    return Buffer.from(res.result.data, "base64");
  });
}

/**
 * Renders HTML to a PNG, at exactly the size asked for.
 *
 * Same browser and same rules as `renderPdf`: the HTML is self-contained, so
 * a render cannot hang on somebody else's CDN.
 */
export async function renderPng(html: string, width: number, height: number): Promise<Buffer> {
  return onTab(async (t) => {
    // The viewport has to match, or the capture is padded or cropped.
    await t.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await t.send("Page.setDocumentContent", { frameId: t.frameId, html: await withLocalFonts(html) });
    await settled(t);
    const res = await t.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
      captureBeyondViewport: true,
    });
    return Buffer.from(res.result.data, "base64");
  });
}

/**
 * Starts Chrome and opens the tabs before anybody needs them.
 *
 * Called at boot. Launching costs about two seconds, and it used to land on
 * whoever sent the first invoice after each deploy.
 */
export async function warmRenderer(): Promise<void> {
  if (!chromePath()) return;
  const b = await ready();
  while (b.tabs.size < TABS) {
    const t = await openTab(b);
    b.tabs.add(t);
    release(t);
  }
}

/** Closes the browser. Called on shutdown so no process is left behind. */
export async function closeRenderer(): Promise<void> {
  const b = browser;
  browser = null;
  if (!b) return;
  for (const t of b.tabs) {
    try {
      t.ws.close();
    } catch {
      /* already gone */
    }
  }
  b.process.kill();
}
