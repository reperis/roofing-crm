import type { ReactNode } from 'react';

/**
 * A deliberately tiny renderer for the light markdown the agent returns.
 *
 * The agent writes bold lead sentences and bulleted findings, which previously reached the page as
 * literal `**asterisks**` because the answer was split on newlines and wrapped in paragraphs.
 *
 * This builds React elements directly and never uses `dangerouslySetInnerHTML`. That matters more
 * than usual here: the input is model output shaped partly by a user's question, so any path that
 * turned it into raw HTML would be an injection vector straight through the product.
 *
 * It handles bold, unordered and ordered lists, and paragraph breaks. Anything else renders as
 * plain text, which is the correct failure mode — unsupported syntax should look slightly plain,
 * never broken.
 */

/** Split a line into text and bold runs. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return parts.filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    return <span key={key}>{part}</span>;
  });
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const key = `p-${blocks.length}`;
    blocks.push(<p key={key}>{inline(paragraph.join(' '), key)}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (list === null) return;
    const key = `l-${blocks.length}`;
    const items = list.items.map((item, index) => (
      <li key={`${key}-${index}`}>{inline(item, `${key}-${index}`)}</li>
    ));
    blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);

    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const ordered = numbered !== null;
      const content = line.replace(bullet !== null ? BULLET : NUMBERED, '');

      // A change of list type starts a new list rather than mixing markers.
      if (list !== null && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(content);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return <>{blocks}</>;
}
