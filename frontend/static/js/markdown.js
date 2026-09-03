/* markdown.js — tiny, dependency-free markdown renderer for AI replies.
 *
 * Safety: the input is HTML-escaped FIRST, then markdown is applied on top.
 * This means raw HTML in the model's reply is shown as literal text, never
 * executed. Only a small, safe subset of markdown is supported:
 *
 *   - headings  # .. ######
 *   - bold      **x** / __x__
 *   - italic    *x* / _x_
 *   - inline code  `x`
 *   - fenced code blocks  ```lang ... ```
 *   - unordered lists  - / * / + items
 *   - ordered lists    1. items
 *   - links      [text](url)   (http/https only)
 *   - line breaks / paragraphs
 *
 * Returns an HTML string safe to assign to innerHTML.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCode(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Inline formatting applied to an already-escaped string.
function inline(text) {
  let s = text;
  // Inline code first (so * and _ inside code aren't mangled).
  s = s.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);
  // Bold.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // Italic.
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  // Links (http/https only).
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

export function renderMarkdown(src) {
  if (!src) return '';
  const escaped = escapeHtml(src);
  const lines = escaped.split('\n');
  const out = [];
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  let codeLang = '';

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        codeLang = fence[1].trim();
        codeBuf = [];
      } else {
        inCode = false;
        out.push(`<pre><code${codeLang ? ` class="lang-${codeLang}"` : ''}>${codeBuf.join('\n')}</code></pre>`);
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // Headings.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blank line -> paragraph break.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (gather consecutive non-blank, non-special lines).
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
           !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  if (inCode) {
    out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
  }

  return out.join('\n');
}
