/* markdown.test.mjs — tests for the tiny markdown renderer.
 *
 * Run:  node --import ./register.mjs markdown.test.mjs   (from frontend/tests/)
 */
import { assert, eq, summary } from './lib/t.mjs';

const { renderMarkdown } = await import('/static/js/markdown.js');

// headings
eq(renderMarkdown('# Title'), '<h1>Title</h1>', 'h1');
eq(renderMarkdown('## Sub'), '<h2>Sub</h2>', 'h2');

// bold / italic
eq(renderMarkdown('**bold**'), '<p><strong>bold</strong></p>', 'bold');
eq(renderMarkdown('*italic*'), '<p><em>italic</em></p>', 'italic');

// inline code
eq(renderMarkdown('use `code` here'), '<p>use <code>code</code> here</p>', 'inline code');

// fenced code block
eq(
  renderMarkdown('```js\nconst x = 1;\n```'),
  '<pre><code class="lang-js">const x = 1;</code></pre>',
  'fenced code block'
);

// unordered list
eq(
  renderMarkdown('- a\n- b'),
  '<ul><li>a</li><li>b</li></ul>',
  'unordered list'
);

// ordered list
eq(
  renderMarkdown('1. a\n2. b'),
  '<ol><li>a</li><li>b</li></ol>',
  'ordered list'
);

// link
eq(
  renderMarkdown('[text](https://example.com)'),
  '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">text</a></p>',
  'link'
);

// paragraph
eq(renderMarkdown('hello world'), '<p>hello world</p>', 'paragraph');

// XSS safety: raw HTML is escaped, not executed
const xss = renderMarkdown('<script>alert(1)</script>');
assert(!xss.includes('<script>'), 'raw script tag is escaped');
assert(xss.includes('&lt;script&gt;'), 'script tag shown as text');

// XSS via markdown link javascript: is not turned into a link
const jsLink = renderMarkdown('[x](javascript:alert(1))');
assert(!jsLink.includes('href="javascript:'), 'javascript: link is not rendered as a link');

// edge cases
eq(renderMarkdown(''), '', 'empty input');
eq(renderMarkdown('__bold__'), '<p><strong>bold</strong></p>', 'bold with underscores');
eq(renderMarkdown('_italic_'), '<p><em>italic</em></p>', 'italic with underscores');
eq(renderMarkdown('###### tiny'), '<h6>tiny</h6>', 'h6');
eq(renderMarkdown('#nospace'), '<p>#nospace</p>', 'hash without space is not a heading');
eq(renderMarkdown('+ a\n+ b'), '<ul><li>a</li><li>b</li></ul>', 'plus list');
eq(renderMarkdown('* a\n* b'), '<ul><li>a</li><li>b</li></ul>', 'star list');
eq(renderMarkdown('para one\n\npara two'), '<p>para one</p>\n<p>para two</p>', 'multiple paragraphs');
eq(
  renderMarkdown('**bold** and *italic* and `code`'),
  '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>',
  'mixed inline formatting'
);
// code block content is escaped (no HTML execution inside fences)
const codeBlock = renderMarkdown('```\n<script>alert(1)</script>\n```');
assert(!codeBlock.includes('<script>'), 'code block content is escaped');

summary('markdown');
