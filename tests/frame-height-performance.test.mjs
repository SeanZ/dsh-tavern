import assert from "node:assert/strict";
import test from "node:test";
import { measureHeightPerformance } from "./fixtures/frame-height-performance.mjs";

test(
  "真实浏览器：单次复杂内容测量对每个节点最多读取一次样式和几何",
  { skip: !process.env.TAVERN_BROWSER_TESTS, timeout: 30000 },
  async () => {
    const result = await measureHeightPerformance();
    for (const sample of result.samples) {
      assert.equal(sample.times.length, 1, "同一轮激活只测量一次");
      assert.ok(sample.styles <= sample.elements, JSON.stringify(sample));
      assert.ok(sample.rects <= sample.elements, JSON.stringify(sample));
      assert.equal(sample.height, 12598);
      assert.equal(sample.reportedHeight, 12600);
    }
    console.log(JSON.stringify(result));
  },
);
