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
 * Renders are serialised. A queue is the simple correct thing at this volume —
 * a render is well under a second and a beta does not have two people
 * confirming an invoice in the same breath. The alternative, a tab per render,
 * is the change to make when that stops being true.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { env } from "../config.ts";

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

type Browser = {
  process: ChildProcess;
  ws: WebSocket;
  frameId: string;
  send: (method: string, params?: unknown) => Promise<any>;
};

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;

/** Renders run one at a time; this is the tail of that chain. */
let queue: Promise<unknown> = Promise.resolve();

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
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      target = list.find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
    if (!target) await sleep(100);
  }
  if (!target) {
    child.kill();
    throw new Error("Chrome did not open a debugging port");
  }

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
  const frameId: string = tree.result.frameTree.frame.id;

  const b: Browser = { process: child, ws, frameId, send };

  // If it dies, forget it: the next render launches a fresh one rather than
  // failing forever against a corpse.
  const forget = () => {
    if (browser === b) browser = null;
  };
  child.once("exit", forget);
  ws.addEventListener("close", forget);

  return b;
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

/* -------------------------------------------------------------------------- */

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
  const run = async (): Promise<Buffer> => {
    let b = await ready();

    const attempt = async (): Promise<Buffer> => {
      await b.send("Page.setDocumentContent", { frameId: b.frameId, html });
      // Long enough for layout and webfont fallback, short enough not to matter.
      await sleep(120);
      const res = await b.send("Page.printToPDF", {
        printBackground: true,
        paperWidth: size.widthInches,
        paperHeight: size.heightInches,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
        preferCSSPageSize: false,
      });
      return Buffer.from(res.result.data, "base64");
    };

    try {
      return await attempt();
    } catch (first) {
      // A browser that died between renders is the ordinary failure here, and
      // it looks like any other protocol error. One fresh start, then give up.
      browser = null;
      b = await ready();
      try {
        return await attempt();
      } catch {
        throw first;
      }
    }
  };

  const mine = queue.then(run, run);
  // The queue must survive a failed render, or one bad document stops them all.
  queue = mine.catch(() => undefined);
  return mine;
}

/** Closes the browser. Called on shutdown so no process is left behind. */
export async function closeRenderer(): Promise<void> {
  const b = browser;
  browser = null;
  if (!b) return;
  try {
    b.ws.close();
  } catch {
    /* already gone */
  }
  b.process.kill();
}
