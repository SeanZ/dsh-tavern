import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDisplayParts } from '../tavern-plugin/lib/domain/display-source.js';
import { createBodyRenderPlan, renderBodyMarkdown } from '../tavern-plugin/lib/domain/body-renderer.js';
import { projectPersistentStatusView } from '../tavern-plugin/lib/domain/persistent-status-view.js';
import { runtimeBoundaryCases } from './fixtures/body-renderer-cases.mjs';

test('先记录旧运行索引，再组合完整原文；空白不丢，输入不变', () => {
  const parts = [{kind:'markdown',text:'  '}, ...projectDisplayParts('*<span>正文</span>*').parts, {kind:'html',content:'<script>call()</script>'}];
  const before = JSON.stringify(parts);
  const plan = createBodyRenderPlan({ parts });
  assert.equal(plan[0].kind, 'body');
  assert.equal(plan[0].text, '  *<span>正文</span>*');
  assert.equal(plan[1].kind, 'html');
  assert.equal(plan[1].frameIndex, parts.length - 2);
  for (const member of plan[0].members) {
    const original = parts[member.sourcePartIndex];
    assert.equal(plan[0].text.slice(member.start, member.end), original.text ?? original.content);
  }
  assert.equal(plan[0].members[0].frameIndex, null);
  assert.equal(plan[0].members.at(-1).end, plan[0].text.length);
  assert.equal(JSON.stringify(parts), before);
});

for (const content of runtimeBoundaryCases) test('运行边界保持：' + content.slice(0, 35), () => {
  const parts = [{kind:'markdown',text:'前'}, {kind:'html',content}, {kind:'markdown',text:'后'}];
  const plan = createBodyRenderPlan({ parts });
  assert.deepEqual(plan.map(part => part.kind), ['body','html','body']);
  assert.equal(plan[1].content, content);
  assert.equal(plan[1].frameIndex, 1);
});

test('显式HTML围栏、未抽取状态片段和冻结模板不二次解析', () => {
  const content = '<div>**字面**</div>';
  for (const fields of [{fenced:true}, {statusKey:'id:x'}, {statusRule:0}, {sourceKind:'rendered'}]) {
    const plan = createBodyRenderPlan({ parts:[{kind:'html',content,...fields}] });
    assert.equal(plan[0].kind, 'html');
    assert.equal(plan[0].content, content);
  }
  assert.equal(projectDisplayParts('```html\n<div>**文档**</div>\n```').parts[0].fenced, true);
});

test('状态栏抽取保留缺口与原索引，不修改冻结投影或重复面板', () => {
  const content='<script>status()</script>';
  const parts=Object.freeze([{kind:'markdown',text:'*'},{kind:'html',content},{kind:'markdown',text:'*'},{kind:'html',content:'<script>other()</script>'}].map(Object.freeze));
  const input=Object.freeze({turn:2,parts});
  const result=projectPersistentStatusView([{role:'assistant',turn:2,text:'<StatusPlaceHolderImpl/>'}],[input],{regexScripts:[{id:'panel',placement:[2],markdownOnly:true,findRegex:'<StatusPlaceHolderImpl/>',replaceString:content}]});
  assert.equal(result.statusViews.length,1);
  assert.equal(result.statusViews[0].sourcePartIndex,1);
  assert.equal(result.projections[0].parts[1].bodyBreakBefore,true);
  assert.equal(parts[2].bodyBreakBefore,undefined);
  const plan=createBodyRenderPlan(result.projections[0]);
  assert.deepEqual(plan.map(part=>part.kind),['body','body','html']);
  assert.equal(plan[2].frameIndex,2);
  assert.ok(!plan.some(part=>part.content===content));
});

test('mode=html的普通混排仍组合，原样字节拼接恢复链接结构', () => {
  const projection={mode:'html',parts:projectDisplayParts('[<span>链接</span>](https://example.com)').parts};
  const plan=createBodyRenderPlan(projection);
  assert.equal(plan.length,1);
  assert.match(renderBodyMarkdown(plan[0].text), /<a[^>]+><span>链接<\/span><\/a>/);
});
