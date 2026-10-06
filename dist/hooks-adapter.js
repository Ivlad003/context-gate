#!/usr/bin/env node

// packages/hooks-adapter/src/main.ts
import { copyFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// packages/core/src/glob.ts
var MAX_EXPANSIONS = 1024;
var cache = /* @__PURE__ */ new Map();
function expandBraces(pattern) {
  const open = findOpenBrace(pattern);
  if (open < 0) return [pattern];
  const close = findMatchingBrace(pattern, open);
  if (close < 0) return [pattern];
  const inner = pattern.slice(open + 1, close);
  const pre = pattern.slice(0, open);
  const post = pattern.slice(close + 1);
  let alts = splitTopLevel(inner);
  if (alts.length === 1) {
    const range = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      const step2 = a <= b ? 1 : -1;
      alts = [];
      for (let i = a; step2 > 0 ? i <= b : i >= b; i += step2) {
        alts.push(String(i));
        if (alts.length > MAX_EXPANSIONS) break;
      }
    } else {
      return expandBraces(post).map((p) => pre + "\\{" + inner + "\\}" + p).slice(0, MAX_EXPANSIONS);
    }
  }
  const out = [];
  const posts = expandBraces(post);
  for (const alt of alts) {
    for (const a of expandBraces(pre + alt)) {
      for (const p of posts) {
        out.push(a + p);
        if (out.length >= MAX_EXPANSIONS) return out;
      }
    }
  }
  return out;
}
function findOpenBrace(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "[") {
      const c = findClassEnd(s, i);
      if (c > 0) {
        i = c;
        continue;
      }
    }
    if (s[i] === "{") return i;
  }
  return -1;
}
function findMatchingBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitTopLevel(s, sep = ",") {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function findClassEnd(s, open) {
  let i = open + 1;
  if (s[i] === "!" || s[i] === "^") i++;
  if (s[i] === "]") i++;
  for (; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === "]") return i;
    if (s[i] === "/") return -1;
  }
  return -1;
}
var RE_SPECIAL = /[.+^$|()[\]{}\\*?]/;
function escapeRe(ch) {
  return RE_SPECIAL.test(ch) ? "\\" + ch : ch;
}
function globToSource(pat, matchBase) {
  if (pat.startsWith("./")) pat = pat.slice(2);
  while (pat.startsWith("/")) pat = pat.slice(1);
  if (pat.endsWith("/")) pat += "**";
  let src = "";
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const ch = pat[i];
    if (ch === "\\") {
      if (i + 1 < n) src += escapeRe(pat[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "/" && pat.slice(i + 1) === "**") {
      src += "(?:/.*)?";
      i = n;
      continue;
    }
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        const atStart = i === 0 || pat[i - 1] === "/";
        let j = i;
        while (pat[j] === "*") j++;
        const atEnd = j === n || pat[j] === "/";
        if (atStart && atEnd) {
          if (j === n) {
            src += ".*";
            i = j;
            continue;
          }
          src += "(?:.*/)?";
          i = j + 1;
          continue;
        }
        src += "[^/]*";
        i = j;
        continue;
      }
      src += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      src += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      const end = findClassEnd(pat, i);
      if (end < 0) {
        src += "\\[";
        i++;
        continue;
      }
      let body = pat.slice(i + 1, end);
      let neg = false;
      if (body[0] === "!" || body[0] === "^") {
        neg = true;
        body = body.slice(1);
      }
      let cls = "";
      for (let k = 0; k < body.length; k++) {
        const c = body[k];
        if (c === "\\" && k + 1 < body.length) {
          cls += "\\" + body[k + 1];
          k++;
          continue;
        }
        if (c === "^" || c === "\\" || c === "[" || c === "]") cls += "\\" + c;
        else cls += c;
      }
      src += neg ? `[^/${cls}]` : `[${cls}]`;
      i = end + 1;
      continue;
    }
    src += escapeRe(ch);
    i++;
  }
  if (matchBase && !pat.includes("/")) src = "(?:.*/)?" + src;
  return src;
}
function globToRegExp(pattern, opts = {}) {
  const key = `${opts.nocase ? "i" : ""}${opts.matchBase ? "b" : ""}\0${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const alts = expandBraces(pattern).map((p) => globToSource(p, !!opts.matchBase));
  const re = new RegExp(`^(?:${alts.join("|")})$`, opts.nocase ? "i" : "");
  if (cache.size > 5e3) cache.clear();
  cache.set(key, re);
  return re;
}
function splitNegation(pattern) {
  let negated = false;
  let p = pattern;
  while (p.startsWith("!")) {
    negated = !negated;
    p = p.slice(1);
  }
  return { negated, pattern: p };
}
function compileGlob(pattern, opts = {}) {
  const { negated, pattern: p } = splitNegation(pattern.trim());
  const re = globToRegExp(p, opts);
  return negated ? (path) => !re.test(path) : (path) => re.test(path);
}
function matchAny(path, globs, negGlobs = [], opts = {}) {
  let hit = false;
  const negs = [...negGlobs];
  for (const g of globs) {
    const { negated, pattern } = splitNegation(g.trim());
    if (negated) {
      negs.push(pattern);
      continue;
    }
    if (!hit && pattern && globToRegExp(pattern, opts).test(path)) hit = true;
  }
  if (!hit) return false;
  for (const g of negs) if (g && globToRegExp(g, opts).test(path)) return false;
  return true;
}
var DRIVE = /^[A-Za-z]:(?:\/|$)/;
function detectWindows(cwdOrRoot, osEnv) {
  if (osEnv && /windows/i.test(osEnv)) return true;
  return !!cwdOrRoot && (DRIVE.test(cwdOrRoot.replace(/\\/g, "/")) || cwdOrRoot.startsWith("\\\\"));
}
function collapse(p) {
  const abs = p.startsWith("/");
  const parts = p.split("/");
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const seg = parts[k];
    if (seg === "" || seg === ".") {
      if (k === 0 && abs) out.push("");
      continue;
    }
    if (seg === ".." && out.length && out[out.length - 1] !== ".." && !(out.length === 1 && (out[0] === "" || DRIVE.test(out[0] + "/")))) {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (abs && out.length === 1 && out[0] === "") return "/";
  return out.join("/");
}
function normalizePath(path, root, opts = {}) {
  let s = path.replace(/\\/g, "/");
  let r = root.replace(/\\/g, "/");
  const windows = opts.windows ?? (detectWindows(r) || DRIVE.test(s));
  s = collapse(s);
  r = collapse(r);
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  const isAbs = s.startsWith("/") || DRIVE.test(s);
  if (!isAbs) return s;
  const cmpS = windows ? s.toLowerCase() : s;
  const cmpR = windows ? r.toLowerCase() : r;
  if (cmpS === cmpR) return "";
  const prefix = cmpR.endsWith("/") ? cmpR : cmpR + "/";
  if (r && cmpS.startsWith(prefix)) return s.slice(prefix.length);
  return s;
}

// packages/core/src/codes.ts
var PROVIDER_HINT = "\u0426\u044F \u043B\u043E\u0433\u0456\u043A\u0430 \u043C\u0430\u0454 \u0436\u0438\u0442\u0438 \u0432 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0456 (`module`-\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u0430\u0431\u043E `Run`).";
var CODES = {
  // ── G0xx: structure (.mdc and prompt files) ──
  G001: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0430 \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430 \u043F\u0440\u043E\u043C\u043F\u0442\u0443", explain: "\u041F\u0440\u043E\u043C\u043F\u0442 \u043F\u043E\u0440\u0443\u0448\u0443\u0454 \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0443 DSL: \u043D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0434\u0438\u0440\u0435\u043A\u0442\u0438\u0432\u0430, `<Section>` \u043F\u043E\u0437\u0430 `<Prompt>` \u0430\u0431\u043E \u0432\u043A\u043B\u0430\u0434\u0435\u043D\u0430, `<Else>` \u043F\u043E\u0437\u0430 `<If>`, \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0456\u0439 \u043E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u0438\u0439 \u043F\u0440\u043E\u043F, \u0434\u0432\u0430 \u0444\u0430\u0439\u043B\u0438 \u0437 \u043E\u0434\u043D\u0438\u043C id, \u043F\u043E\u0448\u043A\u043E\u0434\u0436\u0435\u043D\u0438\u0439 `.compiled/<id>.json`.", hint: "\u041F\u043E\u0432\u0456\u0434\u043E\u043C\u043B\u0435\u043D\u043D\u044F \u043D\u0430\u0437\u0438\u0432\u0430\u0454 \u0435\u043B\u0435\u043C\u0435\u043D\u0442 \u0456 \u043C\u0456\u0441\u0446\u0435; `context-gate build` \u043F\u043E\u043A\u0430\u0437\u0443\u0454 \u0432\u0441\u0456." },
  G002: { severity: "error", title: "\u041D\u0435\u0437\u0430\u043A\u0440\u0438\u0442\u0438\u0439 \u0431\u043B\u043E\u043A", explain: "\u0411\u043B\u043E\u043A `@if`/`@each`/`@run`/\u2026 \u043D\u0435 \u043C\u0430\u0454 `@end`. \u0419\u043E\u0433\u043E \u0437\u0430\u043A\u0440\u0438\u0442\u043E \u0432 \u043A\u0456\u043D\u0446\u0456 \u0444\u0430\u0439\u043B\u0443.", hint: "\u0414\u043E\u0434\u0430\u0439 `@end`." },
  G003: { severity: "error", title: "\u0417\u0430\u0439\u0432\u0438\u0439 @end \u0430\u0431\u043E @else", explain: "`@end` \u0431\u0435\u0437 \u0432\u0456\u0434\u043A\u0440\u0438\u0442\u043E\u0433\u043E \u0431\u043B\u043E\u043A\u0443, \u0430\u0431\u043E `@else`/`@elif` \u0431\u0435\u0437 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u043D\u043E\u0433\u043E `@if`." },
  G004: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 \u0441\u0438\u043D\u0442\u0430\u043A\u0441\u0438\u0441 \u0434\u0438\u0440\u0435\u043A\u0442\u0438\u0432\u0438", explain: "\u0414\u0438\u0440\u0435\u043A\u0442\u0438\u0432\u0430 Markdown-DSL \u043C\u0430\u0454 \u043D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0443 \u0444\u043E\u0440\u043C\u0443 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432 (\u043D\u0430\u043F\u0440\u0438\u043A\u043B\u0430\u0434 `@each x in <\u0432\u0438\u0440\u0430\u0437>`, `@call ns.fn() as x`).", hint: "\u041F\u043E\u0432\u0456\u0434\u043E\u043C\u043B\u0435\u043D\u043D\u044F \u043F\u043E\u043A\u0430\u0437\u0443\u0454 \u043E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u0443 \u0444\u043E\u0440\u043C\u0443." },
  G005: { severity: "error", title: "@break/@continue \u043F\u043E\u0437\u0430 \u0446\u0438\u043A\u043B\u043E\u043C", explain: "`@break` \u0456 `@continue` \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0456 \u043B\u0438\u0448\u0435 \u0432\u0441\u0435\u0440\u0435\u0434\u0438\u043D\u0456 `@each` \u0430\u0431\u043E `@repeat`." },
  G006: { severity: "warning", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 frontmatter \u043F\u0440\u043E\u043C\u043F\u0442\u0443", explain: "Frontmatter Markdown-\u043F\u0440\u043E\u043C\u043F\u0442\u0443 \u043D\u0435 \u0437\u0430\u043A\u0440\u0438\u0442\u043E, \u043C\u0430\u0454 \u043D\u0435\u0440\u043E\u0437\u043F\u0456\u0437\u043D\u0430\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A \u0430\u0431\u043E \u043D\u0435\u0432\u0456\u0440\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F (`scope`, `budget`)." },
  G010: { severity: "warning", title: "\u041D\u0435\u0437\u0430\u043A\u0440\u0438\u0442\u0438\u0439 frontmatter", explain: "\u0424\u0430\u0439\u043B \u043F\u043E\u0447\u0438\u043D\u0430\u0454\u0442\u044C\u0441\u044F \u0437 `---`, \u0430\u043B\u0435 \u0437\u0430\u043A\u0440\u0438\u0432\u0430\u043B\u044C\u043D\u043E\u0433\u043E `---` \u043D\u0435\u043C\u0430\u0454. \u0412\u0435\u0441\u044C \u0444\u0430\u0439\u043B \u0432\u0432\u0430\u0436\u0430\u0454\u0442\u044C\u0441\u044F \u0442\u0456\u043B\u043E\u043C \u043F\u0440\u0430\u0432\u0438\u043B\u0430 (\u0442\u0438\u043F Manual).", hint: "\u0414\u043E\u0434\u0430\u0439 \u0440\u044F\u0434\u043E\u043A `---` \u043F\u0456\u0441\u043B\u044F \u043F\u043E\u043B\u0456\u0432 frontmatter." },
  G011: { severity: "info", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0435 \u043F\u043E\u043B\u0435 frontmatter", explain: "\u0423 frontmatter `.mdc` \u0454 \u043F\u043E\u043B\u0435, \u044F\u043A\u0435 Cursor \u043D\u0435 \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0454 (\u0432\u0456\u0434\u043E\u043C\u0456: description, globs, alwaysApply). \u041F\u043E\u043B\u0435 \u0456\u0433\u043D\u043E\u0440\u0443\u0454\u0442\u044C\u0441\u044F." },
  G012: { severity: "warning", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F alwaysApply", explain: "`alwaysApply` \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 `true` \u0430\u0431\u043E `false`. \u0406\u043D\u0448\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0442\u0440\u0430\u043A\u0442\u0443\u0454\u0442\u044C\u0441\u044F \u044F\u043A `false`." },
  G013: { severity: "warning", title: "\u041F\u043E\u0440\u043E\u0436\u043D\u0456\u0439 glob", explain: "\u0421\u043F\u0438\u0441\u043E\u043A `globs` \u043C\u0456\u0441\u0442\u0438\u0442\u044C \u043F\u043E\u0440\u043E\u0436\u043D\u0456\u0439 \u0435\u043B\u0435\u043C\u0435\u043D\u0442 (\u0437\u0430\u0439\u0432\u0430 \u043A\u043E\u043C\u0430 \u0430\u0431\u043E \u043F\u043E\u0440\u043E\u0436\u043D\u0456\u0439 \u0440\u044F\u0434\u043E\u043A). \u0419\u043E\u0433\u043E \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E." },
  G014: { severity: "warning", title: "\u0420\u044F\u0434\u043E\u043A frontmatter \u043D\u0435 \u0440\u043E\u0437\u043F\u0456\u0437\u043D\u0430\u043D\u043E", explain: "\u0420\u044F\u0434\u043E\u043A \u043D\u0435 \u043C\u0430\u0454 \u0444\u043E\u0440\u043C\u0438 `\u043A\u043B\u044E\u0447: \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F` \u0456 \u043D\u0435 \u0454 \u0435\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u043C \u0441\u043F\u0438\u0441\u043A\u0443. \u0419\u043E\u0433\u043E \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E." },
  G015: { severity: "warning", title: "\u041F\u0440\u0430\u0432\u0438\u043B\u043E \u0431\u0435\u0437 \u0443\u043C\u043E\u0432", explain: "\u0404 `globs`, \u0430\u043B\u0435 \u0432\u0441\u0456 \u0432\u043E\u043D\u0438 \u043D\u0435\u0433\u0430\u0442\u0438\u0432\u043D\u0456 (`!pattern`): \u043F\u0440\u0430\u0432\u0438\u043B\u043E \u043D\u0456\u043A\u043E\u043B\u0438 \u043D\u0435 \u0441\u043F\u0440\u0430\u0446\u044E\u0454 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E.", hint: "\u0414\u043E\u0434\u0430\u0439 \u0445\u043E\u0447\u0430 \u0431 \u043E\u0434\u0438\u043D \u043F\u043E\u0437\u0438\u0442\u0438\u0432\u043D\u0438\u0439 glob." },
  G020: { severity: "warning", title: "after: \u0441\u0435\u043A\u0446\u0456\u044E \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E", explain: "`after=` \u043F\u043E\u0441\u0438\u043B\u0430\u0454\u0442\u044C\u0441\u044F \u043D\u0430 \u0441\u0435\u043A\u0446\u0456\u044E, \u044F\u043A\u043E\u0457 \u043D\u0435\u043C\u0430\u0454 \u0432 \u0442\u043E\u043C\u0443 \u0441\u0430\u043C\u043E\u043C\u0443 scope. \u0421\u0435\u043A\u0446\u0456\u044E \u043B\u0438\u0448\u0435\u043D\u043E \u043D\u0430 \u043C\u0456\u0441\u0446\u0456." },
  G021: { severity: "warning", title: "\u0426\u0438\u043A\u043B \u0443 after", explain: "\u041B\u0430\u043D\u0446\u044E\u0436\u043E\u043A `after=` \u0443\u0442\u0432\u043E\u0440\u044E\u0454 \u0446\u0438\u043A\u043B. \u0421\u0435\u043A\u0446\u0456\u0457 \u043B\u0438\u0448\u0435\u043D\u043E \u0432 \u043F\u043E\u0440\u044F\u0434\u043A\u0443 \u0434\u0436\u0435\u0440\u0435\u043B\u0430." },
  // ── G1xx: expressions and language limits ──
  G101: { severity: "error", title: "\u0421\u0438\u043D\u0442\u0430\u043A\u0441\u0438\u0447\u043D\u0430 \u043F\u043E\u043C\u0438\u043B\u043A\u0430 \u0432\u0438\u0440\u0430\u0437\u0443", explain: "\u0412\u0438\u0440\u0430\u0437 \u043D\u0435 \u043F\u0430\u0440\u0441\u0438\u0442\u044C\u0441\u044F: \u043D\u0435\u043E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u0438\u0439 \u0441\u0438\u043C\u0432\u043E\u043B, \u043F\u043E\u0440\u043E\u0436\u043D\u0456\u0439 \u0432\u0438\u0440\u0430\u0437 \u0430\u0431\u043E \u043A\u043E\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0456\u044F \u043F\u043E\u0437\u0430 \u0433\u0440\u0430\u043C\u0430\u0442\u0438\u043A\u043E\u044E." },
  G102: { severity: "error", title: "\u041D\u0435\u0437\u0430\u043A\u0440\u0438\u0442\u0438\u0439 \u0440\u044F\u0434\u043E\u043A", explain: "\u0420\u044F\u0434\u043A\u043E\u0432\u0438\u0439 \u043B\u0456\u0442\u0435\u0440\u0430\u043B \u0443 \u0432\u0438\u0440\u0430\u0437\u0456 \u043D\u0435 \u043C\u0430\u0454 \u0437\u0430\u043A\u0440\u0438\u0432\u0430\u043B\u044C\u043D\u043E\u0457 \u043B\u0430\u043F\u043A\u0438." },
  G103: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0444\u0443\u043D\u043A\u0446\u0456\u044F", explain: "\u0412\u0438\u043A\u043B\u0438\u043A \u0444\u0443\u043D\u043A\u0446\u0456\u0457, \u044F\u043A\u043E\u0457 \u043D\u0435\u043C\u0430\u0454 \u0441\u0435\u0440\u0435\u0434 \u0432\u0431\u0443\u0434\u043E\u0432\u0430\u043D\u0438\u0445. \u0420\u0435\u0448\u0442\u0430 \u0444\u0443\u043D\u043A\u0446\u0456\u0439 \u2014 \u0447\u0435\u0440\u0435\u0437 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 `ns.fn(...)`." },
  G104: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u0444\u0456\u043B\u044C\u0442\u0440", explain: "\u0424\u0456\u043B\u044C\u0442\u0440 \u043F\u0456\u0441\u043B\u044F `|` \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0443 \u043F\u0435\u0440\u0435\u043B\u0456\u043A \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0438\u0445." },
  G105: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0430 \u043A\u0456\u043B\u044C\u043A\u0456\u0441\u0442\u044C \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432", explain: "\u041C\u0435\u0442\u043E\u0434 \u0447\u0438 \u0444\u0443\u043D\u043A\u0446\u0456\u044F \u043E\u0442\u0440\u0438\u043C\u0430\u043B\u0438 \u043D\u0435 \u0442\u0443 \u043A\u0456\u043B\u044C\u043A\u0456\u0441\u0442\u044C \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432." },
  G106: { severity: "warning", title: "\u0414\u0456\u043B\u0435\u043D\u043D\u044F \u043D\u0430 \u043D\u0443\u043B\u044C", explain: "\u0414\u0456\u043B\u0435\u043D\u043D\u044F \u043D\u0430 \u043D\u0443\u043B\u044C \u0443 \u0432\u0438\u0440\u0430\u0437\u0456; \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 `null`." },
  G107: { severity: "warning", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 \u0440\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u0438\u0439 \u0432\u0438\u0440\u0430\u0437", explain: "\u0420\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u0438\u0439 \u0432\u0438\u0440\u0430\u0437 \u043D\u0435 \u043A\u043E\u043C\u043F\u0456\u043B\u044E\u0454\u0442\u044C\u0441\u044F \u0430\u0431\u043E \u0434\u043E\u0432\u0448\u0438\u0439 \u0437\u0430 500 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432; \u0437\u0431\u0456\u0433 \u0432\u0432\u0430\u0436\u0430\u0454\u0442\u044C\u0441\u044F \u0445\u0438\u0431\u043D\u0438\u043C." },
  G108: { severity: "error", title: "\u0406\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438 \u043D\u0435 \u043F\u0456\u0434\u0442\u0440\u0438\u043C\u0443\u044E\u0442\u044C\u0441\u044F", explain: "\u0424\u0443\u043D\u043A\u0446\u0456\u044F \u0430\u0431\u043E \u0444\u0456\u043B\u044C\u0442\u0440 \u043D\u0435 \u043F\u0440\u0438\u0439\u043C\u0430\u0454 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432 `k=v`." },
  G120: { severity: "warning", title: "@each \u043F\u043E \u043D\u0435-\u0441\u043F\u0438\u0441\u043A\u0443", explain: "\u0417\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0434\u043B\u044F `@each`/`<Each of>` \u043D\u0435 \u0454 \u0441\u043F\u0438\u0441\u043A\u043E\u043C; \u0431\u043B\u043E\u043A \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E." },
  G151: { severity: "error", title: "\u0420\u0435\u043A\u0443\u0440\u0441\u0456\u044F \u0444\u0443\u043D\u043A\u0446\u0456\u0457", explain: "\u0424\u0443\u043D\u043A\u0446\u0456\u044F (`@fn` \u0430\u0431\u043E \u0432\u043B\u0430\u0441\u043D\u0438\u0439 \u043A\u043E\u043C\u043F\u043E\u043D\u0435\u043D\u0442) \u0432\u0438\u043A\u043B\u0438\u043A\u0430\u0454 \u0441\u0430\u043C\u0430 \u0441\u0435\u0431\u0435 \u043F\u0440\u044F\u043C\u043E \u0447\u0438 \u0447\u0435\u0440\u0435\u0437 \u0456\u043D\u0448\u0443 \u0444\u0443\u043D\u043A\u0446\u0456\u044E. DSL \u0442\u043E\u0442\u0430\u043B\u044C\u043D\u0430: \u0440\u0435\u043A\u0443\u0440\u0441\u0456\u044F \u0437\u0430\u0431\u043E\u0440\u043E\u043D\u0435\u043D\u0430.", hint: PROVIDER_HINT },
  G152: { severity: "error", title: "\u0426\u0438\u043A\u043B \u0431\u0435\u0437 \u043C\u0435\u0436\u0456", explain: "`@each` \xAB\u043F\u043E\u043A\u0438\xBB \u0431\u0435\u0437 \u043C\u0435\u0436\u0456, \u0430\u0431\u043E `@repeat` \u043F\u043E\u043D\u0430\u0434 1 000 \u0456\u0442\u0435\u0440\u0430\u0446\u0456\u0439 \u0447\u0438 \u0437 \u043C\u0435\u0436\u0435\u044E, \u043D\u0435\u0432\u0456\u0434\u043E\u043C\u043E\u044E \u0434\u043E \u0437\u0430\u043F\u0443\u0441\u043A\u0443.", hint: "\u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u043F\u043E\u0432\u0435\u0440\u0442\u0430\u0454 \u0433\u043E\u0442\u043E\u0432\u0438\u0439 \u0441\u043F\u0438\u0441\u043E\u043A. " + PROVIDER_HINT },
  G153: { severity: "error", title: "\u041F\u0435\u0440\u0435\u0432\u0438\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u043A\u043E\u043D\u0441\u0442\u0430\u043D\u0442\u0438", explain: "\u0406\u043C'\u044F, \u043F\u0440\u0438\u0432'\u044F\u0437\u0430\u043D\u0435 \u0447\u0435\u0440\u0435\u0437 `@let`, \u043F\u0435\u0440\u0435\u0432\u0438\u0437\u043D\u0430\u0447\u0435\u043D\u043E \u043F\u0456\u0437\u043D\u0456\u0448\u0435 \u0432 \u0442\u0456\u0439 \u0441\u0430\u043C\u0456\u0439 \u0441\u0435\u043A\u0446\u0456\u0457.", hint: "`@let` \u0437 \u043D\u043E\u0432\u0438\u043C \u0456\u043C\u0435\u043D\u0435\u043C \u0430\u0431\u043E \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440. " + PROVIDER_HINT },
  G154: { severity: "error", title: "\u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u043D\u0435 \u043D\u0430 \u043F\u043E\u0447\u0430\u0442\u043A\u0443 pipe", explain: "\u0412\u0438\u0440\u0430\u0437 \u0456\u0437 `@run` \u0430\u0431\u043E \u0432\u0438\u043A\u043B\u0438\u043A\u043E\u043C \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430 \u0441\u0442\u043E\u0457\u0442\u044C \u043D\u0435 \u043D\u0430 \u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u043B\u0430\u043D\u0446\u044E\u0436\u043A\u0430 `|`. \u0424\u0456\u043B\u044C\u0442\u0440\u0438 \u2014 \u043B\u0438\u0448\u0435 \u0447\u0438\u0441\u0442\u0456 \u0444\u0443\u043D\u043A\u0446\u0456\u0457.", hint: "\u041F\u0435\u0440\u0435\u043D\u0435\u0441\u0438 \u0432\u0438\u043A\u043B\u0438\u043A \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430 \u043D\u0430 \u043F\u043E\u0447\u0430\u0442\u043E\u043A. " + PROVIDER_HINT },
  G155: { severity: "error", title: "\u041F\u0435\u0440\u0435\u0432\u0438\u0449\u0435\u043D\u043E \u043B\u0456\u043C\u0456\u0442 \u043A\u0440\u043E\u043A\u0456\u0432", explain: "\u0406\u043D\u0442\u0435\u0440\u043F\u0440\u0435\u0442\u0430\u0442\u043E\u0440 \u0432\u0438\u043A\u043E\u043D\u0430\u0432 \u043F\u043E\u043D\u0430\u0434 10 000 \u043A\u0440\u043E\u043A\u0456\u0432 \u0443 \u0441\u0435\u043A\u0446\u0456\u0457. \u0426\u0435 \u0432\u0432\u0430\u0436\u0430\u0454\u0442\u044C\u0441\u044F \u043F\u043E\u043C\u0438\u043B\u043A\u043E\u044E \u043A\u043E\u043D\u0444\u0456\u0433\u0443\u0440\u0430\u0446\u0456\u0457.", hint: PROVIDER_HINT },
  G156: { severity: "error", title: "\u0417\u0430\u0432\u0435\u043B\u0438\u043A\u0430 \u0433\u043B\u0438\u0431\u0438\u043D\u0430 \u0432\u043A\u043B\u0430\u0434\u0435\u043D\u043D\u044F", explain: "\u0412\u043A\u043B\u0430\u0434\u0435\u043D\u043D\u044F `@if` \u043F\u043E\u043D\u0430\u0434 3 \u0440\u0456\u0432\u043D\u0456 \u0430\u0431\u043E `@each` \u043F\u043E\u043D\u0430\u0434 2.", hint: "\u0420\u043E\u0437\u0431\u0438\u0439 \u0441\u0435\u043A\u0446\u0456\u044E \u043D\u0430 \u043A\u0456\u043B\u044C\u043A\u0430." },
  G157: { severity: "error", title: "\u0414\u043E\u0441\u0442\u0443\u043F \u0434\u043E \u0444\u0430\u0439\u043B\u0456\u0432, \u043F\u0440\u043E\u0446\u0435\u0441\u0456\u0432 \u0447\u0438 \u043C\u0435\u0440\u0435\u0436\u0456 \u0437 \u0432\u0438\u0440\u0430\u0437\u0443", explain: "\u0412\u0438\u0440\u0430\u0437\u0438 DSL \u043D\u0435 \u043C\u0430\u044E\u0442\u044C \u043F\u043E\u0431\u0456\u0447\u043D\u0438\u0445 \u0435\u0444\u0435\u043A\u0442\u0456\u0432 \u0456 \u043D\u0435 \u0447\u0438\u0442\u0430\u044E\u0442\u044C \u0444\u0430\u0439\u043B\u0438.", hint: "\u0412\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0439 `@run` \u0430\u0431\u043E \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440." },
  G158: { severity: "error", title: "\u0424\u0443\u043D\u043A\u0446\u0456\u0457 \u043D\u0435\u043C\u0430\u0454 \u0432 \u043C\u043E\u0434\u0443\u043B\u0456", explain: "`Call` \u043F\u043E\u0441\u0438\u043B\u0430\u0454\u0442\u044C\u0441\u044F \u043D\u0430 \u0444\u0443\u043D\u043A\u0446\u0456\u044E, \u044F\u043A\u0443 \u043C\u043E\u0434\u0443\u043B\u044C \u0456\u0437 `Use` \u043D\u0435 \u0435\u043A\u0441\u043F\u043E\u0440\u0442\u0443\u0454. \u041F\u043E\u043C\u0438\u043B\u043A\u0430 \u0432\u0430\u043B\u0456\u0434\u0430\u0446\u0456\u0457 \u0449\u0435 \u0434\u043E \u0440\u0435\u043D\u0434\u0435\u0440\u0430.", hint: "\u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u0456\u043C'\u044F \u0444\u0443\u043D\u043A\u0446\u0456\u0457 \u0430\u0431\u043E `functions` \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430." },
  G159: { severity: "error", title: "\u0426\u0438\u043A\u043B \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u044C", explain: "`@include` / `@section` \u0443\u0442\u0432\u043E\u0440\u044E\u044E\u0442\u044C \u0446\u0438\u043A\u043B \u0430\u0431\u043E \u0433\u043B\u0438\u0431\u0438\u043D\u0443 \u043F\u043E\u043D\u0430\u0434 3.", hint: "\u041F\u0440\u0438\u0431\u0435\u0440\u0438 \u0432\u0437\u0430\u0454\u043C\u043D\u0456 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F." },
  G160: { severity: "error", title: "\u0421\u0438\u043D\u0442\u0430\u043A\u0441\u0438\u0441 \u043F\u043E\u0437\u0430 \u043F\u0456\u0434\u043C\u043D\u043E\u0436\u0438\u043D\u043E\u044E", explain: "TS-\u0442\u0440\u0430\u043D\u0441\u0444\u043E\u0440\u043C\u0435\u0440 (\u0440\u0456\u0432\u0435\u043D\u044C 2) \u043D\u0435 \u043C\u043E\u0436\u0435 \u043F\u0435\u0440\u0435\u0442\u0432\u043E\u0440\u0438\u0442\u0438 \u0446\u0435\u0439 \u0432\u0438\u0440\u0430\u0437 \u0443 \u0432\u0443\u0437\u043E\u043B AST: \u043A\u043E\u043D\u0441\u0442\u0440\u0443\u043A\u0446\u0456\u044F \u043F\u043E\u0437\u0430 \u0434\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u043E\u044E \u043F\u0456\u0434\u043C\u043D\u043E\u0436\u0438\u043D\u043E\u044E.", hint: "\u0417\u0430\u043F\u0438\u0448\u0438 \u0432\u0438\u0440\u0430\u0437 \u0440\u044F\u0434\u043A\u043E\u043C (\u0440\u0456\u0432\u0435\u043D\u044C 1) \u0430\u0431\u043E \u0432\u0438\u043D\u0435\u0441\u0438 \u0432 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440." },
  G161: { severity: "error", title: "\u0414\u0443\u0431\u043B\u044C \u0441\u0435\u043A\u0446\u0456\u0457", explain: "`Section` \u0437 \u0442\u0438\u043C \u0441\u0430\u043C\u0438\u043C `id` \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u043E \u0443 \u0434\u0432\u043E\u0445 \u0444\u0430\u0439\u043B\u0430\u0445.", hint: "\u041F\u0435\u0440\u0435\u0439\u043C\u0435\u043D\u0443\u0439 \u043E\u0434\u043D\u0443 \u0437 \u0441\u0435\u043A\u0446\u0456\u0439." },
  G162: { severity: "error", title: "\u0417\u0430\u0432\u0435\u043B\u0438\u043A\u0438\u0439 .compiled", explain: "\u0417\u0456\u0431\u0440\u0430\u043D\u0438\u0439 `.compiled/<id>.json` \u0431\u0456\u043B\u044C\u0448\u0438\u0439 \u0437\u0430 2 \u041C\u0411.", hint: '\u0412\u0438\u043D\u0435\u0441\u0438 \u0434\u0430\u043D\u0456 \u0432 `Include mode="lazy"` \u0430\u0431\u043E \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440.' },
  G163: { severity: "error", title: "Run \u0431\u0435\u0437 cache \u0443 static", explain: "`@run` / `<Run>` \u0431\u0435\u0437 `cache` \u0443 \u0441\u0435\u043A\u0446\u0456\u0457 `scope: static`. Static \u0440\u0435\u043D\u0434\u0435\u0440\u0438\u0442\u044C\u0441\u044F \u043E\u0434\u0438\u043D \u0440\u0430\u0437 \u0456 \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u0441\u0442\u0430\u0431\u0456\u043B\u044C\u043D\u043E\u044E.", hint: '\u0414\u043E\u0434\u0430\u0439 `cache="5m"` \u0430\u0431\u043E \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0438 \u0441\u0435\u043A\u0446\u0456\u044E \u0443 `volatile`.' },
  G164: { severity: "error", title: "\u041F\u043E\u043C\u0438\u043B\u043A\u0430 \u0437\u0431\u0456\u0440\u043A\u0438 \u043F\u0440\u043E\u043C\u043F\u0442\u0443", explain: "esbuild \u043D\u0435 \u0437\u043C\u0456\u0433 \u0437\u0456\u0431\u0440\u0430\u0442\u0438 `.prompt.tsx`, \u0430\u0431\u043E \u043C\u043E\u0434\u0443\u043B\u044C \u0443\u043F\u0430\u0432 \u043F\u0456\u0434 \u0447\u0430\u0441 \u0432\u0438\u043A\u043E\u043D\u0430\u043D\u043D\u044F \u043D\u0430 \u0437\u0431\u0456\u0440\u0446\u0456.", hint: "\u041F\u043E\u0432\u0456\u0434\u043E\u043C\u043B\u0435\u043D\u043D\u044F \u043C\u0456\u0441\u0442\u0438\u0442\u044C \u043F\u043E\u043C\u0438\u043B\u043A\u0443 esbuild \u0430\u0431\u043E stderr \u043C\u043E\u0434\u0443\u043B\u044F." },
  G170: { severity: "warning", title: "\u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u0431\u0435\u0437 \u0441\u0445\u0435\u043C\u0438", explain: "\u0414\u043E\u0441\u0442\u0443\u043F \u0434\u043E \u043F\u043E\u043B\u044F \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u0443 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430, \u044F\u043A\u0438\u0439 \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0441\u0438\u0432 `schema`: \u0442\u0438\u043F `unknown`.", hint: "\u0414\u043E\u0434\u0430\u0439 `schema` \u0430\u0431\u043E \u0437\u0433\u0435\u043D\u0435\u0440\u0443\u0439 \u0447\u0435\u0440\u043D\u0435\u0442\u043A\u0443: `context-gate schema infer <provider>`." },
  G171: { severity: "warning", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0437\u043C\u0456\u043D\u043D\u0430", explain: "\u0412\u0438\u0440\u0430\u0437 \u043F\u043E\u0441\u0438\u043B\u0430\u0454\u0442\u044C\u0441\u044F \u043D\u0430 \u0456\u043C'\u044F, \u044F\u043A\u043E\u0433\u043E \u043D\u0435\u043C\u0430\u0454 \u043D\u0456 \u0441\u0435\u0440\u0435\u0434 \u043A\u043E\u0440\u0435\u043D\u0456\u0432 \u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442\u0443, \u043D\u0456 \u0441\u0435\u0440\u0435\u0434 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0438\u0445 \u043F\u0440\u0438\u0432'\u044F\u0437\u043E\u043A.", hint: "\u041A\u043E\u0440\u0435\u043D\u0456 \u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442\u0443: gate, git, fs, cursor, session, ctx, budgets, args, data \u0456 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0438 \u0437 gate.json; \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0456 \u2014 \u0437 as=/name=." },
  G172: { severity: "warning", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0435 \u043F\u043E\u043B\u0435", explain: "\u041F\u043E\u043B\u0435 \u043D\u0435 \u0456\u0441\u043D\u0443\u0454 \u0443 \u0432\u0456\u0434\u043E\u043C\u0456\u0439 \u0444\u043E\u0440\u043C\u0456 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F (\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u0437\u0456 `schema`, \u043A\u043E\u0440\u0456\u043D\u044C \u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442\u0443), \u0430\u0431\u043E \u0444\u0443\u043D\u043A\u0446\u0456\u044E \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E \u0431\u0435\u0437 \u0432\u0438\u043A\u043B\u0438\u043A\u0443.", hint: "\u041F\u0435\u0440\u0435\u0432\u0456\u0440 \u043D\u0430\u0437\u0432\u0443 \u043F\u043E\u043B\u044F \u0430\u0431\u043E `schema` \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430." },
  G180: { severity: "warning", title: "\u0417\u0430\u0441\u0442\u0430\u0440\u0456\u043B\u0438\u0439 \u043C\u0435\u0445\u0430\u043D\u0456\u0437\u043C", explain: "\u0412\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E \u043D\u0435\u043A\u043E\u043D\u043E\u043D\u0456\u0447\u043D\u0438\u0439 \u0437\u0430\u043F\u0438\u0441 (`Lazy`, \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 `scripts`, `store=` \u043D\u0430 `Run`, `tiers[*].preload` \u043F\u043E\u0437\u0430 \u0441\u0435\u043A\u0446\u0456\u0454\u044E `preload`). \u0412\u0456\u043D \u043F\u0440\u0438\u0439\u043C\u0430\u0454\u0442\u044C\u0441\u044F \u0434\u043E \u0432\u0435\u0440\u0441\u0456\u0457 1.0.", hint: "\u041F\u0435\u0440\u0435\u0439\u0434\u0438 \u043D\u0430 `Include mode=\u2026`, `Use`+`Call`, `Store`." },
  // ── G2xx: run / lazy / providers ──
  G201: { severity: "warning", title: "\u0411\u0456\u043D\u0430\u0440\u043D\u0438\u043A \u043F\u043E\u0437\u0430 \u0431\u0456\u043B\u0438\u043C \u0441\u043F\u0438\u0441\u043A\u043E\u043C", explain: "\u0412\u0438\u043A\u043E\u043D\u0430\u0432\u0435\u0446\u044C, shim \u0430\u0431\u043E cli-\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0454 \u043F\u0440\u043E\u0433\u0440\u0430\u043C\u0443, \u044F\u043A\u043E\u0457 \u043D\u0435\u043C\u0430\u0454 \u0432 `allowBinaries` (\u0437\u0430 \u0437\u0430\u043C\u043E\u0432\u0447\u0443\u0432\u0430\u043D\u043D\u044F\u043C bash, sh, node, python3, python, deno, git; ~/.claude/context-gate.json). `allowBinaries` \u0443 gate.json \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0456\u044E \u0441\u043F\u0438\u0441\u043E\u043A \u043B\u0438\u0448\u0435 \u0437\u0432\u0443\u0436\u0443\u0454.", hint: "\u0414\u043E\u0434\u0430\u0439 \u0431\u0456\u043D\u0430\u0440\u043D\u0438\u043A \u0443 allowBinaries \u043A\u043E\u0440\u0438\u0441\u0442\u0443\u0432\u0430\u0446\u044C\u043A\u0438\u0445 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u044C." },
  G202: { severity: "warning", title: "\u041D\u0435\u043C\u0430\u0454 \u0432\u0438\u043A\u043E\u043D\u0430\u0432\u0446\u044F \u0434\u043B\u044F \u043C\u043E\u0432\u0438", explain: "`@run <\u043C\u043E\u0432\u0430>` \u0430\u0431\u043E `<Run lang>` \u043F\u043E\u0441\u0438\u043B\u0430\u0454\u0442\u044C\u0441\u044F \u043D\u0430 \u043C\u043E\u0432\u0443, \u044F\u043A\u043E\u0457 \u043D\u0435\u043C\u0430\u0454 \u0432 `executors` (\u0432\u0431\u0443\u0434\u043E\u0432\u0430\u043D\u0456: bash, node, python, deno).", hint: "\u0414\u043E\u0434\u0430\u0439 `executors.<\u043C\u043E\u0432\u0430>` \u0443 gate.json." },
  G203: { severity: "warning", title: "Run \u0430\u0431\u043E \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0432\u0441\u044F \u0437 \u043F\u043E\u043C\u0438\u043B\u043A\u043E\u044E", explain: "`@run`, cli/file/module-\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u043D\u0435 \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u0434\u0430\u043D\u0438\u0445. \u0414\u0430\u043B\u0456 \u0434\u0456\u0454 `onError`: unverified \u2014 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F null; skip \u2014 \u0441\u0435\u043A\u0446\u0456\u044E \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E; fail \u2014 \u0440\u0435\u043D\u0434\u0435\u0440 \u0437\u0430\u0432\u0435\u0440\u0448\u0443\u0454\u0442\u044C\u0441\u044F \u0437 \u043F\u043E\u043C\u0438\u043B\u043A\u043E\u044E." },
  G204: { severity: "warning", title: "\u0420\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0456\u0439 \u043D\u0435 \u0434\u043E\u0432\u0456\u0440\u0435\u043D\u0438\u0439", explain: "\u0414\u043E \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043D\u044F \u0434\u043E\u0432\u0456\u0440\u0438 (\u04202) \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E\u0442\u044C\u0441\u044F \u043F\u0440\u043E\u0446\u0435\u0441\u0438 \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0456\u044E: @run/@call \u0440\u0435\u043D\u0434\u0435\u0440\u044F\u0442\u044C\u0441\u044F \u0437\u0430\u0433\u043B\u0443\u0448\u043A\u0430\u043C\u0438, cli/module-\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0438 \u0434\u0430\u044E\u0442\u044C null.", hint: "context-gate trust grant \u0430\u0431\u043E --trust-repo." },
  G205: { severity: "info", title: "MCP \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0438\u0439 \u0443 CLI", explain: "\u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0438 kind=mcp \u0456 @mcp \u043F\u0440\u0430\u0446\u044E\u044E\u0442\u044C \u043B\u0438\u0448\u0435 \u0432\u0441\u0435\u0440\u0435\u0434\u0438\u043D\u0456 Claude Code (mod \u0432\u0438\u043A\u043B\u0438\u043A\u0430\u0454 $.mcp.call). \u0423 CLI \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F unverified." },
  G206: { severity: "warning", title: "\u041A\u043E\u043D\u0442\u0435\u043A\u0441\u0442 --ctx-from \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E", explain: "\u0417\u043D\u0456\u043C\u043E\u043A session:<id> \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0456\u0439 \u0443 .claude/gate.log.jsonl (\u043F\u043E\u0442\u0440\u0456\u0431\u0435\u043D `log.file: true`) \u0430\u0431\u043E fixture \u043D\u0435 \u0454 JSON-\u043E\u0431'\u0454\u043A\u0442\u043E\u043C." },
  G207: { severity: "warning", title: "\u0414\u0430\u043D\u0456 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u0456", explain: "\u041F\u0456\u0441\u043B\u044F \u043A\u0456\u043B\u044C\u043A\u043E\u0445 \u043F\u0440\u043E\u0445\u043E\u0434\u0456\u0432 \u0440\u0435\u043D\u0434\u0435\u0440\u0430 `needs=` \u0434\u043E\u0441\u0456 \u0447\u0435\u043A\u0430\u0454 \u043D\u0430 \u0434\u0430\u043D\u0456 \u0431\u0435\u0437 \u0434\u0436\u0435\u0440\u0435\u043B\u0430; \u0441\u0435\u043A\u0446\u0456\u044E \u0432\u0456\u0434\u0440\u0435\u043D\u0434\u0435\u0440\u0435\u043D\u043E \u0437 null." },
  G208: { severity: "info", title: "\u0414\u0430\u043D\u0456 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0456 \u0432 \u0430\u0434\u0430\u043F\u0442\u0435\u0440\u0456", explain: "\u0410\u0434\u0430\u043F\u0442\u0435\u0440 \u0431\u0435\u0437 \u043C\u043E\u0434\u0435\u043B\u0456 \u0434\u043E\u0432\u0456\u0440\u0438 (claude-code-hooks, pi, opencode) \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0454 \u043F\u0440\u043E\u0446\u0435\u0441\u0438 \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0456\u044E: `itemSources` kind=provider \u043D\u0430\u0434 cli/module/mcp-\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u043E\u043C \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E. \u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0438 kind=file \u0447\u0438\u0442\u0430\u044E\u0442\u044C\u0441\u044F. \u041F\u043E\u0432\u043D\u0438\u0439 \u043D\u0430\u0431\u0456\u0440 \u2014 \u0443 mod \u0456 CLI.", hint: "\u0412\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0439 file-\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 (JSON, \u044F\u043A\u0438\u0439 \u043F\u0438\u0448\u0435 CI) \u0430\u0431\u043E mod." },
  G210: { severity: "warning", title: "\u0424\u0430\u0439\u043B \u0434\u043B\u044F @include \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E", explain: "\u0428\u043B\u044F\u0445 @include/<Include path> \u043D\u0435 \u0456\u0441\u043D\u0443\u0454 \u0432\u0456\u0434\u043D\u043E\u0441\u043D\u043E \u043A\u043E\u0440\u0435\u043D\u044F \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0456\u044E." },
  G211: { severity: "warning", title: "\u0421\u0435\u043A\u0446\u0456\u044E \u0430\u0431\u043E \u0435\u043B\u0435\u043C\u0435\u043D\u0442 \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E", explain: "@section/@skill/@rule \u0430\u0431\u043E --only \u043F\u043E\u0441\u0438\u043B\u0430\u0454\u0442\u044C\u0441\u044F \u043D\u0430 id, \u044F\u043A\u043E\u0433\u043E \u043D\u0435\u043C\u0430\u0454." },
  G220: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0435 \u0456\u043C'\u044F gate-tool", explain: "\u0417\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A `# gate-tool:` \u043C\u0430\u0454 \u043C\u0456\u0441\u0442\u0438\u0442\u0438 \u0456\u043C'\u044F \u0437 \u043B\u0430\u0442\u0438\u043D\u0438\u0446\u0456, \u0446\u0438\u0444\u0440, _ \u0430\u0431\u043E -." },
  G221: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 input \u0443 gate-tool", explain: '`# input:` \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 JSON: \u0441\u043A\u043E\u0440\u043E\u0447\u0435\u043D\u043D\u044F `{ "path": "string" }` \u0430\u0431\u043E \u043F\u043E\u0432\u043D\u0430 JSON Schema.' },
  // ── G3xx: config (.claude/gate.json) ──
  G301: { severity: "error", title: "gate.json \u043D\u0435 \u0454 \u043E\u0431'\u0454\u043A\u0442\u043E\u043C", explain: "\u0424\u0430\u0439\u043B \u043A\u043E\u043D\u0444\u0456\u0433\u0443\u0440\u0430\u0446\u0456\u0457 \u043D\u0435 \u0454 JSON-\u043E\u0431'\u0454\u043A\u0442\u043E\u043C \u0430\u0431\u043E \u043D\u0435 \u043F\u0430\u0440\u0441\u0438\u0442\u044C\u0441\u044F. \u0428\u0430\u0440 skill-gate \u0432\u0438\u043C\u043A\u043D\u0435\u043D\u043E \u0434\u043E \u0432\u0438\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044F; \u0441\u0435\u0441\u0456\u044F \u043F\u0440\u0430\u0446\u044E\u0454 \u0434\u0430\u043B\u0456.", hint: "\u041F\u0435\u0440\u0435\u0432\u0456\u0440 JSON: `context-gate validate`." },
  G302: { severity: "warning", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u043A\u043B\u044E\u0447", explain: "\u041A\u043B\u044E\u0447 \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0443 \u0441\u0445\u0435\u043C\u0443 gate.json \u0456 \u0456\u0433\u043D\u043E\u0440\u0443\u0454\u0442\u044C\u0441\u044F. \u0427\u0430\u0441\u0442\u043E \u0446\u0435 \u043E\u0434\u0440\u0443\u043A\u0456\u0432\u043A\u0430." },
  G303: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 \u0442\u0438\u043F \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F", explain: "\u0417\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u043F\u043E\u043B\u044F \u043C\u0430\u0454 \u0456\u043D\u0448\u0438\u0439 \u0442\u0438\u043F, \u043D\u0456\u0436 \u0432\u0438\u043C\u0430\u0433\u0430\u0454 \u0441\u0445\u0435\u043C\u0430. \u0428\u0430\u0440 skill-gate \u0432\u0438\u043C\u043A\u043D\u0435\u043D\u043E, \u043F\u0440\u0438\u0447\u0438\u043D\u0430 \u2014 \u0443 `/gate why`." },
  G304: { severity: "warning", title: "\u041F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F \u043D\u0430 \u043D\u0435\u0432\u0456\u0434\u043E\u043C\u0443 \u0433\u0440\u0443\u043F\u0443", explain: "\u041F\u0440\u043E\u0444\u0456\u043B\u044C \u0430\u0431\u043E tier \u043F\u043E\u0441\u0438\u043B\u0430\u0454\u0442\u044C\u0441\u044F \u043D\u0430 \u0433\u0440\u0443\u043F\u0443, \u044F\u043A\u043E\u0457 \u043D\u0435\u043C\u0430\u0454 \u0432 `groups` (\u0447\u0438 `skillGroups`/`mcpGroups`). \u041F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F \u043D\u0456\u0447\u043E\u0433\u043E \u043D\u0435 \u0432\u043C\u0438\u043A\u0430\u0454." },
  G305: { severity: "warning", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 tier", explain: "`models` \u0430\u0431\u043E `escalation.order` \u043F\u043E\u0441\u0438\u043B\u0430\u0454\u0442\u044C\u0441\u044F \u043D\u0430 tier, \u044F\u043A\u043E\u0433\u043E \u043D\u0435\u043C\u0430\u0454 \u0432 `tiers`." },
  G306: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 \u0440\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u0438\u0439 \u0432\u0438\u0440\u0430\u0437", explain: "`when.branch` \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u0432\u0430\u043B\u0456\u0434\u043D\u0438\u043C \u0440\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u0438\u043C \u0432\u0438\u0440\u0430\u0437\u043E\u043C JavaScript." },
  G307: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0430 \u0442\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C", explain: "\u0422\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C \u043C\u0430\u0454 \u0444\u043E\u0440\u043C\u0443 `500ms`, `10s`, `5m`, `1h`, `1d` (\u043C\u043E\u0436\u043D\u0430 \u043F\u043E\u0454\u0434\u043D\u0443\u0432\u0430\u0442\u0438: `1h30m`)." },
  G308: { severity: "error", title: "\u0417\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u043F\u043E\u0437\u0430 \u043F\u0435\u0440\u0435\u043B\u0456\u043A\u043E\u043C", explain: "\u041F\u043E\u043B\u0435 \u043F\u0440\u0438\u0439\u043C\u0430\u0454 \u043B\u0438\u0448\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0437 \u043F\u0435\u0440\u0435\u043B\u0456\u043A\u0443, \u0432\u043A\u0430\u0437\u0430\u043D\u043E\u0433\u043E \u0432 \u043F\u043E\u0432\u0456\u0434\u043E\u043C\u043B\u0435\u043D\u043D\u0456." },
  G309: { severity: "error", title: "\u0417\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u043F\u043E\u0437\u0430 \u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D\u043E\u043C", explain: "\u0427\u0438\u0441\u043B\u043E \u0432\u0438\u0445\u043E\u0434\u0438\u0442\u044C \u0437\u0430 \u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u0456 \u043C\u0435\u0436\u0456 (\u043D\u0430\u043F\u0440\u0438\u043A\u043B\u0430\u0434 `minConfidence` 0\u20261, \u0432\u0456\u0434\u0441\u043E\u0442\u043A\u0438 0\u2026100)." },
  G310: { severity: "warning", title: "\u0417\u0430\u0441\u0442\u0430\u0440\u0456\u043B\u0438\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 \u043A\u043E\u043D\u0444\u0456\u0433\u0443\u0440\u0430\u0446\u0456\u0457", explain: "\u041F\u043E\u043B\u044F `skillGroups`, `mcpGroups`, `ruleSources` \u0456 `skills`/`mcp`/`agents` \u0443 \u043F\u0440\u043E\u0444\u0456\u043B\u044F\u0445 \u0447\u0438 tiers \u2014 \u0441\u0442\u0430\u0440\u0438\u0439 \u0444\u043E\u0440\u043C\u0430\u0442. \u0412\u043E\u043D\u0438 \u043A\u043E\u043D\u0432\u0435\u0440\u0442\u0443\u044E\u0442\u044C\u0441\u044F \u0432 \u0454\u0434\u0438\u043D\u0456 `groups` \u0437 kind-\u043F\u0440\u0435\u0444\u0456\u043A\u0441\u0430\u043C\u0438 (`skill:\u2026`, `tool:mcp__<server>__*`, `agent:\u2026`) \u0456 `itemSources`.", hint: "\u0417\u0430\u043F\u0443\u0441\u0442\u0438 `context-gate migrate`, \u0449\u043E\u0431 \u043F\u0435\u0440\u0435\u043F\u0438\u0441\u0430\u0442\u0438 gate.json \u0443 \u043D\u043E\u0432\u043E\u043C\u0443 \u0444\u043E\u0440\u043C\u0430\u0442\u0456." },
  G311: { severity: "error", title: "\u0412\u0456\u0434\u0441\u0443\u0442\u043D\u0454 \u043E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u0435 \u043F\u043E\u043B\u0435", explain: "\u041E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u0435 \u043F\u043E\u043B\u0435 \u043E\u0431'\u0454\u043A\u0442\u0430 \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0454." },
  G312: { severity: "warning", title: "softContextPct \u2265 hardContextPct", explain: "\u041C'\u044F\u043A\u0438\u0439 \u043F\u043E\u0440\u0456\u0433 \u0431\u044E\u0434\u0436\u0435\u0442\u0443 \u043D\u0435 \u043C\u0435\u043D\u0448\u0438\u0439 \u0437\u0430 \u0436\u043E\u0440\u0441\u0442\u043A\u0438\u0439: \u043F\u043E\u043F\u0435\u0440\u0435\u0434\u0436\u0435\u043D\u043D\u044F \u043D\u0456\u043A\u043E\u043B\u0438 \u043D\u0435 \u0432\u0441\u0442\u0438\u0433\u043D\u0435 \u0441\u043F\u0440\u0430\u0446\u044E\u0432\u0430\u0442\u0438." },
  G313: { severity: "warning", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0435 \u0434\u0436\u0435\u0440\u0435\u043B\u043E \u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", explain: "\u0417\u0430\u043F\u0438\u0441 `itemSources`/`ruleSources` \u043D\u0435\u043F\u043E\u0432\u043D\u0438\u0439: `markdown-dir` \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 `dir`, `provider` \u2014 `name` \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430, \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u043E\u0433\u043E \u0432 `providers`. \u0414\u0436\u0435\u0440\u0435\u043B\u043E \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E." },
  // ── G5xx: pipe / /gate command ──
  G501: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0441\u0442\u0430\u0434\u0456\u044F pipe", explain: "\u0421\u0442\u0430\u0434\u0456\u044F \u043A\u043E\u043D\u0432\u0435\u0454\u0440\u0430 \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442\u044C \u0443 \u0433\u0440\u0430\u043C\u0430\u0442\u0438\u043A\u0443.", hint: "\u0412\u0456\u0434\u043E\u043C\u0456 \u0441\u0442\u0430\u0434\u0456\u0457: collect, normalize, decide, budget, render, deliver, observe, where, tokens, on, off, why, take, sort, preview." },
  G502: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u043F\u0440\u043E\u0444\u0456\u043B\u044C \u0430\u0431\u043E \u043F\u0456\u0434\u043A\u043E\u043C\u0430\u043D\u0434\u0430", explain: "\u0421\u043B\u043E\u0432\u043E \u043F\u0456\u0441\u043B\u044F `/gate` \u043D\u0435 \u0454 \u043F\u0456\u0434\u043A\u043E\u043C\u0430\u043D\u0434\u043E\u044E \u0456 \u043D\u0435 \u0437\u0431\u0456\u0433\u0430\u0454\u0442\u044C\u0441\u044F \u0437 \u0436\u043E\u0434\u043D\u0438\u043C \u043F\u0440\u043E\u0444\u0456\u043B\u0435\u043C \u0437 gate.json.", hint: "`/gate` \u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432 \u043F\u043E\u043A\u0430\u0437\u0443\u0454 \u043F\u0440\u043E\u0444\u0456\u043B\u0456; `/gate help` \u2014 \u043F\u0456\u0434\u043A\u043E\u043C\u0430\u043D\u0434\u0438." },
  G503: { severity: "error", title: "\u041F\u043E\u0440\u043E\u0436\u043D\u044F \u0441\u0442\u0430\u0434\u0456\u044F pipe", explain: "\u041C\u0456\u0436 \u0434\u0432\u043E\u043C\u0430 `|` \u043D\u0435\u043C\u0430\u0454 \u0441\u0442\u0430\u0434\u0456\u0457." },
  G504: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442 \u0441\u0442\u0430\u0434\u0456\u0457", explain: "\u0410\u0440\u0433\u0443\u043C\u0435\u043D\u0442 \u0441\u0442\u0430\u0434\u0456\u0457 \u043C\u0430\u0454 \u0444\u043E\u0440\u043C\u0443 `key=value`, `--key value` \u0430\u0431\u043E `--flag`." },
  G505: { severity: "error", title: "\u0411\u0440\u0430\u043A\u0443\u0454 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0443", explain: "\u041F\u0456\u0434\u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0454 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0443 (\u043D\u0430\u043F\u0440\u0438\u043A\u043B\u0430\u0434 `/gate render prompt://<id>`)." },
  G506: { severity: "error", title: "\u0417\u043C\u0456\u0448\u0430\u043D\u0456 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0438 \u0433\u0440\u0443\u043F", explain: "`/gate +a -b` \u043F\u0440\u0438\u0439\u043C\u0430\u0454 \u043B\u0438\u0448\u0435 \u0433\u0440\u0443\u043F\u0438 \u0437 `+` \u0430\u0431\u043E `-`." },
  G507: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0434\u0456\u044F trust", explain: "\u041F\u0456\u0434\u0442\u0440\u0438\u043C\u0443\u0454\u0442\u044C\u0441\u044F \u043B\u0438\u0448\u0435 `/gate trust revoke`." },
  G508: { severity: "error", title: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 \u0444\u0456\u043B\u044C\u0442\u0440 where", explain: "\u0424\u0456\u043B\u044C\u0442\u0440 \u043C\u0430\u0454 \u0444\u043E\u0440\u043C\u0443 `where key=value` (\u0442\u0430\u043A\u043E\u0436 `!=`, `~` \u0434\u043B\u044F \u043F\u0456\u0434\u0440\u044F\u0434\u043A\u0430, `>`/`<` \u0434\u043B\u044F \u0447\u0438\u0441\u0435\u043B), \u0443\u043C\u043E\u0432\u0438 \u0447\u0435\u0440\u0435\u0437 \u043F\u0440\u043E\u0431\u0456\u043B \u0430\u0431\u043E `and`." },
  // ── H0xx: prompt health ──
  H001: { severity: "warning", title: "\u0417\u0430\u0432\u0435\u043B\u0438\u043A\u0438\u0439 \u043F\u0440\u043E\u043C\u043F\u0442", explain: "\u0421\u0438\u0441\u0442\u0435\u043C\u043D\u0438\u0439 \u043F\u0440\u043E\u043C\u043F\u0442 \u0440\u0430\u0437\u043E\u043C \u043F\u043E\u043D\u0430\u0434 12 000 \u0442\u043E\u043A\u0435\u043D\u0456\u0432.", hint: '\u0411\u044E\u0434\u0436\u0435\u0442\u0438 \u043D\u0430 \u0441\u0435\u043A\u0446\u0456\u0457, `Include mode="lazy"`, Always-\u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u2192 Auto Attached.' },
  H002: { severity: "warning", title: "\u041C\u0430\u043B\u0430 \u0441\u0442\u0430\u0431\u0456\u043B\u044C\u043D\u0430 \u0447\u0430\u0441\u0442\u043A\u0430", explain: "\u041C\u0435\u043D\u0448\u0435 70 % \u043F\u0440\u043E\u043C\u043F\u0442\u0443 \u043D\u0435 \u0437\u043C\u0456\u043D\u0438\u043B\u043E\u0441\u044C \u0432\u0456\u0434 \u043C\u0438\u043D\u0443\u043B\u043E\u0433\u043E \u0445\u043E\u0434\u0443: prompt cache \u0432\u0442\u0440\u0430\u0447\u0430\u0454\u0442\u044C\u0441\u044F.", hint: "\u041F\u0435\u0440\u0435\u043D\u0435\u0441\u0438 \u0437\u043C\u0456\u043D\u043D\u0456 \u0434\u0430\u043D\u0456 \u0432 `scope: volatile` \u0443 \u043A\u0456\u043D\u0446\u0456." },
  H003: { severity: "warning", title: "\u0414\u0440\u0435\u0439\u0444 \u043F\u0440\u043E\u043C\u043F\u0442\u0443", explain: "\u041F\u0440\u043E\u043C\u043F\u0442 \u043F\u043E\u0437\u0430 `volatile` \u0437\u043C\u0456\u043D\u0438\u0432\u0441\u044F \u0431\u0456\u043B\u044C\u0448 \u043D\u0456\u0436 \u043D\u0430 500 \u0442\u043E\u043A\u0435\u043D\u0456\u0432 \u043C\u0456\u0436 \u0445\u043E\u0434\u0430\u043C\u0438." },
  H004: { severity: "warning", title: "\u041F\u043E\u0432\u0456\u043B\u044C\u043D\u0438\u0439 \u0440\u0435\u043D\u0434\u0435\u0440", explain: "\u0420\u0435\u043D\u0434\u0435\u0440 \u0431\u0435\u0437 \u0441\u043A\u0440\u0438\u043F\u0442\u0456\u0432 \u0442\u0440\u0438\u0432\u0430\u0454 \u043F\u043E\u043D\u0430\u0434 1 \u0441." },
  H005: { severity: "warning", title: "\u041F\u043E\u0432\u0456\u043B\u044C\u043D\u0438\u0439 \u0440\u0435\u043D\u0434\u0435\u0440 \u0437\u0456 \u0441\u043A\u0440\u0438\u043F\u0442\u0430\u043C\u0438", explain: "\u0420\u0435\u043D\u0434\u0435\u0440 \u0440\u0430\u0437\u043E\u043C \u0456\u0437 `@run` \u0456 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430\u043C\u0438 \u0442\u0440\u0438\u0432\u0430\u0454 \u043F\u043E\u043D\u0430\u0434 2 \u0441; \u0441\u0435\u043A\u0446\u0456\u0457 \u0437\u0456 \u0441\u043A\u0440\u0438\u043F\u0442\u0430\u043C\u0438 \u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E\u0442\u044C\u0441\u044F.", hint: "\u0414\u043E\u0434\u0430\u0439 `cache` \u0434\u043E `Run` \u0430\u0431\u043E \u0432\u0438\u043D\u0435\u0441\u0438 \u0432 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440." },
  H006: { severity: "warning", title: "\u0417\u0430\u0441\u0442\u0430\u0440\u0456\u043B\u0456 \u0434\u0430\u043D\u0456", explain: "\u0421\u0435\u043A\u0446\u0456\u044E \u0432\u0456\u0434\u0440\u0435\u043D\u0434\u0435\u0440\u0435\u043D\u043E \u0437 \u0434\u0430\u043D\u0438\u0445 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430 \u0430\u0431\u043E `data.*`, \u0449\u043E \u0437\u0430\u0441\u0442\u0430\u0440\u0456\u043B\u0438 (`stale`) \u0430\u0431\u043E \u0432\u0437\u044F\u0442\u0456 \u0437 \u0440\u0435\u0437\u0435\u0440\u0432\u0443." },
  H007: { severity: "warning", title: "\u041D\u0435\u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0430 \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430", explain: "\u0404 \u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0438 \u0437\u0456 \u0441\u0442\u0430\u0442\u0443\u0441\u043E\u043C `unverified` \u043F\u0456\u0441\u043B\u044F apply-\u0440\u0435\u0436\u0438\u043C\u0443." },
  H008: { severity: "warning", title: "\u0423\u0440\u0456\u0437\u0430\u043D\u043D\u044F static", explain: "\u0421\u0435\u043A\u0446\u0456\u044E `scope: static` \u043E\u0431\u0440\u0456\u0437\u0430\u043D\u043E \u0437\u0430 `budget`." },
  H009: { severity: "warning", title: "\u041F\u0435\u0440\u0435\u043F\u043E\u0432\u043D\u0435\u043D\u043D\u044F \u043B\u0438\u0441\u0442\u0438\u043D\u0433\u0443 skills", explain: "\u041B\u0438\u0441\u0442\u0438\u043D\u0433 skills \u043F\u0435\u0440\u0435\u0432\u0438\u0449\u0443\u0454 \u043D\u0430\u0442\u0438\u0432\u043D\u0438\u0439 \u0431\u044E\u0434\u0436\u0435\u0442 1 % \u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442\u0443.", hint: "\u0417\u0432\u0443\u0437\u044C \u043F\u0440\u043E\u0444\u0456\u043B\u044C \u0430\u0431\u043E \u043F\u0435\u0440\u0435\u0432\u0435\u0434\u0438 \u0447\u0430\u0441\u0442\u0438\u043D\u0443 skills \u0443 `nameOnly`." },
  H010: { severity: "warning", title: "\u0427\u0430\u0441\u0442\u0456 deny", explain: "\u041F\u043E\u043D\u0430\u0434 3 deny \u043E\u0434\u043D\u043E\u0433\u043E \u0456\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430 \u0437\u0430 \u0441\u0435\u0441\u0456\u044E.", hint: "\u0414\u043E\u0434\u0430\u0439 \u0433\u0440\u0443\u043F\u0443 \u0456\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430 \u0432 \u043F\u0440\u043E\u0444\u0456\u043B\u044C." },
  H011: { severity: "warning", title: "\u0413\u0435\u0439\u0442 \u0431\u043B\u043E\u043A\u0443\u0454 \u043D\u0430\u0434\u0442\u043E \u0447\u0430\u0441\u0442\u043E", explain: "\u0413\u0435\u0439\u0442 \u0431\u043B\u043E\u043A\u0443\u0454 \u043F\u043E\u043D\u0430\u0434 30 % \u0441\u043F\u0440\u043E\u0431." },
  H012: { severity: "warning", title: "\u0414\u043E\u0440\u043E\u0433\u0438\u0439 \u0441\u0438\u0441\u0442\u0435\u043C\u043D\u0438\u0439 \u043F\u0440\u043E\u043C\u043F\u0442", explain: "\u0421\u0438\u0441\u0442\u0435\u043C\u043D\u0438\u0439 \u043F\u0440\u043E\u043C\u043F\u0442 \u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u043F\u043E\u043D\u0430\u0434 40 % \u0432\u0445\u0456\u0434\u043D\u0438\u0445 \u0442\u043E\u043A\u0435\u043D\u0456\u0432." },
  H013: { severity: "warning", title: "\u0417\u0430\u0441\u0442\u0430\u0440\u0456\u043B\u0438\u0439 .compiled", explain: "`.compiled/<id>.json` \u0441\u0442\u0430\u0440\u0456\u0448\u0438\u0439 \u0437\u0430 `.tsx` \u0430\u0431\u043E \u0439\u043E\u0433\u043E \u0456\u043C\u043F\u043E\u0440\u0442\u0438; \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E \u043F\u043E\u043F\u0435\u0440\u0435\u0434\u043D\u044E \u0437\u0431\u0456\u0440\u043A\u0443.", hint: "`context-gate build`." },
  // ── D0xx: debug ──
  D001: { severity: "warning", title: "Assert \u043D\u0435 \u043F\u0440\u043E\u0439\u0448\u043E\u0432", explain: "\u0423\u043C\u043E\u0432\u0430 `@assert` \u0445\u0438\u0431\u043D\u0430; \u0437\u0430 `assertFail` \u0441\u0435\u043A\u0446\u0456\u044E \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E \u0430\u0431\u043E \u0440\u0435\u043D\u0434\u0435\u0440 \u0443\u043F\u0430\u0432." }
};
function diag(code, message, extra = {}) {
  const info = CODES[code];
  const d = {
    code,
    severity: info?.severity ?? "error",
    message: message ?? info?.title ?? code
  };
  if (info?.hint) d.hint = info.hint;
  return { ...d, ...extra };
}

// packages/core/src/duration.ts
var UNIT = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
function parseDuration(input) {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input : void 0;
  if (typeof input !== "string") return void 0;
  const s = input.trim().toLowerCase();
  if (!s) return void 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/gy;
  let total = 0;
  let pos = 0;
  let m;
  while (m = re.exec(s)) {
    total += Number(m[1]) * UNIT[m[2]];
    pos = re.lastIndex;
    while (s[pos] === " ") pos++;
    re.lastIndex = pos;
  }
  return pos === s.length && pos > 0 ? Math.round(total) : void 0;
}

// packages/core/src/config.ts
var DEFAULT_TIER = "standard";
var DEFAULT_BUDGET = { softContextPct: 70, hardContextPct: 85 };
function defaultConfig() {
  return {
    groups: {},
    tiers: { premium: { groups: [] }, standard: { groups: [] }, quick: { groups: [] } },
    models: { "*opus*": "premium", "*sonnet*": "standard", "*haiku*": "quick" },
    profiles: {},
    classify: { mode: "shadow", minConfidence: 0.7, recheckOn: ["/gate new", "compact"] },
    budgets: { default: { ...DEFAULT_BUDGET } },
    cursorRules: { enabled: true, nested: false, maxCharsPerInjection: 3e4, strictWrite: false },
    prompt: { dir: ".claude/prompt", runCacheDefault: "5m", build: "auto", commitCompiled: false }
  };
}
var str = { type: "string" };
var bool = { type: "boolean" };
var strArr = { type: "array", items: { type: "string" } };
var pct = { type: "number", minimum: 0, maximum: 100 };
var duration = { type: "string", pattern: "^\\s*(\\d+(\\.\\d+)?|(\\d+(\\.\\d+)?\\s*([mM][sS]|[sSmMhHdDwW])\\s*)+)$", "x-duration": true, description: "\u0422\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C: 5m, 1h30m, 10s, 500ms." };
var tierRef = { type: "string", description: "Tier name (key of `tiers`)." };
var budgetPct = { type: "object", additionalProperties: false, properties: { softContextPct: pct, hardContextPct: pct } };
var onExceedAction = {
  anyOf: [
    { type: "object", additionalProperties: false, required: ["do", "section"], properties: { do: { enum: ["section"] }, section: str } },
    { type: "object", additionalProperties: false, required: ["do", "text"], properties: { do: { enum: ["notice"] }, text: str } },
    { type: "object", additionalProperties: false, required: ["do"], properties: { do: { enum: ["compact"] }, instructions: str } }
  ]
};
var num0 = { type: "number", minimum: 0 };
var modelSpec = {
  type: "object",
  additionalProperties: false,
  description: "Model attributes: with `tier` a direct mapping; without it the tier is inferred from `tiers[*].thresholds`.",
  properties: { tier: tierRef, match: { type: "string", description: "Glob on the model id (the key is then a label)." }, contextWindow: { type: "integer", minimum: 1 }, costPer1k: num0 }
};
var thresholds = {
  type: "object",
  additionalProperties: false,
  properties: { minContextWindow: { type: "integer", minimum: 0 }, maxContextWindow: { type: "integer", minimum: 0 }, minCostPer1k: num0, maxCostPer1k: num0 }
};
var providerRef = {
  anyOf: [
    { enum: ["builtin", "jev"] },
    { type: "object", additionalProperties: false, required: ["kind", "command"], properties: { kind: { enum: ["cli"] }, command: strArr, timeout: duration } }
  ]
};
var groupMap = { type: "object", additionalProperties: strArr, description: "Group name \u2192 globs." };
var itemSource = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: ["claude-skills", "claude-tools", "claude-agents", "cursor-mdc", "markdown-dir", "prompt-dir", "provider"] },
    dir: str,
    match: str,
    as: { enum: ["skill", "tool", "agent", "rule", "section", "datum", "always"] },
    name: str,
    pick: str,
    field: str,
    template: str,
    nested: bool,
    frontmatter: { type: "object", additionalProperties: str }
  }
};
var gateJsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://context-gate.dev/context-gate.schema.json",
  title: "context-gate .claude/gate.json",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: str,
    groups: { ...groupMap, description: "Unified groups: name \u2192 kind-prefixed globs (`skill:react-*`, `tool:mcp__figma__*`, `agent:ui-reviewer`, `rule:api-*`)." },
    skillGroups: { ...groupMap, description: "Legacy (G310): group \u2192 skill name globs." },
    mcpGroups: { ...groupMap, description: "Legacy (G310): group \u2192 MCP server name globs." },
    tiers: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: { groups: strArr, skills: { ...strArr, description: "Legacy (G310)." }, preload: strArr, thresholds }
      }
    },
    models: { type: "object", additionalProperties: { anyOf: [tierRef, modelSpec] }, description: "Model id glob \u2192 tier, or model attributes (`contextWindow`, `costPer1k`)." },
    profiles: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          groups: strArr,
          skills: strArr,
          mcp: strArr,
          agents: strArr,
          when: {
            type: "object",
            additionalProperties: false,
            properties: { paths: strArr, branch: str, expr: str, ticketType: strArr }
          }
        }
      }
    },
    classify: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: ["shadow", "auto"] },
        model: str,
        minConfidence: { type: "number", minimum: 0, maximum: 1 },
        recheckOn: strArr,
        provider: providerRef
      }
    },
    budgets: { type: "object", additionalProperties: false, properties: { default: budgetPct, tiers: { type: "object", additionalProperties: budgetPct } } },
    onExceed: { type: "object", additionalProperties: false, properties: { softContextPct: onExceedAction, hardContextPct: onExceedAction } },
    escalation: {
      type: "object",
      additionalProperties: false,
      required: ["order", "after"],
      properties: {
        order: { type: "array", items: tierRef },
        after: { type: "object", additionalProperties: false, properties: { verifyFailed: { type: "integer", minimum: 1 }, stallTurns: { type: "integer", minimum: 1 } } }
      }
    },
    brief: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: { enabled: bool, model: str, maxChars: { type: "integer", minimum: 0 }, tiers: { type: "array", items: tierRef }, provider: providerRef }
    },
    providers: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { enum: ["cli", "file", "mcp", "module"] },
          builtin: bool,
          command: strArr,
          functions: { anyOf: [strArr, { type: "object", additionalProperties: strArr }] },
          path: str,
          pick: strArr,
          tool: str,
          args: { type: "object" },
          cache: duration,
          onError: { enum: ["unverified", "skip", "fail"] },
          okExitCodes: { type: "array", items: { type: "integer" }, description: "cli: exit codes that count as success (default [0])." },
          parseOnError: { type: "boolean", description: "cli: another exit code with JSON on stdout still yields data (eslint -f json exits 1)." },
          schema: {},
          exposes: strArr
        }
      }
    },
    executors: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: { command: strArr, stdin: str, timeout: duration, env: { type: "object", additionalProperties: str }, callTemplate: strArr }
      }
    },
    ruleSources: { type: "array", items: itemSource, description: "Legacy (G310): use itemSources." },
    itemSources: { type: "array", items: itemSource },
    gates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "on"],
        properties: {
          name: str,
          on: { enum: ["write", "commit", "turn", "prompt"] },
          builtin: bool,
          tiers: { type: "array", items: tierRef },
          run: strArr,
          pass: str,
          message: str,
          provider: str,
          onlyNew: bool,
          baseline: str
        }
      }
    },
    cursorRules: {
      type: "object",
      additionalProperties: false,
      properties: { enabled: bool, nested: bool, maxCharsPerInjection: { type: "integer", minimum: 0 }, strictWrite: bool }
    },
    prompt: {
      type: "object",
      additionalProperties: false,
      properties: { dir: str, runCacheDefault: duration, build: { enum: ["auto", "never"] }, commitCompiled: bool, persist: bool, packages: { ...strArr, description: "Prompt library packages whose exported skills `build` builds." }, transform: { enum: ["level1", "level2"], description: "TSX level 2: native TS expressions in runtime props (\u04201)." }, skillBody: { enum: ["live", "static", "both"], description: "SKILL.md body: live render line, pre-rendered static body, or both (\u04206)." } }
    },
    health: { type: "object", additionalProperties: { type: "number" }, description: "Code (H001\u2026) \u2192 threshold." },
    debug: bool,
    debugLog: { type: "object", additionalProperties: false, properties: { path: str, maxBytes: { type: "integer", minimum: 1 } }, description: "Debug log file (written only with `debug: true` or CLI `--debug`)." },
    assertFail: { enum: ["skip", "fail"], description: "A false `@assert`: skip the section (default) or fail the render." },
    log: { type: "object", additionalProperties: false, properties: { file: bool } },
    env: { ...strArr, description: "Env vars visible to the DSL as `env.*` (masked in debug output)." },
    allowBinaries: { ...strArr, description: "Binaries repo executors/providers may start. Narrows the user whitelist (~/.claude/context-gate.json), never widens it (\u04202)." }
  }
};
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}
function typeMatches(want, v) {
  const t = typeOf(v);
  if (want === "number") return t === "number" || t === "integer";
  return want === t;
}
function checkSchema(schema, v, path, out) {
  if (schema.anyOf) {
    const alts = schema.anyOf;
    let best;
    for (const alt of alts) {
      const d = [];
      checkSchema(alt, v, path, d);
      if (!d.some((x) => x.severity === "error")) {
        out.push(...d);
        return;
      }
      if (!best || d.length < best.length) best = d;
    }
    out.push(...best ?? []);
    return;
  }
  if (schema.enum) {
    const vals = schema.enum;
    if (!vals.includes(v)) out.push(diag("G308", `${path}: ${JSON.stringify(v)} \u2014 \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F \u043E\u0434\u043D\u0435 \u0437: ${vals.join(" | ")}`));
    return;
  }
  const type = schema.type;
  if (type && !typeMatches(type, v)) {
    out.push(diag("G303", `${path}: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${type}, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${typeOf(v)}`));
    return;
  }
  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum) out.push(diag("G309", `${path}: ${v} < ${schema.minimum}`));
    if (typeof schema.maximum === "number" && v > schema.maximum) out.push(diag("G309", `${path}: ${v} > ${schema.maximum}`));
  }
  if (typeof v === "string" && schema["x-duration"] === true && parseDuration(v) === void 0) {
    out.push(diag("G307", `${path}: \u043D\u0435\u0432\u0456\u0440\u043D\u0430 \u0442\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C ${JSON.stringify(v)}`));
  }
  if (Array.isArray(v) && schema.items) {
    v.forEach((x, i) => checkSchema(schema.items, x, `${path}[${i}]`, out));
  }
  if (type === "object" && v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v;
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) {
      if (!(r in obj)) out.push(diag("G311", `${path}.${r}: \u043E\u0431\u043E\u0432'\u044F\u0437\u043A\u043E\u0432\u0435 \u043F\u043E\u043B\u0435 \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0454`));
    }
    for (const [k, val] of Object.entries(obj)) {
      const sub = props[k];
      if (sub) {
        checkSchema(sub, val, `${path}.${k}`, out);
        continue;
      }
      const ap = schema.additionalProperties;
      if (ap === false) out.push(diag("G302", `${path}.${k}: \u043D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u043A\u043B\u044E\u0447, \u0456\u0433\u043D\u043E\u0440\u0443\u0454\u0442\u044C\u0441\u044F`));
      else if (ap && typeof ap === "object") checkSchema(ap, val, `${path}.${k}`, out);
    }
  }
}
function validateConfig(json) {
  const diagnostics = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { diagnostics: [diag("G301", `gate.json: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F \u043E\u0431'\u0454\u043A\u0442, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${typeOf(json)}`)] };
  }
  checkSchema(gateJsonSchema, json, "$", diagnostics);
  const raw = json;
  semanticChecks(raw, diagnostics);
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  const known = gateJsonSchema.properties;
  const clean = {};
  for (const [k, v] of Object.entries(raw)) if (k in known) clean[k] = v;
  return { config: mergeDefaults(clean), diagnostics };
}
function loadConfig(text) {
  if (text === void 0) return { config: defaultConfig(), diagnostics: [] };
  let json;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { diagnostics: [diag("G301", `gate.json \u043D\u0435 \u043F\u0430\u0440\u0441\u0438\u0442\u044C\u0441\u044F: ${e.message}`)] };
  }
  const v = validateConfig(json);
  if (!v.config) return v;
  const n = normalizeConfig(v.config);
  return { config: n.config, diagnostics: [...v.diagnostics, ...n.diagnostics] };
}
function semanticChecks(raw, out) {
  const profiles = isObj(raw.profiles) ? raw.profiles : {};
  for (const [name, p] of Object.entries(profiles)) {
    if (!isObj(p) || !isObj(p.when)) continue;
    const br = p.when.branch;
    if (typeof br === "string") {
      try {
        new RegExp(br);
      } catch (e) {
        out.push(diag("G306", `$.profiles.${name}.when.branch: ${e.message}`));
      }
    }
  }
  const tiers = isObj(raw.tiers) ? raw.tiers : void 0;
  const tierNames = new Set(Object.keys(tiers ?? defaultConfig().tiers));
  if (isObj(raw.models)) {
    for (const [glob, t] of Object.entries(raw.models)) {
      const tt = typeof t === "string" ? t : isObj(t) && typeof t.tier === "string" ? t.tier : void 0;
      if (tt !== void 0 && !tierNames.has(tt)) out.push(diag("G305", `$.models.${glob}: tier "${tt}" \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u043E \u0432 tiers`));
    }
  }
  const sources = [...Array.isArray(raw.itemSources) ? raw.itemSources : [], ...Array.isArray(raw.ruleSources) ? raw.ruleSources : []];
  const providerNames = new Set(Object.keys(isObj(raw.providers) ? raw.providers : {}));
  sources.forEach((src, i) => {
    if (!isObj(src)) return;
    const where = `$.itemSources[${i}] (${String(src.kind)})`;
    if ((src.kind === "markdown-dir" || src.kind === "prompt-dir") && typeof src.dir !== "string") out.push(diag("G313", `${where}: \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0435 \u043F\u043E\u043B\u0435 dir`));
    if (src.kind === "prompt-dir" && src.as !== void 0 && src.as !== "section") out.push(diag("G313", `${where}: prompt-dir \u0434\u0430\u0454 \u043B\u0438\u0448\u0435 \u0441\u0435\u043A\u0446\u0456\u0457 (as: "section")`));
    if (src.kind === "provider") {
      if (typeof src.name !== "string") out.push(diag("G313", `${where}: \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0435 \u043F\u043E\u043B\u0435 name`));
      else if (!providerNames.has(src.name)) out.push(diag("G313", `${where}: \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 "${src.name}" \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u043E \u0432 providers`));
    }
  });
  for (const [name, p] of Object.entries(isObj(raw.providers) ? raw.providers : {})) {
    if (!isObj(p) || p.kind === "cli") continue;
    for (const k of ["okExitCodes", "parseOnError"]) if (k in p) out.push(diag("G302", `$.providers.${name}.${k}: \u0434\u0456\u0454 \u043B\u0438\u0448\u0435 \u0434\u043B\u044F kind "cli", \u0456\u0433\u043D\u043E\u0440\u0443\u0454\u0442\u044C\u0441\u044F`));
  }
  const esc = raw.escalation;
  if (isObj(esc) && Array.isArray(esc.order)) {
    for (const t of esc.order) if (typeof t === "string" && !tierNames.has(t)) out.push(diag("G305", `$.escalation.order: tier "${t}" \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u043E \u0432 tiers`));
  }
  const budgets = raw.budgets;
  if (isObj(budgets)) {
    const check = (b, p) => {
      if (isObj(b) && typeof b.softContextPct === "number" && typeof b.hardContextPct === "number" && b.softContextPct >= b.hardContextPct) {
        out.push(diag("G312", `${p}: softContextPct ${b.softContextPct} \u2265 hardContextPct ${b.hardContextPct}`));
      }
    };
    check(budgets.default, "$.budgets.default");
    if (isObj(budgets.tiers)) for (const [t, b] of Object.entries(budgets.tiers)) check(b, `$.budgets.tiers.${t}`);
  }
  const groupNames = /* @__PURE__ */ new Set([...Object.keys(isObj(raw.groups) ? raw.groups : {}), ...Object.keys(isObj(raw.skillGroups) ? raw.skillGroups : {}), ...Object.keys(isObj(raw.mcpGroups) ? raw.mcpGroups : {})]);
  for (const [name, p] of Object.entries(profiles)) {
    if (isObj(p) && Array.isArray(p.groups)) {
      for (const g of p.groups) if (typeof g === "string" && !groupNames.has(g)) out.push(diag("G304", `$.profiles.${name}.groups: \u0433\u0440\u0443\u043F\u0430 "${g}" \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u0430`));
    }
  }
  if (tiers) {
    for (const [name, t] of Object.entries(tiers)) {
      if (isObj(t) && Array.isArray(t.groups)) {
        for (const g of t.groups) if (typeof g === "string" && !groupNames.has(g)) out.push(diag("G304", `$.tiers.${name}.groups: \u0433\u0440\u0443\u043F\u0430 "${g}" \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u0430`));
      }
    }
  }
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function mergeDefaults(cfg) {
  const d = defaultConfig();
  return {
    ...d,
    ...cfg,
    tiers: cfg.tiers ?? d.tiers,
    models: cfg.models ?? d.models,
    profiles: cfg.profiles ?? d.profiles,
    groups: cfg.groups ?? (cfg.skillGroups || cfg.mcpGroups ? void 0 : d.groups),
    classify: cfg.classify ? { ...d.classify, ...cfg.classify } : d.classify,
    budgets: cfg.budgets ? { ...cfg.budgets, default: { ...DEFAULT_BUDGET, ...cfg.budgets.default } } : d.budgets,
    cursorRules: { ...d.cursorRules, ...cfg.cursorRules },
    prompt: { ...d.prompt, ...cfg.prompt }
  };
}
function uniq(xs) {
  return [...new Set(xs)];
}
function hasLegacy(cfg) {
  const fields = [];
  if (cfg.skillGroups) fields.push("skillGroups");
  if (cfg.mcpGroups) fields.push("mcpGroups");
  if (cfg.ruleSources) fields.push("ruleSources");
  for (const [n, p] of Object.entries(cfg.profiles ?? {})) {
    for (const k of ["skills", "mcp", "agents"]) if (p[k]) fields.push(`profiles.${n}.${k}`);
  }
  for (const [n, t] of Object.entries(cfg.tiers ?? {})) if (t.skills) fields.push(`tiers.${n}.skills`);
  return fields;
}
function normalizeConfig(cfg) {
  const legacy = hasLegacy(cfg);
  if (!legacy.length) return { config: cfg, diagnostics: [] };
  const diagnostics = [diag("G310", `\u0417\u0430\u0441\u0442\u0430\u0440\u0456\u043B\u0438\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 gate.json: ${legacy.join(", ")}. \u041A\u043E\u043D\u0432\u0435\u0440\u0442\u043E\u0432\u0430\u043D\u043E \u0432 groups; \u0437\u0430\u043F\u0443\u0441\u0442\u0438 \`context-gate migrate\`.`)];
  const sg = cfg.skillGroups ?? {};
  const mg = cfg.mcpGroups ?? {};
  const groups = {};
  for (const [k, v] of Object.entries(cfg.groups ?? {})) groups[k] = [...v];
  const add = (name, globs) => {
    groups[name] = uniq([...groups[name] ?? [], ...globs]);
  };
  const skillGlobs = (name) => (sg[name] ?? []).map((g) => prefixKind("skill", g));
  const mcpGlobs = (name) => (mg[name] ?? []).map(mcpServerGlob);
  for (const name of Object.keys(sg)) add(name, skillGlobs(name));
  for (const name of Object.keys(mg)) add(name, mcpGlobs(name));
  const collides = (name) => name in sg && name in mg;
  const refFor = (name, kind, where) => {
    if (kind === "skills" && !(name in sg) && !(name in mg) && !(name in (cfg.groups ?? {}))) {
      diagnostics.push(diag("G304", `${where}: \u0433\u0440\u0443\u043F\u0430 "${name}" \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u0430 \u0432 skillGroups`));
      return void 0;
    }
    if (kind === "mcp" && !(name in mg) && !(name in sg) && !(name in (cfg.groups ?? {}))) {
      diagnostics.push(diag("G304", `${where}: \u0433\u0440\u0443\u043F\u0430 "${name}" \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u0430 \u0432 mcpGroups`));
      return void 0;
    }
    if (!collides(name)) return name;
    const split = `${name}-${kind}`;
    add(split, kind === "skills" ? skillGlobs(name) : mcpGlobs(name));
    return split;
  };
  const convertRefs = (skills, mcp, where) => {
    const s = new Set(skills ?? []);
    const m = new Set(mcp ?? []);
    const out2 = [];
    for (const name of uniq([...s, ...m])) {
      if (s.has(name) && m.has(name)) {
        out2.push(name);
        continue;
      }
      const r = refFor(name, s.has(name) ? "skills" : "mcp", where);
      if (r) out2.push(r);
    }
    return out2;
  };
  const profiles = {};
  for (const [name, p] of Object.entries(cfg.profiles ?? {})) {
    const { skills, mcp, agents, ...rest } = p;
    const refs = [...p.groups ?? [], ...convertRefs(skills, mcp, `profiles.${name}`)];
    if (agents && agents.length) {
      const g = `${name}-agents`;
      add(g, agents.map((a) => prefixKind("agent", a)));
      refs.push(g);
    }
    profiles[name] = { ...rest, groups: uniq(refs) };
  }
  const tiers = {};
  for (const [name, t] of Object.entries(cfg.tiers ?? {})) {
    const { skills, ...rest } = t;
    tiers[name] = { ...rest, groups: uniq([...t.groups ?? [], ...convertRefs(skills, void 0, `tiers.${name}`)]) };
  }
  const out = { ...cfg, groups, profiles, tiers };
  delete out.skillGroups;
  delete out.mcpGroups;
  if (cfg.ruleSources) {
    out.itemSources = [...cfg.itemSources ?? [], ...cfg.ruleSources.filter((r) => !(cfg.itemSources ?? []).some((i) => sameSource(i, r)))];
    delete out.ruleSources;
  }
  if (cfg.profiles === void 0) delete out.profiles;
  if (cfg.tiers === void 0) delete out.tiers;
  return { config: out, diagnostics };
}
function sameSource(a, b) {
  return a.kind === b.kind && a.dir === b.dir && a.name === b.name;
}
function prefixKind(kind, glob) {
  const neg = glob.startsWith("!");
  const g = neg ? glob.slice(1) : glob;
  return (neg ? "!" : "") + (/^(skill|tool|agent|rule|section|datum):/.test(g) ? g : `${kind}:${g}`);
}
function mcpServerGlob(server) {
  const neg = server.startsWith("!");
  const s = neg ? server.slice(1) : server;
  if (s.startsWith("tool:")) return server;
  return (neg ? "!" : "") + (s.startsWith("mcp__") ? `tool:${s}` : `tool:mcp__${s}__*`);
}
function normalizeModelId(model) {
  return model.trim().replace(/\[[^\]]*\]$/, "").replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
}
var DEFAULT_THRESHOLDS = { premium: { minCostPer1k: 0.01 }, standard: { minCostPer1k: 2e-3 }, quick: {} };
function meets(t, a) {
  const cw = a.contextWindow;
  const cost = a.costPer1k;
  if (t.minContextWindow !== void 0 && (cw === void 0 || cw < t.minContextWindow)) return false;
  if (t.maxContextWindow !== void 0 && (cw === void 0 || cw > t.maxContextWindow)) return false;
  if (t.minCostPer1k !== void 0 && (cost === void 0 || cost < t.minCostPer1k)) return false;
  if (t.maxCostPer1k !== void 0 && (cost === void 0 || cost > t.maxCostPer1k)) return false;
  return true;
}
function inferTier(cfg, attrs) {
  if (attrs.contextWindow === void 0 && attrs.costPer1k === void 0) return void 0;
  const tiers = Object.entries(cfg.tiers ?? {});
  const declared = tiers.filter(([, t]) => t.thresholds);
  const table = declared.length ? declared.map(([n, t]) => [n, t.thresholds]) : Object.keys(DEFAULT_THRESHOLDS).filter((n) => tiers.some(([k]) => k === n)).map((n) => [n, DEFAULT_THRESHOLDS[n]]);
  for (const [name, t] of table) if (meets(t, attrs)) return name;
  return void 0;
}
function attrText(a) {
  return [a.contextWindow !== void 0 ? `contextWindow ${a.contextWindow}` : "", a.costPer1k !== void 0 ? `costPer1k ${a.costPer1k}` : ""].filter(Boolean).join(", ");
}
function tierForModel(cfg, modelId, attrs) {
  if (!modelId) return { tier: DEFAULT_TIER, reason: `\u043C\u043E\u0434\u0435\u043B\u044C \u043D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u2192 ${DEFAULT_TIER}`, fallback: true };
  const id = normalizeModelId(modelId);
  const models = cfg.models ?? {};
  const resolve2 = (key, how, v) => {
    if (typeof v === "string") return { tier: v, reason: `\u043C\u043E\u0434\u0435\u043B\u044C ${id} ${how} \u2192 ${v}`, matched: key, fallback: false };
    if (v.tier) return { tier: v.tier, reason: `\u043C\u043E\u0434\u0435\u043B\u044C ${id} ${how} \u2192 ${v.tier}`, matched: key, fallback: false };
    const a = { ...attrs, ...v.contextWindow !== void 0 ? { contextWindow: v.contextWindow } : {}, ...v.costPer1k !== void 0 ? { costPer1k: v.costPer1k } : {} };
    const t = inferTier(cfg, a);
    if (t) return { tier: t, reason: `\u043C\u043E\u0434\u0435\u043B\u044C ${id} ${how}: ${attrText(a)} \u2192 \u043F\u043E\u0440\u0456\u0433 tier ${t}`, matched: key, fallback: false };
    return { tier: DEFAULT_TIER, reason: `\u043C\u043E\u0434\u0435\u043B\u044C ${id} ${how}: \u0430\u0442\u0440\u0438\u0431\u0443\u0442\u0438 (${attrText(a) || "\u2014"}) \u043D\u0435 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0430\u044E\u0442\u044C \u043F\u043E\u0440\u043E\u0433\u0430\u043C \u0436\u043E\u0434\u043D\u043E\u0433\u043E tier \u2192 ${DEFAULT_TIER}`, matched: key, fallback: true };
  };
  const exact = models[id];
  if (exact !== void 0 && (typeof exact === "string" || !exact.match)) return resolve2(id, "\u2192", exact);
  for (const [key, v] of Object.entries(models)) {
    const glob = typeof v === "string" ? key : v.match ?? key;
    if (compileGlob(glob, { nocase: true })(id)) return resolve2(key, `~ ${glob}`, v);
  }
  if (attrs) {
    const t = inferTier(cfg, attrs);
    if (t) return { tier: t, reason: `\u043C\u043E\u0434\u0435\u043B\u044C ${id} \u043D\u0435\u043C\u0430\u0454 \u0432 models; ${attrText(attrs)} \u2192 \u043F\u043E\u0440\u0456\u0433 tier ${t}`, fallback: false };
  }
  return { tier: DEFAULT_TIER, reason: `\u043C\u043E\u0434\u0435\u043B\u044C ${id} \u043D\u0435 \u0437\u0431\u0456\u0433\u0430\u0454\u0442\u044C\u0441\u044F \u0437 \u0436\u043E\u0434\u043D\u0438\u043C glob \u0443 models \u2192 ${DEFAULT_TIER}`, fallback: true };
}
var DEBUG_LOG_MAX_BYTES = 1024 * 1024;

