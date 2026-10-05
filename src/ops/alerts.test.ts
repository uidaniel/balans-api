import assert from "node:assert/strict";
import { describe, it } from "node:test";

delete process.env.RESEND_API_KEY;
const { captureLogError, sendErrorDigest, ALERT_TO } = await import("./alerts.ts");

function fakeLog() {
  const said: { obj: Record<string, unknown>; msg?: string }[] = [];
  const log = { warn: (obj: Record<string, unknown>, msg?: string) => said.push({ obj, msg }), info() {}, error() {}, debug() {} };
  return { log: log as never, said };
}

describe("error digests", () => {
  it("groups the same error into one line with a count, and keeps nothing else from the log", async () => {
    for (let i = 0; i < 5; i++) captureLogError([{ err: { message: "connect ETIMEDOUT" }, phone: "2348000000000" }, "could not send"]);
    captureLogError(["plain failure"]);
    const { log, said } = fakeLog();
    assert.equal(await sendErrorDigest(log), 6);
    const bodies = said.map((s) => String(s.obj.body ?? ""));
    assert.equal(bodies.length, ALERT_TO.length);
    assert.match(bodies[0]!, /5× could not send: connect ETIMEDOUT/);
    assert.match(bodies[0]!, /1× plain failure/);
    assert.doesNotMatch(bodies[0]!, /2348000000000/, "a phone number leaked into an alert");
  });

  it("sends nothing when nothing went wrong", async () => {
    const { log, said } = fakeLog();
    assert.equal(await sendErrorDigest(log), 0);
    assert.equal(said.length, 0);
  });

  it("goes to all four of the team", () => {
    assert.deepEqual(ALERT_TO, ["usebalans@gmail.com", "dannycodesltd@gmail.com", "uwakblessing1@gmail.com", "joshuauwak1@gmail.com"]);
  });
});
