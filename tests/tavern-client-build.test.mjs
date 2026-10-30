import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { assembleTavernClient } from "../bin/build-tavern-client.mjs";

test("完整客户端必须可解析，局部源码测试不能代替入口语法检查", async () => {
  const source = await assembleTavernClient();
  assert.doesNotThrow(
    () => new vm.Script(source, { filename: "tavern-plugin/lib/client.js" }),
  );
});

for (const check of [false, true]) {
  test(`客户端 ${check ? '--check' : 'build'} 拒绝非法语法且保留现有产物`, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tavern-client-build-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    const builder = path.join(root, 'bin/build-tavern-client.mjs')
    const template = path.join(root, 'tavern-plugin/src/client/main.js')
    const output = path.join(root, 'tavern-plugin/lib/client.js')
    for (const directory of ['bin/lib', 'tavern-plugin/src/client', 'tavern-plugin/lib/client-assets']) {
      await mkdir(path.join(root, directory), { recursive: true })
    }
    await copyFile(new URL('../bin/build-tavern-client.mjs', import.meta.url), builder)
    await copyFile(new URL('../bin/lib/client-export-guard.mjs', import.meta.url), path.join(root, 'bin/lib/client-export-guard.mjs'))
    // The copied builder imports its dependencies (acorn) by package name.
    await symlink(new URL('../node_modules', import.meta.url).pathname, path.join(root, 'node_modules'), 'dir')
    await writeFile(path.join(root, 'tavern-plugin/lib/client-assets/tavern.css'), '')
    for (const name of ['logo', 'lockup', 'lockup-dark']) await writeFile(path.join(root, `tavern-plugin/lib/client-assets/${name}.svg`), '<svg/>')
    const valid = 'const fixture = 1;\n'
    const invalid = 'const = 1;\n'
    await writeFile(template, valid)
    const build = args => spawnSync(process.execPath, [builder, ...args], { encoding: 'utf8', timeout: 10000 })
    const initial = build([])
    assert.ifError(initial.error)
    assert.equal(initial.status, 0, initial.stderr)
    let previous = await readFile(output, 'utf8')
    assert.ok(previous.includes(valid))
    await writeFile(template, invalid)
    if (check) {
      // Keep source and output in sync so an outdated-output error cannot pass this test.
      previous = previous.replace(valid, invalid);
      await writeFile(output, previous);
    }
    const result = build(check ? ["--check"] : []);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Unexpected token/);
    assert.equal(await readFile(output, "utf8"), previous);
  });
}

test("故事领域 include 从独立目录装配并拒绝越界读取", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "tavern-story-include-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    "bin/lib",
    "tavern-plugin/src/client",
    "tavern-plugin/lib/client-assets",
    "tavern-plugin/lib/story",
  ])
    await mkdir(path.join(root, directory), { recursive: true });
  await symlink(new URL("../node_modules", import.meta.url), path.join(root, "node_modules"), "dir");
  await copyFile(new URL("../bin/lib/client-export-guard.mjs", import.meta.url), path.join(root, "bin/lib/client-export-guard.mjs"));
  const builder = path.join(root, "bin/build-tavern-client.mjs");
  await copyFile(
    new URL("../bin/build-tavern-client.mjs", import.meta.url),
    builder,
  );
  await writeFile(
    path.join(root, "tavern-plugin/lib/client-assets/tavern.css"),
    "",
  );
  for (const name of ["logo", "lockup", "lockup-dark"])
    await writeFile(
      path.join(root, `tavern-plugin/lib/client-assets/${name}.svg`),
      "<svg/>",
    );
  await writeFile(
    path.join(root, "tavern-plugin/lib/story/rounds.js"),
    "function fold() { return 42; }\nexport { fold };\n",
  );
  const template = path.join(root, "tavern-plugin/src/client/main.js");
  await writeFile(
    template,
    '// @include-story rounds.js\nif (fold() !== 42) throw new Error("story include missing");\n',
  );
  const build = () =>
    spawnSync(process.execPath, [builder], {
      encoding: "utf8",
      timeout: 10000,
    });
  const accepted = build();
  assert.equal(accepted.status, 0, accepted.stderr);
  const output = path.join(root, "tavern-plugin/lib/client.js");
  const previous = await readFile(output, "utf8");
  assert.doesNotThrow(() => new vm.Script(previous).runInNewContext());
  await writeFile(template, "// @include-story ../private.js\n");
  const refused = build();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /include 越界/);
  assert.equal(await readFile(output, "utf8"), previous, "拒绝后保留原产物");
});
