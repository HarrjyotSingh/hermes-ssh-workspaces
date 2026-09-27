/* hermes-editor md-core: pure Markdown <-> document-model conversion.
 *
 * Runs identically in the browser bundle and in Node tests (no DOM,
 * no ProseMirror view imports). The document model is a plain JSON tree
 * matching the ProseMirror schema used by md-ui.js:
 *
 *   doc(frontmatter? | block*)           frontmatter {text}
 *   heading {level} | paragraph | blockquote | code_block {lang,text}
 *   horizontal_rule | raw_block {text}
 *   bullet_list | ordered_list {start} -> list_item {checked} -> blocks
 *   table -> table_row -> table_header/table_cell -> inline blocks
 *   inline: text {marks}, image {src,alt,title}, wikilink {target,heading,alias},
 *           hard_break, raw_inline {text}
 *   marks: bold, italic, strike, code, link {href,title}
 *
 * Storage guarantee: .md files stay ordinary portable Markdown. Nothing
 * editor-specific is ever written into them; unsupported constructs are
 * preserved verbatim via raw_block/raw_inline.
 */

var MARKDOWN_IT = require("markdown-it");

var md = new MARKDOWN_IT({ html: true, breaks: false, linkify: false });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isMdFile(name) {
  return /\.md$/i.test(name);
}