// packages/core/src/items.ts
var ITEM_KINDS = ["skill", "tool", "agent", "rule", "section", "datum"];
function itemId(kind, name) {
  return `${kind}:${name}`;
}
function parseItemId(id) {
  const i = id.indexOf(":");
  if (i > 0) {
    const k = id.slice(0, i);
    if (ITEM_KINDS.includes(k)) return { kind: k, name: id.slice(i + 1) };
  }
  return { name: id };
}
function isMcpTool(item) {
  return item.kind === "tool" && item.name.startsWith("mcp__");
}
function mcpServerOf(toolName) {
  const m = /^mcp__(.+?)__/.exec(toolName);
  return m ? m[1] : void 0;
}
function makeItem(kind, name, extra = {}) {
  const it = {
    kind,
    id: itemId(kind, name),
    name,
    attach: { when: kind === "rule" ? "manual" : "on-demand" },
    cost: { chars: 0 },
    provenance: { source: "unknown" },
    ...extra
  };
  if (!extra.cost) it.cost = { chars: itemChars(it) };
  return it;
}
function itemChars(it) {
  if (it.body) return it.body.length;
  return (it.description?.length ?? 0) + it.name.length;
}
function groupMatches(groupPattern, item) {
  const { pattern } = splitNegation(groupPattern.trim());
  const { kind, name } = parseItemId(pattern);
  if (kind && kind !== item.kind) return false;
  return compileGlob(name)(item.name);
}
function expandGroups(cfg, groupNames, items) {
  const out = /* @__PURE__ */ new Set();
  for (const g of groupNames) {
    const pats = cfg.groups?.[g];
    if (!pats) continue;
    const pos = pats.filter((p) => !p.trim().startsWith("!"));
    const neg = pats.filter((p) => p.trim().startsWith("!"));
    for (const it of items) {
      if (pos.some((p) => groupMatches(p, it)) && !neg.some((p) => groupMatches(p, it))) out.add(it.id);
    }
  }
  return out;
}
function groupsOf(cfg, item) {
  const out = [];
  for (const [g, pats] of Object.entries(cfg.groups ?? {})) {
    const pos = pats.filter((p) => !p.trim().startsWith("!"));
    const neg = pats.filter((p) => p.trim().startsWith("!"));
    if (pos.some((p) => groupMatches(p, item)) && !neg.some((p) => groupMatches(p, item))) out.push(g);
  }
  return out;
}

