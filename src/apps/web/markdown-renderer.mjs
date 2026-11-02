import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function AssistantMarkdown({ content }) {
  return createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    skipHtml: true,
  }, content);
}
