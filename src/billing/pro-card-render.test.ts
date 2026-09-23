/**
 * The month on the membership card.
 *
 * The artwork reads "MEMBER SINCE SEP 2026", painted into the PNG. Everybody
 * who subscribed later would have got a card saying September, and no amount
 * of code could fix a picture — so the month is drawn over it instead, by the
 * same browser that renders the invoices.
 *
 * The design is the designed file. Nothing is rebuilt in CSS, because a copy
 * would not match the type and would drift from the artwork every time either
 * changed. All that is added is a patch in the card's own colour over the old
 * line, and the real month in its place.
 *
 * The numbers below were measured off the artwork rather than guessed. The
 * first attempt was guessed and the patch landed on the word PRO.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

import { proCardHtml, SIZE, LINE } from "./pro-card.ts";

const html = (m: number, y: number) => proCardHtml(m, y);

describe("the month it draws", () => {
  it("says the month it was given", () => {
    assert.match(html(12, 2026), /MEMBER SINCE DEC 2026/);
    assert.match(html(1, 2027), /MEMBER SINCE JAN 2027/);
    assert.match(html(9, 2026), /MEMBER SINCE SEP 2026/);
  });

  it("covers the month painted into the artwork", () => {
    // Without the patch the old line shows through under the new one, which
    // is what the first render did.
    const out = html(3, 2027);
    assert.match(out, /class="patch"/);
    assert.match(out, /MEMBER SINCE MAR 2027/);
  });

  it("knows all twelve", () => {
    const seen = new Set<string>();
    for (let m = 1; m <= 12; m++) {
      const label = /MEMBER SINCE (\w+) 2027/.exec(html(m, 2027))?.[1];
      assert.ok(label && label !== "undefined", `month ${m} has no name`);
      seen.add(label);
    }
    assert.equal(seen.size, 12, "twelve distinct months");
  });
});

describe("where it draws it", () => {
  /*
   * The card's own yellow, read out of the artwork.
   *
   * A patch that is even slightly off shows as a rectangle. This decodes the
   * PNG and checks the pixels around the line are the colour the code paints
   * with — so if the artwork is ever re-exported with a different yellow,
   * this fails rather than the card looking broken.
   */
  const pixels = (() => {
    const buf = readFileSync(new URL("../../assets/brand/pro.png", import.meta.url));
    let pos = 8;
    let width = 0;
    let height = 0;
    const idat: Buffer[] = [];
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString("ascii", pos + 4, pos + 8);
      const data = buf.subarray(pos + 8, pos + 8 + len);
      if (type === "IHDR") {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
      } else if (type === "IDAT") idat.push(data);
      else if (type === "IEND") break;
      pos += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = 4;
    const stride = width * bpp;
    const out = Buffer.alloc(height * stride);
    let rp = 0;
    for (let y = 0; y < height; y++) {
      const f = raw[rp++]!;
      const row = raw.subarray(rp, rp + stride);
      rp += stride;
      const cur = out.subarray(y * stride, (y + 1) * stride);
      const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        let v = row[i]!;
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cur[i] = v & 0xff;
      }
    }
    return {
      width,
      hex: (x: number, y: number) => {
        const i = y * stride + x * bpp;
        return `#${[out[i]!, out[i + 1]!, out[i + 2]!]
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("")}`.toUpperCase();
      },
    };
  })();

  it("is the size the artwork actually is", () => {
    assert.equal(pixels.width, SIZE, "the card is drawn at the artwork's own size");
  });

  it("paints the patch in the colour the card already is", () => {
    // Sampled around the line, away from the type itself.
    for (const [x, y] of [
      [420, 1120],
      [1150, 1000],
      [600, 1180],
      [500, 900],
    ] as const) {
      assert.equal(pixels.hex(x, y), "#F5B82E", `the card is not that colour at ${x},${y}`);
    }
    assert.match(html(1, 2027), /#F5B82E/, "and the patch uses it");
  });

  it("sits on the card's plane, not the page's", () => {
    // The card is tilted about five degrees. Level text would float.
    const out = html(1, 2027);
    const tilt = /rotate\((-?[\d.]+)deg\)/.exec(out)?.[1];
    assert.ok(tilt, "nothing is rotated");
    assert.ok(Number(tilt) < -4 && Number(tilt) > -6, `${tilt} degrees is not the card's angle`);
  });

  it("clears the bottom of PRO", () => {
    /*
     * The regression this is here for.
     *
     * The patch started at y=1055, ten pixels above PRO's baseline, so it
     * shaved the bottom off the letters — visible on a real card and not in
     * any test. Reading the ink column by column: PRO bottoms out around
     * y=1065 and the date line starts around y=1113, so the patch has to
     * live in that gap.
     */
    const top = LINE.y * SIZE;

    let proBottom = 0;
    for (let x = 460; x <= 940; x += 4) {
      for (let y = 980; y <= 1090; y++) {
        // Anything this high is PRO: the date line starts well below it.
        if (pixels.hex(x, y) === "#10231C" && y > proBottom) proBottom = y;
      }
    }

    assert.ok(proBottom > 1000, `did not find PRO (lowest ink ${proBottom})`);
    assert.ok(
      top > proBottom,
      `the patch starts at ${top} and PRO reaches ${proBottom} — it would clip the letters`,
    );
  });

  it("still covers the line it is there to cover", () => {
    // And the other side of the same gap: too low and the old date shows.
    const top = LINE.y * SIZE;
    const bottom = top + LINE.h * SIZE;

    assert.ok(top < 1113, `the date starts at 1113 and the patch at ${top}`);
    assert.ok(bottom > 1138, `the date ends at 1138 and the patch at ${bottom}`);
  });

  it("carries the artwork itself, not a rebuild of it", () => {
    // The whole point: the design is the designed file.
    assert.match(html(1, 2027), /url\(data:image\/png;base64,/);
  });
});
