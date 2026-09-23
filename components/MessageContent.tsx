import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MessageContent({ text }: { text: string }) {
  return <div className="message-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]}
    components={{
      a: ({ href, children }) => href && /^https?:\/\//i.test(href)
        ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : ""}</span>,
      table: ({ children }) => <div className="message-table"><table>{children}</table></div>,
    }}>{text}</Markdown></div>;
}
