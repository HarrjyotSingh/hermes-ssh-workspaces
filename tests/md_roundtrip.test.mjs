// hermes-editor Stage 4: Markdown round-trip fidelity suite.
// Run: node tests/md_roundtrip.test.mjs   (Node >= 18, no deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const MD = require(path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "build", "dist-md-core.cjs"
));

const here = path.dirname(fileURLToPath(import.meta.url));

function roundtrip(src) {
  const doc = MD.parseMarkdown(src);
  const once = MD.serializeMarkdown(doc);
  assert.deepEqual(once.issues, [], `serializer issues: ${once.issues}`);
  const rt = MD.roundTripStable(src);
  assert.equal(rt.stable, true, `not idempotent.\nONCE:\n${rt.once}\nTWICE:\n${rt.twice}`);
  return { doc, out: rt.once };
}

test("headings 1-6 round-trip", () => {
  const src = "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n";
  const { out } = roundtrip(src);
  for (const [n, name] of [[1, "#"], [2, "##"], [6, "######"]]) {
    assert.ok(out.includes(`${name} `), `${name} heading missing`);
  }
});

test("bold, italic, strikethrough, inline code", () => {
  const src = "A **strong** and *em* and ~~gone~~ and `code` end.\n";
  const { out } = roundtrip(src);
  assert.match(out, /\*\*strong\*\*/);
  assert.match(out, /\*em\*/);
  assert.match(out, /~~gone~~/);
  assert.match(out, /`code`/);
  const a = JSON.stringify(MD.parseMarkdown(src));
  const b = JSON.stringify(MD.parseMarkdown(out));
  assert.equal(a, b, "structure drift");
});

test("nested bullet lists stay nested and tight", () => {
  const src = "- a\n- b\n  - b1\n  - b2\n    - deep\n- c\n";
  const { out } = roundtrip(src);
  assert.equal(out.trim(), src.trim(), "nested list normalized unexpectedly");
});

test("ordered lists with explicit start", () => {
  const src = "3. three\n4. four\n5. five\n";
  const { doc } = roundtrip(src);
  const ol = doc.content.find((n) => n.type === "ordered_list");
  assert.equal(ol.attrs.start, 3);
});

test("task lists open/checked", () => {
  const src = "- [ ] open\n- [x] done\n- [X] also done\n";
  const { doc } = roundtrip(src);
  const items = doc.content[0].content;
  assert.deepEqual(items.map((i) => i.attrs.checked), [false, true, true]);
});

test("links with titles; urls preserved", () => {
  const src = "[example](https://x.y/z \"Title\") and [b](https://a.b/c)\n";
  const { out } = roundtrip(src);
  assert.match(out, /\[example\]\(https:\/\/x\.y\/z "Title"\)/);
  assert.match(out, /\[b\]\(https:\/\/a\.b\/c\)/);
});

test("fenced code blocks keep language identifiers and content", () => {
  const src = "```python\ndef f():\n    return 1\n```\n\n```ts\nlet x = `tpl`;\n```\n";
  const { out } = roundtrip(src);
  assert.match(out, /```python\ndef f\(\):\n    return 1\n```/);
  assert.match(out, /```ts\nlet x = `tpl`;\n```/);
});

