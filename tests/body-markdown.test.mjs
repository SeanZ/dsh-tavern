import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderBodyMarkdown } from '../tavern-plugin/lib/domain/body-renderer.js';
import { bodyRendererCases } from './fixtures/body-renderer-cases.mjs';

for (const [name, source, selectors, text] of bodyRendererCases) test('正文语义：' + name, () => {
  const html = renderBodyMarkdown(source);
  const dom = new JSDOM('<main>' + html + '</main>');
  try {
    const root = dom.window.document.querySelector('main');
    for (const [selector, count] of Object.entries(selectors)) assert.equal(root.querySelectorAll(selector).length, count, html);
    if (text) assert.ok(root.textContent.includes(text), html);
    assert.equal(root.querySelectorAll('[markdown]').length, 0);
    assert.equal(root.querySelectorAll('[data-dsh-body-opaque]').length, 0);
  } finally { dom.window.close(); }
});

test('原始块保护不改写脚本、样式和代码字符串', () => {
  for (const tag of ['script', 'style', 'textarea', 'pre']) {
    const content = '<' + tag + '>"<div markdown=1>**字面**</div>"</' + tag + '>';
    assert.ok(renderBodyMarkdown(content).includes(content));
  }
});

test('连续调用不残留递归深度或容器槽，不污染另一条消息', () => {
  renderBodyMarkdown('<div markdown="0"><div markdown="1">**关闭**</div></div>');
  const first = renderBodyMarkdown('<div>**开启**</div>');
  assert.match(first, /<strong>开启<\/strong>/);
  assert.equal(first, renderBodyMarkdown('<div>**开启**</div>'));
});

test('每个流式前缀安全完成，终态与普通渲染相同', () => {
  const source = '<details class="card"><summary>**标题**</summary>\n\n- <span>项目</span>\n- 第二项\n</details>';
  for (let index = 0; index < source.length; index++) {
    const html = renderBodyMarkdown(source.slice(0, index), { streaming: true });
    assert.equal(typeof html, 'string');
    assert.doesNotMatch(html, /data-dsh-body-opaque/);
  }
  assert.equal(renderBodyMarkdown(source, { streaming: true }), renderBodyMarkdown(source));
});