// packages/core/src/decide.ts
var PROFILE_UNION = "+";
function profileParts(profile) {
  return profile ? profile.split(PROFILE_UNION).filter(Boolean) : [];
}
function whenMatches(when, signals, opts, reasons, name) {
  if (!when) return void 0;
  if (when.paths?.length) {
    for (const p of signals.paths) {
      if (matchAny(p, when.paths, [], { matchBase: true })) return { trigger: "when:paths", detail: `${p} ~ ${when.paths.join(", ")}` };
    }
  }
  if (when.branch && signals.branch) {
    try {
      if (new RegExp(when.branch).test(signals.branch)) return { trigger: "when:branch", detail: `\u0433\u0456\u043B\u043A\u0430 ${signals.branch} ~ /${when.branch}/` };
    } catch {
      reasons.push(`\u043F\u0440\u043E\u0444\u0456\u043B\u044C ${name}: \u043D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 regex \u0433\u0456\u043B\u043A\u0438 /${when.branch}/`);
    }
  }
  if (when.ticketType?.length && signals.ticketType && when.ticketType.includes(signals.ticketType)) {
    return { trigger: "when:ticketType", detail: `\u0442\u0438\u043F \u0442\u0456\u043A\u0435\u0442\u0430 ${signals.ticketType}` };
  }
  if (when.expr && opts.evalExpr) {
    try {
      if (opts.evalExpr(when.expr, signals.data ?? {})) return { trigger: "when:expr", detail: `\u0432\u0438\u0440\u0430\u0437 ${when.expr}` };
    } catch (e) {
      reasons.push(`\u043F\u0440\u043E\u0444\u0456\u043B\u044C ${name}: \u043F\u043E\u043C\u0438\u043B\u043A\u0430 \u0432\u0438\u0440\u0430\u0437\u0443 ${when.expr}: ${e.message}`);
    }
  }
  return void 0;
}
function hasLegacy2(cfg) {
  return !!(cfg.skillGroups || cfg.mcpGroups || Object.values(cfg.profiles ?? {}).some((p) => p.skills || p.mcp || p.agents) || Object.values(cfg.tiers ?? {}).some((t) => t.skills));
}
function resolveGroupRef(cfg, name) {
  if (cfg.groups?.[name]) return [name];
  const p = cfg.profiles?.[name];
  if (p) return p.groups ?? [];
  return [name];
}
function decideGate(config, signals, state, items, opts = {}) {
  const cfg = hasLegacy2(config) ? normalizeConfig(config).config : config;
  const reason = [];
  const turn = (state.turn ?? 0) + 1;
  const ts = opts.now ?? 0;
  const needTurns = opts.hysteresisTurns ?? 2;
  const t = opts.tier ? { tier: opts.tier, reason: `tier ${opts.tier} \u0437\u0430\u0434\u0430\u043D\u043E \u044F\u0432\u043D\u043E`, fallback: false } : tierForModel(cfg, signals.model);
  const tier = t.tier;
  reason.push((signals.agentId ? `\u0441\u0443\u0431\u0430\u0433\u0435\u043D\u0442 ${signals.agentId}: ` : "") + t.reason);
  if ((signals.model || opts.tier) && !cfg.tiers?.[tier]) reason.push(`tier ${tier} \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u043E \u0432 tiers`);
  if (signals.manual?.off) {
    const gate2 = allOn(items, tier, state.profile, ["/gate off: \u0444\u0456\u043B\u044C\u0442\u0440\u0430\u0446\u0456\u044E \u0432\u0438\u043C\u043A\u043D\u0435\u043D\u043E, \u0443\u0441\u0435 \u0443\u0432\u0456\u043C\u043A\u043D\u0435\u043D\u043E", ...reason]);
    const newState3 = { ...state, turn };
    return { gate: gate2, state: newState3, log: logOf(gate2, turn, ts) };
  }
  let profile = state.profile;
  let source = state.profileSource;
  let pending = state.pending;
  let trigger;
  let proposed;
  const recheck = !!opts.recheck || state.profileSource === "manual" && !signals.manual?.profile;
  const mode = cfg.classify?.mode ?? "shadow";
  const minConf = cfg.classify?.minConfidence ?? 0.7;
  let classifyCandidate;
  if (signals.classified) {
    const { profile: cp, confidence } = signals.classified;
    const known = !!cfg.profiles?.[cp];
    if (!known) reason.push(`\u043A\u043B\u0430\u0441\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440: \u043F\u0440\u043E\u0444\u0456\u043B\u044C ${cp} \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u043E`);
    else if (mode === "shadow") {
      proposed = { profile: cp, confidence };
      reason.push(`\u043A\u043B\u0430\u0441\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440 (shadow): ${cp} ${confidence.toFixed(2)} \u2014 \u043B\u0438\u0448\u0435 \u0432 \u0436\u0443\u0440\u043D\u0430\u043B`);
    } else if (confidence >= minConf) {
      classifyCandidate = cp;
    } else {
      reason.push(`\u043A\u043B\u0430\u0441\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440: ${cp} ${confidence.toFixed(2)} < ${minConf} \u2192 \u043D\u0435 \u0437\u0430\u0441\u0442\u043E\u0441\u043E\u0432\u0430\u043D\u043E`);
    }
  }
  if (signals.manual?.profile) {
    const mp = signals.manual.profile;
    if (!profileParts(mp).every((p) => cfg.profiles?.[p])) reason.push(`\u0440\u0443\u0447\u043D\u0438\u0439 \u043F\u0440\u043E\u0444\u0456\u043B\u044C ${mp} \u043D\u0435 \u043E\u0433\u043E\u043B\u043E\u0448\u0435\u043D\u043E \u0432 profiles`);
    if (profile !== mp || source !== "manual") reason.push(`/gate ${mp}: \u043F\u0440\u043E\u0444\u0456\u043B\u044C \u0437\u0430\u0444\u0456\u043A\u0441\u043E\u0432\u0430\u043D\u043E \u0432\u0440\u0443\u0447\u043D\u0443`);
    else reason.push(`\u043F\u0440\u043E\u0444\u0456\u043B\u044C ${mp} \u0437\u0430\u0444\u0456\u043A\u0441\u043E\u0432\u0430\u043D\u043E \u0432\u0440\u0443\u0447\u043D\u0443`);
    profile = mp;
    source = "manual";
    trigger = "manual";
    pending = void 0;
  } else {
    if (recheck) {
      reason.push(opts.recheckReason === "compact" ? "compaction: \u043F\u0440\u043E\u0444\u0456\u043B\u044C \u043F\u0435\u0440\u0435\u0440\u0430\u0445\u043E\u0432\u0430\u043D\u043E" : opts.recheckReason === "auto" || state.profileSource === "manual" ? "/gate auto: \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0442\u043E \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u043A\u0443" : "/gate new: \u043F\u0435\u0440\u0435\u043A\u043B\u0430\u0441\u0438\u0444\u0456\u043A\u0430\u0446\u0456\u044F");
    }
    const hits = [];
    for (const [name, p] of Object.entries(cfg.profiles ?? {})) {
      const hit = whenMatches(p.when, signals, opts, reason, name);
      if (hit) hits.push({ name, hit });
    }
    let candidate;
    let candTrigger;
    if (hits.length) {
      candidate = hits.map((h) => h.name).join(PROFILE_UNION);
      candTrigger = hits[0].hit.trigger;
      for (const h of hits) reason.push(`${h.hit.trigger}: ${h.hit.detail} \u2192 ${h.name}`);
      if (hits.length > 1) reason.push(`\u0437\u0431\u0456\u0433 \u043A\u0456\u043B\u044C\u043A\u043E\u0445 \u043F\u0440\u043E\u0444\u0456\u043B\u0456\u0432 \u2192 \u043E\u0431'\u0454\u0434\u043D\u0430\u043D\u043D\u044F ${candidate}`);
    } else if (classifyCandidate) {
      candidate = classifyCandidate;
      candTrigger = "classify";
    }
    const isFirst = profile === void 0 || recheck;
    if (candidate === void 0) {
      if (recheck) {
        profile = void 0;
        source = void 0;
      }
      pending = void 0;
    } else if (candidate === profile && !recheck) {
      pending = void 0;
    } else if (isFirst) {
      profile = candidate;
      source = candTrigger;
      trigger = candTrigger;
      pending = void 0;
      if (candTrigger === "classify") reason.push(`\u043A\u043B\u0430\u0441\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440: ${candidate} ${signals.classified.confidence.toFixed(2)} \u2265 ${minConf} \u2192 \u0437\u0430\u0441\u0442\u043E\u0441\u043E\u0432\u0430\u043D\u043E`);
    } else if (candTrigger === "classify") {
      reason.push(`\u043A\u043B\u0430\u0441\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440 \u043F\u0440\u043E\u043F\u043E\u043D\u0443\u0454 ${candidate}, \u0430\u043B\u0435 \u043F\u0440\u043E\u0444\u0456\u043B\u044C ${profile} \u0441\u0442\u0430\u0431\u0456\u043B\u044C\u043D\u0438\u0439 \u0434\u043E /gate new`);
      pending = void 0;
    } else {
      const count = pending?.profile === candidate ? pending.count + 1 : 1;
      if (count >= needTurns) {
        reason.push(`\u0433\u0456\u0441\u0442\u0435\u0440\u0435\u0437\u0438\u0441: ${candidate} ${count} \u0445\u043E\u0434\u0438 \u043F\u043E\u0441\u043F\u0456\u043B\u044C \u2192 \u0437\u043C\u0456\u043D\u0430 \u043F\u0440\u043E\u0444\u0456\u043B\u044E \u0437 ${profile}`);
        profile = candidate;
        source = candTrigger;
        trigger = candTrigger;
        pending = void 0;
      } else {
        reason.push(`\u0433\u0456\u0441\u0442\u0435\u0440\u0435\u0437\u0438\u0441: ${candidate} (${count}/${needTurns}), \u043F\u0440\u043E\u0444\u0456\u043B\u044C ${profile} \u043B\u0438\u0448\u0430\u0454\u0442\u044C\u0441\u044F`);
        pending = { profile: candidate, count };
      }
    }
  }
  if (!trigger) {
    if (profile) trigger = opts.recheckReason === "compact" ? "compact" : source ?? "tier";
    else trigger = t.fallback ? "default" : "tier";
    if (opts.prevModel && signals.model && opts.prevModel !== signals.model) trigger = "model-change";
    if (opts.recheckReason === "compact") trigger = "compact";
  }
  if (!profile) {
    reason.push(t.fallback ? `\u043F\u0440\u043E\u0444\u0456\u043B\u044C \u043D\u0435 \u0432\u0438\u0437\u043D\u0430\u0447\u0435\u043D\u043E; ${t.reason} (\u043F\u043E\u043F\u0435\u0440\u0435\u0434\u0436\u0435\u043D\u043D\u044F: \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u043D\u043E tier \u0437\u0430 \u0437\u0430\u043C\u043E\u0432\u0447\u0443\u0432\u0430\u043D\u043D\u044F\u043C)` : `\u043F\u0440\u043E\u0444\u0456\u043B\u044C \u043D\u0435 \u0432\u0438\u0437\u043D\u0430\u0447\u0435\u043D\u043E \u2192 \u043D\u0430\u0431\u0456\u0440 tier ${tier}`);
  }
  const tierCfg = cfg.tiers?.[tier];
  const active = new Set(tierCfg?.groups ?? []);
  for (const p of profileParts(profile)) for (const g of cfg.profiles?.[p]?.groups ?? []) active.add(g);
  for (const a of signals.manual?.add ?? []) for (const g of resolveGroupRef(cfg, a)) {
    active.add(g);
    reason.push(`/gate +${a}: \u0433\u0440\u0443\u043F\u0430 ${g}`);
  }
  for (const r of signals.manual?.remove ?? []) for (const g of resolveGroupRef(cfg, r)) {
    active.delete(g);
    reason.push(`/gate -${r}: \u0433\u0440\u0443\u043F\u0430 ${g}`);
  }
  const groups = [...active];
  const noGroups = !Object.keys(cfg.groups ?? {}).length;
  if (noGroups) reason.push("\u0443 gate.json \u043D\u0435\u043C\u0430\u0454 \u0433\u0440\u0443\u043F \u2192 \u0443\u0441\u0435 \u0443\u0432\u0456\u043C\u043A\u043D\u0435\u043D\u043E");
  const enabled = expandGroups(cfg, groups, items);
  const preloadPats = (tierCfg?.preload ?? []).map((p) => p.replace(/^skill:/, ""));
  const preloadMatch = preloadPats.map((p) => compileGlob(p));
  const decisions = {};
  const gate = {
    profile,
    tier,
    trigger,
    off: false,
    skills: { on: [], nameOnly: [], off: [], preload: [] },
    mcp: { on: [], off: [] },
    agents: { on: [], off: [] },
    rules: { on: [], off: [] },
    items: decisions,
    groups,
    reason
  };
  if (proposed) gate.proposed = proposed;
  for (const it of items) {
    let d;
    const grouped = noGroups ? false : groupsOf(cfg, it).length > 0;
    if (it.kind === "skill" && preloadMatch.some((m) => m(it.name))) d = "preload";
    else if (noGroups || enabled.has(it.id)) d = "on";
    else if (it.kind === "section" || it.kind === "datum") d = "on";
    else if (grouped) d = "off";
    else if (it.kind === "tool" && !isMcpTool(it)) d = "on";
    else if (it.kind === "skill") d = "nameOnly";
    else if (it.kind === "tool") d = "off";
    else d = "on";
    decisions[it.id] = d;
    switch (it.kind) {
      case "skill":
        if (d === "preload") gate.skills.preload.push(it.name);
        else gate.skills[d === "nameOnly" ? "nameOnly" : d === "off" ? "off" : "on"].push(it.name);
        break;
      case "tool":
        if (isMcpTool(it)) gate.mcp[d === "off" ? "off" : "on"].push(it.name);
        break;
      case "agent":
        gate.agents[d === "off" ? "off" : "on"].push(it.name);
        break;
      case "rule":
        gate.rules[d === "off" ? "off" : "on"].push(it.name);
        break;
    }
  }
  if (gate.skills.preload.length) reason.push(`preload \u0434\u043B\u044F tier ${tier}: ${gate.skills.preload.join(", ")}`);
  if (gate.mcp.off.length) {
    const servers = [...new Set(gate.mcp.off.map((n) => mcpServerOf(n) ?? n))];
    reason.push(`MCP \u043F\u043E\u0437\u0430 \u043F\u0440\u043E\u0444\u0456\u043B\u0435\u043C \u0432\u0438\u043C\u043A\u043D\u0435\u043D\u043E: ${servers.join(", ")}`);
  }
  const newState2 = { turn, profile, profileSource: source };
  if (pending) newState2.pending = pending;
  return { gate, state: newState2, log: logOf(gate, turn, ts) };
}
function allOn(items, tier, profile, reason) {
  const gate = {
    profile,
    tier,
    trigger: "off",
    off: true,
    skills: { on: [], nameOnly: [], off: [], preload: [] },
    mcp: { on: [], off: [] },
    agents: { on: [], off: [] },
    rules: { on: [], off: [] },
    items: {},
    groups: [],
    reason
  };
  for (const it of items) {
    gate.items[it.id] = "on";
    if (it.kind === "skill") gate.skills.on.push(it.name);
    else if (it.kind === "tool" && isMcpTool(it)) gate.mcp.on.push(it.name);
    else if (it.kind === "agent") gate.agents.on.push(it.name);
    else if (it.kind === "rule") gate.rules.on.push(it.name);
  }
  return gate;
}
function logOf(gate, turn, ts) {
  const enabled = [];
  const disabled = [];
  for (const [id, d] of Object.entries(gate.items)) (d === "off" ? disabled : enabled).push(id);
  const entry = { ts, turn, trigger: gate.trigger, tier: gate.tier, enabled, disabled, reason: gate.reason, kind: "decision" };
  if (gate.profile) entry.profile = gate.profile;
  if (gate.proposed) entry.data = { proposed: gate.proposed };
  return entry;
}
function profileLabel(gate) {
  if (gate.off) return "off";
  return gate.profile ? `\u043F\u0440\u043E\u0444\u0456\u043B\u0435\u043C ${gate.profile}` : `tier ${gate.tier}`;
}
function enablingGroup(kind, name, config) {
  const cfg = hasLegacy2(config) ? normalizeConfig(config).config : config;
  const gs = groupsOf(cfg, { kind, name });
  if (!gs.length) return void 0;
  return gs.find((g) => cfg.profiles?.[g]) ?? gs[0];
}
function denyText(kind, name, gate, config) {
  const display = kind === "tool" && name.startsWith("mcp__") ? mcpServerOf(name) ?? name : name;
  const g = enablingGroup(kind, name, config);
  const how = g ? `/gate +${g}` : "/gate off";
  return `${display} \u0432\u0438\u043C\u043A\u043D\u0435\u043D\u043E ${profileLabel(gate)}. \u041A\u043E\u0440\u0438\u0441\u0442\u0443\u0432\u0430\u0447 \u043C\u043E\u0436\u0435 \u0443\u0432\u0456\u043C\u043A\u043D\u0443\u0442\u0438: ${how}`;
}
function statusLine(gate, extra = {}) {
  const s = gate.skills;
  const skillsTotal = s.on.length + s.nameOnly.length + s.off.length + s.preload.length;
  const mcpTotal = gate.mcp.on.length + gate.mcp.off.length;
  const rulesTotal = gate.rules.on.length + gate.rules.off.length;
  const proposal = gate.proposed?.profile ?? (gate.shadow ? gate.profile : void 0);
  const prof = gate.off ? "off" : gate.shadow ? proposal ? `(${proposal}?)` : "\u2014" : gate.profile ?? (gate.proposed ? `(${gate.proposed.profile}?)` : "\u2014");
  const skillsOn = gate.shadow || gate.off ? skillsTotal : s.on.length + s.preload.length;
  const mcpOn = gate.shadow || gate.off ? mcpTotal : gate.mcp.on.length;
  const rulesOn = gate.shadow || gate.off ? rulesTotal : gate.rules.on.length;
  const parts = [`gate ${prof}`, `tier ${gate.tier}`, `skills ${skillsOn}/${skillsTotal}`, `mcp ${mcpOn}/${mcpTotal}`, `rules ${rulesOn}`];
  if (extra.ctxPct !== void 0) parts.push(`ctx ${Math.round(extra.ctxPct)}%`);
  return parts.join(" \xB7 ");
}
function skillOverridesFor(gate, opts = {}) {
  const out = {};
  const name = (n) => n.replace(/^skill:/, "");
  for (const n of gate.skills.nameOnly) out[name(n)] = "name-only";
  for (const n of gate.skills.off) out[name(n)] = opts.hard ? "off" : "user-invocable-only";
  return out;
}

