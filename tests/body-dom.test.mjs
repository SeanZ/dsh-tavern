import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { sanitizeTavernBodyHtml } from '../tavern-plugin/lib/domain/body-dom.cjs';

function clean(html, mode, slots = []) {
  const dom = new JSDOM('<main></main>');
  try { return sanitizeTavernBodyHtml(html, dom.window.document, { mode, slots }); }
  finally { dom.window.close(); }
}

for (const mode of ['trusted','untrusted','static']) test(mode + '：普通正文绝不激活脚本、事件或危险URL', () => {
  const result=clean('<div onclick="bad()"><script>bad()</script><iframe srcdoc="bad"></iframe><svg onload="bad()"></svg><a href="java\nscript:bad()">链接</a><img src="x" onerror="bad()"><form><input><button>提交</button></form></div>',mode);
  assert.doesNotMatch(result, /<script|<iframe|<svg|onclick|onerror|javascript|srcdoc|<form|<input|<button/i);
  assert.match(result,/链接/);
});

test('可信正文保留作者可达性，非可信去作者样式与选择器，静态样式限制在shadow', () => {
  const source='<style>body{color:red}</style><div id="author" class="card" style="color:red">正文</div>';
  const trusted=clean(source,'trusted'), untrusted=clean(source,'untrusted'), stat=clean(source,'static');
  assert.match(trusted,/id="author"/); assert.match(trusted,/class="card"/); assert.match(trusted,/style="color:red"/);
  assert.doesNotMatch(trusted,/<style/);
  assert.doesNotMatch(untrusted, /\s(?:id|class|style)=|<style/);
  assert.match(stat,/:host\{color:red\}/);
});

test('生成的标准格式与details结构通过清洗', () => {
  const source='<details open class="card"><summary><strong>标题</strong></summary><del>删除</del><u>下划线</u><table><tbody><tr><td style="text-align:right">格子</td></tr></tbody></table></details>';
  const result=clean(source,'trusted');
  for(const tag of ['details','summary','strong','del','u','table','td']) assert.ok(result.includes('<'+tag),result);
  assert.match(result,/details open/);
});

test('仅本次登记的span槽可通过，作者不能伪造内部槽', () => {
  const source='<span data-dsh-body-slot="good"></span><span data-dsh-body-slot="forged" id="x"></span>';
  const result=clean(source,'untrusted',['good']);
  assert.match(result,/data-dsh-body-slot="good"/);
  assert.doesNotMatch(result,/data-dsh-body-slot="forged"|id="x"/);
});

test('外链安全打开，非法协议和非可信锚点不能触达宿主', () => {
  const source='<a href="https://example.com" target="_self">外链</a><a href="#host">锚点</a><a href="file:///tmp/x">本地</a>';
  const result=clean(source,'untrusted');
  assert.match(result,/target="_blank"/); assert.match(result,/rel="noopener noreferrer"/);
  assert.doesNotMatch(result,/href="#host"|file:/);
});