function splitFrontmatter(src) {
  var lines = src.split("\n");
  if (!/^---[ \t]*\r?$/.test(lines[0])) return null;
  for (var i = 1; i < Math.min(lines.length, 200); i++) {
    if (/^---[ \t]*\r?$/.test(lines[i])) {
      return {
        text: lines.slice(0, i + 1).join("\n"),
        rest: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wikilink syntax: [[Page]], [[Page|Alias]], [[Page#Heading]],
// [[Page#Heading|Alias]] and Obsidian embeds ![[-same-]] (images render
// inline; other files act as transclusion chips).
// ---------------------------------------------------------------------------

var WIKI_RE = /(!?)\[\[([^\[\]\n]+)\]\]/g;
var MATH_RE = /\$(?!\s)((?:\\.|[^$\n])+?)\$/g;

var IMAGE_EXTENSIONS = ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"];

function isImageTarget(path2) {
  var m = /\.([a-z0-9]+)$/i.exec(String(path2 || "").split(/[#|]/)[0].trim());
  return !!m && IMAGE_EXTENSIONS.indexOf(m[1].toLowerCase()) >= 0;
}

function parseWikilink(inner) {
  var alias = null;
  var target = inner;
  var pipe = inner.indexOf("|");
  if (pipe >= 0) {
    alias = inner.slice(pipe + 1);
    target = inner.slice(0, pipe);
  }
  var heading = null;
  var hash = target.indexOf("#");
  if (hash >= 0) {
    heading = target.slice(hash + 1);
    target = target.slice(0, hash);
  }
  return {
    type: "wikilink",
    attrs: {
      target: target.trim(),
      heading: heading && heading.trim() ? heading.trim() : null,
      alias: alias && alias.trim() ? alias.trim() : null,
    },
  };
}

function serializeWikilink(attrs) {
  var t = attrs.target || "";
  var out = t + (attrs.heading ? "#" + attrs.heading : "");
  if (attrs.alias) out += "|" + attrs.alias;
  return "[[" + out + "]]";
}

// markdown-it resolves entities inside inline href/title attributes; the
// raw attribute values may still contain numeric/named entities for
// html:false configs. Decode the small set that matters for URLs.
var _NAMED = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
function decodeEntities(s) {
  if (!s || s.indexOf("&") < 0) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, function (_m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_m, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
      return _NAMED[name] != null ? _NAMED[name] : m;
    });
}

// ---------------------------------------------------------------------------
// Markdown -> doc JSON
// ---------------------------------------------------------------------------

function parseMarkdown(src) {
  var doc = { type: "doc", content: [] };
  var fm = splitFrontmatter(src);
  var body = src;
  if (fm) {
    doc.content.push({ type: "frontmatter", attrs: { text: fm.text } });
    body = fm.rest.replace(/^\r?\n/, "");
  }

  var tokens = md.parse(body, {});

  // Pre-slice original lines so raw preservation can quote exact source.
  var lines = body.split("\n");

  var i = 0;
  function peek() { return tokens[i]; }

  function parseBlocksUntil(endType, endLevel) {
    var out = [];
    while (i < tokens.length) {
      var t = peek();
      if (endType && t.type === endType && (endLevel === undefined || t.level === endLevel)) break;
      var node = parseBlock(t, lines);
      if (node) out.push(node);
    }
    return out;
  }

  function inlineToContent(inlineToken, extraMarks) {
    return parseInlineChildren(inlineToken.children || [], extraMarks || {}, lines, inlineToken.map);
  }

  function parseBlock(t, linesRef) {
    i++;
    switch (t.type) {
      case "heading_open": {
        var level = parseInt(t.tag.slice(1), 10);
        var inline = tokens[i++];
        return { type: "heading", attrs: { level: level }, content: inline ? inlineToContent(inline) : [] };
      }
      case "paragraph_open": {
        var p = tokens[i++];
        // Display math: a paragraph whose whole content is wrapped in $$...$$.
        var blockMath = p && /^\$\$([\s\S]+)\$\$ *$/.exec(String(p.content || "").trim());
        if (blockMath) return { type: "math_block", attrs: { tex: blockMath[1].replace(/^\n+|\n+$/g, "") } };
        return { type: "paragraph", content: p ? inlineToContent(p) : [] };
      }
      case "blockquote_open": {
        var innerStart = i;
        var inner = parseBlocksUntil("blockquote_close");
        i++; // consume blockquote_close
        // merge nested blockquote children directly (blockquote > blockquote ok)
        return { type: "blockquote", content: inner };
      }
      case "bullet_list_open":
        return parseList(t, "bullet_list", null);
      case "ordered_list_open":
        return parseList(t, "ordered_list", parseInt((t.attrs && (t.attrs.find(function (a) { return a[0] === "start"; })) || [null, "1"])[1], 10) || 1);
      case "fence": {
        return {
          type: "code_block",
          attrs: { lang: (t.info || "").trim().split(/\s+/)[0] || "" },
          attrsText: t.content,
        };
      }
      case "code_block": {
        return { type: "code_block", attrs: { lang: "" }, attrsText: t.content };
      }
      case "hr":
        return { type: "horizontal_rule" };
      case "table_open": {
        return parseTable();
      }
      case "html_block": {
        // preserve exact original lines (token.content already exact)
        return { type: "raw_block", attrs: { reason: "html" }, attrsText: t.content };
      }
      case "math_block": {
        return { type: "raw_block", attrs: { reason: "math" }, attrsText: t.content };
      }
      default: {
        // Unknown block-level construct: preserve verbatim from source lines.
        if (t.map && t.type !== "inline") {
          var textLines = linesRef.slice(t.map[0], t.map[1]);
          while (textLines.length && textLines[textLines.length - 1].trim() === "") textLines.pop();
          if (textLines.length) {
            // skip its tokens: advance past everything belonging to this block
            var endLine = t.map[1];
            while (i < tokens.length) {
              var nt = tokens[i];
              if (nt.map && nt.map[0] >= endLine) break;
              if (!nt.map && (nt.type === "inline" || /_close$/.test(nt.type))) { i++; break; }
              i++;
            }
            return { type: "raw_block", attrs: { reason: t.type }, attrsText: textLines.join("\n") };
          }
        }
        return null; // closing tokens etc. handled by their openers
      }
    }

    function parseList(listOpen, kind, startAttr) {
      var items = [];
      var loose = !!listOpen.loose;
      while (i < tokens.length && tokens[i].type !== kind + "_close") {
        if (tokens[i].type !== "list_item_open") { i++; continue; }
        var open = tokens[i++];
        var checked = null;
        // task-list detection happens on first paragraph content below
        var blocks = [];
        while (i < tokens.length && tokens[i].type !== "list_item_close") {
          var b = parseBlock(tokens[i], linesRef);
          if (b) blocks.push(b);
        }
        i++; // list_item_close
        // task marker?
        var firstPara = blocks[0];
        if (firstPara && firstPara.type === "paragraph" && firstPara.content.length &&
            firstPara.content[0].type === "text") {
          var txt = firstPara.content[0].text || "";
          var mtask = /^\[([ xX])\] +/.exec(txt);
          if (mtask) {
            checked = mtask[1] !== " ";
            txt = txt.slice(mtask[0].length);
            if (txt) firstPara.content[0].text = txt;
            else firstPara.content.shift();
          }
        }
        items.push({ type: "list_item", attrs: { checked: checked }, content: blocks });
      }
      i++; // list close
      var node2 = { type: kind, content: items };
      if (kind === "ordered_list") node2.attrs = { start: startAttr || 1 };
      return node2;
    }

    function parseTable() {
      var rows = [];
      var aligns = [];
      while (i < tokens.length && tokens[i].type !== "table_close") {
        if (tokens[i].type === "thead_open") { i++; continue; }
        if (tokens[i].type === "tbody_open") { i++; continue; }
        if (tokens[i].type === "tr_open") {
          i++;
          var cells = [];
          while (i < tokens.length && tokens[i].type !== "tr_close") {
            if (tokens[i].type === "th_open" || tokens[i].type === "td_open") {
              var style = tokens[i].attrs && (tokens[i].attrs.find(function (a) { return a[0] === "style"; }) || [])[1];
              if (style && style.indexOf("text-align") >= 0 && cells.length === aligns.length) {
                aligns.push(/right/.test(style) ? "right" : /center/.test(style) ? "center" : "left");
              } else if (cells.length === aligns.length) {
                aligns.push("");
              }
              var cellInline = tokens[i + 1];
              i += 2;
              cells.push({
                type: tokens[i - 2].type === "th_open" ? "table_header" : "table_cell",
                content: cellInline ? inlineToContent(cellInline) : [],
              });
            } else { i++; }
          }
          i++; // tr_close
          rows.push({ type: "table_row", content: cells });
        } else { i++; }
      }
      i++; // table_close
      // normalize alignment row count
      var header = rows[0];
      if (header) {
        while (aligns.length < header.content.length) aligns.push("");
      }
      return { type: "table", attrs: { aligns: aligns }, content: rows };
    }
  }

  function parseInlineChildren(children, marks, linesRef, map) {
    var out = [];
    var pendingLink = null;

    function pushText(str) {
      if (!str) return;
      WIKI_RE.lastIndex = 0;
      var last = 0, mm;
      while ((mm = WIKI_RE.exec(str)) !== null) {
        if (mm.index > last) pushTextWithMath(str.slice(last, mm.index));
        var wl = parseWikilink(mm[2]);
        wl.marks = cloneMarks();
        if (mm[1]) {
          // Obsidian embed: ![[-target-]] renders the file (images inline).
          wl.type = "wiki_embed";
          if (!wl.attrs.alias) wl.attrs.alias = null;
        }
        out.push(wl);
        last = mm.index + mm[0].length;
      }
      if (last < str.length) pushTextWithMath(str.slice(last));
    }

    // Inline math: $...$ where content neither starts nor ends with space
    // and does not cross lines (Obsidian's rules). Escaped \$ never opens a
    // span, and currency like "$5 and $7" fails the no-space checks.
    function pushTextWithMath(str) {
      MATH_RE.lastIndex = 0;
      var last = 0, m;
      while ((m = MATH_RE.exec(str)) !== null) {
        var tex = m[1];
        if (tex === "" || /^\s/.test(tex) || /\s$/.test(tex)) {
          MATH_RE.lastIndex = m.index + 1; // not math — keep scanning
          continue;
        }
        if (m.index > last) out.push({ type: "text", marks: cloneMarks(), text: str.slice(last, m.index) });
        out.push({ type: "math_inline", attrs: { tex: tex }, marks: cloneMarks() });
        last = m.index + m[0].length;
      }
      if (last < str.length) out.push({ type: "text", marks: cloneMarks(), text: str.slice(last) });
    }
    function cloneMarks() {
      var arr = Object.keys(marks).map(function (k) { return marks[k]; });
      return arr.length ? arr : undefined;
    }

    for (var j = 0; j < children.length; j++) {
      var c = children[j];
      switch (c.type) {
        case "text": pushText(c.content); break;
        case "code_inline":
          out.push({ type: "text", marks: mergeMark({ type: "code" }), text: c.content });
          break;
        case "strong_open": marks.strong = { type: "bold" }; break;
        case "strong_close": delete marks.strong; break;
        case "em_open": marks.em = { type: "italic" }; break;
        case "em_close": delete marks.em; break;
        case "s_open": marks.s = { type: "strike" }; break;
        case "s_close": delete marks.s; break;
        case "link_open": {
          var href = (c.attrs && (c.attrs.find(function (a) { return a[0] === "href"; })) || [])[1] || "";
          var titleA = (c.attrs && (c.attrs.find(function (a) { return a[0] === "title"; })) || [])[1];
          pendingLink = href;
          marks.link = { type: "link", attrs: { href: decodeEntities(href), title: titleA ? decodeEntities(titleA) : null } };
          break;
        }
        case "link_close": delete marks.link; pendingLink = null; break;
        case "hardbreak": out.push({ type: "hard_break" }); break;
        case "softbreak":
          // Preserve the author's line wrapping inside paragraphs:
          // CommonMark treats a newline as a soft break (renders as space),
          // so keeping "\n" is rendering-identical and diff-friendly.
          pushText("\n");
          break;
        case "image": {
          var src = (c.attrs && (c.attrs.find(function (a) { return a[0] === "src"; })) || [])[1] || "";
          out.push({
            type: "image",
            attrs: { src: decodeEntities(src), alt: c.content || "", title: (c.attrs && (c.attrs.find(function (a) { return a[0] === "title"; })) || [null, null])[1] || null },
          });
          break;
        }
        case "html_inline": {
          // Obsidian notes lean on inline HTML for sub/superscripts
          // (R<sup>n</sup>, v<sub>1</sub>) and font colors. Render the two
          // structural ones as marks; everything else stays verbatim.
          var tag = /^<\/(sub|sup)\s*>$/i.exec(c.content);
          if (tag) {
            delete marks[tag[1].toLowerCase()];
          } else {
            var openTag = /^<(sub|sup)\s*>$/i.exec(c.content);
            if (openTag) {
              marks[openTag[1].toLowerCase()] = { type: openTag[1].toLowerCase() };
            } else {
              var fontTag = /^<font\s+color="([^"]*)"\s*>$/i.exec(c.content);
              if (fontTag) {
                marks.fontcolor = { type: "fontcolor", attrs: { color: fontTag[1] } };
              } else if (/^<\/font\s*>$/i.test(c.content)) {
                delete marks.fontcolor;
              } else {
                out.push({ type: "raw_inline", attrs: { reason: "html_inline" }, text: c.content });
              }
            }
          }
          break;
        }
        default: {
          // unknown inline construct (footnote refs, math, ...) -
          // preserve verbatim rather than drop
          out.push({ type: "raw_inline", attrs: { reason: c.type },
            text: c.content != null ? c.content : "<" + c.type + ">" });
          break;
        }
      }
    }
    function mergeMark(extra) {
      var arr = Object.keys(marks).map(function (k) { return marks[k]; }).concat([extra]);
      return arr;
    }
    return out;
  }

  doc.content = doc.content.concat(parseBlocksUntil(null));
  return normalizeDoc(doc);
}

function normalizeDoc(doc) {
  // Represent fenced code with canonical ProseMirror text children.
  function walk(n) {
    if (n.attrsText !== undefined) {
      var text = n.attrsText.replace(/\n$/, "");
      delete n.attrsText;
      if (n.type === "code_block") {
        n.content = text ? [{ type: "text", text: text + "\n" }] : [];
      } else {
        n.text = text + "\n";
      }
    }
    if (n.content) n.content.forEach(walk);
  }
  walk(doc);
  return doc;
}

// ---------------------------------------------------------------------------
// doc JSON -> Markdown
// ---------------------------------------------------------------------------

var ESCAPE_CHARS = /[\\`*_<>~]/;

function repeat(ch, n) {
  return new Array(n + 1).join(ch);
}

function escapeText(s, opts) {
  opts = opts || {};
  var out = "";
  for (var k = 0; k < s.length; k++) {
    var ch = s[k];
    var nxt = s[k + 1];
    if (ESCAPE_CHARS.test(ch)) { out += "\\" + ch; continue; }
    if (ch === "-" && nxt === "-" && s[k + 2] === "-") { out += "\\-"; k += 0; continue; }
    out += ch;
  }
  if (opts.inCell) out = out.replace(/\|/g, "\\|");
  if (opts.noTrailingSpace) out = out.replace(/ +$/, "");
  return out;
}

function escapeUrl(u) {
  if (/[\s<>()]/.test(u)) return "<" + u.replace(/</g, "%3C").replace(/>/g, "%3E") + ">";
  return u;
}

function serializeMarkdown(doc) {
  var linesOut = [];
  var issues = [];

  function inline(nodes, ctx) {
    nodes = nodes || [];
    ctx = ctx || {};
    var s = "";
    var i = 0;
    while (i < nodes.length) {
      var n = nodes[i];
      if (n.type === "text" && n.marks && n.marks.length && !hasCodeOnly(n)) {
        // collect a maximal run of text nodes with an identical mark set
        var key = markKey(n);
        var run = [];
        while (i < nodes.length && nodes[i].type === "text" &&
               nodes[i].marks && nodes[i].marks.length && markKey(nodes[i]) === key) {
          run.push(nodes[i]); i++;
        }
        s += emitMarked(run, n.marks, ctx);
        continue;
      }
      switch (n.type) {
        case "text": {
          var t = n.text == null ? "" : n.text;
          if (hasCodeMark(n)) {
            s += "`" + String(t).replace(/`/g, "\\`") + "`";
          } else if (t === " ") {
            s += " ";
          } else {
            s += escapeText(t, { inCell: ctx.inCell });
          }
          break;
        }
        case "image":
          s += "![" + escapeText(n.attrs.alt || "") + "](" + escapeUrl(n.attrs.src || "") +
               (n.attrs.title ? " \"" + String(n.attrs.title).replace(/"/g, "'") + "\"" : "") + ")";
          break;
        case "wikilink":
          s += serializeWikilink(n.attrs || {});
          break;
        case "wiki_embed":
          s += "!" + serializeWikilink(n.attrs || {});
          break;
        case "hard_break": s += "  \n"; break;
        // Live-LaTeX nodes: emit Obsidian-faithful delimiters.
        case "math_inline":
          s += "$" + String((n.attrs && n.attrs.tex) || "") + "$";
          break;
        // raw verbatim lives on attrs.text in live-doc (schema) JSON and on
        // .text in IR JSON; accept both so saves never drop content.
        case "raw_inline": s += rawVerbatim(n); break;
        default:
          if (n.content) s += inline(n.content, ctx); // defensive
      }
      i++;
    }
    return s;

    function hasCodeOnly(node) {
      return node.marks.length === 1 && node.marks[0].type === "code";
    }
    function hasCodeMark(node) {
      return (node.marks || []).some(function (m) { return m.type === "code"; });
    }
    function markKey(node) {
      return (node.marks || []).map(function (m) {
        return m.type + ":" + (m.attrs ? JSON.stringify(m.attrs) : "");
      }).sort().join("|");
    }
    function emitMarked(run, marksArr, ictx) {
      var raw = run.map(function (r) { return r.text == null ? "" : r.text; }).join("");
      var codeM = marksArr.filter(function (m2) { return m2.type === "code"; })[0];
      var rest = marksArr.filter(function (m2) { return m2.type !== "code"; });
      var inner = codeM
        ? "`" + raw.replace(/`/g, "\\`") + "`"
        : escapeText(raw, { inCell: ictx.inCell });
      // wrap from innermost out: strike -> bold -> italic -> link
      if (!codeM) {
        if (rest.some(function (m2) { return m2.type === "strike"; })) inner = "~~" + inner + "~~";
        if (rest.some(function (m2) { return m2.type === "bold" })) inner = "**" + inner + "**";
        if (rest.some(function (m2) { return m2.type === "italic" })) inner = "*" + inner + "*";
        if (rest.some(function (m2) { return m2.type === "sup" })) inner = "<sup>" + inner + "</sup>";
        if (rest.some(function (m2) { return m2.type === "sub" })) inner = "<sub>" + inner + "</sub>";
        var fc = rest.filter(function (m2) { return m2.type === "fontcolor"; })[0];
        if (fc && fc.attrs && fc.attrs.color) {
          inner = '<font color="' + fc.attrs.color + '">' + inner + "</font>";
        }
      }
      var linkM = rest.filter(function (m2) { return m2.type === "link"; })[0];
      if (linkM) {
        inner = "[" + inner + "](" + escapeUrl(linkM.attrs.href || "") +
          (linkM.attrs.title ? " \"" + String(linkM.attrs.title).replace(/"/g, "'") + "\"" : "") + ")";
      }
      return inner;
    }
  }

  function inlineWrapped(nodes, open, close, ctx) {
    return open + inline(nodes, ctx) + close;
  }

  function block(node, indent) {
    indent = indent || "";
    switch (node.type) {
      case "frontmatter":
        return node.attrs.text;
      case "heading": {
        var hashes = repeat("#", node.attrs.level);
        return indent + hashes + " " + inline(node.content || []);
      }
      case "paragraph": {
        var txt = inline(node.content || []);
        return txt.split("\n").map(function (l) { return indent + l; }).join("\n");
      }
      case "blockquote":
        return indent + blockquoteInner(node.content || []);
      case "code_block": {
        var lang = (node.attrs && node.attrs.lang) || "";
        var body = String((node.content || []).map(function (child) { return child.text || ""; }).join(""));
        // pick a fence longer than any backtick run in body
        var longest = 0;
        body.replace(/`+/g, function (m) { longest = Math.max(longest, m.length); return m; });
        var fence = repeat("`", Math.max(3, longest));
        var renderedBody = body
          ? body.replace(/\n$/, "").split("\n").map(function (l) { return indent + l; }).join("\n") + "\n"
          : "";
        return indent + fence + lang + "\n" + renderedBody + indent + fence;
      }
      case "horizontal_rule":
        return indent + "---";
      case "math_block": {
        var texB = String((node.attrs && node.attrs.tex) || "");
        var body2 = texB.split("\n").map(function (l) { return indent + l; }).join("\n");
        return indent + "$$\n" + body2 + "\n" + indent + "$$";
      }
      case "raw_block":
        return String(rawVerbatim(node) || "").split("\n").map(function (l) { return indent + l; }).join("\n");
      case "bullet_list": {
        return (node.content || []).map(function (item) {
          return listItem(item, "- ", indent);
        }).join("\n");
      }
      case "ordered_list": {
        var startN = (node.attrs && node.attrs.start) || 1;
        return (node.content || []).map(function (item, ix) {
          return listItem(item, (startN + ix) + ". ", indent);
        }).join("\n");
      }
      case "table":
        return tableLines(node, indent);
      default:
        issues.push("unknown block: " + node.type);
        return indent + (node.text || "");
    }

    function blockquoteInner(children) {
      var inner = children.map(function (b) { return block(b, ""); }).join("\n\n");
      return inner.split("\n").map(function (l) { return "> " + l; }).join("\n");
    }

    function listItem(item, marker, baseIndent) {
      var checked = item.attrs && item.attrs.checked;
      var m = marker;
      if (checked === true) m = marker + "[x] ";
      else if (checked === false) m = marker + "[ ] ";
      var pad = repeat(" ", m.length);
      var innerBlocks = (item.content || []).map(function (b, bi) {
        return block(b, "");
      });
      var inner = innerBlocks[0] || "";
      for (var bj = 1; bj < innerBlocks.length; bj++) {
        var prevIsTextual = item.content[bj - 1].type === "paragraph";
        var curIsList = /_list$/.test(item.content[bj].type);
        inner += (prevIsTextual && curIsList) ? "\n" : "\n\n";
        inner += innerBlocks[bj];
      }
      var ilines = inner.split("\n");
      var out = baseIndent + m + (ilines[0] || "");
      for (var li = 1; li < ilines.length; li++) {
        out += "\n" + baseIndent + pad + ilines[li];
      }
      return out;
    }

    function tableLines(tbl, baseIndent) {
      var aligns = (tbl.attrs && tbl.attrs.aligns) || [];
      var header = tbl.content[0];
      if (!header) return "";
      function row(cells) {
        return "| " + cells.map(function (cell) {
          return inline(cell.content || [], { inCell: true }).replace(/\n/g, " ");
        }).join(" | ") + " |";
      }
      function sep() {
        return "| " + header.content.map(function (_c, ix) {
          var a = aligns[ix] || "";
          if (a === "left") return ":--";
          if (a === "right") return "--:";
          if (a === "center") return ":-:";
          return "---";
        }).join(" | ") + " |";
      }
      var bodyRows = tbl.content.filter(function (r, ix) { return ix > 0; });
      return [row(header.content), sep()].concat(bodyRows.map(function (r) { return row(r.content); })).join("\n");
    }
  }

  var blocks = doc.content || [];
  var parts = [];
  for (var bi = 0; bi < blocks.length; bi++) {
    var piece = block(blocks[bi], "");
    if (piece !== "") parts.push(piece);
  }
  return { markdown: parts.join("\n\n") + "\n", issues: issues };
}

// Idempotency / safety check used before every save:
// parse(serialize(parse(src))) must serialize identically.
function roundTripStable(markdownText) {
  var a = parseMarkdown(markdownText);
  var once = serializeMarkdown(a).markdown;
  var b = parseMarkdown(once);
  var twice = serializeMarkdown(b).markdown;
  return { stable: once === twice, once: once, twice: twice };
}

// Verbatim content of a raw node: live ProseMirror docs carry it as the
// required attrs.text attribute, IR docs carry it on .text.
function rawVerbatim(node) {
  if (node.attrs && node.attrs.text != null) return node.attrs.text;
  return node.text;
}

// Editor-boundary adapter: convert IR-shaped doc JSON into JSON that
// Node.fromJSON can load. The schema declares raw_block/raw_inline text as
// a REQUIRED attribute (no default), so passing IR nodes whose verbatim
// content sits on .text throws "No value supplied for attribute text" and
// prevents the file from opening at all.
function toSchemaJSON(node) {
  if (!node || typeof node !== "object") return node;
  var out = node;
  if ((node.type === "raw_block" || node.type === "raw_inline") &&
      typeof node.text === "string" &&
      !(node.attrs && node.attrs.text != null)) {
    out = Object.assign({}, node);
    delete out.text;
    out.attrs = Object.assign({}, node.attrs || {}, { text: node.text });
  }
  if (out.content) {
    out = Object.assign({}, out, { content: out.content.map(toSchemaJSON) });
  }
  return out;
}

module.exports = {
  parseMarkdown: parseMarkdown,
  serializeMarkdown: serializeMarkdown,
  roundTripStable: roundTripStable,
  parseWikilink: parseWikilink,
  serializeWikilink: serializeWikilink,
  isImageTarget: isImageTarget,
  isMdFile: isMdFile,
  toSchemaJSON: toSchemaJSON,
};
