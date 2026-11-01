/**
 * "Is this your business name?" (1 November 2026). Which names are asked
 * about again, and the message and buttons that ask.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { looksWrong, nameCheckText, NAME_BUTTONS } from "./name-check.ts";
import { TEMPLATES } from "../whatsapp/window.ts";
import { monthBannerHtml, monthBannerUrl } from "../brand/month-banner.ts";

describe("names that still look wrong", () => {
  for (const name of ["Hi Balans", "I Want To Try It", "Good Morning", "Ok", "0123456789", "Test", "My Business Name Is Ada", "X"]) {
    it(`asks again about "${name}"`, () => assert.ok(looksWrong(name)));
  }
  for (const name of ["Kemi Adeyemi Studio", "Sure Prints", "Hi-Tech Solutions", "Zenith Homes Ltd", "Tunde Bakare", "OK Motors"]) {
    it(`leaves "${name}" at one ask`, () => assert.ok(!looksWrong(name)));
  }
});

describe("the question", () => {
  it("names the business", () => {
    assert.ok(nameCheckText("Ada Studio").includes("Is Ada Studio your business name?"));
  });

  it("has buttons Meta will take", () => {
    assert.ok(NAME_BUTTONS.length <= 3);
    for (const b of NAME_BUTTONS) assert.ok(b.title.length <= 20, b.title);
  });

  it("sends the same ids from the template as from the chat", () => {
    assert.equal(TEMPLATES.business_name_check.quickReplies?.length, NAME_BUTTONS.length);
  });
});

describe("the templates with reply buttons", () => {
  it("keep to Meta's limits", () => {
    for (const t of Object.values(TEMPLATES)) {
      if (!t.quickReplies) continue;
      assert.ok(t.quickReplies.length <= 3, t.name);
      for (const q of t.quickReplies) assert.ok(q.length <= 25, `${t.name}: ${q}`);
      assert.ok(!t.button && !t.flowButton, `${t.name}: one kind of button`);
    }
  });
});

describe("the month banner", () => {
  it("says the month and the year, nothing private", () => {
    const html = monthBannerHtml(10, 2026);
    assert.ok(html.includes(">October<"));
    assert.ok(html.includes(">2026<"));
  });

  it("is a fixed address per month", () => {
    assert.ok(monthBannerUrl(3, 2027).endsWith("/brand/month/2027-03.jpg"));
  });
});