test("fenced code uses canonical ProseMirror text children", () => {
  const tagged = "```sh\necho \"stage6\"\npwd\n```\n";
  const taggedDoc = MD.parseMarkdown(tagged);
  const taggedNode = taggedDoc.content.find((node) => node.type === "code_block");
  assert.ok(taggedNode);
  assert.equal(taggedNode.attrs.lang, "sh");
  assert.equal(Object.hasOwn(taggedNode, "text"), false);
  assert.deepEqual(taggedNode.content, [{ type: "text", text: "echo \"stage6\"\npwd\n" }]);
  const taggedOut = MD.serializeMarkdown(taggedDoc).markdown;
  assert.match(taggedOut, /```sh\necho "stage6"\npwd\n```/);

  const untagged = "```\nalpha\nbeta\n```\n";
  const untaggedNode = MD.parseMarkdown(untagged).content.find((node) => node.type === "code_block");
  assert.equal(untaggedNode.attrs.lang, "");
  assert.equal(Object.hasOwn(untaggedNode, "text"), false);
  assert.deepEqual(untaggedNode.content, [{ type: "text", text: "alpha\nbeta\n" }]);
  assert.match(MD.serializeMarkdown(MD.parseMarkdown(untagged)).markdown, /```\nalpha\nbeta\n```/);

  const emptyNode = MD.parseMarkdown("```\n```\n").content.find((node) => node.type === "code_block");
  assert.equal(Object.hasOwn(emptyNode, "text"), false);
  assert.deepEqual(emptyNode.content, []);
  assert.equal(MD.serializeMarkdown(MD.parseMarkdown("```\n```\n")).markdown, "```\n```\n");
});

test("GFM tables with alignment", () => {
  const src = "| A | B |\n|---|:-:|\n| 1 | 2 |\n";
  const { doc } = roundtrip(src);
  const tbl = doc.content[0];
  assert.equal(tbl.type, "table");
  assert.equal(tbl.attrs.aligns[1], "center");
  const rt = MD.roundTripStable(src);
  assert.match(rt.once, /\| :-: \|/, "center alignment row missing");
});

test("blockquotes (single and multi-line)", () => {
  const src = "> line one\n> line two\n\n> nested quote para two\n";
  const { out } = roundtrip(src);
  assert.match(out, /^> line one\n> line two$/m);
});

test("escaped characters keep literal meaning", () => {
  const src = "Escaped \\*star\\* \\_under\\_ \\[bracket\\] and \\\\ backslash.\n";
  const { doc } = roundtrip(src);
  const para = doc.content[0].content[0].text || "";
  assert.ok(para.includes("*star*"), "escape not resolved on parse");
  // serialized form re-escapes so meaning survives
  const out = MD.roundTripStable(src).once;
  assert.match(out, /\\\*star\\\*/, "re-escaping lost");
  assert.ok(!MD.parseMarkdown(out).content[0].content[0].text.includes("\\*"));
});

test("blank-line structure stays valid between blocks", () => {
  const src = "# T\n\ntext one\n\n- x\n- y\n\nmore text\n";
  const { out } = roundtrip(src);
  const blocks = out.split(/\n\n+/).length;
  assert.ok(blocks >= 4, "blocks collapsed together");
});

test("YAML frontmatter is preserved byte-for-byte and first", () => {
  const fm = "---\ntitle: Note\naliases: [A, B]\ncustom: |-\n  keep me\n---\n";
  const body = "\n# Body\n\ntext\n";
  const { doc } = roundtrip(fm + body);
  assert.equal(doc.content[0].type, "frontmatter");
  assert.equal(doc.content[0].attrs.text, fm.trimEnd());
  const out = MD.roundTripStable(fm + body).once;
  assert.ok(out.startsWith(fm.trimEnd()));
});

test("wikilink forms parse to nodes and serialize back", () => {
  const cases = [
    ["[[Page]]", { target: "Page" }],
    ["[[Page|Alias]]", { target: "Page", alias: "Alias" }],
    ["[[Page#Head]]", { target: "Page", heading: "Head" }],
    ["[[Page#Head|Alias]]", { target: "Page", heading: "Head", alias: "Alias" }],
  ];
  for (const [src, attrs] of cases) {
    const doc = MD.parseMarkdown(`x ${src} y`);
    let wl = null;
    const walk = (n) => {
      if (n.type === "wikilink") wl = n;
      (n.content || []).forEach(walk);
    };
    walk(doc);
    assert.ok(wl, `no wikilink node for ${src}`);
    assert.equal(wl.attrs.target, attrs.target);
    assert.equal(wl.attrs.heading ?? null, attrs.heading ?? null);
    assert.equal(wl.attrs.alias ?? null, attrs.alias ?? null);
    assert.ok(MD.serializeWikilink(wl.attrs) === src, `serialize mismatch ${MD.serializeWikilink(wl.attrs)}`);
  }
});

