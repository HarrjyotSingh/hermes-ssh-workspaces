/* hermes-editor md-ui: ProseMirror WYSIWYG editor for Markdown files.
 *
 * Plain-DOM ProseMirror view mounted inside the Stage 3 plugin page; the
 * host SDK's React remains the only React runtime. Document model JSON
 * matches build/src/md-core.js exactly:
 *
 *   .md bytes -> md-core.parseMarkdown -> doc JSON -> ProseMirror doc
 *   editing   -> doc JSON -> md-core.serializeMarkdown -> .md bytes
 *            -> existing revision-safe atomic write API (Stage 3)
 */
(function () {
  "use strict";

  var Model, State, View, History, Keymap, Commands, SchemaList;

  // KaTeX powers the live-LaTeX nodeviews; its stylesheet is bundled by the
  // build (fonts fall back to system faces when the woff assets are absent).
  var katex = require("katex");
  require("katex/dist/katex.min.css");

  // Modifier state captured at MOUSEDOWN time: some Electron/Chromium paths
  // deliver the subsequent click event to ProseMirror with modifiers stripped,
  // so handleClickOn consults this record instead of trusting evt alone.
  var lastMouseDownMods = { alt: false, ctrl: false, meta: false };

  function openModifiers(evt) {
    return {
      alt: !!(evt && evt.altKey),
      ctrl: !!((evt && (evt.ctrlKey || evt.metaKey)) || lastMouseDownMods.ctrl),
      meta: !!((evt && evt.metaKey) || lastMouseDownMods.meta),
    };
  }

  // IR -> schema JSON boundary: raw verbatim nodes carry content on .text in
  // doc JSON, but the schema requires it as the attrs.text attribute; feeding
  // IR straight to Node.fromJSON throws "No value supplied for attribute text"
  // and blocks the file from opening.
  function schemaLoadable(docJSON) {
    var MD = globalThis.__HERMES_EDITOR_MD__ || {};
    return MD.toSchemaJSON ? MD.toSchemaJSON(docJSON) : docJSON;
  }

  function initPM(libs) {
    Model = libs.Model; State = libs.State; View = libs.View;
    History = libs.History; Keymap = libs.Keymap; Commands = libs.Commands;
    SchemaList = libs.SchemaList;
  }

  function buildSchema() {
    return new Model.Schema({
      nodes: {
        doc: { content: "block+" },
        frontmatter: {
          attrs: { text: {} },
          group: "block", code: true, defining: true,
          parseDOM: [{ tag: "pre.he-frontmatter", preserveWhitespace: true }],
          toDOM: function () { return ["pre", { class: "he-frontmatter" }, 0]; },
        },
        paragraph: { group: "block", content: "inline*", parseDOM: [{ tag: "p" }], toDOM: function () { return ["p", 0]; } },
        heading: {
          attrs: { level: { default: 1 } },
          group: "block", defining: true, content: "inline*",
          parseDOM: [1,2,3,4,5,6].map(function (l) {
            return { tag: "h" + l, getAttrs: function () { return { level: l }; } };
          }),
          toDOM: function (n) { return ["h" + n.attrs.level, 0]; },
        },
        blockquote: { group: "block", defining: true, content: "block+", parseDOM: [{ tag: "blockquote" }], toDOM: function () { return ["blockquote", 0]; } },
        code_block: {
          attrs: { lang: { default: "" } },
          group: "block", defining: true, code: true, content: "text*", marks: "",
          parseDOM: [{ tag: "pre.he-code", preserveWhitespace: true, getAttrs: function (d) { return { lang: d.getAttribute("data-lang") || "" }; } }],
          toDOM: function (n) { return ["pre", { class: "he-code", "data-lang": n.attrs.lang || "" }, ["code", 0]]; },
        },
        horizontal_rule: { group: "block", parseDOM: [{ tag: "hr" }], toDOM: function () { return ["hr"]; } },
        raw_block: {
          attrs: { text: {}, reason: { default: "" } },
          group: "block", defining: true, code: true, marks: "",
          parseDOM: [{ tag: "pre.he-raw" }],
          toDOM: function (n) {
            return ["pre", { class: "he-raw he-unsupported", title: "preserved verbatim (" + (n.attrs.reason || "unknown") + ")" }, n.attrs.text];
          },
        },
        bullet_list: { group: "block", content: "list_item+", parseDOM: [{ tag: "ul" }], toDOM: function () { return ["ul", 0]; } },
        ordered_list: {
          attrs: { start: { default: 1 } },
          group: "block", content: "list_item+",
          parseDOM: [{ tag: "ol" }],
          toDOM: function (n) { return ["ol", { start: n.attrs.start }, 0]; },
        },
        list_item: {
          attrs: { checked: { default: null } },
          defining: true,
          content: "(paragraph|block)*",
          parseDOM: [{ tag: "li" }],
          toDOM: function (n) {
            if (n.attrs.checked === null) return ["li", 0];
            var inp = ["input", { type: "checkbox", class: "he-task-box", disabled: "disabled" }];
            if (n.attrs.checked) inp[1].checked = "";
            return ["li", { class: "he-task" + (n.attrs.checked ? " he-task-done" : "") }, inp, ["span", 0]];
          },
        },
        table: { group: "block", defining: true, content: "table_row+", tableRole: "table", isolating: true, parseDOM: [{ tag: "table" }], toDOM: function () { return ["table", ["tbody", 0]]; } },
        table_row: { content: "(table_cell | table_header)*", tableRole: "row", parseDOM: [{ tag: "tr" }], toDOM: function () { return ["tr", 0]; } },
        table_cell: { content: "inline*", tableRole: "cell", isolating: true, parseDOM: [{ tag: "td" }], toDOM: function () { return ["td", 0]; } },
        table_header: { content: "inline*", tableRole: "header_cell", isolating: true, parseDOM: [{ tag: "th" }], toDOM: function () { return ["th", 0]; } },
        text: { group: "inline" },
        image: {
          inline: true, group: "inline", draggable: true,
          attrs: { src: {}, alt: { default: "" }, title: { default: null } },
          parseDOM: [{
            tag: "img[src]",
            getAttrs: function (d) {
              return { src: d.getAttribute("src"), alt: d.getAttribute("alt") || "", title: d.getAttribute("title") };
            },
          }],
          toDOM: function (n) { return ["img", { src: n.attrs.src, alt: n.attrs.alt || "", title: n.attrs.title || "" }]; },
        },
        wikilink: {
          inline: true, group: "inline", atom: true,
          attrs: { target: {}, heading: { default: null }, alias: { default: null } },
          parseDOM: [{
            tag: "span[data-wikilink]",
            getAttrs: function (d) {
              return {
                target: d.getAttribute("data-target") || "",
                heading: d.getAttribute("data-heading") || null,
                alias: d.getAttribute("data-alias") || null,
              };
            },
          }],
          toDOM: function (n) {
            var label = n.attrs.alias ||
              (n.attrs.target + (n.attrs.heading ? "#" + n.attrs.heading : ""));
            return ["span", {
              "data-wikilink": "1",
              "data-target": n.attrs.target,
              "data-heading": n.attrs.heading || "",
              "data-alias": n.attrs.alias || "",
              class: "he-wiki",
              title: "[[" + n.attrs.target + (n.attrs.heading ? "#" + n.attrs.heading : "") +
                (n.attrs.alias ? "|" + n.attrs.alias : "") + "]]",
            }, label];
          },
        },
        wiki_embed: {
          inline: true, group: "inline", atom: true,
          attrs: { target: {}, heading: { default: null }, alias: { default: null } },
          parseDOM: [{
            tag: "span[data-wiki-embed]",
            getAttrs: function (d) {
              return {
                target: d.getAttribute("data-target") || "",
                heading: d.getAttribute("data-heading") || null,
                alias: d.getAttribute("data-alias") || null,
              };
            },
          }],
          // Fallback chip rendering; images upgrade to a live NodeView
          // (buildEmbedView) that loads actual bytes through opts.loadEmbed.
          toDOM: function (n) {
            var label = n.attrs.alias ||
              (n.attrs.target + (n.attrs.heading ? "#" + n.attrs.heading : ""));
            return ["span", {
              "data-wiki-embed": "1",
              "data-target": n.attrs.target,
              "data-heading": n.attrs.heading || "",
              "data-alias": n.attrs.alias || "",
              class: "he-wiki he-wiki-embed",
              title: "![[" + label + "]]",
            }, "\u29c9 " + label];
          },
        },
        raw_inline: {
          inline: true, group: "inline", atom: true,
          attrs: { text: {}, reason: { default: "" } },
          toDOM: function (n) {
            return ["code", { class: "he-raw-inline he-unsupported", title: "preserved verbatim (" + (n.attrs.reason || "unknown") + ")" }, n.attrs.text];
          },
        },
        // Live LaTeX: atom nodes rendered by KaTeX nodeviews. Source is
        // revealed only when the equation itself is selected, with a live
        // preview while typing; selecting adjacent prose keeps it rendered.
        math_inline: {
          inline: true, group: "inline", atom: true,
          attrs: { tex: { default: "" } },
          toDOM: function (n) { return ["span", { class: "he-math he-math-inline", "data-tex": n.attrs.tex || "" }]; },
        },
        math_block: {
          group: "block", atom: true, code: true,
          attrs: { tex: { default: "" } },
          toDOM: function (n) { return ["div", { class: "he-math he-math-block", "data-tex": n.attrs.tex || "" }]; },
        },
        hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: function () { return ["br"]; } },
      },
      marks: {
        bold: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: function () { return ["strong", 0]; } },
        italic: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: function () { return ["em", 0]; } },
        strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: function () { return ["s", 0]; } },
        sub: { parseDOM: [{ tag: "sub" }], toDOM: function () { return ["sub", 0]; } },
        sup: { parseDOM: [{ tag: "sup" }], toDOM: function () { return ["sup", 0]; } },
        fontcolor: {
          attrs: { color: { default: null } },
          parseDOM: [{
            tag: "font[color]",
            getAttrs: function (d) { return { color: d.getAttribute("color") }; },
          }],
          toDOM: function (n) { return ["span", { style: "color:" + ((n.attrs && n.attrs.color) || "inherit") }, 0]; },
        },
        code: { code: true, excludes: "_", parseDOM: [{ tag: "code:not(.he-raw-inline)" }], toDOM: function () { return ["code", 0]; } },
        link: {
          attrs: { href: {}, title: { default: null } },
          inclusive: false,
          parseDOM: [{ tag: "a[href]", getAttrs: function (d) { return { href: d.getAttribute("href"), title: d.getAttribute("title") }; } }],
          toDOM: function (n) { return ["a", { href: n.attrs.href, title: n.attrs.title || "", "data-extlink": "1" }, 0]; },
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Editor factory
  // ---------------------------------------------------------------------------

    // ---------------------------------------------------------------------------
  // LaTeX command completion (ZenNotes port, lean): typing `\su` inside an
  // active formula pops matching commands with KaTeX-rendered previews.
  // Snippet templates land the cursor in the first argument. Kept dependency-
  // free: a static table + one absolutely-positioned div per active formula.
  // ---------------------------------------------------------------------------

  var LATEX_CMDS = (function () {
    var T = [];
    var add = function (label, detail, template, preview, boost) {
      T.push({ l: label, d: detail, t: template || null, p: preview || label, b: boost || 0 });
    };
    // Everyday constructs, boosted to the top like ZenNotes.
    add("\\frac", "fraction", "\\frac{}{}", "\\frac{a}{b}", 99);
    add("\\sqrt", "square root", "\\sqrt{}", "\\sqrt{x}", 98);
    add("\\sum", "sum", "\\sum_{i=1}^{n}", "\\sum_{i=1}^{n}", 97);
    add("\\int", "integral", "\\int_{a}^{b}", "\\int_{a}^{b}", 96);
    add("\\lim", "limit", "\\lim_{x \\to 0}", "\\lim_{x \\to 0}", 95);
    add("\\prod", "product", "\\prod_{i=1}^{n}", "\\prod_{i=1}^{n}", 90);
    add("\\infty", "infinity", null, null, 90);
    add("\\vec", "vector accent", "\\vec{}", "\\vec{x}");
    add("\\hat", "hat accent", "\\hat{}", "\\hat{x}");
    add("\\bar", "bar accent", "\\bar{}", "\\bar{x}");
    // Greek.
    ["alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta",
     "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "phi",
     "varphi", "chi", "psi", "omega",
     "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega"
    ].forEach(function (n) { add("\\" + n, "greek"); });
    // Accents and decorations.
    [["dot", "\\dot{x}"], ["ddot", "\\ddot{x}"], ["tilde", "\\tilde{x}"],
     ["widehat", "\\widehat{xy}"], ["overline", "\\overline{xy}"], ["underline", "\\underline{xy}"],
     ["boxed", "\\boxed{x}"]
    ].forEach(function (p) { add("\\" + p[0], "accent", "\\" + p[0] + "{}", p[1]); });
    // Fonts and text.
    [["text", "\\text{if}"], ["mathrm", "\\mathrm{d}"], ["mathbb", "\\mathbb{R}"],
     ["mathcal", "\\mathcal{L}"], ["mathbf", "\\mathbf{v}"]
    ].forEach(function (p) { add("\\" + p[0], "font", "\\" + p[0] + "{}", p[1]); });
    // Relations.
    ["leq", "geq", "neq", "approx", "equiv", "sim", "cong", "propto",
     "subset", "supset", "subseteq", "supseteq", "in", "notin"
    ].forEach(function (n) { add("\\" + n, "relation"); });
    // Arrows.
    ["to", "gets", "leftarrow", "rightarrow", "Leftarrow", "Rightarrow", "leftrightarrow",
     "Leftrightarrow", "mapsto", "longrightarrow", "uparrow", "downarrow", "implies", "iff"
    ].forEach(function (n) { add("\\" + n, "arrow"); });
    // Binary operators.
    ["pm", "mp", "times", "div", "cdot", "circ", "cap", "cup", "vee", "wedge",
     "setminus", "oplus", "otimes"
    ].forEach(function (n) { add("\\" + n, "operator"); });
    // Named functions.
    ["sin", "cos", "tan", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
     "exp", "log", "ln", "det", "gcd", "deg", "dim", "max", "min", "sup", "inf"
    ].forEach(function (n) { add("\\" + n, "function", null, "\\" + n + " x"); });
    // Symbols and misc.
    ["partial", "nabla", "forall", "exists", "neg", "emptyset", "angle", "triangle",
     "square", "hbar", "ell", "therefore", "because", "cdots", "ldots", "dots"
    ].forEach(function (n) { add("\\" + n, "symbol"); });
    // Environments (templates span lines; previews stay single-line).
    [["pmatrix", "a & b \\\\ c & d"], ["bmatrix", "a & b \\\\ c & d"],
     ["cases", "a & x>0 \\\\ b & x<0"], ["aligned", "a &= b \\\\ &= c"]
    ].forEach(function (p) {
      add("\\begin{" + p[0] + "}", "environment",
          "\\begin{" + p[0] + "}\n{}\n\\end{" + p[0] + "}",
          "\\begin{" + p[0] + "}\\end{" + p[0] + "}");
    });
    return T;
  })();

  var latexPreviewCache = new Map();

  function latexPreviewHtml(latex) {
    var hit = latexPreviewCache.get(latex);
    if (hit !== undefined) return hit;
    var html = "";
    try { html = katex.renderToString(latex === "\\" ? "\\lambda" : latex, { throwOnError: false }); }
    catch (_e) { html = ""; }
    if (latexPreviewCache.size > 400) latexPreviewCache.clear();
    latexPreviewCache.set(latex, html);
    return html;
  }

/** Live-LaTeX nodeview: KaTeX render while idle; editable source + live
   *  preview when the equation itself is selected; leaving commits edits back
   *  through setNodeAttribute so saves emit faithful $...$ / $$...$$. */
  function buildMathView(node, view, getPos, kind, registry) {
    var dom = document.createElement(kind === "block" ? "div" : "span");
    dom.className = "he-math-view he-math-" + kind;
    var current = node;
    var active = false;
    var clickArmed = false;

    function tex() { return String((current.attrs && current.attrs.tex) || ""); }

    function renderMath(target, value) {
      try {
        katex.render(value, target, { throwOnError: false, displayMode: kind === "block" });
      } catch (_e) {
        target.textContent = (kind === "block" ? "$$\n" : "$") + value + (kind === "block" ? "\n$$" : "$");
      }
    }

    function renderIdle() {
      dom.classList.remove("he-math-active");
      dom.innerHTML = "";
      renderMath(dom, tex());
    }

    function commit(inputEl) {
      var next = inputEl.value;
      if (next === tex()) return;
      setTimeout(function () {
        var pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null || next === tex()) return;
        view.dispatch(view.state.tr.setNodeAttribute(pos, "tex", next));
      }, 0);
    }

    function sourceEl() { return dom.querySelector(".he-math-source"); }

    function renderActive() {
      dom.classList.add("he-math-active");
      dom.innerHTML = "";
      var wrap = document.createElement("span");
      wrap.className = "he-math-edit";
      var preview = document.createElement(kind === "block" ? "div" : "span");
      preview.className = "he-math-preview";
      renderMath(preview, tex());
      var input = document.createElement(kind === "block" ? "textarea" : "input");
      if (kind === "block") input.rows = Math.min(8, tex().split("\n").length + 1);
      else { input.type = "text"; input.spellcheck = false; }
      input.className = "he-math-source";
      input.value = tex();
      var pop = null;
      var popItems = [];
      var popIdx = 0;

      function closePop() {
        if (pop) { pop.remove(); pop = null; }
        popItems = [];
      }

      function tokenAtCaret() {
        var s = input.selectionStart == null ? input.value.length : input.selectionStart;
        var m = /\\([a-zA-Z]*)$/.exec(input.value.slice(0, s));
        return m ? { word: m[1], from: s - m[1].length - 1, to: s } : null;
      }

      function insertCmd(c) {
        var tk = tokenAtCaret();
        closePop();
        if (!tk || !c.t && !c.l) return;
        var ins = c.t || c.l;
        var bracePos = ins.indexOf("{}");
        var caret = bracePos >= 0 ? tk.from + bracePos + 1 : tk.from + ins.length;
        var applied = false;
        try {
          input.setSelectionRange(tk.from, tk.to);
          applied = document.execCommand("insertText", false, ins);
        } catch (_e) { applied = false; }
        if (!applied) {
          var v2 = input.value;
          input.value = v2.slice(0, tk.from) + ins + v2.slice(tk.to);
        }
        renderMath(preview, input.value);
        if (kind === "block") input.rows = Math.min(10, input.value.split("\n").length + 1);
        try { input.focus(); input.setSelectionRange(caret, caret); } catch (_e) {}
        // re-open for chained input (e.g. picking \vec then typing x keeps preview live)
        showPop();
      }

      function showPop() {
        var tk = tokenAtCaret();
        if (!tk || !tk.word) { closePop(); return; }
        var q = tk.word.toLowerCase();
        var scored = [];
        for (var i2 = 0; i2 < LATEX_CMDS.length; i2++) {
          var c = LATEX_CMDS[i2];
          var name = c.l.slice(1).toLowerCase();
          if (name.indexOf(q) !== 0) continue;
          scored.push({ c: c, name: name });
        }
        scored.sort(function (a2, b2) { return (b2.c.b - a2.c.b) || (a2.name.length - b2.name.length); });
        popItems = scored.slice(0, 8);
        popIdx = 0;
        if (!popItems.length) { closePop(); return; }
        if (!pop) {
          pop = document.createElement("div");
          pop.className = "he-math-cmds";
          wrap.appendChild(pop);
        }
        pop.innerHTML = "";
        popItems.forEach(function (it, ix) {
          var row = document.createElement("div");
          row.className = "he-math-cmd" + (ix === popIdx ? " he-math-cmd-on" : "");
          var pv = document.createElement("span");
          pv.className = "he-math-cmd-pv";
          pv.innerHTML = latexPreviewHtml(it.c.p);
          var lb = document.createElement("code");
          lb.textContent = it.c.l;
          var dt = document.createElement("em");
          dt.textContent = it.c.d;
          row.appendChild(pv);
          row.appendChild(lb);
          row.appendChild(dt);
          row.addEventListener("mousedown", function (e2) { e2.preventDefault(); insertCmd(it.c); });
          pop.appendChild(row);
        });
      }

      input.addEventListener("input", function () {
        renderMath(preview, input.value);
        if (kind === "block") input.rows = Math.min(10, input.value.split("\n").length + 1);
        showPop();
      });
      input.addEventListener("keydown", function (e) {
        if (pop) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            popIdx = (popIdx + (e.key === "ArrowDown" ? 1 : popItems.length - 1)) % popItems.length;
            Array.prototype.forEach.call(pop.children, function (r2, ix2) {
              r2.classList.toggle("he-math-cmd-on", ix2 === popIdx);
            });
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            insertCmd(popItems[popIdx].c);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closePop();
            return;
          }
        }
        if (e.key === "Escape" && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          setActive(false);
        }
      });
      input.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      wrap.appendChild(input);
      wrap.appendChild(preview);
      dom.appendChild(wrap);
      if (clickArmed) {
        clickArmed = false;
        setTimeout(function () {
          try { input.focus(); input.select(); } catch (_e) {}
        }, 0);
      }
    }

    function setActive(next) {
      if (next === active) return;
      active = next;
      if (!active) {
        var input = sourceEl();
        var pending = null;
        if (input && input.value !== tex()) pending = input.value;
        renderIdle();
        // Defer the attribute write out of any in-flight transaction.
        if (pending != null) {
          setTimeout(function () {
            var pos = null;
            try { pos = typeof getPos === "function" ? getPos() : null; } catch (_e) {}
            if (pos == null || pending === tex()) return;
            view.dispatch(view.state.tr.setNodeAttribute(pos, "tex", pending));
          }, 0);
        }
      } else {
        renderActive();
      }
    }

    dom.addEventListener("mousedown", function () {
      if (!active) clickArmed = true;
    });

    renderIdle();

    var api = {
      dom: dom,
      pos: function () {
        try { return typeof getPos === "function" ? getPos() : null; } catch (_e) { return null; }
      },
      size: function () { return current.nodeSize; },
      setActive: setActive,
      update: function (next) {
        if (next.type.name !== current.type.name) return false;
        var changed = (next.attrs.tex || "") !== tex();
        current = next;
        if (!active) renderIdle();
        else if (changed && !dom.contains(document.activeElement)) renderActive();
        return true;
      },
      stopEvent: function (e) {
        var src = active && sourceEl();
        return !!src && src.contains(e.target);
      },
      ignoreMutation: function () { return true; },
      destroy: function () {},
    };
    registry.add(api);
    return api;
  }

  function createMdEditor(hostEl, opts) {
    var schema = buildSchema();
    var doc = Model.Node.fromJSON(schema, schemaLoadable(opts.docJSON));
    var mathRegistry = new Set();

    // Exact-selection driver for live-LaTeX nodeviews. A caret in the prose
    // immediately before or after an equation must not reveal its source; only
    // a NodeSelection of the equation activates the editor.
    function syncMathViews() {
      var selection = null;
      try { selection = view.state.selection; } catch (_e) { return; }
      mathRegistry.forEach(function (mv) {
        var pos = null;
        try { pos = mv.pos(); } catch (_e) { return; }
        if (pos == null) return;
        mv.setActive(!!(selection && selection.node && selection.from === pos));
      });
    }

    var state = State.EditorState.create({
      doc: doc,
      plugins: [
        History.history(),
        Keymap.keymap(keymap(schema)),
        markdownInputRules(schema),
        wikiSuggestPlugin(schema, opts),
        brokenLinkDecorations(opts),
      ],
    });

    /** Rehydrate literal [[target|alias]] text left by an inline edit. This
     * runs on blur so clicking away never leaves the editor stuck showing raw
     * brackets until a save/reload cycle. */
    function rehydrateWikiLinks(v) {
      var core = globalThis.__HERMES_EDITOR_MD__;
      var wl = v.state.schema.nodes.wikilink;
      if (!core || !core.parseWikilink || !wl) return;
      var replacements = [];
      v.state.doc.descendants(function (node, pos) {
        if (!node.isText || !node.text || node.text.indexOf("[[") < 0) return;
        var rx = /\[\[([^\]\n]+)\]\]/g, match;
        while ((match = rx.exec(node.text))) {
          var parsed = core.parseWikilink(match[1]);
          if (parsed && parsed.type === "wikilink") {
            replacements.push({ from: pos + match.index, to: pos + match.index + match[0].length, attrs: parsed.attrs });
          }
        }
      });
      if (!replacements.length) return;
      var tr = v.state.tr;
      // Replace from right to left so each original document position remains
      // valid while earlier text is being transformed.
      replacements.sort(function (a, b) { return b.from - a.from; }).forEach(function (item) {
        tr = tr.replaceWith(item.from, item.to, wl.create(item.attrs));
      });
      v.dispatch(tr);
    }

    var view = new View.EditorView(hostEl, {
      state: state,
      nodeViews: {
        image: function (node) { return buildImageView(node, opts); },
        wiki_embed: function (node) { return buildEmbedView(node, opts); },
        math_inline: function (node, v, getPos) { return buildMathView(node, v, getPos, "inline", mathRegistry); },
        math_block: function (node, v, getPos) { return buildMathView(node, v, getPos, "block", mathRegistry); },
      },
      dispatchTransaction: function (tr) {
        view.updateState(view.state.apply(tr));
        if (tr.docChanged && opts.onChange) opts.onChange();
        if (tr.selectionSet || tr.docChanged || tr.scrolledIntoView) syncMathViews();
      },
      attributes: { class: "he-prosemirror" },
      handleClickOn: function (v, _p, node, nodePos, _dom, evt) {
        try { window.__heClick = { type: node.type.name, ctrl: !!evt.ctrlKey, meta: !!evt.metaKey, trusted: evt.isTrusted }; } catch (_e) {}
        var mods = openModifiers(evt);
        if (node.type.name === "wikilink" || node.type.name === "wiki_embed") {
          // A normal click follows a link, like every other file reference in
          // Hermes. Alt-click is the explicit edit gesture; blur rehydrates it.
          if (!mods.alt) { opts.openWiki(node.attrs); return true; }
          dissolveWikiToText(v, nodePos, node);
          return true;
        }
        var lm = (node.marks || []).filter(function (m) { return m.type === "link"; })[0];
        if (!lm) return false;
        var href = lm.attrs.href || "";
        var external = /^[a-z][a-z0-9+.\-]*:/i.test(href);
        if (mods.ctrl) {
          if (external) { opts.openExternal(href); return true; }
          if (opts.openInternal) { opts.openInternal(href); return true; }
        }
        // Plain click on a link: just place the caret (no navigation).
        return false;
      },
      handleDOMEvents: {
        blur: function (v) {
          rehydrateWikiLinks(v);
          return false;
        },
        mousedown: function (v, e) {
          lastMouseDownMods = { alt: !!e.altKey, ctrl: !!(e.ctrlKey || e.metaKey), meta: !!e.metaKey };
          if (lastMouseDownMods.ctrl && e.button === 0 && !e.shiftKey && !e.altKey) {
            // Open the link/embed under the pointer right here — the mousedown
            // is the one event whose modifiers are trustworthy end-to-end.
            try {
              var mpos = v.posAtCoords({ left: e.clientX, top: e.clientY });
              if (mpos != null) {
                var $mpos = v.state.doc.resolve(mpos);
                var around = $mpos.parent.childAfter($mpos.parentOffset);
                var mnode = around.node;
                if (mnode && (mnode.type.name === "wikilink" || mnode.type.name === "wiki_embed")) {
                  e.preventDefault();
                  opts.openWiki(mnode.attrs);
                  return true;
                }
              }
            } catch (_me) { /* fall through to normal handling */ }
          }
          if (e.target && e.target.classList && e.target.classList.contains("he-task-box")) {
            e.preventDefault();
            toggleTaskAt(v, e.target);
            return true;
          }
          return false;
        },
      },
    });

    var dirtyBase = doc;
    syncMathViews();

    /** Scroll the first heading whose text matches `needle` (exact, then
     *  prefix, then substring - case-insensitive) into view and flash it.
     *  Powers [[Note#Heading]] and same-file [[#Heading]] navigation. */
    function revealHeading(needle) {
      try {
        // Obsidian heading paths use "#" separators and notes often wrap
        // anchors in emphasis: normalize both sides down to bare words.
        var norm = function (s) {
          return String(s || "").toLowerCase()
            .replace(/^[#\s*]+/, "").replace(/[#\s*]+$/, "").trim();
        };
        var want = norm(needle);
        if (!want) return false;
        var bestScore = 0;
        var bestPos = null;
        view.state.doc.descendants(function (node, pos) {
          if (node.type.name !== "heading") return;
          var text = norm(node.textContent);
          if (!text) return;
          var score = text === want ? 3
            : text.indexOf(want) === 0 ? 2
            : text.indexOf(want) >= 0 ? 1 : 0;
          if (score > bestScore) { bestScore = score; bestPos = pos; }
        });
        if (bestScore === 0) return false;
        var domPos = view.domAtPos(bestPos + 1);
        var el = domPos.node.nodeType === 1 ? domPos.node : domPos.node.parentElement;
        if (!el) return false;
        el.scrollIntoView({ block: "start" });
        el.classList.add("he-anchor-flash");
        setTimeout(function () { el.classList.remove("he-anchor-flash"); }, 1600);
        return true;
      } catch (_e) { return false; }
    }

    return {
      view: view,
      focus: function () { view.focus(); },
      destroy: function () { mathRegistry.clear(); view.destroy(); },
      isDirty: function () { return !view.state.doc.eq(dirtyBase); },
      markClean: function () { dirtyBase = view.state.doc; },
      toJSON: function () { return view.state.doc.toJSON(); },
      // Stage 5B: swap in externally refreshed content while staying in the
      // WYSIWYG pipeline. Replaces the whole doc through a history-exempt
      // transaction, resets the clean baseline, and preserves scroll.
      setContent: function (docJSON) {
        var next = Model.Node.fromJSON(view.state.schema, schemaLoadable(docJSON));
        var hostEl = view.dom;
        var scrollTop = hostEl && hostEl.scrollTop ? hostEl.scrollTop : 0;
        var tr = view.state.tr.replaceWith(
          0, view.state.doc.content.size, next.content);
        tr.setMeta("addToHistory", false);
        view.dispatch(tr);
        dirtyBase = view.state.doc;
        if (hostEl && scrollTop) {
          try { hostEl.scrollTop = Math.min(scrollTop, hostEl.scrollHeight); } catch (_e) {}
        }
      },
      run: function (name, arg) { return run(view, name, arg); },
      insertWiki: function (attrs) { insertWikiNode(view, attrs); },
      revealHeading: function (needle) { return revealHeading(needle); },
      headings: function () {
        var out = [];
        view.state.doc.descendants(function (node) {
          if (node.type.name === "heading") {
            var text = node.textContent.trim();
            if (text) out.push(text);
          }
        });
        return out;
      },
      findNext: function (q) { return findText(view, q, false); },
      findPrev: function (q) { return findText(view, q, true); },
      replaceAll: function (q, rep) { return replaceAllText(view, q, rep); },
      countUnsupported: function () {
        var n = 0;
        view.state.doc.descendants(function (node) {
          if (node.type.name === "raw_block" || node.type.name === "raw_inline") n++;
        });
        return n;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // wiki embed node view (Obsidian-style ![[-image-]] inline rendering)
  // ---------------------------------------------------------------------------

  function buildImageView(node, opts) {
    var src = String(node.attrs.src || "");
    var img = document.createElement("img");
    img.alt = node.attrs.alt || "";
    if (node.attrs.title) img.title = node.attrs.title;
    img.className = "he-markdown-image";
    img.draggable = false;
    var alive = true;
    img.addEventListener("load", function () {
      img.classList.remove("he-image-loading", "he-image-error");
    });
    img.addEventListener("error", function () {
      img.classList.remove("he-image-loading");
      img.classList.add("he-image-error");
    });
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src) || typeof opts.loadEmbed !== "function") {
      img.src = src;
    } else {
      img.classList.add("he-image-loading");
      Promise.resolve(opts.loadEmbed(src)).then(function (url) {
        if (!alive || !img.isConnected) return;
        img.classList.remove("he-image-loading");
        if (url) img.src = url;
        else img.classList.add("he-image-error");
      }).catch(function () {
        if (!alive || !img.isConnected) return;
        img.classList.remove("he-image-loading");
        img.classList.add("he-image-error");
      });
    }
    return {
      dom: img,
      destroy: function () { alive = false; },
    };
  }

  function buildEmbedView(node, opts) {
    var MD = globalThis.__HERMES_EDITOR_MD__ || {};
    var target = node.attrs.target || "";
    var label = node.attrs.alias ||
      (target + (node.attrs.heading ? "#" + node.attrs.heading : ""));
    var span = document.createElement("span");

    span.setAttribute("data-wiki-embed", "1");
    span.setAttribute("data-target", target);
    span.className = "he-wiki he-wiki-embed";
    span.title = "![[" + label + "]]";

    if (typeof MD.isImageTarget === "function" && MD.isImageTarget(target)) {
      var img = document.createElement("img");

      img.alt = label;
      img.className = "he-embed-image";
      img.draggable = false;
      span.classList.add("he-embed-loading");
      span.appendChild(img);

      // One delayed retry on a miss: first load can fail transiently while
      // several embeds mount at once (cold SSH pool, busy listing endpoint).
      function loadOnce() {
        return Promise.resolve(typeof opts.loadEmbed === "function" ? opts.loadEmbed(target) : null)
          .then(function (u) { return u || null; })
          .catch(function () { return null; });
      }
      function wait(ms) {
        return new Promise(function (done) { setTimeout(done, ms); });
      }
      loadOnce()
        .then(function (first) {
          return first || !span.isConnected ? first : wait(1500).then(loadOnce);
        })
        .then(function (url) {
          if (!span.isConnected) return;
          span.classList.remove("he-embed-loading");
          if (url) {
            img.addEventListener("error", function () {
              span.classList.remove("he-embed-ok");
              span.classList.add("he-embed-broken", "he-image-error");
            }, { once: true });
            img.src = url;
            span.classList.add("he-embed-ok");
          } else {
            img.remove();
            span.classList.add("he-embed-broken");
            span.appendChild(document.createTextNode("\u26a0 " + label));
          }
        });
    } else {
      // Non-image transclusion: compact chip (click-through to open with Ctrl).
      var chip = document.createElement("span");

      chip.className = "he-embed-chip";
      chip.textContent = "\u29c9 " + label;
      span.appendChild(chip);
    }

    return { dom: span };
  }

  /** Plain-click on a wikilink/embed: replace the atom with its literal
   *  `[[target|alias]]` text and select the inner part, so the raw brackets
   *  are visible AND editable in place. Re-parses back into a link on the
   *  next load/save cycle; typing a fresh `[[` also rebuilds live nodes. */
  function dissolveWikiToText(v, nodePos, node) {
    try {
      var a = node.attrs || {};
      var open = "[[";
      var inner = (a.target || "") + (a.heading ? "#" + a.heading : "") +
        (a.alias ? "|" + a.alias : "");
      var close = "]]";
      var Sel = State.TextSelection || State.Selection;
      var tr = v.state.tr.replaceWith(nodePos, nodePos + node.nodeSize, [
        v.state.schema.text(open),
        v.state.schema.text(inner),
        v.state.schema.text(close),
      ]);
      tr.setSelection(Sel.create(tr.doc, nodePos + open.length,
        nodePos + open.length + inner.length));
      tr.scrollIntoView();
      v.dispatch(tr);
      v.focus();
    } catch (_e) { /* leave the node intact */ }
  }

  // ---------------------------------------------------------------------------
  // Obsidian-style Markdown input rules (official prosemirror-inputrules)
  // ---------------------------------------------------------------------------

  function markdownInputRules(schema) {
    var IR = require("prosemirror-inputrules");
    globalThis.HE_RULES_MARKER = "HE_RULES_V4";
    var rules = [];
    for (var level = 1; level <= 6; level++) {
      var rx = new RegExp("^#{" + level + "}\\s$");
      rules.push(IR.textblockTypeInputRule(rx, schema.nodes.heading, { level: level }));
    }
    rules.push(IR.wrappingInputRule(/^[*+-]\s$/, schema.nodes.bullet_list));
    rules.push(IR.wrappingInputRule(/^(\d{1,9})\.\s$/, schema.nodes.ordered_list,
      function (m) { return { start: parseInt(m[1], 10) }; },
      function (m, node) { return node.childCount + ((node.attrs && node.attrs.start) || 1) === parseInt(m[1], 10); }));
    rules.push(IR.wrappingInputRule(/^>\s$/, schema.nodes.blockquote));
    return IR.inputRules({ rules: rules });
  }

  // ---------------------------------------------------------------------------
  // keymap + commands
  // ---------------------------------------------------------------------------

  function keymap(schema) {
    var keys = {};
    keys["Mod-b"] = Commands.toggleMark(schema.marks.bold);
    keys["Mod-i"] = Commands.toggleMark(schema.marks.italic);
    keys["Mod-Shift-x"] = Commands.toggleMark(schema.marks.strike);
    keys["Mod-e"] = Commands.toggleMark(schema.marks.code);
    keys["Mod-z"] = History.undo;
    keys["Mod-y"] = History.redo;
    keys["Shift-Mod-z"] = History.redo;
    keys["Enter"] = Commands.chainCommands(
      SchemaList.splitListItem(schema.nodes.list_item),
      Commands.splitBlock
    );
    keys["Tab"] = SchemaList.sinkListItem(schema.nodes.list_item);
    keys["Shift-Tab"] = SchemaList.liftListItem(schema.nodes.list_item);
    Object.assign(keys, Commands.baseKeymap);
    return keys;
  }

  function run(view, name, arg) {
    var s = view.state;
    var schema = s.schema;
    var C = Commands;
    var cmd = null;
    switch (name) {
      case "bold": cmd = C.toggleMark(schema.marks.bold); break;
      case "italic": cmd = C.toggleMark(schema.marks.italic); break;
      case "strike": cmd = C.toggleMark(schema.marks.strike); break;
      case "code": cmd = C.toggleMark(schema.marks.code); break;
      case "h1": cmd = C.setBlockType(schema.nodes.heading, { level: 1 }); break;
      case "h2": cmd = C.setBlockType(schema.nodes.heading, { level: 2 }); break;
      case "h3": cmd = C.setBlockType(schema.nodes.heading, { level: 3 }); break;
      case "para": cmd = C.setBlockType(schema.nodes.paragraph); break;
      case "bullet": cmd = toggleList(schema, schema.nodes.bullet_list); break;
      case "ordered": cmd = toggleList(schema, schema.nodes.ordered_list); break;
      case "task": cmd = toggleTaskItem(s); break;
      case "quote": cmd = C.wrapIn(schema.nodes.blockquote); break;
      case "hr": cmd = insertHr(schema); break;
      case "link": cmd = setLink(schema, arg); break;
    }
    if (!cmd) return false;
    cmd(s, function (tr) { view.dispatch(tr); }, view);
    view.focus();
    return true;
  }

  function toggleList(schema, nodeType) {
    return function (state, dispatch) {
      var $from = state.selection.$from;
      for (var d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === nodeType.name) {
          return SchemaList.liftListItem(schema.nodes.list_item)(state, dispatch);
        }
      }
      return SchemaList.wrapInList(nodeType)(state, dispatch);
    };
  }

  function toggleTaskItem(state) {
    return function (_s, dispatch) {
      var $from = state.selection.$from;
      for (var d = $from.depth; d >= 0; d--) {
        var n = $from.node(d);
        if (n.type.name === "list_item") {
          if (dispatch) {
            dispatch(state.tr.setNodeMarkup($from.before(d), null,
              { checked: n.attrs.checked === null ? false : !n.attrs.checked }));
          }
          return true;
        }
      }
      return false;
    };
  }

  function insertHr(schema) {
    return function (state, dispatch) {
      if (dispatch) {
        var tr = state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create());
        tr.scrollIntoView();
        dispatch(tr);
      }
      return true;
    };
  }

  function setLink(schema, href) {
    return function (state, dispatch) {
      if (!href) return Commands.toggleMark(schema.marks.link)(state, dispatch);
      return Commands.toggleMark(schema.marks.link, { href: href })(state, dispatch);
    };
  }

  function toggleTaskAt(view, inputEl) {
    try {
      var pos = view.posAtDOM(inputEl, 0);
      var $pos = view.state.doc.resolve(pos);
      for (var d = $pos.depth; d >= 0; d--) {
        var n = $pos.node(d);
        if (n.type.name === "list_item") {
          view.dispatch(view.state.tr.setNodeMarkup($pos.before(d), null, { checked: !n.attrs.checked }));
          return;
        }
      }
    } catch (_e) { /* noop */ }
  }

  function insertWikiNode(view, attrs) {
    var wl = view.state.schema.nodes.wikilink;
    if (!wl) return;
    var node = wl.create(attrs);
    var tr = view.state.tr.replaceSelectionWith(node);
    tr.scrollIntoView();
    view.dispatch(tr);
    view.focus();
  }

  // ---------------------------------------------------------------------------
  // broken wikilink decorations
  // ---------------------------------------------------------------------------

  function brokenLinkDecorations(opts) {
    var decos = View.DecorationSet.empty;
    function isBroken(node) {
      // Same-file anchors ([[#Heading]]) have an empty target by design;
      // they resolve inside the current note and are never "broken".
      if (!node.attrs.target && node.attrs.heading) return false;
      return !opts.resolveWiki(node.attrs.target);
    }
    function recompute(v) {
      var found = [];
      v.state.doc.descendants(function (node, pos) {
        if (node.type.name !== "wikilink") return;
        if (isBroken(node)) {
          found.push(View.Decoration.node(pos, pos + node.nodeSize,
            { class: "he-wiki he-wiki-broken" }));
        }
      });
      decos = View.DecorationSet.create(v.state.doc, found);
    }
    var plugin;
    plugin = new State.Plugin({
      state: {
        init: function (_config, state) {
          return computeFor(state.doc);
        },
        apply: function (tr, old) {
          if (!tr.docChanged) return old;
          return computeFor(tr.doc);
        },
      },
      props: {
        decorations: function (state) { return plugin.getState(state); },
      },
    });
    function computeFor(doc) {
      var found = [];
      doc.descendants(function (node, pos) {
        if (node.type.name !== "wikilink") return;
        if (isBroken(node)) {
          found.push(View.Decoration.node(pos, pos + node.nodeSize,
            { class: "he-wiki he-wiki-broken" }));
        }
      });
      return View.DecorationSet.create(doc, found);
    }
    return plugin;
  }

  // ---------------------------------------------------------------------------
  // [[ autocomplete
  // ---------------------------------------------------------------------------

  function wikiSuggestPlugin(schema, opts) {
    var sug = null;   // {from, cursorTo, query, phase:null|'heading'|'alias', target}
    var popup = null;
    var selIdx = 0;
    var items = [];
    var viewRef = null;

    return new State.Plugin({
      view: function (v) { viewRef = v; return { destroy: hide }; },
      props: {
        handleTextInput: function (v, from, to, text) {
          var before = v.state.doc.textBetween(Math.max(0, from - 1), from, "\n", "\n");
          if (text === "[" && before.endsWith("[") && !sug) {
            sug = { from: from - 1, cursorTo: to, query: "", phase: null, target: null };
            selIdx = 0;
            refresh();
            return false;
          }
          if (sug && sug.phase === null) {
            if (text === "#") {
              sug.phase = "heading"; sug.target = sug.query.trim(); sug.query = "";
              refresh(); return false;
            }
            if (text === "|" || /[\s\]]/.test(text)) {
              hide(); sug = null; return false;
            }
            sug.cursorTo = to; sug.query += text; refresh();
          } else if (sug && sug.phase === "heading") {
            if (/[\s|\]]/.test(text)) { hide(); sug = null; return false; }
            sug.cursorTo = to; sug.query += text; refresh();
          }
          return false;
        },
        handleKeyDown: function (v, e) {
          if (!sug) return false;
          if (e.key === "Escape") { hide(); sug = null; return true; }
          if (e.key === "ArrowDown" && items.length) { selIdx = (selIdx + 1) % items.length; render(); return true; }
          if (e.key === "ArrowUp" && items.length) { selIdx = (selIdx - 1 + items.length) % items.length; render(); return true; }
          if (e.key === "Enter") { accept(v); return true; }
          return false;
        },
        handleClick: function () { hide(); sug = null; return false; },
      },
    });

    function refresh() {
      if (!sug) return;
      if (sug.phase === null) {
        items = (opts.suggestPages(sug.query) || []).slice(0, 8);
      } else {
        items = (opts.suggestHeadings(sug.target) || [])
          .filter(function (h2) {
            return h2.toLowerCase().indexOf((sug.query || "").toLowerCase()) >= 0;
          })
          .slice(0, 8)
          .map(function (h2) { return { label: h2 }; });
      }
      if (selIdx >= Math.max(items.length, 1)) selIdx = 0;
      render();
    }

    function render() {
      if (!popup) {
        popup = document.createElement("div");
        popup.className = "he-suggest";
        document.body.appendChild(popup);
      }
      popup.innerHTML = "";
      var list = items.length ? items :
        [{ label: sug.phase === null ? ((sug.query || "new page") + " (new)") : "(no matching headings)" }];
      list.forEach(function (it, ix) {
        var row = document.createElement("div");
        row.className = "he-suggest-item" + (ix === selIdx ? " he-suggest-sel" : "");
        row.textContent = it.label;
        if (it.sub) {
          var sub = document.createElement("span");
          sub.className = "he-suggest-sub";
          sub.textContent = it.sub;
          row.appendChild(sub);
        }
        row.addEventListener("mousedown", function (e) {
          e.preventDefault();
          selIdx = ix;
          accept(viewRef);
        });
        popup.appendChild(row);
      });
      try {
        var pos = Math.min(sug.cursorTo != null ? sug.cursorTo : sug.from,
                           viewRef.state.doc.content.size);
        var coords = viewRef.coordsAtPos(pos);
        popup.style.left = Math.max(8, Math.min(coords.left, window.innerWidth - 280)) + "px";
        popup.style.top = (coords.bottom + 4) + "px";
        popup.style.display = "block";
      } catch (_e) { /* noop */ }
    }

    function accept(v) {
      if (!sug || !v) return;
      var attrs;
      if (sug.phase === null && items.length) {
        attrs = { target: items[selIdx].label, heading: null, alias: null };
      } else if (sug.phase === "heading" && items.length) {
        attrs = { target: sug.target, heading: items[selIdx].label, alias: null };
      } else if (sug.phase === null && sug.query.trim()) {
        attrs = { target: sug.query.trim(), heading: null, alias: null };
      } else {
        hide(); sug = null; return;
      }
      var wl = v.state.schema.nodes.wikilink.create(attrs);
      var tr = v.state.tr.replaceWith(sug.from, Math.max(sug.from, sug.cursorTo || sug.from), wl);
      tr.insertText(" ", sug.from + wl.nodeSize);
      tr.scrollIntoView();
      v.dispatch(tr);
      v.focus();
      hide(); sug = null;
    }

    function hide() { if (popup) popup.style.display = "none"; }
  }

  // ---------------------------------------------------------------------------
  // literal find / replace over text nodes
  // ---------------------------------------------------------------------------

  function collectMatches(doc, q) {
    var ranges = [];
    doc.descendants(function (node, pos) {
      if (!node.isText || !node.text) return;
      var hay = node.text.toLowerCase();
      var needle = q.toLowerCase();
      var idx = 0;
      while ((idx = hay.indexOf(needle, idx)) !== -1) {
        ranges.push({ from: pos + idx, to: pos + idx + q.length });
        idx += needle.length;
      }
    });
    return ranges;
  }

  function findText(view, q, backwards) {
    if (!q) return false;
    var all = collectMatches(view.state.doc, q);
    if (backwards) all.reverse();
    var selFrom = view.state.selection.from;
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (backwards ? r.to < selFrom : r.from >= selFrom) {
        select(view, r); return true;
      }
    }
    if (all.length) { select(view, all[0]); return true; } // wrap around
    return false;

    function select(v, r2) {
      var Sel = State.TextSelection || State.Selection;
      v.dispatch(v.state.tr.setSelection(
        Sel.create(v.state.doc, r2.from, r2.to)).scrollIntoView());
      v.focus();
    }
  }

  function replaceAllText(view, q, rep) {
    if (!q) return 0;
    var count = 0;
    var tr = view.state.tr;
    var rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    view.state.doc.descendants(function (node, pos) {
      if (!node.isText || !node.text) return;
      var m2;
      rx.lastIndex = 0;
      while ((m2 = rx.exec(node.text)) !== null) {
        var absFrom = pos + m2.index;
        var mapped = tr.mapping ? tr.mapping.map(absFrom, -1) : absFrom;
        var mappedEnd = tr.mapping ? tr.mapping.map(absFrom + m2[0].length, 1) : absFrom + m2[0].length;
        tr.replaceWith(mapped, mappedEnd, view.state.schema.text(rep));
        count++;
      }
    });
    if (count) { tr.scrollIntoView(); view.dispatch(tr); view.focus(); }
    return count;
  }

  // exports - attaches to the ambient global so both the bundled IIFE
  // (dashboard) and Node-based smoke harnesses can consume it.
  globalThis.__HERMES_EDITOR_UI__ = {
    initPM: initPM,
    createMdEditor: createMdEditor,
    buildSchema: buildSchema,
  };
})();
