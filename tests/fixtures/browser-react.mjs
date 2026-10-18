import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export async function browserReactScript() {
  let script = "const modules={};\n";
  for (const [name, file] of [
    ["react", "react.production.js"],
    ["scheduler", "scheduler.production.js"],
    ["react-dom", "react-dom.production.js"],
    ["react-dom/client", "react-dom-client.production.js"],
  ]) {
    let source;
    for (const candidate of [file, file.replace(".js", ".min.js")]) {
      source = await readFile(
        join(dirname(require.resolve(name)), "cjs", candidate),
        "utf8",
      ).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (source) break;
    }
    if (!source && name === "react-dom/client") {
      script += `modules['react-dom/client']={createRoot:modules['react-dom'].createRoot,hydrateRoot:modules['react-dom'].hydrateRoot};\n`;
      continue;
    }
    if (!source) throw new Error(`缺少浏览器 React 测试源码: ${name}`);
    script += `modules[${JSON.stringify(name)}]=(()=>{const module={exports:{}};const exports=module.exports;const require=name=>modules[name];\n${source}\nreturn module.exports;})();\n`;
  }
  return script;
}
