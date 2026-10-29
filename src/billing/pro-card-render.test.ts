/**
 * The month on the membership card.
 *
 * Until 29 October 2026 the artwork read "MEMBER SINCE SEP 2026", painted
 * into the PNG, and the real month was drawn over a patch in the card's
 * yellow. The rebranded card is drawn from code (brand/cards.ts): a gold card
 * made in Google Flow with the coin, "PRO" and the month engraved on its face.
 *
 * What can still go wrong is the geometry. The engraving is laid out flat and
 * projected onto the four corners of the card in the render; corners taken
 * from the extreme pixels sit on the rounded corners and tip the type off the
 * card's plane, which is what the first attempt did.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { proCardHtml, SIZE } from "./pro-card.ts";
import { faceMatrix } from "../brand/cards.ts";

const html = (m: number, y: number) => proCardHtml(m, y);

describe("the month it draws", () => {
  it("says the month it was given", () => {
    assert.match(html(12, 2026), /Member since Dec 2026/);
    assert.match(html(1, 2027), /Member since Jan 2027/);
    assert.match(html(9, 2026), /Member since Sep 2026/);
  });

  it("knows all twelve", () => {
    const seen = new Set<string>();
    for (let m = 1; m <= 12; m++) {
      const label = /Member since (\w+) 2027/.exec(html(m, 2027))?.[1];
      assert.ok(label && label !== "undefined", `month ${m} has no name`);
      seen.add(label);
    }
    assert.equal(seen.size, 12, "twelve distinct months");
  });

  it("has nothing painted to cover any more", () => {
    assert.doesNotMatch(html(3, 2027), /class="patch"/);
    assert.doesNotMatch(html(3, 2027), /MEMBER SINCE SEP/);
  });
});

describe("where it draws it", () => {
  it("is the size of the card", () => {
    assert.equal(SIZE, 2160);
  });

  it("engraves on the card's plane, in perspective", () => {
    const out = html(1, 2027);
    assert.ok(out.includes(faceMatrix()), "the face is not projected onto the card");

    // The projected corners of the 1000 × 630 face, in the 2160px card.
    const m = /matrix3d\(([^)]+)\)/.exec(faceMatrix())![1]!.split(",").map(Number);
    const at = (x: number, y: number) => {
      const w = m[3]! * x + m[7]! * y + m[15]!;
      return [(m[0]! * x + m[4]! * y + m[12]!) / w, (m[1]! * x + m[5]! * y + m[13]!) / w];
    };
    const [tl, tr, br, bl] = [at(0, 0), at(1000, 0), at(1000, 630), at(0, 630)];

    // On the card, below the logo row and above the headline at y=1380.
    for (const [x, y] of [tl, tr, br, bl]) {
      assert.ok(x! > 300 && x! < 1900 && y! > 300 && y! < 1300, `a corner fell off the card at ${x},${y}`);
    }
    // Tilted the way the card is: the right edge sits higher than the left.
    assert.ok(tr![1]! < tl![1]!, "the top edge should rise to the right");
    // A real card, not a sliver: wider than it is tall, at roughly 3:2.
    const width = Math.hypot(tr![0]! - tl![0]!, tr![1]! - tl![1]!);
    const height = Math.hypot(bl![0]! - tl![0]!, bl![1]! - tl![1]!);
    assert.ok(width / height > 1.3 && width / height < 1.8, `${(width / height).toFixed(2)} is not a card`);
  });
});
