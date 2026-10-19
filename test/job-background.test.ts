import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createBrowser } from "../src/browser.ts";

test("full browser uses distinct semantic outcome backgrounds without red/green foregrounds", () => {
  const backgrounds: Array<{ color: string; text: string }> = [];
  const foregrounds: string[] = [];
  const browser = createBrowser({ title: "Jobs", height: () => 5, requestRender() {}, done() {}, items: [
    { title: "Failed", detail: "Failed output", background: "toolErrorBg" },
    { title: "Success", detail: "Success output", background: "toolSuccessBg" },
  ], theme: {
    fg: (color, text) => { foregrounds.push(color); return text; },
    bg: (color, text) => { assert.equal(visibleWidth(text), 20); backgrounds.push({ color, text }); return text; },
  } });
  browser.render(20);
  browser.handleInput!("\r");
  browser.render(20);
  assert.ok(backgrounds.some(({ color, text }) => color === "toolErrorBg" && text.includes("Failed output")));
  assert.ok(backgrounds.some(({ color, text }) => color === "toolSuccessBg" && text.includes("Success")));
  assert.ok(!backgrounds.some(({ color, text }) => color === "toolErrorBg" && text.includes("Success")));
  assert.ok(!foregrounds.includes("error") && !foregrounds.includes("success"));
});