// packages/core/src/expr.ts
var BUILTINS = ["len", "min", "max", "abs", "round", "floor", "ceil"];
var FILTERS = ["take", "sort", "grep", "map", "join", "truncate", "fence", "unique", "where", "len", "round", "ago"];
var BUILTIN_SET = new Set(BUILTINS);
var FILTER_SET = new Set(FILTERS);
var OPS3 = ["===", "!=="];
var OPS2 = ["?.", "??", "&&", "||", "==", "!=", "<=", ">="];
var OPS1 = "!~+-*/%()[],.?:|=<>";
var isIdStart = (c) => /[A-Za-z_$]/.test(c);
var isIdChar = (c) => /[A-Za-z0-9_$]/.test(c);
function tokenize(src, diags) {
  const toks = [];
  let i = 0;
  let afterDot = false;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      i++;
      afterDot = false;
      continue;
    }
    const start = i;
    if (afterDot && isIdChar(c)) {
      let j = i;
      while (j < src.length && (isIdChar(src[j]) || src[j] === "-" && j + 1 < src.length && isIdChar(src[j + 1]) && j > i)) j++;
      toks.push({ t: "id", v: src.slice(i, j), pos: start });
      i = j;
      afterDot = false;
      continue;
    }
    afterDot = false;
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j);
      toks.push({ t: "num", v: text, num: Number(text), pos: start });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < src.length && isIdChar(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j), pos: start });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = "";
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          out += e === "n" ? "\n" : e === "t" ? "	" : e === "r" ? "\r" : e;
          j += 2;
          continue;
        }
        if (d === c) {
          closed = true;
          j++;
          break;
        }
        out += d;
        j++;
      }
      if (!closed) diags.push({ code: "G102", severity: "error", message: `\u041D\u0435\u0437\u0430\u043A\u0440\u0438\u0442\u0438\u0439 \u0440\u044F\u0434\u043E\u043A \u0443 \u0432\u0438\u0440\u0430\u0437\u0456 \u0437 \u043F\u043E\u0437\u0438\u0446\u0456\u0457 ${start}` });
      toks.push({ t: "str", v: out, pos: start });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) {
      toks.push({ t: "op", v: three.slice(0, 2), pos: start });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      toks.push({ t: "op", v: two, pos: start });
      i += 2;
      if (two === "?.") afterDot = true;
      continue;
    }
    if (OPS1.includes(c)) {
      toks.push({ t: "op", v: c, pos: start });
      i++;
      if (c === ".") afterDot = true;
      continue;
    }
    diags.push({ code: "G101", severity: "error", message: `\u041D\u0435\u043E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u0438\u0439 \u0441\u0438\u043C\u0432\u043E\u043B \xAB${c}\xBB \u0443 \u0432\u0438\u0440\u0430\u0437\u0456 \u043D\u0430 \u043F\u043E\u0437\u0438\u0446\u0456\u0457 ${start}` });
    i++;
  }
  toks.push({ t: "eof", v: "", pos: src.length });
  return toks;
}
var ParseFail = class extends Error {
};
var BIN_BP = {
  "??": 3,
  "||": 4,
  "&&": 5,
  "==": 6,
  "!=": 6,
  "~": 6,
  "<": 7,
  "<=": 7,
  ">": 7,
  ">=": 7,
  in: 7,
  "+": 8,
  "-": 8,
  "*": 9,
  "/": 9,
  "%": 9
};
var Parser = class {
  toks;
  i = 0;
  diags;
  src;
  constructor(toks, diags, src) {
    this.toks = toks;
    this.diags = diags;
    this.src = src;
  }
  peek() {
    return this.toks[this.i];
  }
  next() {
    return this.toks[this.i++];
  }
  isOp(v) {
    const t = this.peek();
    return t.t === "op" && t.v === v;
  }
  fail(message, code = "G101") {
    this.diags.push({ code, severity: "error", message: `${message} \u0443 \xAB${this.src}\xBB` });
    throw new ParseFail(message);
  }
  expectOp(v) {
    if (!this.isOp(v)) this.fail(`\u041E\u0447\u0456\u043A\u0443\u0432\u0430\u043B\u043E\u0441\u044C \xAB${v}\xBB, \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E \xAB${this.peek().v || "\u043A\u0456\u043D\u0435\u0446\u044C"}\xBB`);
    this.i++;
  }
  lbp(t) {
    if (t.t === "op") {
      if (t.v === "|") return 1;
      if (t.v === "?") return 2;
      if (t.v === "." || t.v === "?." || t.v === "[" || t.v === "(") return 11;
      return BIN_BP[t.v] ?? 0;
    }
    if (t.t === "id" && t.v === "in") return 7;
    return 0;
  }
  expr(rbp) {
    let left = this.nud();
    while (rbp < this.lbp(this.peek())) left = this.led(left);
    return left;
  }
  nud() {
    const t = this.next();
    if (t.t === "num") return { k: "lit", v: t.num ?? 0 };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "id") {
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (t.v === "null" || t.v === "undefined") return { k: "lit", v: null };
      return { k: "id", name: t.v };
    }
    if (t.t === "op") {
      if (t.v === "(") {
        const e = this.expr(0);
        this.expectOp(")");
        return e;
      }
      if (t.v === "[") {
        const items = [];
        if (!this.isOp("]")) {
          for (; ; ) {
            items.push(this.expr(0));
            if (this.isOp(",")) {
              this.i++;
              if (this.isOp("]")) break;
              continue;
            }
            break;
          }
        }
        this.expectOp("]");
        return { k: "list", items };
      }
      if (t.v === "!" || t.v === "-") return { k: "unary", op: t.v, arg: this.expr(10) };
      if (t.v === "+") return this.expr(10);
    }
    return this.fail(t.t === "eof" ? "\u041D\u0435\u043E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u0438\u0439 \u043A\u0456\u043D\u0435\u0446\u044C \u0432\u0438\u0440\u0430\u0437\u0443" : `\u041D\u0435\u043E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u0438\u0439 \u0442\u043E\u043A\u0435\u043D \xAB${t.v}\xBB`);
  }
  args() {
    const args = [];
    const kwargs = {};
    this.expectOp("(");
    if (!this.isOp(")")) {
      for (; ; ) {
        const t = this.peek();
        const n = this.toks[this.i + 1];
        if (t.t === "id" && n.t === "op" && n.v === "=") {
          this.i += 2;
          kwargs[t.v] = this.expr(0);
        } else {
          if (Object.keys(kwargs).length) this.fail("\u041F\u043E\u0437\u0438\u0446\u0456\u0439\u043D\u0438\u0439 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442 \u043F\u0456\u0441\u043B\u044F \u0456\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u043E\u0433\u043E");
          args.push(this.expr(0));
        }
        if (this.isOp(",")) {
          this.i++;
          continue;
        }
        break;
      }
    }
    this.expectOp(")");
    return { args, kwargs };
  }
  led(left) {
    const t = this.next();
    if (t.t === "id" && t.v === "in") return { k: "bin", op: "in", l: left, r: this.expr(7) };
    switch (t.v) {
      case ".":
      case "?.": {
        const p = this.next();
        if (p.t !== "id" && p.t !== "num") this.fail("\u041E\u0447\u0456\u043A\u0443\u0432\u0430\u043B\u043E\u0441\u044C \u0456\u043C'\u044F \u043F\u043E\u043B\u044F \u043F\u0456\u0441\u043B\u044F \xAB.\xBB");
        return { k: "member", obj: left, prop: p.v, optional: t.v === "?." || void 0 };
      }
      case "[": {
        const index = this.expr(0);
        this.expectOp("]");
        return { k: "index", obj: left, index };
      }
      case "(": {
        this.i--;
        const { args, kwargs } = this.args();
        const hasKw = Object.keys(kwargs).length > 0;
        if (left.k === "id") {
          if (!BUILTIN_SET.has(left.name)) {
            this.diags.push({ code: "G103", severity: "error", message: `\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0444\u0443\u043D\u043A\u0446\u0456\u044F \xAB${left.name}\xBB`, hint: `\u0412\u0431\u0443\u0434\u043E\u0432\u0430\u043D\u0456: ${BUILTINS.join(", ")}; \u0440\u0435\u0448\u0442\u0430 \u2014 \u0447\u0435\u0440\u0435\u0437 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 ns.fn(...)` });
            throw new ParseFail("unknown fn");
          }
          if (hasKw) this.fail(`\u0424\u0443\u043D\u043A\u0446\u0456\u044F ${left.name} \u043D\u0435 \u043F\u0440\u0438\u0439\u043C\u0430\u0454 \u0456\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0445 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432`, "G108");
          return { k: "builtin", fn: left.name, args };
        }
        if (left.k === "member" && (left.prop === "at" || left.prop === "in")) {
          if (args.length !== 1 || hasKw) this.fail(`.${left.prop}() \u043F\u0440\u0438\u0439\u043C\u0430\u0454 \u043E\u0434\u0438\u043D \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442`, "G105");
          return { k: "method", obj: left.obj, fn: left.prop, args };
        }
        const path = pathOf(left);
        if (!path) this.fail("\u0412\u0438\u043A\u043B\u0438\u043A\u0430\u0442\u0438 \u043C\u043E\u0436\u043D\u0430 \u043B\u0438\u0448\u0435 \u0444\u0443\u043D\u043A\u0446\u0456\u0457 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0456\u0432 (ns.fn) \u0456 \u0432\u0431\u0443\u0434\u043E\u0432\u0430\u043D\u0456 \u0444\u0443\u043D\u043A\u0446\u0456\u0457");
        return { k: "call", path, args, kwargs };
      }
      case "?": {
        const then = this.expr(1);
        this.expectOp(":");
        const els = this.expr(1);
        return { k: "cond", test: left, then, else: els };
      }
      case "|": {
        const f = this.next();
        if (f.t !== "id") this.fail("\u041F\u0456\u0441\u043B\u044F \xAB|\xBB \u043E\u0447\u0456\u043A\u0443\u0432\u0430\u043B\u043E\u0441\u044C \u0456\u043C'\u044F \u0444\u0456\u043B\u044C\u0442\u0440\u0430");
        if (this.isOp(".")) {
          this.diags.push({ code: "G154", severity: "error", message: `\u0412\u0438\u043A\u043B\u0438\u043A \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430 \xAB${f.v}.\u2026\xBB \u043D\u0435 \u043D\u0430 \u043F\u043E\u0447\u0430\u0442\u043A\u0443 \u043B\u0430\u043D\u0446\u044E\u0436\u043A\u0430 pipe`, hint: "\u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0442\u0438 \u0432\u0438\u043A\u043B\u0438\u043A \u043D\u0430 \u043F\u043E\u0447\u0430\u0442\u043E\u043A; \u0446\u044F \u043B\u043E\u0433\u0456\u043A\u0430 \u043C\u0430\u0454 \u0436\u0438\u0442\u0438 \u0432 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0456" });
          throw new ParseFail("G154");
        }
        if (!FILTER_SET.has(f.v)) {
          this.diags.push({ code: "G104", severity: "error", message: `\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u0444\u0456\u043B\u044C\u0442\u0440 \xAB${f.v}\xBB`, hint: `\u0414\u043E\u0437\u0432\u043E\u043B\u0435\u043D\u0456: ${FILTERS.join(", ")}` });
          throw new ParseFail("G104");
        }
        let args = [];
        if (this.isOp("(")) {
          const r = this.args();
          if (Object.keys(r.kwargs).length) this.fail(`\u0424\u0456\u043B\u044C\u0442\u0440 ${f.v} \u043D\u0435 \u043F\u0440\u0438\u0439\u043C\u0430\u0454 \u0456\u043C\u0435\u043D\u043E\u0432\u0430\u043D\u0438\u0445 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0456\u0432`, "G108");
          args = r.args;
        }
        const node = { k: "pipe", input: left, filter: f.v, args };
        if (f.v === "map" && args[0]?.k === "lit" && typeof args[0].v === "string" && args[0].v.includes("{{")) {
          const r = parseTemplate(args[0].v);
          this.diags.push(...r.diagnostics);
          node.tpl = r.parts;
        }
        return node;
      }
    }
    if (t.t === "op" && BIN_BP[t.v] !== void 0) {
      return { k: "bin", op: t.v, l: left, r: this.expr(BIN_BP[t.v]) };
    }
    return this.fail(`\u041D\u0435\u043E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u0438\u0439 \u0442\u043E\u043A\u0435\u043D \xAB${t.v}\xBB`);
  }
};
function pathOf(e) {
  if (e.k === "id") return e.name;
  if (e.k === "member") {
    const p = pathOf(e.obj);
    return p ? `${p}.${e.prop}` : void 0;
  }
  return void 0;
}
var parseCache = /* @__PURE__ */ new Map();
function parseExpr(src) {
  const hit = parseCache.get(src);
  if (hit) return hit;
  const diagnostics = [];
  let ast;
  if (!src.trim()) {
    diagnostics.push({ code: "G101", severity: "error", message: "\u041F\u043E\u0440\u043E\u0436\u043D\u0456\u0439 \u0432\u0438\u0440\u0430\u0437" });
  } else {
    const toks = tokenize(src, diagnostics);
    if (!diagnostics.some((d) => d.severity === "error")) {
      const p = new Parser(toks, diagnostics, src);
      try {
        ast = p.expr(0);
        if (p.peek().t !== "eof") p.fail(`\u0417\u0430\u0439\u0432\u0438\u0439 \u0442\u043E\u043A\u0435\u043D \xAB${p.peek().v}\xBB`);
      } catch (e) {
        if (!(e instanceof ParseFail)) throw e;
        ast = void 0;
      }
    }
  }
  const res = { ast: diagnostics.some((d) => d.severity === "error") ? void 0 : ast, diagnostics };
  if (parseCache.size > 5e3) parseCache.clear();
  parseCache.set(src, res);
  return res;
}
function templateClose(src, from) {
  let depth = 0;
  let quote;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = void 0;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{" && src[i + 1] === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" && src[i + 1] === "}") {
      if (depth === 0) return i;
      depth--;
      i++;
    }
  }
  return -1;
}
function splitTemplate(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    if (open < 0) {
      out.push({ text: src.slice(i) });
      break;
    }
    let close = templateClose(src, open + 2);
    if (close < 0) close = src.indexOf("}}", open + 2);
    if (close < 0) {
      out.push({ text: src.slice(i) });
      break;
    }
    if (open > i) out.push({ text: src.slice(i, open) });
    out.push({ expr: src.slice(open + 2, close).trim() });
    i = close + 2;
  }
  return out;
}
function parseTemplate(src) {
  const diagnostics = [];
  const parts = [];
  for (const p of splitTemplate(src)) {
    if ("text" in p) {
      parts.push(p.text);
      continue;
    }
    const r = parseExpr(p.expr);
    diagnostics.push(...r.diagnostics);
    parts.push(r.ast ?? { k: "lit", v: null });
  }
  return { parts, diagnostics };
}
var DEFAULT_STEP_LIMIT = 1e4;
function newBudget(limit = DEFAULT_STEP_LIMIT) {
  return { steps: 0, limit };
}
var StepLimitError = class extends Error {
  constructor(limit) {
    super(`G155: \u043F\u0435\u0440\u0435\u0432\u0438\u0449\u0435\u043D\u043E \u043B\u0456\u043C\u0456\u0442 \u043A\u0440\u043E\u043A\u0456\u0432 ${limit}`);
  }
};
function step(b, n = 1) {
  b.steps += n;
  if (b.steps > b.limit) throw new StepLimitError(b.limit);
}
var hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
var isObj2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function truthy(v) {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  if (typeof v === "number" && Number.isNaN(v)) return false;
  return true;
}
function toText(v) {
  if (v === null || v === void 0) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map((x) => isObj2(x) || Array.isArray(x) ? JSON.stringify(x) : toText(x)).join(", ");
  return JSON.stringify(v);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj2(a) && isObj2(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}
function getProp(v, prop) {
  if (Array.isArray(v)) {
    if (prop === "length") return v.length;
    if (/^-?\d+$/.test(prop)) return v[Number(prop)] ?? null;
    return null;
  }
  if (typeof v === "string") return prop === "length" ? v.length : null;
  if (isObj2(v)) return hasOwn(v, prop) ? v[prop] ?? null : null;
  return null;
}
function getPath(v, path) {
  if (!path) return v;
  let cur = v;
  for (const seg of path.split(".")) {
    cur = getProp(cur, seg);
    if (cur === null) return null;
  }
  return cur;
}
function lookup(scope, name) {
  let o = scope;
  while (o && o !== Object.prototype) {
    if (hasOwn(o, name)) return o[name] ?? null;
    o = Object.getPrototypeOf(o);
  }
  return null;
}
function compare(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = typeof a === "string" ? a : toText(a);
  const sb = typeof b === "string" ? b : toText(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
var regexCache = /* @__PURE__ */ new Map();
function regex(pattern, env) {
  if (regexCache.has(pattern)) return regexCache.get(pattern) ?? null;
  let re = null;
  if (pattern.length > 500) {
    env.diagnostics?.push({ code: "G107", severity: "warning", message: "\u0420\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u0438\u0439 \u0432\u0438\u0440\u0430\u0437 \u0434\u043E\u0432\u0448\u0438\u0439 \u0437\u0430 500 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432" });
  } else {
    try {
      re = new RegExp(pattern);
    } catch {
      env.diagnostics?.push({ code: "G107", severity: "warning", message: `\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 \u0440\u0435\u0433\u0443\u043B\u044F\u0440\u043D\u0438\u0439 \u0432\u0438\u0440\u0430\u0437 \xAB${pattern}\xBB` });
    }
  }
  regexCache.set(pattern, re);
  return re;
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function roundTo(n, digits) {
  const f = 10 ** Math.max(0, Math.min(10, Math.trunc(digits)));
  return Math.round(n * f) / f;
}
function arith(op, a, b, env) {
  if (op === "+") {
    if (typeof a === "string" || typeof b === "string") return toText(a) + toText(b);
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  }
  const x = num(a), y = num(b);
  if (x === null || y === null) return null;
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
    case "%":
      if (y === 0) {
        env.diagnostics?.push({ code: "G106", severity: "warning", message: "\u0414\u0456\u043B\u0435\u043D\u043D\u044F \u043D\u0430 \u043D\u0443\u043B\u044C \u2014 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 null" });
        return null;
      }
      return op === "/" ? x / y : x % y;
  }
  return null;
}
function evalBuiltin(fn, args) {
  const a0 = args[0] ?? null;
  switch (fn) {
    case "len":
      if (Array.isArray(a0) || typeof a0 === "string") return a0.length;
      if (isObj2(a0)) return Object.keys(a0).length;
      return 0;
    case "min":
    case "max": {
      const list = args.length === 1 && Array.isArray(a0) ? a0 : args;
      const ns = list.map(num).filter((n) => n !== null);
      if (!ns.length) return null;
      return fn === "min" ? Math.min(...ns) : Math.max(...ns);
    }
    case "abs": {
      const n = num(a0);
      return n === null ? null : Math.abs(n);
    }
    case "round": {
      const n = num(a0);
      return n === null ? null : roundTo(n, num(args[1] ?? 0) ?? 0);
    }
    case "floor": {
      const n = num(a0);
      return n === null ? null : Math.floor(n);
    }
    case "ceil": {
      const n = num(a0);
      return n === null ? null : Math.ceil(n);
    }
  }
  return null;
}
function agoText(input, now) {
  const t = typeof input === "number" ? input : typeof input === "string" ? Date.parse(input) : NaN;
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1e3));
  if (s < 5) return "\u0449\u043E\u0439\u043D\u043E";
  if (s < 60) return `${s} \u0441 \u0442\u043E\u043C\u0443`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} \u0445\u0432 \u0442\u043E\u043C\u0443`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} \u0433\u043E\u0434 \u0442\u043E\u043C\u0443`;
  return `${Math.round(h / 24)} \u0434\u043D \u0442\u043E\u043C\u0443`;
}
function evalFilter(node, input, scope, budget, env) {
  const args = node.args.map((a) => evalExpr(a, scope, budget, env));
  const list = Array.isArray(input) ? input : null;
  if (list) step(budget, list.length);
  switch (node.filter) {
    case "take": {
      const n = Math.max(0, Math.trunc(num(args[0] ?? null) ?? 0));
      if (list) return list.slice(0, n);
      if (typeof input === "string") return input.slice(0, n);
      return null;
    }
    case "sort": {
      if (!list) return input;
      const key = typeof args[0] === "string" ? args[0] : "";
      const desc = args[1] === "desc" || key.startsWith("-");
      const k = key.replace(/^-/, "");
      const sorted = list.map((v, i) => ({ v, i })).sort((a, b) => compare(getPath(a.v, k), getPath(b.v, k)) || a.i - b.i).map((x) => x.v);
      return desc ? sorted.reverse() : sorted;
    }
    case "grep": {
      const re = regex(toText(args[0] ?? ""), env);
      if (!re) return list ? [] : null;
      const key = typeof args[1] === "string" ? args[1] : "";
      if (list) return list.filter((x) => re.test(toText(getPath(x, key))));
      if (typeof input === "string") return input.split("\n").filter((l) => re.test(l)).join("\n");
      return null;
    }
    case "map": {
      if (!list) return input === null ? null : input;
      let tpl = node.tpl;
      if (!tpl && typeof args[0] === "string" && args[0].includes("{{")) tpl = parseTemplate(args[0]).parts;
      if (tpl) {
        const parts = tpl;
        return list.map((item) => {
          const sub = Object.create(scope);
          sub.item = item;
          return renderTemplate(parts, sub, budget, env);
        });
      }
      const key = typeof args[0] === "string" ? args[0] : "";
      return list.map((x) => getPath(x, key));
    }
    case "join": {
      const sep = args.length ? toText(args[0]) : ", ";
      if (list) return list.map((x) => toText(x)).join(sep);
      return input === null ? "" : toText(input);
    }
    case "truncate": {
      const n = Math.max(1, Math.trunc(num(args[0] ?? null) ?? 0));
      const s = toText(input);
      return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
    }
    case "fence": {
      const lang = args.length ? toText(args[0]) : "";
      return "```" + lang + "\n" + toText(input).replace(/\n+$/, "") + "\n```";
    }
    case "unique": {
      if (!list) return input;
      const key = typeof args[0] === "string" ? args[0] : "";
      const seen = /* @__PURE__ */ new Set();
      return list.filter((x) => {
        const s = JSON.stringify(getPath(x, key));
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      });
    }
    case "where": {
      if (!list) return list === null && input === null ? [] : input;
      const key = toText(args[0] ?? "");
      if (args.length < 2) return list.filter((x) => truthy(getPath(x, key)));
      return list.filter((x) => deepEqual(getPath(x, key), args[1]));
    }
    case "len":
      return evalBuiltin("len", [input]);
    case "round":
      return evalBuiltin("round", [input, args[0] ?? 0]);
    case "ago":
      return agoText(input, env.now ?? Date.now());
  }
  return null;
}
function renderTemplate(parts, scope, budget, env = {}) {
  let out = "";
  for (const p of parts) out += typeof p === "string" ? p : toText(evalExpr(p, scope, budget, env));
  return out;
}
function evalExpr(ast, scope, budget, env = {}) {
  step(budget);
  switch (ast.k) {
    case "lit":
      return ast.v;
    case "list":
      return ast.items.map((i) => evalExpr(i, scope, budget, env));
    case "id":
      return lookup(scope, ast.name);
    case "member":
      return getProp(evalExpr(ast.obj, scope, budget, env), ast.prop);
    case "index": {
      const o = evalExpr(ast.obj, scope, budget, env);
      const i = evalExpr(ast.index, scope, budget, env);
      if (Array.isArray(o) && typeof i === "number") return o[Math.trunc(i)] ?? null;
      if (typeof i === "string" || typeof i === "number") return getProp(o, String(i));
      return null;
    }
    case "unary": {
      const v = evalExpr(ast.arg, scope, budget, env);
      if (ast.op === "!") return !truthy(v);
      const n = num(v);
      return n === null ? null : -n;
    }
    case "cond":
      return truthy(evalExpr(ast.test, scope, budget, env)) ? evalExpr(ast.then, scope, budget, env) : evalExpr(ast.else, scope, budget, env);
    case "bin": {
      const { op } = ast;
      if (op === "&&") {
        const l2 = evalExpr(ast.l, scope, budget, env);
        return truthy(l2) ? evalExpr(ast.r, scope, budget, env) : l2;
      }
      if (op === "||") {
        const l2 = evalExpr(ast.l, scope, budget, env);
        return truthy(l2) ? l2 : evalExpr(ast.r, scope, budget, env);
      }
      if (op === "??") {
        const l2 = evalExpr(ast.l, scope, budget, env);
        return l2 !== null ? l2 : evalExpr(ast.r, scope, budget, env);
      }
      const l = evalExpr(ast.l, scope, budget, env);
      const r = evalExpr(ast.r, scope, budget, env);
      switch (op) {
        case "==":
          return deepEqual(l, r);
        case "!=":
          return !deepEqual(l, r);
        case "<":
          return l !== null && r !== null && typeof l === typeof r && compare(l, r) < 0;
        case "<=":
          return l !== null && r !== null && typeof l === typeof r && compare(l, r) <= 0;
        case ">":
          return l !== null && r !== null && typeof l === typeof r && compare(l, r) > 0;
        case ">=":
          return l !== null && r !== null && typeof l === typeof r && compare(l, r) >= 0;
        case "~": {
          if (l === null) return false;
          const re = regex(toText(r), env);
          return re ? re.test(toText(l)) : false;
        }
        case "in":
          return inOp(l, r, budget);
        default:
          return arith(op, l, r, env);
      }
    }
    case "builtin":
      return evalBuiltin(ast.fn, ast.args.map((a) => evalExpr(a, scope, budget, env)));
    case "method": {
      const o = evalExpr(ast.obj, scope, budget, env);
      const a = evalExpr(ast.args[0], scope, budget, env);
      if (ast.fn === "in") return inOp(o, a, budget);
      if (typeof a !== "number") return null;
      if (Array.isArray(o) || typeof o === "string") {
        const v = o.at(Math.trunc(a));
        return v === void 0 ? null : v;
      }
      return null;
    }
    case "call": {
      const args = ast.args.map((a) => evalExpr(a, scope, budget, env));
      const kwargs = {};
      for (const [k, v] of Object.entries(ast.kwargs)) kwargs[k] = evalExpr(v, scope, budget, env);
      if (!env.call) {
        env.diagnostics?.push({ code: "G157", severity: "error", message: `\xAB${ast.path}\xBB \u043D\u0435 \u0454 \u0444\u0443\u043D\u043A\u0446\u0456\u0454\u044E, \u044F\u043A\u0443 \u0432\u0456\u0434\u043A\u0440\u0438\u0432\u0430\u0454 \u0445\u043E\u0441\u0442; \u0434\u043E\u0441\u0442\u0443\u043F \u0434\u043E \u0444\u0430\u0439\u043B\u0456\u0432, \u043F\u0440\u043E\u0446\u0435\u0441\u0456\u0432 \u0456 \u043C\u0435\u0440\u0435\u0436\u0456 \u0437 \u0432\u0438\u0440\u0430\u0437\u0443 \u043D\u0435\u043C\u043E\u0436\u043B\u0438\u0432\u0438\u0439`, hint: "\u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u0430\u0442\u0438 @run \u0430\u0431\u043E \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440" });
        return null;
      }
      return env.call(ast.path, args, kwargs);
    }
    case "pipe":
      return evalFilter(ast, evalExpr(ast.input, scope, budget, env), scope, budget, env);
  }
}
function inOp(l, r, budget) {
  if (Array.isArray(r)) {
    step(budget, r.length);
    return r.some((x) => deepEqual(x, l));
  }
  if (typeof r === "string") return typeof l === "string" && r.includes(l);
  if (isObj2(r)) return typeof l === "string" && hasOwn(r, l);
  return false;
}
function evalSource(src, scope, budget, env = {}) {
  const r = parseExpr(src);
  if (!r.ast) {
    env.diagnostics?.push(...r.diagnostics);
    return null;
  }
  return evalExpr(r.ast, scope, budget, env);
}

