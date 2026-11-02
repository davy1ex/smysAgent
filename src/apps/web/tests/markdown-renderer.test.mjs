import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown } from "../markdown-renderer.mjs";

function render(content) {
  return renderToStaticMarkup(createElement(AssistantMarkdown, { content }));
}

test("assistant Markdown renders CommonMark and GFM syntax", () => {
  const html = render("# Heading\n\n- [x] done\n- ~~old~~\n\n| A | B |\n| - | - |\n| 1 | 2 |");

  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /type="checkbox"[^>]*disabled=""[^>]*checked=""/);
  assert.match(html, /<del>old<\/del>/);
  assert.match(html, /<table>/);
});

test("assistant Markdown keeps streamed input incremental", () => {
  const partial = render("**answer");
  const complete = render("**answer**");

  assert.match(partial, /\*\*answer/);
  assert.match(complete, /<strong>answer<\/strong>/);
});

test("assistant Markdown does not render model HTML or unsafe link protocols", () => {
  const html = render("<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n[jump](javascript:alert%281%29)");

  assert.doesNotMatch(html, /<img\b|<script\b|onerror=/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, />jump<\/a>/);
});
