// @ts-nocheck
import fs from "fs";
import path from "path";

/**
 * ⛔ Guard: this node is HAND-WRITTEN (no node-config), so the generator's raw-JSON-fallback
 * check (n8n_module_scripts assertEmittedJsonFieldsStrict) never scans it. Every try block in
 * operations/index.ts that calls JSON.parse must have a catch whose body is a `throw` — no
 * `return []`, `= {}`, `return raw`, `x = raw` or empty catch that turns invalid JSON into a
 * default or ships it raw. (A local check: importing the generator across repos is not a
 * dependency this package can take.)
 */
const OPS = path.join(__dirname, "../../nodes/Observability/operations/index.ts");

/** Blank comments and string/template literal text (same length) so braces and keywords are code-only. */
function mask(src: string): string {
  const out = src.split("");
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); const end = e === -1 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); if (e === -1) throw new Error("unterminated comment"); blank(i, e + 2); i = e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      if (j >= src.length) throw new Error("unterminated literal");
      blank(i + 1, j); i = j + 1; continue; // template ${} contents blanked too: braces stay balanced
    }
    i++;
  }
  return out.join("");
}

function matchBrace(m: string, open: number): number {
  let d = 0;
  for (let k = open; k < m.length; k++) { if (m[k] === "{") d++; else if (m[k] === "}" && --d === 0) return k; }
  return -1;
}

function findJsonDefaultFallbacks(src: string): string[] {
  const m = mask(src);
  const out: string[] = [];
  const re = /\btry\s*\{/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(m))) {
    const open = t.index + t[0].length - 1;
    const close = matchBrace(m, open);
    const line = src.slice(0, t.index).split("\n").length;
    if (close === -1) { out.push(`unbalanced try at :${line}`); continue; }
    if (!/\bJSON\s*\.\s*parse\s*\(/.test(m.slice(open, close))) continue;
    const c = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(m.slice(close + 1));
    if (!c) continue;
    const cOpen = close + 1 + c[0].length - 1;
    const cClose = matchBrace(m, cOpen);
    const body = m.slice(cOpen + 1, cClose).replace(/^[\s;]+/, "");
    if (!/^throw\b/.test(body)) out.push(`:${line} JSON.parse catch does not throw: ${src.slice(t.index, cClose + 1).replace(/\s+/g, " ").slice(0, 100)}`);
  }
  return out;
}

describe("operations/index.ts: no json field falls back to a default or the raw string", () => {
  it("every JSON.parse catch throws", () => {
    const src = fs.readFileSync(OPS, "utf8");
    expect(src).toMatch(/JSON\.parse\(/); // the scan is not vacuous
    expect(findJsonDefaultFallbacks(src)).toEqual([]);
  });

  it("the check bites on every fallback shape (and accepts throws)", () => {
    const bad = [
      "try { value = JSON.parse(value); } catch { return []; }",
      "try { return JSON.parse(raw); } catch { return {}; }",
      "try { metricValues = JSON.parse(metricValues); } catch { metricValues = []; }",
      "try { x = JSON.parse(raw); } catch (e) { x = raw; }",
      "try { x = JSON.parse(raw); } catch { return String(raw); }",
      "try { x = JSON.parse(raw); } catch {}",
      "try { x = JSON.parse(raw); } catch { ; }",
      "try { x = JSON.parse(raw); } catch { /* keep */ }",
      "try {\n  x = JSON.parse(raw);\n} catch (e) {\n  console.warn(e); throw e;\n}", // conservative: the throw must come first (no conditional/default path before it)
    ];
    for (const code of bad) expect(findJsonDefaultFallbacks(`function f() {\n${code}\n}`)).toHaveLength(1);
    const ok = [
      "try { x = JSON.parse(raw); } catch (e) { throw new NodeOperationError(n, `bad ${raw}`, { itemIndex }); }",
      "try { x = JSON.parse(raw); } catch { ; throw e; }",
      "try { doThing(); } catch { return []; }",
      'const s = "try { JSON.parse(raw) } catch { return []; }";',
    ];
    for (const code of ok) expect(findJsonDefaultFallbacks(`function f() {\n${code}\n}`)).toEqual([]);
  });
});