// packages/core/src/mdc.ts
var KNOWN_KEYS = /* @__PURE__ */ new Set(["description", "globs", "alwaysApply"]);
function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && (s[0] === '"' && s.endsWith('"') || s[0] === "'" && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    if (s[0] === "'") return inner.replace(/''/g, "'");
    try {
      return JSON.parse(s);
    } catch {
      return inner.replace(/\\"/g, '"');
    }
  }
  return s;
}
function stripComment(v) {
  let q;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) {
      if (c === q) q = void 0;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(v[i - 1]))) return v.slice(0, i).trimEnd();
  }
  return v;
}
function parseGlobList(value) {
  const v = value.trim();
  if (!v) return [];
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1);
    const out = [];
    let cur = "";
    let q;
    let depth = 0;
    for (const c of inner) {
      if (q) {
        cur += c;
        if (c === q) q = void 0;
        continue;
      }
      if (c === '"' || c === "'") {
        q = c;
        cur += c;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") depth = Math.max(0, depth - 1);
      if (c === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out.map(unquote);
  }
  return splitTopLevel(unquote(v)).map((s) => unquote(s));
}
function prefixGlob(glob, dirPrefix) {
  let g = glob.replace(/^\.\//, "").replace(/^\//, "");
  if (!g.includes("/") && !g.startsWith("**")) g = `**/${g}`;
  return dirPrefix + g;
}
function normPrefix(p) {
  if (!p) return "";
  let s = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (s && !s.endsWith("/")) s += "/";
  return s === "/" ? "" : s;
}
function expandFileRefs(body) {
  const refs = [];
  let inFence = false;
  const lines = body.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    const onlyRef = /^\s*@([^\s`]+?)[.,;:!?)]*\s*$/.exec(line);
    if (onlyRef && looksLikeFile(onlyRef[1])) {
      refs.push(onlyRef[1]);
      return `\u0434\u0438\u0432. \u0444\u0430\u0439\u043B ${onlyRef[1]}`;
    }
    return line.split(/(`[^`]*`)/).map((part) => part.startsWith("`") ? part : part.replace(/(^|[\s(])@([^\s`,;!?)]+)/g, (m, pre, ref) => {
      const p = ref.replace(/[.:]+$/, "");
      if (!looksLikeFile(p)) return m;
      refs.push(p);
      return `${pre}\u0434\u0438\u0432. \u0444\u0430\u0439\u043B ${p}${ref.slice(p.length)}`;
    })).join("");
  });
  return { body: lines.join("\n"), fileRefs: [...new Set(refs)] };
}
function looksLikeFile(s) {
  return /[/.]/.test(s) && !s.includes("@") && /[A-Za-z0-9]/.test(s);
}
function classifyRule(r) {
  if (r.alwaysApply) return "always";
  if (r.globs.length || r.negGlobs.length) return "auto";
  if (r.description) return "agent";
  return "manual";
}
function parseMdc(text, opts) {
  const diagnostics = [];
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const prefix = normPrefix(opts.dirPrefix);
  const id = prefix && !opts.id.startsWith(prefix) ? prefix + opts.id : opts.id;
  let description;
  let alwaysApply = false;
  const rawGlobs = [];
  let bodyStart = 0;
  const lines = src.split("\n");
  if (lines[0]?.trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") {
      end = i;
      break;
    }
    if (end < 0) {
      diagnostics.push(diag("G010", void 0, { path: opts.path, line: 1 }));
    } else {
      let listKey;
      for (let i = 1; i < end; i++) {
        const line = lines[i];
        const lineNo = i + 1;
        if (!line.trim() || line.trim().startsWith("#")) continue;
        const item = /^\s*-\s*(.*)$/.exec(line);
        if (item && listKey) {
          if (listKey === "globs") {
            const v = unquote(stripComment(item[1]));
            if (v) rawGlobs.push(v);
            else diagnostics.push(diag("G013", void 0, { path: opts.path, line: lineNo }));
          }
          continue;
        }
        const kv = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
        if (!kv) {
          if (/^\s+\S/.test(line) && listKey === "description") {
            description = ((description ?? "") + " " + line.trim()).trim();
            continue;
          }
          diagnostics.push(diag("G014", `\u0420\u044F\u0434\u043E\u043A frontmatter \u043D\u0435 \u0440\u043E\u0437\u043F\u0456\u0437\u043D\u0430\u043D\u043E: ${line.trim()}`, { path: opts.path, line: lineNo }));
          continue;
        }
        const key = kv[1];
        const value = stripComment(kv[2].trim());
        listKey = key;
        if (!KNOWN_KEYS.has(key)) {
          diagnostics.push(diag("G011", `\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0435 \u043F\u043E\u043B\u0435 frontmatter: ${key}`, { path: opts.path, line: lineNo }));
          continue;
        }
        if (key === "description") {
          const v = value === "|" || value === ">" || value === ">-" || value === "|-" ? "" : unquote(value);
          description = v || void 0;
        } else if (key === "alwaysApply") {
          const v = unquote(value).toLowerCase();
          if (v === "true" || v === "yes") alwaysApply = true;
          else if (v === "false" || v === "no" || v === "") alwaysApply = false;
          else diagnostics.push(diag("G012", `alwaysApply: ${value}`, { path: opts.path, line: lineNo }));
        } else if (key === "globs") {
          if (value && value !== "null" && value !== "~") {
            const parts = parseGlobList(value);
            if (parts.some((p) => !p.trim())) diagnostics.push(diag("G013", void 0, { path: opts.path, line: lineNo }));
            rawGlobs.push(...parts.map((p) => p.trim()).filter(Boolean));
          }
        }
      }
      bodyStart = end + 1;
    }
  }
  const rawBody = lines.slice(bodyStart).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  const { body, fileRefs } = expandFileRefs(rawBody);
  const globs = [];
  const negGlobs = [];
  for (const g of rawGlobs) {
    const neg = g.startsWith("!");
    const p = neg ? g.slice(1).trim() : g;
    if (!p) continue;
    const full = prefix ? prefixGlob(p, prefix) : p;
    (neg ? negGlobs : globs).push(full);
  }
  if (!globs.length && negGlobs.length) diagnostics.push(diag("G015", void 0, { path: opts.path }));
  const rule = { id, path: opts.path, type: "manual", globs, negGlobs, alwaysApply, body, fileRefs };
  if (description) rule.description = description;
  rule.type = classifyRule(rule);
  return { rule, diagnostics };
}
function ruleIdFromPath(path) {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const m = /^(.*?)\.cursor\/rules\/(.+?)\.mdc$/.exec(p);
  if (!m) return { id: p.replace(/\.mdc$/, "").split("/").pop() ?? p, dirPrefix: "" };
  return { id: m[2], dirPrefix: m[1] };
}
function ruleMatches(rule, path, opts = {}) {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return matchAny(p, rule.globs, rule.negGlobs, { nocase: !!opts.nocase, matchBase: true });
}
function autoRulesFor(rules, path, opts = {}) {
  return rules.filter((r) => r.type === "auto" && ruleMatches(r, path, opts));
}
function ruleToItem(rule) {
  const when = rule.type === "always" ? "always" : rule.type === "auto" ? "paths" : rule.type === "agent" ? "on-demand" : "manual";
  const item = {
    kind: "rule",
    id: `rule:${rule.id}`,
    name: rule.id,
    body: rule.body,
    attach: { when },
    cost: { chars: rule.body.length },
    provenance: { source: rule.source ?? "cursor-mdc", path: rule.path },
    ruleType: rule.type
  };
  if (rule.description) item.description = rule.description;
  if (rule.type === "auto") item.attach.globs = [...rule.globs, ...rule.negGlobs.map((g) => `!${g}`)];
  return item;
}
function frameRule(rule, path) {
  const label = !rule.source || rule.source === "cursor-mdc" ? "Cursor rule" : "rule";
  return `Contents of ${path ?? rule.path} (${label} ${rule.id}):
${rule.body}`;
}
function pointerLine(path) {
  return `\u0442\u0430\u043A\u043E\u0436 \u0434\u0456\u0454: ${path}, \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0437\u0430 \u043F\u043E\u0442\u0440\u0435\u0431\u0438`;
}
function packInjections(rules, maxChars) {
  const parts = [];
  const included = [];
  const deferred = [];
  let used = 0;
  for (const r of rules) {
    const framed = frameRule(r);
    const add = framed.length + (parts.length ? 2 : 0);
    if (used + add <= maxChars) {
      parts.push(framed);
      included.push(r.id);
      used += add;
    } else {
      deferred.push(r.id);
    }
  }
  const pointers = rules.filter((r) => deferred.includes(r.id)).map((r) => pointerLine(r.path));
  const text = [...parts, ...pointers.length ? [pointers.join("\n")] : []].join("\n\n");
  return { text, included, deferred };
}
function isPartialRead(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return false;
  const t = toolInput;
  return [t.offset, t.limit, t.pages].some((v) => v !== void 0 && v !== null && v !== "");
}
function ruleSourcesOf(cfg) {
  const out = [];
  for (const s of [...cfg.itemSources ?? [], ...cfg.ruleSources ?? []]) {
    if (s.kind === "cursor-mdc" || s.kind === "markdown-dir") out.push(s);
    else if (s.kind === "provider" && s.name && s.as !== "datum" && s.as !== "skill" && s.as !== "tool" && s.as !== "agent" && s.as !== "section") out.push(s);
  }
  return out;
}
function cursorRuleDirs(cfg) {
  const dirs = [".cursor/rules"];
  let nested = !!cfg.cursorRules?.nested;
  for (const s of ruleSourcesOf(cfg)) {
    if (s.kind !== "cursor-mdc") continue;
    const d = (s.dir ?? ".cursor/rules").replace(/^\.\//, "").replace(/\/+$/, "");
    if (d && !dirs.includes(d)) dirs.push(d);
    if (s.nested) nested = true;
  }
  return { dirs, nested };
}
function markdownRuleId(path, dir) {
  const d = dir.replace(/^\.\//, "").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const rel = d && p.startsWith(d + "/") ? p.slice(d.length + 1) : p.split("/").pop() ?? p;
  return rel.replace(/\.(md|mdc|markdown)$/i, "");
}
function parseMarkdownRule(text, opts) {
  const map = opts.frontmatter ?? {};
  let src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) {
      let keep = true;
      const fm = [];
      for (const line of lines.slice(1, end)) {
        const kv = /^([A-Za-z_][\w-]*)(\s*:.*)$/.exec(line);
        if (kv) {
          const key = map[kv[1]] ?? kv[1];
          keep = KNOWN_KEYS.has(key);
          if (keep) fm.push(key + kv[2]);
          continue;
        }
        if (keep) fm.push(line);
      }
      src = ["---", ...fm, "---", ...lines.slice(end + 1)].join("\n");
    }
  }
  const r = parseMdc(src, { path: opts.path, id: opts.id });
  const rule = { ...r.rule, source: "markdown-dir" };
  if (opts.as === "always") {
    rule.alwaysApply = true;
    rule.type = "always";
  }
  return { rule, diagnostics: r.diagnostics.filter((d) => d.code !== "G011") };
}
function getPath2(v, path) {
  if (!path) return v;
  let cur = v;
  for (const k of path.split(".")) {
    if (cur === null || cur === void 0) return void 0;
    if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[Number(k)];
    else if (typeof cur === "object" && !Array.isArray(cur)) cur = cur[k];
    else return void 0;
  }
  return cur;
}
function globsOf(v) {
  if (typeof v === "string") return parseGlobList(v);
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return [];
}
function renderItemTemplate(template, item, index) {
  return splitTemplate(template).map((p) => {
    if ("text" in p) return p.text;
    try {
      return toText(evalSource(p.expr, { item, index }, newBudget(1e3)));
    } catch {
      return "";
    }
  }).join("");
}
function providerRules(value, src) {
  const name = src.name ?? "provider";
  const diagnostics = [];
  if (value === null || value === void 0) return { rules: [], diagnostics };
  if (typeof value === "object" && !Array.isArray(value) && value.unverified === true) {
    diagnostics.push(diag("G203", `\u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 ${name}: \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043D\u0435 \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E (unverified)`));
    return { rules: [], diagnostics };
  }
  const picked = getPath2(value, src.field ?? src.pick);
  if (picked === void 0 || picked === null) {
    diagnostics.push(diag("G313", `itemSources provider ${name}: \u043F\u043E\u043B\u0435 ${src.field ?? src.pick} \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0454 \u0432 \u0434\u0430\u043D\u0438\u0445 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430`));
    return { rules: [], diagnostics };
  }
  const list = Array.isArray(picked) ? picked : typeof picked === "object" ? Object.entries(picked).map(([k, v]) => v && typeof v === "object" && !Array.isArray(v) ? { id: k, ...v } : { id: k, text: v ?? null }) : [picked];
  const rules = [];
  const used = /* @__PURE__ */ new Set();
  list.forEach((el, i) => {
    const obj = el && typeof el === "object" && !Array.isArray(el) ? el : void 0;
    const body = src.template ? renderItemTemplate(src.template, el, i) : obj ? toText(obj.body ?? obj.text ?? obj.message ?? obj.description ?? null) || JSON.stringify(el) : toText(el);
    if (!body.trim()) return;
    const key = obj && (typeof obj.id === "string" || typeof obj.id === "number") ? String(obj.id) : obj && typeof obj.name === "string" ? obj.name : String(i);
    let id = `${name}/${key.replace(/[^\w.@-]+/g, "-")}`;
    for (let n = 2; used.has(id); n++) id = `${name}/${key}-${n}`;
    used.add(id);
    const all = globsOf(obj?.globs ?? obj?.paths);
    const globs = all.filter((g) => !g.startsWith("!"));
    const negGlobs = all.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
    const auto = src.as !== "always" && globs.length > 0;
    const rule = { id, path: `provider:${name}`, type: auto ? "auto" : "always", globs: auto ? globs : [], negGlobs: auto ? negGlobs : [], alwaysApply: !auto, body: body.trim(), fileRefs: [], source: `provider:${name}` };
    if (obj && typeof obj.description === "string" && src.template) rule.description = obj.description;
    rules.push(rule);
  });
  return { rules, diagnostics };
}
var RULE_SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor", ".venv"]);
var RULE_MAX_DEPTH = 6;
var RULE_MAX_DIRS = 400;
var MD_RULE_FILE = /^(?!readme\.md$).+\.(md|markdown)$/i;
function trimRuleDir(d) {
  return d.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
function listRuleFiles(fs, dir, ext, out, depth = 0) {
  if (depth > RULE_MAX_DEPTH) return;
  for (const e of fs.list(dir)) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.kind === "file" && ext.test(e.name)) out.push(rel);
    else if (e.kind === "dir" && !RULE_SKIP_DIRS.has(e.name)) listRuleFiles(fs, rel, ext, out, depth + 1);
  }
}
function nestedCursorRuleDirs(fs) {
  const found = [];
  const queue = [{ rel: "", depth: 0 }];
  let visited = 0;
  while (queue.length && visited < RULE_MAX_DIRS) {
    const { rel, depth } = queue.shift();
    visited++;
    for (const e of fs.list(rel)) {
      if (e.kind !== "dir") continue;
      if (e.name === ".cursor" && rel) found.push(`${rel}/.cursor/rules`);
      if (e.name.startsWith(".") || RULE_SKIP_DIRS.has(e.name) || depth + 1 > RULE_MAX_DEPTH) continue;
      queue.push({ rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 });
    }
  }
  return found;
}
function loadRuleSources(cfg, fs, opts = {}) {
  const rules = [];
  const diagnostics = [];
  if (cfg.cursorRules?.enabled === false) return { rules, diagnostics };
  const { dirs, nested } = cursorRuleDirs(cfg);
  const mdc = [];
  for (const d of dirs) listRuleFiles(fs, trimRuleDir(d), /\.mdc$/, mdc);
  if (nested) for (const d of nestedCursorRuleDirs(fs)) listRuleFiles(fs, d, /\.mdc$/, mdc);
  for (const path of [...new Set(mdc)].sort()) {
    const text = fs.read(path);
    if (text === void 0) continue;
    const { id, dirPrefix } = ruleIdFromPath(path);
    const r = parseMdc(text, { path, id, dirPrefix });
    rules.push(r.rule);
    diagnostics.push(...r.diagnostics);
  }
  const has = (id) => rules.some((x) => x.id === id);
  const md = [];
  for (const src of ruleSourcesOf(cfg)) {
    if (src.kind !== "markdown-dir" || !src.dir) continue;
    const found = [];
    listRuleFiles(fs, trimRuleDir(src.dir), MD_RULE_FILE, found);
    for (const path of found) md.push({ path, src });
  }
  for (const f of md.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const text = fs.read(f.path);
    if (text === void 0) continue;
    const r = parseMarkdownRule(text, { path: f.path, id: markdownRuleId(f.path, trimRuleDir(f.src.dir)), ...f.src.frontmatter ? { frontmatter: f.src.frontmatter } : {}, ...f.src.as ? { as: f.src.as } : {} });
    if (!has(r.rule.id)) rules.push(r.rule);
    diagnostics.push(...r.diagnostics);
  }
  for (const src of ruleSourcesOf(cfg)) {
    if (src.kind !== "provider" || !src.name) continue;
    const v = opts.providerValue?.(src.name);
    if (v === void 0) {
      diagnostics.push(diag("G208", `itemSources provider ${src.name}: \u0434\u0430\u043D\u0456 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0456 \u0432 \u0446\u044C\u043E\u043C\u0443 \u0430\u0434\u0430\u043F\u0442\u0435\u0440\u0456 \u2014 \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E`));
      continue;
    }
    const r = providerRules(v, src);
    for (const rule of r.rules) if (!has(rule.id)) rules.push(rule);
    diagnostics.push(...r.diagnostics);
  }
  return { rules, diagnostics };
}

// packages/core/src/gatecmd.ts
function extractPromptFlag(text) {
  const m = /^\s*\[gate:\s*([\w.+-]+)\s*\]\s*/.exec(text);
  if (!m) return { text };
  return { profile: m[1], text: text.slice(m[0].length) };
}
function extractMentions(text) {
  const files = /* @__PURE__ */ new Set();
  const rules = /* @__PURE__ */ new Set();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const plain = line.replace(/`[^`]*`/g, " ");
    const re = /(^|[\s(\[{,;])@("[^"]+"|[^\s"'`()<>\[\]{},;]+)/g;
    let m;
    while (m = re.exec(plain)) {
      let ref = m[2];
      if (ref.startsWith('"')) ref = ref.slice(1, -1);
      ref = ref.replace(/[.,;:!?]+$/, "");
      if (!ref || ref.includes("@")) continue;
      if (ref.includes("/") || /\.[A-Za-z0-9]+$/.test(ref)) files.add(ref.replace(/^\.\//, ""));
      else if (/^[\w-]+$/.test(ref)) rules.add(ref);
    }
  }
  return { files: [...files], rules: [...rules] };
}

// packages/core/src/journal.ts
function toJsonl(entry) {
  return JSON.stringify(entry) + "\n";
}
function gateAttemptEntry(d, at) {
  const data = { gate: d.gate, outcome: d.outcome };
  if (d.on) data.on = d.on;
  if (d.ms !== void 0) data.ms = Math.round(d.ms);
  if (d.sessionId) data.sessionId = d.sessionId;
  if (d.adapter) data.adapter = d.adapter;
  if (d.skipped) data.skipped = d.skipped;
  return { ts: at.ts, turn: at.turn, trigger: d.on ? `gate:${d.on}` : "gate", ...at.profile ? { profile: at.profile } : {}, tier: at.tier, enabled: [], disabled: [], reason: [], kind: "gate-attempt", data };
}

// packages/hooks-adapter/src/handle.ts
var ADDITIONAL_CONTEXT_LIMIT = 1e4;
var RECENT_PATHS = 20;
var READ_PATHS = 500;
var OWN_MCP_PREFIX = "mcp__context-gate__";
var FILE_TOOLS = ["Read", "Edit", "Write", "NotebookEdit"];
var WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];
function newState() {
  return { v: 1, seen: [], read: [], paths: [], gate: { turn: 0 } };
}
function reviveState(raw) {
  if (!raw || typeof raw !== "object") return newState();
  const s = raw;
  if (s.v !== 1) return newState();
  const arr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  const out = { v: 1, seen: arr(s.seen), read: arr(s.read), paths: arr(s.paths), gate: s.gate && typeof s.gate === "object" ? s.gate : { turn: 0 } };
  if (s.manual) out.manual = s.manual;
  if (typeof s.model === "string") out.model = s.model;
  if (s.last) out.last = s.last;
  return out;
}
function contextOutput(event, text) {
  if (!text.trim()) return void 0;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
function denyOutput(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}
function packWithin(rules, limit, perInjection2 = limit) {
  let budget = Math.min(limit, perInjection2);
  for (let i = 0; i < 50; i++) {
    const r2 = packInjections(rules, Math.max(0, budget));
    if (r2.text.length <= limit || budget <= 0) {
      return r2.text.length <= limit ? r2 : { ...r2, text: r2.text.slice(0, limit) };
    }
    budget -= r2.text.length - limit;
  }
  const r = packInjections(rules, 0);
  return { ...r, text: r.text.slice(0, limit) };
}
function joinLimited(parts, limit = ADDITIONAL_CONTEXT_LIMIT) {
  const out = [];
  let used = 0;
  for (const p of parts) {
    if (!p) continue;
    const add = p.length + (out.length ? 2 : 0);
    if (used + add > limit) break;
    out.push(p);
    used += add;
  }
  return out.join("\n\n");
}
function modelOf(input, state, env) {
  return input.model || state.model || env.CONTEXT_GATE_MODEL || env.ANTHROPIC_MODEL || void 0;
}
function isApplied(cfg, state, env) {
  if (env.CONTEXT_GATE_PROFILE?.trim()) return true;
  if (state.manual?.profile) return true;
  const mode = env.CONTEXT_GATE_MODE?.trim() || cfg.classify?.mode || "shadow";
  return mode === "auto";
}
function manualSignal(state, env) {
  if (env.CONTEXT_GATE_OFF === "1" || state.manual?.off) return { add: [], remove: [], off: true };
  const p = state.manual?.profile || env.CONTEXT_GATE_PROFILE?.trim();
  return p ? { profile: p, add: [], remove: [] } : void 0;
}
function gateItems(ctx, extra = []) {
  return [...ctx.items, ...ctx.rules.map(ruleToItem), ...extra];
}
function decideTurn(ctx, state, input, paths, opts = {}) {
  const signals = { paths, model: modelOf(input, state, ctx.env) };
  if (ctx.branch) signals.branch = ctx.branch;
  if (ctx.env.CONTEXT_GATE_TICKET_TYPE) signals.ticketType = ctx.env.CONTEXT_GATE_TICKET_TYPE;
  if (input.agent_id) signals.agentId = input.agent_id;
  const manual = manualSignal(state, ctx.env);
  if (manual) signals.manual = manual;
  const r = decideGate(ctx.config, signals, state.gate, gateItems(ctx), { ...opts, now: ctx.now, prevModel: state.model });
  return { gate: r.gate, gateState: r.state, log: r.log };
}
function currentGate(ctx, state, input, extra = []) {
  const signals = { paths: [], model: modelOf(input, state, ctx.env) };
  const manual = manualSignal(state, ctx.env);
  if (manual) signals.manual = manual;
  else if (state.gate.profile) signals.manual = { profile: state.gate.profile, add: [], remove: [] };
  return decideGate(ctx.config, signals, state.gate, gateItems(ctx, extra), { now: ctx.now }).gate;
}
function maybeLog(state, d, force) {
  const cur = { profile: d.gate.profile, tier: d.gate.tier, off: d.gate.off };
  const changed = !state.last || state.last.profile !== cur.profile || state.last.tier !== cur.tier || state.last.off !== cur.off;
  if (cur.profile === void 0) delete cur.profile;
  state.last = cur;
  return force || changed ? [{ ...d.log, data: { ...d.log.data, adapter: "claude-code-hooks" } }] : [];
}
function dedupKey(input, ruleId) {
  return `${input.agent_id ?? "main"}:${ruleId}`;
}
function ruleAllowed(rule, gate, applied) {
  if (!applied || !gate) return true;
  return gate.items[`rule:${rule.id}`] !== "off";
}
function autoRulesFor2(ctx, rel) {
  return autoRulesFor(ctx.rules, rel, { nocase: !!ctx.windows });
}
function perInjection(cfg) {
  return cfg.cursorRules?.maxCharsPerInjection ?? 3e4;
}
function relPath(ctx, p) {
  return normalizePath(p, ctx.root, ctx.windows === void 0 ? {} : { windows: ctx.windows });
}
function pushRecent(list, item, max) {
  const out = list.filter((x) => x !== item);
  out.push(item);
  return out.length > max ? out.slice(out.length - max) : out;
}
function toolPath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return void 0;
  const t = toolInput;
  const p = t.file_path ?? t.notebook_path;
  return typeof p === "string" && p ? p : void 0;
}
function deliveredLog(ctx, turn, tier, ids, via, path) {
  return { ts: ctx.now, turn, trigger: via, tier, enabled: ids.map((i) => `rule:${i}`), disabled: [], reason: [`${via}: ${ids.join(", ")}`], kind: "rule-delivered", data: { rules: ids, adapter: "claude-code-hooks", ...path ? { path } : {} } };
}
function handleHook(input, ctx, prev) {
  const state = { ...prev, seen: [...prev.seen], read: [...prev.read], paths: [...prev.paths], gate: { ...prev.gate } };
  switch (input.hook_event_name) {
    case "SessionStart":
      return onSessionStart(input, ctx, state);
    case "UserPromptSubmit":
      return onPrompt(input, ctx, state);
    case "PostToolUse":
      return onPostTool(input, ctx, state);
    case "PreToolUse":
      return onPreTool(input, ctx, state);
    default:
      return { state, log: [] };
  }
}
function onSessionStart(input, ctx, state) {
  const source = input.source ?? "startup";
  if (source === "clear" || source === "compact") state.seen = [];
  if (source === "clear") {
    state.read = [];
    state.paths = [];
    state.manual = void 0;
  }
  const model = modelOf(input, state, ctx.env);
  const d = decideTurn(ctx, state, input, state.paths, source === "compact" ? { recheck: true, recheckReason: "compact" } : source === "clear" ? { recheck: true, recheckReason: "new" } : {});
  state.gate = d.gateState;
  if (model) state.model = model;
  const log = maybeLog(state, d, true);
  const applied = isApplied(ctx.config, state, ctx.env);
  const parts = [];
  const always = ctx.rules.filter((r) => r.type === "always" && !state.seen.includes(dedupKey(input, r.id)) && ruleAllowed(r, d.gate, applied));
  let used = 0;
  if (always.length) {
    const packed = packWithin(always, ADDITIONAL_CONTEXT_LIMIT - 200, perInjection(ctx.config));
    for (const id of packed.included) state.seen.push(dedupKey(input, id));
    if (packed.text) parts.push(packed.text);
    used += packed.text.length;
    if (packed.included.length) log.push(deliveredLog(ctx, d.gateState.turn, d.gate.tier, packed.included, "session-start"));
  }
  {
    for (const name of d.gate.skills.preload) {
      const it = ctx.items.find((i) => i.kind === "skill" && i.name === name);
      if (!it?.body) continue;
      const block = `Preloaded skill ${name}${it.provenance.path ? ` (${it.provenance.path})` : ""}:
${it.body}`;
      if (used + block.length + 2 > ADDITIONAL_CONTEXT_LIMIT - 200) {
        parts.push(`\u0442\u0430\u043A\u043E\u0436 \u0434\u0456\u0454 skill ${name}: \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 ${it.provenance.path ?? name} \u0437\u0430 \u043F\u043E\u0442\u0440\u0435\u0431\u0438`);
        continue;
      }
      parts.push(block);
      used += block.length + 2;
    }
  }
  if (applied && (d.gate.profile || d.gate.mcp.off.length)) parts.unshift(`context-gate: ${statusLine(d.gate)}`);
  const out = contextOutput("SessionStart", joinLimited(parts));
  return out ? { output: out, state, log } : { state, log };
}
var RULE_CMD = /^[ \t]*\/rule[ \t]+([^\n]+)/m;
function onPrompt(input, ctx, state) {
  const raw = input.prompt ?? "";
  const flag = extractPromptFlag(raw);
  let recheck = false;
  if (flag.profile === "off") state.manual = { off: true };
  else if (flag.profile === "auto") {
    state.manual = void 0;
    recheck = true;
  } else if (flag.profile === "new") {
    recheck = true;
  } else if (flag.profile) state.manual = { profile: flag.profile };
  const text = flag.text;
  const mentions = extractMentions(text);
  const ruleIds = new Set(mentions.rules);
  const explicit = /* @__PURE__ */ new Set();
  const cmd = RULE_CMD.exec(text);
  if (cmd) for (const id of cmd[1].trim().split(/[\s,]+/).filter(Boolean)) {
    ruleIds.add(id);
    explicit.add(id);
  }
  const files = mentions.files.map((f) => relPath(ctx, f));
  for (const f of files) state.paths = pushRecent(state.paths, f, RECENT_PATHS);
  const d = decideTurn(ctx, state, input, state.paths, recheck ? { recheck: true, recheckReason: "new" } : {});
  const prevProfile = state.last?.profile;
  state.gate = d.gateState;
  const log = maybeLog(state, d, false);
  const applied = isApplied(ctx.config, state, ctx.env);
  const picked = [];
  const pickedIds = /* @__PURE__ */ new Set();
  const unknown = [];
  for (const id of ruleIds) {
    const rule = ctx.rules.find((r) => r.id === id || r.id.endsWith(`/${id}`));
    if (!rule) {
      if (explicit.has(id)) unknown.push(id);
      continue;
    }
    if (!explicit.has(id) && state.seen.includes(dedupKey(input, rule.id))) continue;
    if (!explicit.has(id) && !ruleAllowed(rule, d.gate, applied)) continue;
    if (!pickedIds.has(rule.id)) {
      picked.push(rule);
      pickedIds.add(rule.id);
    }
  }
  for (const f of files) {
    for (const rule of autoRulesFor2(ctx, f)) {
      if (pickedIds.has(rule.id) || state.seen.includes(dedupKey(input, rule.id)) || !ruleAllowed(rule, d.gate, applied)) continue;
      picked.push(rule);
      pickedIds.add(rule.id);
    }
  }
  const parts = [];
  if (applied && d.gate.profile !== prevProfile && d.gate.profile) parts.push(`context-gate: ${statusLine(d.gate)}`);
  if (unknown.length) parts.push(`context-gate: \u043F\u0440\u0430\u0432\u0438\u043B\u043E ${unknown.join(", ")} \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E \u0432 .cursor/rules`);
  if (picked.length) {
    const packed = packWithin(picked, ADDITIONAL_CONTEXT_LIMIT - 300, perInjection(ctx.config));
    for (const id of packed.included) if (!state.seen.includes(dedupKey(input, id))) state.seen.push(dedupKey(input, id));
    parts.push(packed.text);
    if (packed.included.length) log.push(deliveredLog(ctx, d.gateState.turn, d.gate.tier, packed.included, "prompt"));
  }
  const out = contextOutput("UserPromptSubmit", joinLimited(parts));
  return out ? { output: out, state, log } : { state, log };
}
function onPostTool(input, ctx, state) {
  const tool = input.tool_name ?? "";
  if (!FILE_TOOLS.includes(tool)) return { state, log: [] };
  const p = toolPath(input.tool_input);
  if (!p) return { state, log: [] };
  const rel = relPath(ctx, p);
  state.read = pushRecent(state.read, rel, READ_PATHS);
  state.paths = pushRecent(state.paths, rel, RECENT_PATHS);
  if (tool === "Read" && rel.endsWith(".mdc") && !isPartialRead(input.tool_input)) {
    const r = ctx.rules.find((x) => x.path === rel);
    if (r && !state.seen.includes(dedupKey(input, r.id))) state.seen.push(dedupKey(input, r.id));
  }
  const applied = isApplied(ctx.config, state, ctx.env);
  const gate = applied ? currentGate(ctx, state, input) : void 0;
  const rules = autoRulesFor2(ctx, rel).filter((r) => !state.seen.includes(dedupKey(input, r.id)) && ruleAllowed(r, gate, applied));
  if (!rules.length) return { state, log: [] };
  const packed = packWithin(rules.map((r) => ({ ...r, path: r.path })), ADDITIONAL_CONTEXT_LIMIT, perInjection(ctx.config));
  for (const id of packed.included) state.seen.push(dedupKey(input, id));
  const tier = gate?.tier ?? tierForModel(ctx.config, modelOf(input, state, ctx.env)).tier;
  const log = packed.included.length ? [deliveredLog(ctx, state.gate.turn, tier, packed.included, `tool:${tool}`, rel)] : [];
  const out = contextOutput("PostToolUse", packed.text);
  return out ? { output: out, state, log } : { state, log };
}
function onPreTool(input, ctx, state) {
  const tool = input.tool_name ?? "";
  if (tool.startsWith("mcp__")) return mcpGate(input, ctx, state, tool);
  if (WRITE_TOOLS.includes(tool)) return writeGate(input, ctx, state, tool);
  return { state, log: [] };
}
function denyLog(ctx, state, gate, id, reason, shadow) {
  return { ts: ctx.now, turn: state.gate.turn, trigger: "deny", profile: gate.profile, tier: gate.tier, enabled: [], disabled: [id], reason: [reason], kind: "deny", data: { adapter: "claude-code-hooks", shadow, ...id.startsWith("tool:") ? { tool: id } : { id } } };
}
function mcpGate(input, ctx, state, tool) {
  if (tool.startsWith(OWN_MCP_PREFIX)) return { state, log: [] };
  const toolItem = makeItem("tool", tool, { provenance: { source: "claude-tools" } });
  const gate = currentGate(ctx, state, input, [toolItem]);
  if (gate.items[toolItem.id] !== "off") return { state, log: [] };
  const reason = denyText("tool", tool, gate, ctx.config);
  if (!isApplied(ctx.config, state, ctx.env)) {
    const entry2 = denyLog(ctx, state, gate, toolItem.id, `shadow: ${reason}`, true);
    if (gate.profile === void 0) delete entry2.profile;
    return { state, log: [entry2] };
  }
  const hint = ctx.env.CONTEXT_GATE_PROFILE ? " (\u043F\u0440\u043E\u0444\u0456\u043B\u044C \u0437\u0430\u0434\u0430\u043D\u043E CONTEXT_GATE_PROFILE)" : " \u0410\u0431\u043E \u043D\u0430\u043F\u0438\u0448\u0438 [gate:off] \u0443 \u043F\u0440\u043E\u043C\u043F\u0442\u0456.";
  const text = reason.replace(/Користувач може увімкнути: \/gate (\S+)/, (_m, g) => `\u041A\u043E\u0440\u0438\u0441\u0442\u0443\u0432\u0430\u0447 \u043C\u043E\u0436\u0435 \u0443\u0432\u0456\u043C\u043A\u043D\u0443\u0442\u0438: [gate:${g.replace(/^\+/, "")}] \u0443 \u043F\u0440\u043E\u043C\u043F\u0442\u0456 \u0430\u0431\u043E /gate ${g} \u0437 mod.`) + hint;
  const entry = denyLog(ctx, state, gate, toolItem.id, reason, false);
  if (gate.profile === void 0) delete entry.profile;
  return { output: denyOutput(text), state, log: [entry] };
}
function readBeforeWriteActive(cfg, tier) {
  const g = (cfg.gates ?? []).find((x) => x.name === "read-before-write" && x.builtin !== false && x.on === "write");
  if (!g) return false;
  return !g.tiers?.length || g.tiers.includes(tier);
}
function writeGate(input, ctx, state, tool) {
  const p = toolPath(input.tool_input);
  if (!p) return { state, log: [] };
  const rel = relPath(ctx, p);
  const tier = tierForModel(ctx.config, modelOf(input, state, ctx.env)).tier;
  const exists = rel !== "" && ctx.exists(rel);
  const gateStub = { profile: state.gate.profile, tier };
  const rbw = exists && readBeforeWriteActive(ctx.config, tier);
  const attempt = (outcome) => gateAttemptEntry({ gate: "read-before-write", on: "write", outcome, adapter: "claude-code-hooks", ...input.session_id ? { sessionId: input.session_id } : {} }, { ts: ctx.now, turn: state.gate.turn, tier, ...state.gate.profile ? { profile: state.gate.profile } : {} });
  if (rbw && !state.read.includes(rel)) {
    const reason = tool === "Write" ? `read-before-write: ${rel} \u0443\u0436\u0435 \u0456\u0441\u043D\u0443\u0454; \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 \u0439\u043E\u0433\u043E \u0456\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u043E\u043C Read \u043F\u0435\u0440\u0435\u0434 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0438\u0441\u043E\u043C (tier ${tier}).` : `read-before-write: \u0441\u043F\u0435\u0440\u0448\u0443 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439 ${rel} \u0456\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u043E\u043C Read, \u043F\u043E\u0442\u0456\u043C \u0440\u0435\u0434\u0430\u0433\u0443\u0439 (tier ${tier}).`;
    const entry = { ...denyLog(ctx, state, gateStub, `file:${rel}`, reason, false), kind: "gate-failed", trigger: "read-before-write" };
    if (entry.profile === void 0) delete entry.profile;
    return { output: denyOutput(reason), state, log: [entry, attempt("block")] };
  }
  const passed = rbw ? [attempt("pass")] : [];
  if (!exists && tool === "Write" && ctx.config.cursorRules?.strictWrite) {
    const applied = isApplied(ctx.config, state, ctx.env);
    const gate = applied ? currentGate(ctx, state, input) : void 0;
    const rules = autoRulesFor2(ctx, rel).filter((r) => !state.seen.includes(dedupKey(input, r.id)) && ruleAllowed(r, gate, applied));
    if (rules.length) {
      const packed = packWithin(rules, ADDITIONAL_CONTEXT_LIMIT - 300, perInjection(ctx.config));
      for (const id of packed.included) state.seen.push(dedupKey(input, id));
      const reason = `${packed.text}

\u0414\u043B\u044F ${rel} \u0434\u0456\u044E\u0442\u044C \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u0432\u0438\u0449\u0435. \u041F\u043E\u0432\u0442\u043E\u0440\u0438 \u0437\u0430\u043F\u0438\u0441 \u0437 \u0457\u0445 \u0443\u0440\u0430\u0445\u0443\u0432\u0430\u043D\u043D\u044F\u043C.`;
      return { output: denyOutput(reason), state, log: [deliveredLog(ctx, state.gate.turn, tier, packed.included, "strict-write", rel), ...passed] };
    }
  }
  return { state, log: passed };
}

// packages/hooks-adapter/src/node.ts
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

// packages/core/src/providers.ts
function pickFields(v, pick) {
  if (!pick?.length || !v || typeof v !== "object" || Array.isArray(v)) return v;
  const out = {};
  for (const p of pick) {
    const parts = p.split(".");
    let cur = v;
    for (const k of parts) cur = cur && typeof cur === "object" && !Array.isArray(cur) ? cur[k] : void 0;
    if (cur === void 0) continue;
    let o = out;
    for (const k of parts.slice(0, -1)) o = o[k] ??= {};
    o[parts[parts.length - 1]] = cur;
  }
  return out;
}
function fileProviderValue(path, text, pick) {
  if (/\.json$/i.test(path)) {
    try {
      return { value: pickFields(JSON.parse(text), pick) };
    } catch (e) {
      return { error: `JSON: ${e.message}` };
    }
  }
  if (/\.mdx?$/i.test(path)) return { markdown: true };
  return { value: text };
}
function staticProviderValue(cfg, name, read) {
  const p = cfg.providers?.[name];
  if (!p || p.kind !== "file" || !p.path) return void 0;
  if (/^\//.test(p.path) || p.path.split(/[\\/]/).includes("..")) return void 0;
  const text = read(p.path.replace(/^\.\//, ""));
  if (text === void 0) return void 0;
  const f = fileProviderValue(p.path, text, p.pick);
  return "value" in f ? f.value : "markdown" in f ? markdownProviderValue(text) : void 0;
}
function scalar(v) {
  const s = v.trim();
  if (s === "") return "";
  if (s === "true" || s === "false") return s === "true";
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s.startsWith("[") && s.endsWith("]")) return s.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== "");
  return s;
}
function splitFrontmatter(raw) {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let lastKey;
  for (const line of m[1].split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && lastKey) {
      const cur = meta[lastKey];
      meta[lastKey] = [...Array.isArray(cur) ? cur : cur === "" || cur === void 0 ? [] : [cur], scalar(item[1])];
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      meta[lastKey] = scalar(kv[2]);
    }
  }
  return { meta, body: text.slice(m[0].length) };
}
function markdownProviderValue(text) {
  const { meta, body } = splitFrontmatter(text);
  const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2].trim() }));
  return { meta: JSON.parse(JSON.stringify(meta)), body, headings };
}

// packages/hooks-adapter/src/shiftwork.ts
var GATE_LOG = ".claude/gate.log.jsonl";
var BACKEND_PREFIX = /^(?:claude|codex|cursor|grok|opencode|pi|ollama):/;
function shiftworkModelId(ref) {
  if (!ref) return void 0;
  const m = ref.trim().replace(BACKEND_PREFIX, "");
  const slash = m.lastIndexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : m;
}
function skillAdjustments(skills) {
  const list = typeof skills === "string" ? skills.split(/[\s,]+/) : [...skills ?? []];
  const add = [];
  const remove = [];
  for (const raw of list) {
    const s = raw.trim().replace(/^`|`$/g, "");
    if (!s) continue;
    if (s.startsWith("-")) remove.push(s.slice(1));
    else add.push(s.replace(/^\+/, ""));
  }
  return { add, remove };
}
function profileForTicketType(config, ticketType) {
  if (!ticketType) return {};
  const t = ticketType.trim();
  const hits = Object.entries(config.profiles ?? {}).filter(([, p]) => p.when?.ticketType?.includes(t)).map(([n]) => n);
  if (hits.length) return { profile: hits.join("+"), via: "when:ticketType" };
  if (config.profiles?.[t]) return { profile: t, via: "name" };
  return {};
}
function dirOf(path) {
  const p = path.replace(/\\/g, "/");
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
}
function planForTicket(config, input, now = 0) {
  const model = shiftworkModelId(input.model);
  const { profile } = profileForTicketType(config, input.ticketType);
  const adj = skillAdjustments(input.skills);
  const signals = { paths: input.paths ?? [], model };
  if (input.branch) signals.branch = input.branch;
  if (input.ticketType) signals.ticketType = input.ticketType.trim();
  if (profile || adj.add.length || adj.remove.length) {
    signals.manual = { add: adj.add, remove: adj.remove };
    if (profile) signals.manual.profile = profile;
  }
  const items = input.items ?? [];
  const r = decideGate(config, signals, { turn: 0 }, items, { now });
  const gate = r.gate;
  if (profile) {
    gate.trigger = "when:ticketType";
    r.log.trigger = "when:ticketType";
    const why = `\u0442\u0438\u043F \u0442\u0456\u043A\u0435\u0442\u0430 ${input.ticketType.trim()} \u2192 \u043F\u0440\u043E\u0444\u0456\u043B\u044C ${profile}`;
    gate.reason = [why, ...gate.reason.filter((x) => !x.includes("\u0437\u0430\u0444\u0456\u043A\u0441\u043E\u0432\u0430\u043D\u043E \u0432\u0440\u0443\u0447\u043D\u0443"))];
    r.log.reason = gate.reason;
  }
  r.log.data = { ...r.log.data, adapter: "shiftwork", ...input.ticketType ? { ticketType: input.ticketType } : {} };
  const skillItems = new Map(items.filter((i) => i.kind === "skill").map((i) => [i.name, i]));
  const skills = [...gate.skills.on, ...gate.skills.preload];
  const preload = [...gate.skills.preload];
  const bodies = [];
  for (const name of preload) {
    const it = skillItems.get(name);
    if (it?.body) bodies.push(`<!-- Preloaded skill: ${it.provenance.path ?? name} -->
${it.body}`);
  }
  const pluginDirSymlinks = [];
  for (const name of skills) {
    const p = skillItems.get(name)?.provenance.path;
    if (p) pluginDirSymlinks.push(/SKILL\.md$/i.test(p) ? dirOf(p) : p);
  }
  const skillOverrides = skillOverridesFor(gate, { hard: true });
  const env = {};
  if (gate.profile) env.CONTEXT_GATE_PROFILE = gate.profile;
  if (input.ticketType) env.CONTEXT_GATE_TICKET_TYPE = input.ticketType.trim();
  if (model) env.CONTEXT_GATE_MODEL = model;
  return {
    profile: gate.profile,
    tier: gate.tier,
    skills,
    preload,
    appendSystemPrompt: bodies.join("\n\n"),
    pluginDirSymlinks: [...new Set(pluginDirSymlinks)],
    settings: { skillOverrides },
    env,
    mcpOff: gate.mcp.off,
    gate,
    log: r.log
  };
}

// packages/hooks-adapter/src/node.ts
function readText(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return void 0;
  }
}
function toPosix(p) {
  return p.replace(/\\/g, "/");
}
function projectRoot(input, env = process.env) {
  return env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}
function loadGateConfig(root) {
  const text = readText(join(root, ".claude", "gate.json"));
  const r = loadConfig(text);
  return { config: r.config ?? defaultConfig(), diagnostics: r.diagnostics, present: text !== void 0 };
}
function nodeRuleFs(root) {
  return {
    list(dir) {
      let entries;
      try {
        entries = readdirSync(dir ? join(root, dir) : root, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const e of entries) {
        if (e.isFile()) out.push({ name: e.name, kind: "file" });
        else if (e.isDirectory()) out.push({ name: e.name, kind: "dir" });
      }
      return out;
    },
    read: (path) => readText(join(root, path))
  };
}
function loadRules(root, config) {
  if (config.cursorRules?.enabled === false) return { rules: [], diagnostics: [], skipped: "cursorRules.enabled: false" };
  if (existsSync(join(root, ".claude", "rules", "cursor"))) return { rules: [], diagnostics: [], skipped: ".claude/rules/cursor/ \u0454: \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u0434\u043E\u0441\u0442\u0430\u0432\u043B\u044F\u0454 Claude Code \u043D\u0430\u0442\u0438\u0432\u043D\u043E" };
  const fs = nodeRuleFs(root);
  return loadRuleSources(config, fs, { providerValue: (name) => staticProviderValue(config, name, fs.read) });
}
function frontmatter(text) {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!m) return { fm: {}, body: t };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return { fm, body: t.slice(m[0].length) };
}
function loadSkills(root, home = process.env.HOME || homedir()) {
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [base, source] of [[join(root, ".claude", "skills"), "project"], [join(home, ".claude", "skills"), "user"]]) {
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = join(base, e.name, "SKILL.md");
      const text = readText(file);
      if (text === void 0) continue;
      const { fm, body } = frontmatter(text);
      const name = fm.name || e.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const rel = toPosix(relative(root, file));
      const path = source === "project" && !rel.startsWith("..") ? rel : toPosix(file);
      const extra = { body, provenance: { source: "claude-skills", path } };
      if (fm.description) extra.description = fm.description;
      items.push(makeItem("skill", name, extra));
    }
  }
  return items;
}
function readBranch(root) {
  let gitDir = join(root, ".git");
  try {
    if (statSync(gitDir).isFile()) {
      const m2 = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m2) return void 0;
      gitDir = isAbsolute(m2[1].trim()) ? m2[1].trim() : join(root, m2[1].trim());
    }
  } catch {
    return void 0;
  }
  const head = readText(join(gitDir, "HEAD"));
  const m = head && /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  return m ? m[1].trim() : void 0;
}
function stateDir(env = process.env) {
  return env.CONTEXT_GATE_CACHE_DIR ? join(env.CONTEXT_GATE_CACHE_DIR, "hooks") : join(env.HOME || homedir(), ".cache", "context-gate", "hooks");
}
function statePath(sessionId, env = process.env) {
  const safe = sessionId.replace(/[^\w.-]+/g, "_").slice(0, 128) || "unknown";
  return join(stateDir(env), `${safe}.json`);
}
function readState(sessionId, env = process.env) {
  const text = readText(statePath(sessionId, env));
  if (text === void 0) return reviveState(void 0);
  try {
    return reviveState(JSON.parse(text));
  } catch {
    return reviveState(void 0);
  }
}
function writeState(sessionId, state, env = process.env) {
  const p = statePath(sessionId, env);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, p);
}
function appendJournal(root, entries) {
  if (!entries.length) return;
  const p = join(root, GATE_LOG);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, entries.map((e) => toJsonl(e)).join(""));
}
function fileExists(root, rel) {
  return existsSync(isAbsolute(rel) ? rel : join(root, rel));
}

// packages/hooks-adapter/src/install.ts
var HOOK_MARKER = "hooks-adapter.js";
function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
function hookCommand(scriptPath2, node = "node") {
  return `${node} ${shellQuote(scriptPath2)}`;
}
function hookEntries(command, timeout = 10) {
  const h = () => [{ type: "command", command, timeout }];
  return {
    SessionStart: [{ hooks: h() }],
    UserPromptSubmit: [{ hooks: h() }],
    PostToolUse: [{ matcher: "Read|Edit|Write|NotebookEdit", hooks: h() }],
    PreToolUse: [{ matcher: "mcp__.*|Edit|Write|NotebookEdit", hooks: h() }]
  };
}
function installGate(config, items, opts) {
  let cfg = config;
  let model = opts.model;
  if (opts.tier && !opts.model) {
    model = "__context-gate-tier__";
    cfg = { ...config, models: { [model]: opts.tier, ...config.models } };
  }
  const signals = { paths: [] };
  if (model) signals.model = model;
  if (opts.profile) signals.manual = { profile: opts.profile, add: [], remove: [] };
  return decideGate(cfg, signals, { turn: 0 }, items).gate;
}
function isOurs(m) {
  return Array.isArray(m?.hooks) && m.hooks.some((h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER));
}
function mergeSettings(existing, add) {
  const out = { ...existing };
  if (add.hooks) {
    const hooks = {};
    for (const [ev, list] of Object.entries(existing.hooks ?? {})) {
      const kept = (Array.isArray(list) ? list : []).filter((m) => !isOurs(m));
      if (kept.length) hooks[ev] = kept;
    }
    for (const [ev, list] of Object.entries(add.hooks)) hooks[ev] = [...hooks[ev] ?? [], ...list];
    out.hooks = hooks;
  }
  if (add.skillOverrides) {
    const so = { ...existing.skillOverrides ?? {} };
    for (const n of add.managedSkills ?? []) delete so[n];
    Object.assign(so, add.skillOverrides);
    if (Object.keys(so).length) out.skillOverrides = so;
    else delete out.skillOverrides;
  }
  return out;
}
function unmergeSettings(existing, managedSkills = []) {
  const out = mergeSettings(existing, { hooks: {}, skillOverrides: {}, managedSkills });
  if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

// packages/hooks-adapter/src/main.ts
var USAGE = `context-gate hooks adapter (claude-code-hooks)

  hooks-adapter.js                       \u0445\u0443\u043A settings: JSON \u043F\u043E\u0434\u0456\u0457 \u0437\u0456 stdin \u2192 JSON \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0456
  hooks-adapter.js install [\u043E\u043F\u0446\u0456\u0457]       \u0434\u043E\u0434\u0430\u0442\u0438 \u0445\u0443\u043A\u0438 \u0456 skillOverrides \u0443 .claude/settings.local.json
      --profile <p>   \u043F\u0440\u043E\u0444\u0456\u043B\u044C \u0434\u043B\u044F skillOverrides     --tier <t> | --model <id>
      --hard          off-skills \u2192 "off" (\u0456\u043D\u0430\u043A\u0448\u0435 "user-invocable-only")
      --no-skill-overrides   \u043B\u0438\u0448\u0435 \u0445\u0443\u043A\u0438            --print   \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u0438 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442, \u043D\u0456\u0447\u043E\u0433\u043E \u043D\u0435 \u043F\u0438\u0441\u0430\u0442\u0438
      --uninstall     \u043F\u0440\u0438\u0431\u0440\u0430\u0442\u0438 \u043D\u0430\u0448\u0456 \u0445\u0443\u043A\u0438 \u0439 \u043A\u043B\u044E\u0447\u0456   --root <dir>   \u043A\u043E\u0440\u0456\u043D\u044C \u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0456\u044E (\u0442\u0438\u043F\u043E\u0432\u043E cwd)
  hooks-adapter.js plan --type <Type> [--model <ref>] [--skills "+a -b"] [--root <dir>]
      \u043F\u043B\u0430\u043D \u0437\u043C\u0456\u043D\u0438 \u0434\u043B\u044F shiftwork-runner (JSON): profile, tier, skills, preload,
      appendSystemPrompt, pluginDirSymlinks, settings, env
`;
function debug(msg) {
  if (process.env.CONTEXT_GATE_DEBUG === "1") process.stderr.write(`context-gate hooks: ${msg}
`);
}
function flags(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== void 0 && !next.startsWith("--") && !["hard", "print", "uninstall", "no-skill-overrides", "help"].includes(a.slice(2))) {
      opts[a.slice(2)] = next;
      i++;
    } else opts[a.slice(2)] = true;
  }
  return { opts, rest };
}
var str2 = (v) => typeof v === "string" ? v : void 0;
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function runHook(input, env = process.env, now = Date.now()) {
  const root = projectRoot(input, env);
  const { config, diagnostics } = loadGateConfig(root);
  for (const d of diagnostics) debug(`${d.code} ${d.message}`);
  const { rules } = loadRules(root, config);
  const items = loadSkills(root, env.HOME);
  const sessionId = input.session_id || "unknown";
  const state = readState(sessionId, env);
  const hookEnv = {};
  for (const k of ["CONTEXT_GATE_PROFILE", "CONTEXT_GATE_MODE", "CONTEXT_GATE_OFF", "CONTEXT_GATE_TICKET_TYPE", "CONTEXT_GATE_MODEL", "ANTHROPIC_MODEL"]) {
    const v = env[k];
    if (v) hookEnv[k] = v;
  }
  const ctx = {
    root,
    config,
    rules,
    items,
    env: hookEnv,
    now,
    branch: readBranch(root),
    windows: detectWindows(root, env.OS),
    exists: (p) => fileExists(root, p)
  };
  const r = handleHook(input, ctx, state);
  writeState(sessionId, r.state, env);
  if (config.log?.file && r.log.length) {
    try {
      appendJournal(root, r.log);
    } catch (e) {
      debug(`journal: ${e.message}`);
    }
  }
  return { stdout: r.output ? JSON.stringify(r.output) : "", log: r.log };
}
function scriptPath() {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return resolve(process.argv[1] ?? "dist/hooks-adapter.js");
  }
}
function install(argv) {
  const { opts } = flags(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const root = resolve(str2(opts.root) ?? process.cwd());
  const settingsPath = join2(root, ".claude", "settings.local.json");
  let existing = {};
  if (existsSync2(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync2(settingsPath, "utf8"));
    } catch (e) {
      process.stderr.write(`${settingsPath} \u043D\u0435 \u043F\u0430\u0440\u0441\u0438\u0442\u044C\u0441\u044F: ${e.message}
`);
      return 1;
    }
  }
  const { config, diagnostics } = loadGateConfig(root);
  for (const d of diagnostics) process.stderr.write(`${d.severity} ${d.code}: ${d.message}
`);
  const items = loadSkills(root);
  const managedSkills = items.map((i) => i.name);
  let next;
  let gateInfo = "";
  if (opts.uninstall) next = unmergeSettings(existing, managedSkills);
  else {
    let script = scriptPath();
    if (!script.endsWith(HOOK_MARKER)) script = join2(dirname2(script), "..", "..", "..", "dist", HOOK_MARKER);
    const add = { hooks: hookEntries(hookCommand(script)) };
    if (!opts["no-skill-overrides"]) {
      const gate = installGate(config, items, { profile: str2(opts.profile), tier: str2(opts.tier), model: str2(opts.model), hard: !!opts.hard });
      add.skillOverrides = skillOverridesFor(gate, { hard: !!opts.hard });
      add.managedSkills = managedSkills;
      gateInfo = `\u043F\u0440\u043E\u0444\u0456\u043B\u044C ${gate.profile ?? "\u2014"}, tier ${gate.tier}: skills \u0443\u0432\u0456\u043C\u043A. ${gate.skills.on.length + gate.skills.preload.length}, \u043B\u0438\u0448\u0435 \u043D\u0430\u0437\u0432\u0430 ${gate.skills.nameOnly.length}, \u0432\u0438\u043C\u043A. ${gate.skills.off.length}`;
    }
    next = mergeSettings(existing, add);
  }
  const text = JSON.stringify(next, null, 2) + "\n";
  if (opts.print) {
    process.stdout.write(text);
    return 0;
  }
  mkdirSync2(dirname2(settingsPath), { recursive: true });
  if (existsSync2(settingsPath)) {
    const bak = `${settingsPath}.bak-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(settingsPath, bak);
    process.stdout.write(`\u0440\u0435\u0437\u0435\u0440\u0432\u043D\u0430 \u043A\u043E\u043F\u0456\u044F: ${bak}
`);
  }
  writeFileSync2(settingsPath, text);
  process.stdout.write(`${opts.uninstall ? "\u043F\u0440\u0438\u0431\u0440\u0430\u043D\u043E \u0437" : "\u0437\u0430\u043F\u0438\u0441\u0430\u043D\u043E \u0432"} ${settingsPath}${gateInfo ? `
${gateInfo}` : ""}
`);
  if (!opts.uninstall) process.stdout.write("\u041F\u0440\u043E\u0444\u0456\u043B\u044C \u043D\u0430 \u0441\u0435\u0441\u0456\u044E: CONTEXT_GATE_PROFILE=<p> \u0430\u0431\u043E [gate:<p>] \u0443 \u043F\u0440\u043E\u043C\u043F\u0442\u0456; \u0437\u0430\u0441\u0442\u043E\u0441\u0443\u0432\u0430\u043D\u043D\u044F \u0431\u0435\u0437 \u043F\u0440\u043E\u0444\u0456\u043B\u044E: CONTEXT_GATE_MODE=auto.\n");
  return 0;
}
function plan(argv) {
  const { opts } = flags(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const root = resolve(str2(opts.root) ?? process.cwd());
  const { config, diagnostics } = loadGateConfig(root);
  for (const d of diagnostics) process.stderr.write(`${d.severity} ${d.code}: ${d.message}
`);
  const items = loadSkills(root);
  const p = planForTicket(config, { ticketType: str2(opts.type), model: str2(opts.model), skills: str2(opts.skills), items, branch: readBranch(root) }, Date.now());
  const out = { ...p, pluginDirSymlinks: p.pluginDirSymlinks.map((s) => resolve(root, s)) };
  delete out.gate;
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "install") return install(rest);
  if (cmd === "plan") return plan(rest);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const raw = await readStdin();
    if (!raw.trim()) return 0;
    const input = JSON.parse(raw);
    const { stdout } = runHook(input);
    if (stdout) process.stdout.write(stdout + "\n");
  } catch (e) {
    debug(e.stack ?? String(e));
  }
  return 0;
}
var isEntry = (() => {
  try {
    return resolve(process.argv[1] ?? "") === scriptPath();
  } catch {
    return false;
  }
})();
if (isEntry) main().then((c) => {
  process.exitCode = c;
}, () => {
  process.exitCode = 0;
});
export {
  runHook
};
