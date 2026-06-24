import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import styles from './MarkdownContent.module.css';

/**
 * Markdown 渲染组件 — 用于 assistant 消息的正文。
 * 支持 GFM（表格、删除线、任务列表）和代码高亮。
 */
export default function MarkdownContent({ content }) {
  if (!content) return null;

  return (
    <ReactMarkdown
      className={styles.md}
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        // 行内代码（无 pre 父元素）
        code({ className, children, ...props }) {
          // rehype-highlight 处理后，代码块的 code 会有 className 如 "hljs language-js"
          // 行内代码没有 className
          if (className) {
            return <code className={className} {...props}>{children}</code>;
          }
          return <code className={styles.inlineCode} {...props}>{children}</code>;
        },
        // 代码块容器
        pre({ children, ...props }) {
          return (
            <div className={styles.codeBlockWrapper}>
              <pre {...props}>{children}</pre>
            </div>
          );
        },
        a({ children, href, ...props }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}