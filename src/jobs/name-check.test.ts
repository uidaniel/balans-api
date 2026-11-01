/**
 * "Is this your business name?" (1 November 2026). Which names are asked
 * about again, and the message and buttons that ask.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { judgeName, looksWrong, nameCheckText, NAME_BUTTONS } from "./name-check.ts";
import { TEMPLATES } from "../whatsapp/window.ts";
import { env } from "../config.ts";
import { monthBannerHtml, monthBannerUrl } from "../brand/month-banner.ts";

describe("names the rules call wrong without asking the model", () => {
  for (const name of ["Hi Balans", "I Want To Try It", "Good Morning", "Ok", "0123456789", "Test", "My Business Name Is Ada", "X"]) {
    it(`"${name}"`, () => assert.ok(looksWrong(name)));
  }
  for (const name of ["Kemi Adeyemi Studio", "Sure Prints", "Hi-Tech Solutions", "Zenith Homes Ltd", "Tunde Bakare", "OK Motors"]) {
    it(`leaves "${name}" to the model`, () => assert.ok(!looksWrong(name)));
  }
});

describe("the model's read", () => {
  // A key for the request to be made at all; the answers below are canned.
  if (!env.ANTHROPIC_API_KEY) (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = "test";
  const answering = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("takes the verdict from the tool call", async () => {
    const yes = answering({ content: [{ type: "tool_use", name: "verdict", input: { looks_wrong: true } }] });
    const no = answering({ content: [{ type: "tool_use", name: "verdict", input: { looks_wrong: false } }] });
    assert.equal(await judgeName("I do hair and nails", yes), true);
    assert.equal(await judgeName("Adaeze Hair Studio", no), false);
  });

  it("says nothing rather than guess when the model fails", async () => {
    assert.equal(await judgeName("Adaeze", answering({ error: "overloaded" }, 529)), null);
    assert.equal(await judgeName("Adaeze", answering({ content: [] })), null);
  });
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
