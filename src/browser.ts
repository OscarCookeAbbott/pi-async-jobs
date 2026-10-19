import { stripVTControlCharacters } from "node:util";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

export interface BrowserItem { title: string; detail: string; color?: ThemeColor; background?: Parameters<Theme["bg"]>[0] }
interface BrowserOptions {
  title: string;
  items: BrowserItem[];
  theme: Pick<Theme, "fg" | "bg">;
  height(): number;
  requestRender(): void;
  done(): void;
  selected?: number;
}
const clean = (text: string) => stripVTControlCharacters(text).replace(/\t/g, "   ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");

/** A variable-height list: selection navigates items; paging/wheel reads expanded details. */
export function createBrowser(options: BrowserOptions): Component {
  const { items, theme } = options;
  let selected = Math.max(0, Math.min(options.selected ?? 0, items.length - 1));
  const expanded = new Set<number>();
  let followSelection = true;
  let owners: number[] = [];
  let height = 1;
  let lastWidth = 0;
  let footerY = 0;
  let buttons: Array<{ start: number; end: number; run(): void }> = [];
  const scroll = new ScrollView({
    render(width) {
      owners = [];
      if (!items.length) return ["No items."];
      return items.flatMap((item, index) => {
        const open = expanded.has(index);
        const label = `${index === selected ? "›" : " "} ${open ? "−" : "+"} ${clean(item.title).replace(/\n/g, " ")}`;
        const paint = (text: string) => item.background ? theme.bg(item.background, truncateToWidth(text, width, undefined, true)) : text;
        const lines = [paint(theme.fg(index === selected ? "accent" : item.color ?? "toolOutput", truncateToWidth(label, width)))];
        if (open) for (const part of clean(item.detail).split("\n")) {
          for (const line of wrapTextWithAnsi(part, Math.max(1, width - 2))) lines.push(paint(theme.fg(item.color ?? "toolOutput", truncateToWidth(`  ${line}`, width))));
        }
        owners.push(...lines.map(() => index));
        return lines;
      });
    },
    invalidate() {},
  }, { scrollbar: "hidden" });

  function move(delta: number): void {
    selected = Math.max(0, Math.min(items.length - 1, selected + delta));
    followSelection = true;
    options.requestRender();
  }
  function toggle(): void {
    if (!items.length) return;
    if (expanded.has(selected)) expanded.delete(selected); else expanded.add(selected);
    followSelection = true;
    options.requestRender();
  }
  return {
    render(width) {
      if (width < 1) return [];
      const nextHeight = Math.max(1, options.height());
      if (width !== lastWidth || height !== nextHeight) followSelection = true;
      lastWidth = width;
      height = nextHeight;
      const lines = scroll.render(width);
      scroll.updateLayout(lines.length, height, options.requestRender);
      if (followSelection) {
        const row = owners.indexOf(selected);
        if (row >= 0 && (row < scroll.scrollTop || row >= scroll.scrollTop + height)) scroll.scrollTo(row);
        followSelection = false;
      }
      const body = lines.slice(scroll.scrollTop, scroll.scrollTop + height);
      while (body.length < height) body.push("");
      let footer = "";
      buttons = [];
      for (const [label, run] of [
        ["[↑ Prev]", () => move(-1)], ["[↓ Next]", () => move(1)],
        [expanded.has(selected) ? "[Collapse]" : "[Expand]", toggle], ["[Close]", options.done],
      ] as const) {
        if (footer) footer += " ";
        buttons.push({ start: footer.length, end: footer.length + label.length, run });
        footer += label;
      }
      footerY = height + 1;
      return [
        theme.fg("accent", `${options.title} · ${items.length ? selected + 1 : 0}/${items.length} selected`),
        ...body, theme.fg("muted", footer),
        theme.fg("muted", "↑↓/Home/End select · Enter/Space expand · PgUp/PgDn scroll · Esc close"),
      ].map((line) => truncateToWidth(line, width));
    },
    handleInput(data) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return options.done();
      if (matchesKey(data, "up")) return move(-1);
      if (matchesKey(data, "down")) return move(1);
      if (matchesKey(data, "home")) return move(-items.length);
      if (matchesKey(data, "end")) return move(items.length);
      if (matchesKey(data, "enter") || matchesKey(data, "space")) return toggle();
      if (matchesKey(data, "pageUp")) scroll.scrollBy(-height);
      else if (matchesKey(data, "pageDown")) scroll.scrollBy(height);
      else return;
      options.requestRender();
    },
    handleMouse(event: TuiMouseEvent) {
      if (event.type === "wheel") { scroll.scrollBy(event.wheelDelta ?? 0); options.requestRender(); return { handled: true }; }
      if (event.type !== "click" || event.button !== "left") return;
      if (event.y === footerY) {
        const button = buttons.find(({ start, end }) => event.x >= start && event.x < end);
        if (button) { button.run(); return { handled: true }; }
      }
      if (event.y > 0 && event.y <= height) {
        const owner = owners[scroll.scrollTop + event.y - 1];
        if (owner !== undefined) { selected = owner; toggle(); return { handled: true, focus: true }; }
      }
    },
    invalidate() { scroll.invalidate(); },
  };
}