test("existing valid markdown (not editor-generated) loses no constructs", () => {
  const fixturesDir = path.join(here, "fixtures");
  const files = [
    "obsidian_note.md",
    "vscode_readme.md",
    "kitchen_sink.md",
  ];
  for (const f of files) {
    const src = readFileSync(path.join(fixturesDir, f), "utf8");
    const { doc } = roundtrip(src);
    // structural assertions per file type
    if (f === "obsidian_note.md") {
      assert.equal(doc.content[0].type, "frontmatter");
      let wls = [];
      const walk = (n) => {
        if (n.type === "wikilink") wls.push(n.attrs);
        (n.content || []).forEach(walk);
      };
      walk(doc);
      assert.ok(wls.some((w) => w.target === "Daily/2026-01-01"), "wikilink lost");
      assert.ok(wls.some((w) => w.heading === "Cell"), "heading wikilink lost");
    }
    if (f === "kitchen_sink.md") {
      const types = new Set();
      const collect = (n) => { types.add(n.type); (n.content || []).forEach(collect); };
      collect(doc);
      assert.ok(types.has("table"), "table lost");
      assert.ok(types.has("code_block"), "code block lost");
      assert.ok(types.has("blockquote"), "blockquote lost");
    }
  }
});

test("unsupported constructs are preserved verbatim (raw nodes)", () => {
  const src = "<div class=\"keep\">\nraw html block\n</div>\n\ntext with <span>inline html</span>\n";
  const doc = MD.parseMarkdown(src);
  let rawBlock = null;
  const rawInlines = [];
  const walk = (n) => {
    if (n.type === "raw_block") rawBlock = n;
    if (n.type === "raw_inline") rawInlines.push(n.text);
    (n.content || []).forEach(walk);
  };
  walk(doc);
  assert.ok(rawBlock && String(rawBlock.text).includes("<div class=\"keep\">"), "html block dropped");
  assert.ok(rawInlines.some((x) => x.includes("<span>")), "html inline dropped");
  const out = MD.roundTripStable(src).once;
  assert.match(out, /<div class="keep">[\s\S]*<\/div>/);
  assert.match(out, /<span>inline html<\/span>/);
});

test("footnote-style and definition-list-ish constructs do not crash or vanish", () => {
  const src = "Here is a footnote ref.[^1] and a term\n: definition style line\n";
  const { out } = roundtrip(src);
  assert.ok(out.length > 10);
  assert.match(out, /ref\.\[\^1\]/, "footnote marker destroyed");
});

test("ProseMirror-style JSON with empty blocks serializes instead of crashing", () => {
  // PM omits `content` on empty blocks; Save must not throw undefined.length.
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 } },
      { type: "paragraph" },
      { type: "bullet_list", content: [{ type: "list_item", attrs: { checked: null }, content: [{ type: "paragraph" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "tail" }] },
    ],
  };
  const out = MD.serializeMarkdown(doc);
  assert.ok(typeof out.markdown === "string");
  assert.match(out.markdown, /# /);
  assert.match(out.markdown, /- $/m);
  assert.match(out.markdown, /tail/);
});

