import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createBrowser } from "../src/browser.ts";

const click = (x: number, y: number): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 10, shift: false, alt: false, ctrl: false });

test("full browser selects items, toggles details and pages through all expanded content", () => {
  let closed = 0;
  const browser = createBrowser({ title: "Items", theme: { fg: (_color, text) => text, bg: (_color, text) => text }, height: () => 4, requestRender() {}, done: () => { closed++; }, items: [
    { title: "First", detail: ["FULL FIRST", ...Array.from({ length: 20 }, (_, i) => `Detail ${i}`), "END DETAIL"].join("\n") },
    { title: "Second", detail: "FULL SECOND\n\x1b[31m🥧 safe text\x1b[0m" },
  ] });
  assert.doesNotMatch(browser.render(80).join("\n"), /FULL FIRST/);
  browser.handleInput!("\r");
  assert.match(browser.render(80).join("\n"), /FULL FIRST/);
  const pages: string[] = [];
  for (let i = 0; i < 8; i++) { browser.handleInput!("\x1b[6~"); pages.push(...browser.render(80)); }
  assert.match(pages.join("\n"), /END DETAIL/);
  browser.handleInput!(" ");
  assert.doesNotMatch(browser.render(80).join("\n"), /FULL FIRST|Detail 0/);
  browser.handleInput!("\x1b[B");
  browser.handleInput!("\r");
  assert.match(browser.render(80)[0], /2\/2 selected/);
  assert.match(browser.render(80).join("\n"), /FULL SECOND/);
  for (const width of [1, 12, 80]) assert.ok(browser.render(width).every((line) => visibleWidth(line) <= width));
  assert.deepEqual(browser.render(0), []);
  browser.handleInput!("\x1b");
  assert.equal(closed, 1);
});

test("fullscreen mouse selects/toggles rows and navigation buttons; empty views are safe", () => {
  const browser = createBrowser({ title: "Items", theme: { fg: (_color, text) => text, bg: (_color, text) => text }, height: () => 4, requestRender() {}, done() {}, items: [{ title: "One", detail: "DETAIL ONE" }, { title: "Two", detail: "DETAIL TWO" }] });
  browser.render(80);
  browser.handleMouse!(click(1, 2));
  assert.match(browser.render(80).join("\n"), /DETAIL TWO/);
  browser.handleMouse!(click(1, 5));
  assert.match(browser.render(80)[0], /1\/2 selected/);
  browser.handleMouse!(click(19, 5));
  assert.match(browser.render(80).join("\n"), /DETAIL ONE/);
  const empty = createBrowser({ title: "Empty", items: [], theme: { fg: (_color, text) => text, bg: (_color, text) => text }, height: () => 1, requestRender() {}, done() {} });
  empty.handleInput!(" ");
  assert.match(empty.render(20).join("\n"), /No items/);
});
