import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { depositSplit, formatNaira, lineTotal, splitInto, totalsFor, vatOn } from "./totals.ts";

const N = (naira: number) => naira * 100;

describe("a line", () => {
  it("multiplies without floating-point dust", () => {
    assert.equal(lineTotal(2, N(50_000)), N(100_000));
    assert.equal(lineTotal(1, N(350_000)), N(350_000));
    assert.equal(lineTotal(3, N(1_200_000)), N(3_600_000));
  });

  it("handles fractional quantities", () => {
    assert.equal(lineTotal(2.5, N(20_000)), N(50_000));
    assert.equal(lineTotal(0.5, N(1)), 50);
    // 1.5 hours at 33,333.33 an hour, to the kobo.
    assert.equal(lineTotal(1.5, 3_333_333), 5_000_000);
  });

  it("rounds half up, the way an invoice does", () => {
    // 0.005 of a kobo is still half a kobo up.
    assert.equal(lineTotal(1.005, 100), 101); // 100.5 -> 101
    assert.equal(lineTotal(1.004, 100), 100); // 100.4 -> 100
  });

  it("refuses nonsense rather than producing it", () => {
    assert.throws(() => lineTotal(-1, 100), RangeError);
    assert.throws(() => lineTotal(NaN, 100), RangeError);
    assert.throws(() => lineTotal(1, -100), RangeError);
    assert.throws(() => lineTotal(1, 1.5), RangeError);
  });
});

describe("VAT", () => {
  it("is 7.5% of the subtotal", () => {
    assert.equal(vatOn(N(350_000), 7.5), N(26_250));
    assert.equal(vatOn(N(20_000), 7.5), N(1_500));
    assert.equal(vatOn(N(100), 7.5), 750);
  });

  it("rounds to the kobo, half up", () => {
    // 7.5% of 1 kobo is 0.075 kobo, which rounds to nothing.
    assert.equal(vatOn(1, 7.5), 0);
    // 7.5% of 7 kobo is 0.525, which rounds up to 1.
    assert.equal(vatOn(7, 7.5), 1);
    // 7.5% of 6 kobo is 0.45, which rounds down to nothing.
    assert.equal(vatOn(6, 7.5), 0);
  });

  it("is nothing when it was not asked for", () => {
    assert.equal(vatOn(N(350_000), 0), 0);
  });

  it("survives an amount big enough to break a double", () => {
    // 90 billion naira in kobo is past 2^53 once multiplied out.
    const huge = 9_000_000_000_00;
    assert.equal(vatOn(huge, 7.5), 675_000_000_00);
  });
});

describe("a document's totals", () => {
  it("adds the lines up and leaves them intact", () => {
    const t = totalsFor(
      [
        { description: "banners", qty: 2, unitAmountKobo: N(50_000) },
        { description: "flyer", qty: 1, unitAmountKobo: N(30_000) },
      ],
      null,
    );
    assert.deepEqual(t.lineTotalsKobo, [N(100_000), N(30_000)]);
    assert.equal(t.subtotalKobo, N(130_000));
    assert.equal(t.vatKobo, 0);
    assert.equal(t.totalKobo, N(130_000));
  });

  it("puts VAT on top of the subtotal, not inside it", () => {
    const t = totalsFor([{ description: "render", qty: 1, unitAmountKobo: N(350_000) }], 7.5);
    assert.equal(t.subtotalKobo, N(350_000));
    assert.equal(t.vatKobo, N(26_250));
    assert.equal(t.totalKobo, N(376_250));
  });

  it("is zero for nothing at all", () => {
    const t = totalsFor([], 7.5);
    assert.equal(t.totalKobo, 0);
  });

  it("always closes: subtotal plus VAT is the total", () => {
    for (const unit of [1, 7, 99, 12_345, N(1_000), N(350_000), N(1_200_000)]) {
      for (const qty of [1, 2, 3, 0.5, 1.5, 2.25]) {
        for (const vat of [null, 7.5, 5, 100]) {
          const t = totalsFor([{ description: "x", qty, unitAmountKobo: unit }], vat);
          assert.equal(
            t.subtotalKobo + t.vatKobo,
            t.totalKobo,
            `${qty} x ${unit} at ${vat}% did not close`,
          );
        }
      }
    }
  });
});

describe("splitting a total into parts", () => {
  it("halves an even amount", () => {
    assert.deepEqual(depositSplit(N(350_000), 50), [N(175_000), N(175_000)]);
  });

  it("gives the odd kobo to the last part, never to nobody", () => {
    // 1 kobo in two halves. One part gets it; the total is still 1.
    assert.deepEqual(depositSplit(1, 50), [0, 1]);
    assert.deepEqual(depositSplit(333, 50), [166, 167]);
  });

  it("does a 30/70", () => {
    assert.deepEqual(depositSplit(N(100_000), 30), [N(30_000), N(70_000)]);
  });

  it("does three equal parts without losing a kobo", () => {
    const parts = splitInto(N(100_000), [33.34, 33.33, 33.33]);
    assert.equal(parts.reduce((t, p) => t + p, 0), N(100_000));
  });

  it("always sums to exactly the total", () => {
    const shapes = [[50, 50], [30, 70], [25, 25, 25, 25], [33.34, 33.33, 33.33], [10, 90], [1, 99]];
    for (const total of [1, 2, 3, 7, 99, 101, 333, 12_345, N(350_000), N(1_200_001)]) {
      for (const shape of shapes) {
        const parts = splitInto(total, shape);
        assert.equal(
          parts.reduce((t, p) => t + p, 0),
          total,
          `${shape.join("/")} of ${total} came to ${parts.join(" + ")}`,
        );
        assert.ok(parts.every((p) => p >= 0), "no part may be negative");
      }
    }
  });

  it("refuses parts that do not make a whole", () => {
    assert.throws(() => splitInto(N(1_000), [50, 40]), RangeError);
    assert.throws(() => splitInto(N(1_000), [60, 60]), RangeError);
  });
});

describe("writing an amount for a person to read", () => {
  it("groups the thousands", () => {
    assert.equal(formatNaira(N(350_000)), "₦350,000");
    assert.equal(formatNaira(N(1_200_000)), "₦1,200,000");
    assert.equal(formatNaira(N(500)), "₦500");
  });

  it("shows kobo only when there are some", () => {
    assert.equal(formatNaira(35_000_050), "₦350,000.50");
    assert.equal(formatNaira(1), "₦0.01");
    assert.equal(formatNaira(0), "₦0");
  });
});
