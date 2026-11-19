import { Fragment, type ReactNode } from 'react';

/**
 * Tiny, XSS-safe markdown for advisor replies: **bold**, *italic*, "-"/"•"/"1." lists, blank-line paragraphs.
 * Produces React elements only (no dangerouslySetInnerHTML), ~1KB vs ~30KB for a markdown library.
 */
export function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <em key={i}>{part.slice(1, -1)}</em>
    : <Fragment key={i}>{part}</Fragment>);
}

export function Md({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) { blocks.push(<ul key={`l${blocks.length}`} className="my-1.5 list-disc space-y-1 pl-5">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const m = /^\s*(?:[-•*]|\d+[.)])\s+(.*)$/.exec(line);
    if (m && !/^\s*\*\*/.test(line)) { list.push(m[1]!); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`} className="my-1.5">{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}