test("toSchemaJSON moves raw verbatim .text into required attrs.text", () => {
  const src = "<!-- a hidden note -->\n\npara with <span>inline html</span>\n";
  const doc = MD.parseMarkdown(src);
  const schemaDoc = MD.toSchemaJSON(doc);

  const blocks = [];
  (function walk(n) {
    if (n.type === "raw_block" || n.type === "raw_inline") blocks.push(n);
    if (n.content) n.content.forEach(walk);
  })(schemaDoc);

  assert.ok(blocks.length >= 2, "expected raw nodes in doc");
  for (const b of blocks) {
    assert.equal(b.text, undefined, "IR .text must not leak into schema JSON");
    assert.equal(typeof b.attrs.text, "string", "attrs.text must carry verbatim");
    assert.ok(b.attrs.text.length > 0);
    assert.notEqual(b, undefined);
  }
  // original IR untouched (non-mutating)
  const irBlocks = [];
  (function walk(n) {
    if (n.type === "raw_block" || n.type === "raw_inline") irBlocks.push(n);
    if (n.content) n.content.forEach(walk);
  })(doc);
  assert.ok(irBlocks.some((b) => typeof b.text === "string"));
});

test("serializer accepts live-doc shape where raw text sits on attrs.text", () => {
  const live = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "raw_block", attrs: { text: "<div>kept</div>\n", reason: "html" } },
      { type: "paragraph", content: [
        { type: "text", text: "mid " },
        { type: "raw_inline", attrs: { text: "<br/>", reason: "html_inline" } },
      ] },
    ],
  };
  const { markdown } = MD.serializeMarkdown(live);
  assert.match(markdown, /<div>kept<\/div>/);
  assert.match(markdown, /<br\/>/);
});

test("schema-shaped raw docs load through ProseMirror Node.fromJSON without crashing", async () => {
  const { createRequire: cr2 } = await import("node:module");
  const PM = require(path.join(here, "..", "build", "node_modules", "prosemirror-model"));

  const schema = new PM.Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*" },
      heading: { attrs: { level: { default: 1 } }, group: "block", content: "inline*" },
      raw_block: { attrs: { text: {}, reason: { default: "" } }, group: "block", code: true },
      raw_inline: { inline: true, group: "inline", atom: true, attrs: { text: {}, reason: { default: "" } } },
      text: { group: "inline" },
    },
  });

  const src = [
    "<!-- config comment that must not break opening -->",
    "",
    "# Title",
    "",
    "Body with <em style='x'>inline html</em> kept.",
    "",
  ].join("\n");

  // IR straight from the parser used to throw RangeError here.
  const ir = MD.parseMarkdown(src);
  assert.throws(() => PM.Node.fromJSON(schema, ir), /No value supplied for attribute text/);
  const loaded = PM.Node.fromJSON(schema, MD.toSchemaJSON(ir));
  assert.equal(loaded.type.name, "doc");
  let sawRaw = 0;
  loaded.descendants((n) => {
    if (n.type.name.startsWith("raw_")) sawRaw++;
  });
  assert.ok(sawRaw >= 2, "raw nodes lost during load");
});

test("inline math $...$ parses to dedicated nodes and round-trips", () => {
  const src = "Euler: $e^{i\\pi}+1=0$ indeed\n";
  const doc = MD.parseMarkdown(src);
  const paras = doc.content.filter(n => n.type === "paragraph");
  const inlines = [];
  for (const p of paras) for (const c of (p.content || [])) if (c.type === "math_inline") inlines.push(c);
  assert.equal(inlines.length, 1);
  assert.equal(inlines[0].attrs.tex, "e^{i\\pi}+1=0");
  assert.equal(MD.serializeMarkdown(doc).markdown.trim(), src.trim());
});

test("display math $$..$$ becomes math_block and round-trips", () => {
  const src = "$$\n\\int_0^1 x^2\\,dx = \\tfrac13\n$$\n";
  const doc = MD.parseMarkdown(src);
  const blocks = doc.content.filter(n => n.type === "math_block");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].attrs.tex, "\\int_0^1 x^2\\,dx = \\tfrac13");
  const { markdown } = MD.serializeMarkdown(doc);
  assert.match(markdown, /\$\$\n\\int_0\^1 x\^2\\,dx = \\tfrac13\n\$\$/);
});

test("lone dollars (currency) stay plain text", () => {
  const doc = MD.parseMarkdown("it costs $5 today and $7 tomorrow\n");
  let math = 0;
  for (const p of doc.content.filter(n => n.type === "paragraph")) {
    for (const c of (p.content || [])) if (c.type === "math_inline") math++;
  }
  assert.equal(math, 0);
});

test("math nodes load through ProseMirror with defaulted attrs", async () => {
  const { createRequire } = await import("node:module");
  void createRequire;
  const PM = require(path.join(here, "..", "build", "node_modules", "prosemirror-model"));
  const schema = new PM.Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*" },
      math_inline: { inline: true, group: "inline", atom: true, attrs: { tex: { default: "" } } },
      text: { group: "inline" },
    },
  });
  const doc = MD.toSchemaJSON(MD.parseMarkdown("a $x^2$ b\n"));
  const loaded = PM.Node.fromJSON(schema, doc);
  assert.equal(loaded.textContent.includes("x^2") || JSON.stringify(doc).includes("math_inline"), true);
});

// ---------------------------------------------------------------------------
// Inline HTML: sub/sup/font — the Obsidian-style tags real vaults use
// ---------------------------------------------------------------------------

test("R<sup>n</sup> and v<sub>1</sub> parse to marks and round-trip byte-identical", () => {
  const src = "R<sup>n</sup> and v<sub>1</sub>\n";
  const doc = MD.parseMarkdown(src);
  const para = doc.content.find(n => n.type === "paragraph");
  const supNode = (para.content || []).find(c => c.type === "text" && (c.marks || []).some(m => m.type === "sup"));
  const subNode = (para.content || []).find(c => c.type === "text" && (c.marks || []).some(m => m.type === "sub"));
  assert.equal(supNode && supNode.text, "n");
  assert.equal(subNode && subNode.text, "1");
  const { markdown } = MD.serializeMarkdown(doc);
  assert.equal(markdown, src);
});

test("mixed math + sub: $vec{v}$<sub>1</sub> round-trips", () => {
  const src = "$\\vec{v}$<sub>1</sub> , ...... $\\vec{v}$<sub>p</sub>\n";
  const doc = MD.parseMarkdown(src);
  const para = doc.content.find(n => n.type === "paragraph");
  const kinds = (para.content || []).map(c => c.type);
  assert.ok(kinds.includes("math_inline"), "math still parses");
  assert.ok((para.content || []).some(c => (c.marks || []).some(m => m.type === "sub")), "sub mark present");
  const { markdown } = MD.serializeMarkdown(doc);
  assert.equal(markdown, src);
});

test("font color round-trips byte-identical", () => {
  const src = 'all points <font color="#00b050">each point in the co-domain</font> here\n';
  const doc = MD.parseMarkdown(src);
  const para = doc.content.find(n => n.type === "paragraph");
  const fcNode = (para.content || []).find(c => (c.marks || []).some(m => m.type === "fontcolor"));
  assert.ok(fcNode, "fontcolor mark present");
  const { markdown } = MD.serializeMarkdown(doc);
  assert.equal(markdown, src);
});

test("heading with <sup> round-trips", () => {
  const src = "# Subspaces of R<sup>n</sup>\n";
  const { markdown } = MD.serializeMarkdown(MD.parseMarkdown(src));
  assert.equal(markdown, src);
});

test("classic LaTeX math with ^ and _ is untouched by sub/sup support", () => {
  const src = "$x^2 + v_1$ stays math, and 10^6 plain text stays plain\n";
  const doc = MD.parseMarkdown(src);
  const para = doc.content.find(n => n.type === "paragraph");
  assert.ok((para.content || []).some(c => c.type === "math_inline" && c.attrs.tex === "x^2 + v_1"));
  const { markdown } = MD.serializeMarkdown(doc);
  assert.equal(markdown, src);
});
