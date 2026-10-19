// Codex Translate content script. Injected on demand; safe to inject twice.
//
// Originals are never moved: a <ct-tr> with the translation is inserted right
// after the last node of each run, and the original nodes are hidden in place
// (elements get data-ct-hide, top-level text nodes are blanked and restored).
(() => {
  const prev = window.__codexTranslate;
  if (prev) {
    let ok = false;
    try { ok = !!prev.alive(); } catch {}
    if (ok) return;
    try { prev.dispose(); } catch {}
  }
  if (!document.body) return;

  // Same values as defaults.js (content scripts do not load it).
  const FALLBACK_DEFAULTS = {
    model: "gpt-6-luna", effort: "low", fast: false, target: "Korean", mode: "replace",
    batchChars: 1500, concurrency: 8, scope: "content",
    tone: "auto", fidelity: "balanced", terms: "auto",
    instructions: "", glossary: "", siteTone: {},
  };
  const TONES = new Set(["hamnida", "haeyo", "handa", "casual"]);
  const KEEP = Symbol("keep");

  const SKIP_SELECTOR = [
    "script", "style", "noscript", "template", "textarea", "input", "select", "option",
    "pre", "code", "kbd", "samp", "var", "svg", "math", "canvas", "video", "audio", "iframe",
    ".katex", ".MathJax", "mjx-container", ".notranslate", "[translate='no']",
    "[contenteditable='true']", "[contenteditable='']", "ct-tr", "ct-status",
  ].join(",");
  // Run boundaries that are never cloned or hidden.
  const FORM_SELECTOR = "input,select,textarea,button,[role=button],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[contenteditable=''],[contenteditable='true']";
  const MEDIA_SELECTOR = "video,audio,canvas,iframe,object,embed";
  const BOUNDARY_SELECTOR = FORM_SELECTOR + "," + MEDIA_SELECTOR;
  // Inline elements kept verbatim as a single placeholder (<xN/>).
  const OPAQUE_SELECTOR = [
    "code", "kbd", "samp", "var", "svg", "math", "img", "br", "picture",
    ".katex", ".MathJax", "mjx-container", ".notranslate", "[translate='no']",
    "sup.citation", "sup.reference", ".mwe-math-element",
  ].join(",");
  const BLOCK_TAGS = new Set([
    "H1", "H2", "H3", "H4", "H5", "H6", "P", "LI", "DT", "DD", "BLOCKQUOTE", "FIGCAPTION", "TD", "TH",
    "SUMMARY", "CAPTION", "LEGEND", "TR", "TABLE", "UL", "OL", "DL", "ARTICLE", "SECTION", "HEADER",
    "FOOTER", "NAV", "ASIDE", "MAIN", "FIGURE",
  ]);
  const CONTENT_SKIP = "button,[role=button],[role=tab],[role=menuitem]";
  const OFFSCREEN_WAIT = 800; // ms a partial off-screen batch may wait for more units

  // ---------- Scope: translate the content, not the UI around it ----------

  const SITE_RULES = [
    // X selectors unverified without login; confirm with the user.
    { host: /(^|\.)(x|twitter)\.com$/, include: [
      '[data-testid="primaryColumn"] [data-testid="tweetText"]',
      '[aria-modal="true"] [data-testid="tweetText"]',
      '[data-testid="primaryColumn"] [data-testid="UserDescription"]',
      '[data-testid="primaryColumn"] [data-testid="card.layoutLarge.detail"]',
      '[data-testid="primaryColumn"] [data-testid="card.layoutSmall.detail"]',
      '[data-testid="twitterArticleRichTextView"]',
      '[data-testid="twitter-article-title"]',
      '[data-testid="birdwatch-pivot"]',
    ], exclude: ['[data-testid="HoverCard"]', '[data-testid="sidebarColumn"]'] },
    { host: /(^|\.)reddit\.com$/, include: [
      'shreddit-post [slot="title"]', 'shreddit-post [slot="text-body"]', 'shreddit-comment [slot="comment"]',
      ".thing a.title", ".thing .usertext-body .md", // old.reddit.com
    ] },
    { host: /(^|\.)news\.ycombinator\.com$/, include: [".titleline", ".commtext", ".toptext"] },
    { host: /(^|\.)github\.com$/, include: [
      ".markdown-body", ".comment-body", ".js-issue-title", '[data-testid="issue-title"]', "bdi[data-testid]",
    ] },
    { host: /(^|\.)youtube\.com$/, include: [
      "h1.ytd-watch-metadata", "#description-inline-expander", "#content-text",
    ] },
    { host: /(^|\.)wikipedia\.org$/, include: ["#firstHeading", "#mw-content-text"], exclude: [
      ".mw-editsection", ".navbox", ".vertical-navbox", ".sidebar", ".reflist", ".references",
      ".mw-references-wrap", "#toc", ".toc", ".catlinks", ".metadata", ".noprint",
    ] },
  ];
  // Site chrome: navigation, sidebars, footers, menus and toolbars.
  const CHROME_SELECTOR = [
    "nav", "footer", "aside", "[role=navigation]", "[role=banner]", "[role=contentinfo]",
    "[role=complementary]", "[role=menu]", "[role=menubar]", "[role=toolbar]", "[role=tablist]",
    "[role=search]", "[aria-hidden=true]",
  ].join(",");

  const LETTER = /\p{L}/u;
  const LETTERS = /\p{L}/gu;
  const LANG_CODES = {
    korean: "ko", "한국어": "ko", japanese: "ja", "日本語": "ja", chinese: "zh", "中文": "zh",
    english: "en", spanish: "es", french: "fr", german: "de",
  };
  const LANG_LABEL = { ko: "한국어", ja: "일본어", zh: "중국어" };
  const SCRIPT_RE = {
    ko: /[ᄀ-ᇿ㄰-㆏가-힯]/g,
    ja: /[぀-ヿ㐀-䶿一-鿿]/g,
    zh: /[㐀-䶿一-鿿]/g,
  };
  const targetLang = () => LANG_CODES[String(settings?.target || "").trim().toLowerCase()] || "";

  // Landmarks only count when they hold most of the page's text; otherwise a
  // stray <article> card would hide the real body.
  function contentRoots() {
    const len = (el) => (el.innerText || "").length;
    const bodyLen = len(document.body) || 1;
    const outer = (list) => list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
    const mains = outer([...document.querySelectorAll("main, [role=main]")]);
    if (mains.reduce((a, el) => a + len(el), 0) >= bodyLen * 0.3) return [...mains, ...document.querySelectorAll("h1")];
    const articles = outer([...document.querySelectorAll("article, d-article")]);
    if (articles.reduce((a, el) => a + len(el), 0) >= bodyLen * 0.5) return [...articles, ...document.querySelectorAll("h1")];
    return []; // no reliable landmark: whole body minus chrome
  }

  // {page, rule, test(el), excluded(el)}. Cached per URL for 5s.
  let scopeCache = null;
  function getScope() {
    const key = location.href + "|" + settings.scope;
    const now = Date.now();
    if (scopeCache && scopeCache.key === key && now - scopeCache.at < 5000) return scopeCache.scope;
    const scope = computeScope();
    scopeCache = { key, at: now, scope };
    return scope;
  }
  function computeScope() {
    if (settings.scope === "page") return { page: true, rule: null, test: () => true, excluded: () => false };
    // An excluded element only stops a run when it has text; empty icons do not split sentences.
    const textful = (el) => LETTER.test(el.textContent);
    const rule = SITE_RULES.find((r) => r.host.test(location.hostname)) || null;
    if (rule) {
      const inc = rule.include.join(",");
      const ex = (rule.exclude || []).join(",");
      return {
        page: false, rule,
        test: (el) => !!el.closest(inc) && !(ex && el.closest(ex)) && !el.closest(CONTENT_SKIP),
        excluded: (el) => el.nodeType === 1 && !!ex && el.matches(ex) && textful(el),
      };
    }
    const roots = contentRoots();
    return {
      page: false, rule: null,
      test: (el) => {
        if (el.closest(CHROME_SELECTOR) || el.closest(CONTENT_SKIP)) return false;
        if (roots.length && !roots.some((r) => r.contains(el))) return false;
        const header = el.closest("header");
        return !header || !!header.closest("main, article, [role=main]");
      },
      excluded: (el) => el.nodeType === 1 && el.matches(CHROME_SELECTOR) && textful(el),
    };
  }

  // ---------- State ----------

  let settings = null;      // resolved settings
  let lastRaw = null;
  let started = false;
  let orphaned = false;
  let gen = 0;
  const pagePrefix = String.fromCharCode(97 + Math.floor(Math.random() * 26), 97 + Math.floor(Math.random() * 26));
  let seq = 0;
  const units = new Map();           // id -> live unit
  let owner = new WeakMap();         // node (run node or descendant) -> unit
  const frozen = new WeakSet();      // blocks that churn too much: left as original
  const churn = new WeakMap();       // block -> [invalidation times]
  const cloneSource = new WeakMap(); // cloned link -> original link
  let cache = new Map();             // source text -> translation | KEEP
  const queue = [];
  const batches = new Set();
  let watch = new WeakMap();         // IO target -> [units]
  let io = null, mo = null;
  let flushTimer = null, offTimer = null;
  let pendingRoots = new Set();
  let tickTimer = null, tickAt = 0;
  const stats = { requests: 0, tokensIn: 0, tokensOut: 0, chars: 0 };
  const shownCodes = new Set();      // fatal/failure codes shown since the last toggle
  const noticeTexts = new Set();     // bridge notices shown on this page
  const failTimes = new Map();       // code -> [times]
  let retryTimer = null, lastAutoRetry = 0;
  const timers = new Set();

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const isOriginal = () => document.documentElement.classList.contains("ct-original");
  const shouldHide = () => settings?.mode === "replace" && !isOriginal();

  // ---------- Layout helpers ----------

  let displayCache = new WeakMap(), blockDescCache = new WeakMap(), styleCache = new WeakMap();
  function resetCaches() { displayCache = new WeakMap(); blockDescCache = new WeakMap(); styleCache = new WeakMap(); }
  function cs(el) {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  }
  function display(el) {
    let d = displayCache.get(el);
    if (d === undefined) { d = cs(el).display; displayCache.set(el, d); }
    return d;
  }
  const isInlineDisplay = (d) => d.startsWith("inline") || d === "contents" || d === "ruby";

  function hasBlockDescendant(el) {
    const c = blockDescCache.get(el);
    if (c !== undefined) return c;
    let r = false;
    for (const ch of el.children) {
      if (ch.tagName === "CT-TR" || ch.tagName === "CT-STATUS") { r = true; break; }
      if (display(ch) === "none" || ch.matches(OPAQUE_SELECTOR)) {
        if (ch.matches(BOUNDARY_SELECTOR) || ch.querySelector(BOUNDARY_SELECTOR)) { r = true; break; }
        continue;
      }
      if (BLOCK_TAGS.has(ch.tagName) || ch.matches(BOUNDARY_SELECTOR) ||
          !isInlineDisplay(display(ch)) || hasBlockDescendant(ch)) { r = true; break; }
    }
    blockDescCache.set(el, r);
    return r;
  }

  function isInlineNode(n) {
    const t = n.nodeType;
    if (t === 3 || t === 8) return true;
    if (t !== 1) return false;
    const tag = n.tagName;
    if (tag === "CT-TR" || tag === "CT-STATUS") return false;
    if (n.matches(BOUNDARY_SELECTOR) || BLOCK_TAGS.has(tag)) return false;
    const d = display(n);
    if (d === "none") return !n.querySelector(BOUNDARY_SELECTOR);
    if (n.matches(OPAQUE_SELECTOR)) return isInlineDisplay(d) && !n.querySelector(BOUNDARY_SELECTOR);
    return isInlineDisplay(d) && !hasBlockDescendant(n);
  }

  function blockAncestor(node) {
    let el = node.parentElement;
    while (el && el !== document.body && el !== document.documentElement && isInlineNode(el)) el = el.parentElement;
    return el;
  }

  // The element whose box represents el (display:contents has no box).
  function boxTarget(el) {
    while (el && el.parentElement && getComputedStyle(el).display === "contents") el = el.parentElement;
    return el;
  }
  // Rendered at all? Closed <details> content and content-visibility:hidden
  // still report a box, but IntersectionObserver never sees them.
  const rendered = (el) => !el.checkVisibility || el.checkVisibility();
  function viewportRect(u) {
    const t = boxTarget(u.block);
    if (!rendered(t)) return null;
    const r = t.getBoundingClientRect();
    return r.height > 0 ? r : null;
  }
  function inViewport(u) {
    const r = viewportRect(u);
    return !!r && r.bottom > 0 && r.top < innerHeight;
  }

  function worthTranslating(plain) {
    const letters = (plain.match(LETTERS) || []).length;
    if (letters < 2) return false;
    const re = SCRIPT_RE[targetLang()];
    if (re && (plain.match(re) || []).length / letters > 0.3) return false;
    return true;
  }

  function langSkip(p, code) {
    const L = p.closest("[lang]");
    if (!L || L === document.documentElement) return false;
    const lg = (L.getAttribute("lang") || "").trim().toLowerCase();
    if (!lg) return false;
    if (/^(zxx|qme|qht|und)(-|$)/.test(lg)) return true;
    return !!code && (lg === code || lg.startsWith(code + "-"));
  }

  // ---------- Serialization ----------

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const stripTags = (s) => decode(s.replace(/<\/?x\d+\/?>/g, " ")).replace(/\s+/g, " ").trim();

  function preWhitespace(el) {
    if (!el) return false;
    const s = cs(el);
    return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(s.whiteSpace) ||
      /^(preserve|preserve-breaks|break-spaces)$/.test(s.whiteSpaceCollapse || "");
  }

  // A span that only groups text and looks exactly like its parent adds nothing.
  function transparent(el) {
    if (el.tagName !== "SPAN" && el.tagName !== "FONT") return false;
    for (const a of ["id", "href", "role", "onclick", "tabindex"]) if (el.hasAttribute(a)) return false;
    const p = el.parentElement;
    if (!p) return false;
    const a = cs(el), b = cs(p);
    return a.color === b.color && a.fontWeight === b.fontWeight && a.fontStyle === b.fontStyle &&
      a.textDecorationLine === b.textDecorationLine && a.fontSize === b.fontSize &&
      (a.backgroundColor === b.backgroundColor || a.backgroundColor === "rgba(0, 0, 0, 0)");
  }

  // Turn an inline run into "text <x1>link</x1> <x2/>" plus a placeholder map.
  function serialize(nodes) {
    const map = new Map();
    let n = 0;
    const add = (entry) => { const k = ++n; map.set(k, entry); return k; };
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (preWhitespace(node.parentElement)) {
          return esc(node.data).replace(/[ \t\f\r]+/g, " ").replace(/\n/g, () => `<x${add({ nl: true })}/>`);
        }
        return esc(node.data).replace(/\s+/g, " ");
      }
      if (node.nodeType !== 1) return "";
      if (node.matches("script,style,noscript,template")) return "";
      if (node.tagName === "BR") return `<x${add({ nl: true, node })}/>`;
      if (node.matches(OPAQUE_SELECTOR) || display(node) === "none") return `<x${add({ opaque: true, node })}/>`;
      if ((node.textContent.match(LETTERS) || []).length < 2) return `<x${add({ opaque: true, node })}/>`;
      if (transparent(node)) return Array.from(node.childNodes, walk).join("");
      const k = add({ node });
      const inner = Array.from(node.childNodes, walk).join("");
      if (!inner.trim()) { map.set(k, { opaque: true, node }); return `<x${k}/>`; }
      return `<x${k}>${inner}</x${k}>`;
    };
    const text = nodes.map(walk).join("").replace(/ {2,}/g, " ").trim();
    return { text, map };
  }

  // ---------- Collecting units ----------

  const SKIP_PLAIN = /^(https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|[\d\s.,:%+\-–\/()#]+)$/;
  // Standalone reference labels such as "Eq. 3" or "Fig. 2a" (equation numbers on Wikipedia).
  const LABEL_PLAIN = /^\(?(eqs?|eqn|fig|figs|tab|sec|alg|thm|def|prop|cor)\.\s*\(?\d+(\.\d+)*[a-z]?\)?\)?$/i;

  // Menus, tag clouds and "related" lists: several links and little else.
  function isLinkList(nodes, plain) {
    let links = 0, linkChars = 0;
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      const as = n.matches("a") ? [n] : n.querySelectorAll("a");
      for (const a of as) { links++; linkChars += a.textContent.trim().length; }
    }
    return links >= 3 && linkChars >= plain.replace(/\s+/g, "").length * 0.7;
  }

  // Short capitalized labels equal to a piece of the page title are names
  // (the project, the site); translating them only transliterates them.
  function titleSkip(plain, block, scope) {
    if (scope.page || scope.rule) return false;
    if (block.closest("h1,h2,h3")) return false;
    if (plain.length > 60 || /[.!?:;]$/.test(plain)) return false;
    const words = plain.split(/\s+/);
    if (words.length > 4 || !words.every((w) => /^(\P{L}|\p{Lu})/u.test(w))) return false;
    const low = plain.toLowerCase();
    return document.title.split(/\s+[-|·—–:]\s+|["“”]/).some((s) => s.trim().toLowerCase() === low);
  }

  function textNodesOf(nodes) {
    const out = [];
    for (const n of nodes) {
      if (n.nodeType === 3) out.push(n);
      else if (n.nodeType === 1) {
        const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        for (let x = w.nextNode(); x; x = w.nextNode()) out.push(x);
      }
    }
    return out;
  }

  function collectUnits(root, scope) {
    resetCaches();
    const found = [], hits = [];
    const code = targetLang();
    const visited = new WeakSet();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(t) {
        if (!t.data.trim() || owner.has(t)) return NodeFilter.FILTER_REJECT;
        const p = t.parentElement;
        if (!p || p.closest(SKIP_SELECTOR) || p.closest("[data-ct-hide]")) return NodeFilter.FILTER_REJECT;
        if (langSkip(p, code) || !scope.test(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (owner.has(t) || visited.has(t)) continue;
      const block = blockAncestor(t);
      if (!block || frozen.has(block)) continue;
      let child = t;
      while (child.parentNode !== block) child = child.parentNode;
      if (!isInlineNode(child)) continue;
      // Extend to the maximal run of inline siblings.
      const ok = (n) => !!n && isInlineNode(n) && !scope.excluded(n) && !owner.has(n);
      let first = child, last = child;
      while (ok(first.previousSibling)) first = first.previousSibling;
      while (ok(last.nextSibling)) last = last.nextSibling;
      const nodes = [];
      for (let n = first; ; n = n.nextSibling) { nodes.push(n); if (n === last) break; }
      const texts = textNodesOf(nodes);
      for (const x of texts) visited.add(x);
      const { text, map } = serialize(nodes);
      const plain = stripTags(text);
      if (!worthTranslating(plain) || SKIP_PLAIN.test(plain) || LABEL_PLAIN.test(plain)) continue;
      if (!scope.page && isLinkList(nodes, plain)) continue;
      if (titleSkip(plain, block, scope)) continue;
      const u = makeUnit(block, nodes, texts, text, plain, map);
      const hit = cache.get(text);
      if (hit !== undefined) hits.push([u, hit]); else found.push(u);
    }
    for (const [u, r] of hits) applyResult(u, r);
    return found;
  }

  function makeUnit(block, nodes, texts, text, plain, map) {
    let siblings = 0;
    for (const c of block.childNodes) if (!(c.nodeType === 1 && c.tagName === "CT-TR")) siblings++;
    const u = {
      id: pagePrefix + (++seq), seq, block, nodes, texts, text, plain, map,
      tr: null, state: "new", hidden: false, saved: new Map(), base: new Map(),
      gen, retries: 0, dead: false, inline: siblings !== nodes.length,
    };
    for (const t of texts) { u.base.set(t, t.data); owner.set(t, u); }
    for (const n of nodes) {
      owner.set(n, u);
      if (n.nodeType === 1) for (const d of n.querySelectorAll("*")) owner.set(d, u);
    }
    units.set(u.id, u);
    return u;
  }

  function unclaim(u) {
    const drop = (n) => { if (owner.get(n) === u) owner.delete(n); };
    for (const n of u.nodes) {
      drop(n);
      if (n.nodeType === 1) for (const d of n.querySelectorAll("*")) drop(d);
    }
    for (const t of u.texts) drop(t);
  }

  // ---------- Rendering ----------

  // Every DOM write of ours goes through quiet() so the MutationObserver never
  // sees it. Pending page mutations are handled first.
  let quietDepth = 0;
  function quiet(fn) {
    if (quietDepth) return fn();
    if (mo && started && !orphaned) {
      const recs = mo.takeRecords();
      if (recs.length) handleRecords(recs);
    }
    quietDepth++;
    try { return fn(); } finally { quietDepth--; if (mo) mo.takeRecords(); }
  }

  function setHidden(u, hide) {
    if (u.hidden === hide) return;
    for (const n of u.nodes) {
      if (n.nodeType === 1) n.toggleAttribute("data-ct-hide", hide);
      else if (n.nodeType === 3) {
        if (hide) { u.saved.set(n, n.data); n.data = ""; }
        else {
          if (u.saved.has(n) && n.data === "") n.data = u.saved.get(n);
          u.saved.delete(n);
        }
      }
    }
    u.hidden = hide;
  }

  function cloneClean(src, deep) {
    const c = src.cloneNode(deep);
    if (c.nodeType !== 1) return c;
    const pairs = [[c, src]];
    if (deep) {
      const a = c.querySelectorAll("*"), b = src.querySelectorAll("*");
      for (let i = 0; i < a.length && i < b.length; i++) pairs.push([a[i], b[i]]);
    }
    for (const [x, s] of pairs) {
      x.removeAttribute("id");
      x.removeAttribute("name");
      x.removeAttribute("data-ct-hide");
      if (x.matches("a, [role=link], [role=button]")) cloneSource.set(x, s);
    }
    return c;
  }

  function build(u, s) {
    const frag = document.createDocumentFragment();
    const stack = [{ el: frag, k: 0 }];
    const used = new Set();
    const top = () => stack[stack.length - 1].el;
    const pushText = (str) => { if (str) top().appendChild(document.createTextNode(decode(str))); };
    const re = /<(\/?)x(\d+)(\/?)>/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      pushText(s.slice(last, m.index));
      last = re.lastIndex;
      const k = Number(m[2]);
      const ph = u.map.get(k);
      if (m[1]) {
        // Close: pop down to the matching tag. A close that matches nothing
        // still ends the innermost open tag, so text after a mangled link
        // does not end up inside the link.
        let i = stack.length - 1;
        while (i > 0 && stack[i].k !== k) i--;
        if (i > 0) stack.length = i;
        else if (!ph && stack.length > 1) stack.pop();
        continue;
      }
      if (!ph) continue; // invented tag: drop it
      if (ph.nl) { top().appendChild(ph.node ? cloneClean(ph.node, false) : document.createTextNode("\n")); continue; }
      if (ph.opaque) {
        if (!used.has(k)) { used.add(k); top().appendChild(cloneClean(ph.node, true)); }
        continue;
      }
      if (m[3]) continue; // a paired tag written as <xN/> would be an empty element
      const el = cloneClean(ph.node, false);
      top().appendChild(el);
      stack.push({ el, k });
      used.add(k);
    }
    pushText(s.slice(last));
    for (const [k, ph] of u.map) {
      if (ph.opaque && !ph.nl && !used.has(k)) frag.append(" ", cloneClean(ph.node, true));
    }
    return frag;
  }

  function applyResult(u, r) {
    if (u.dead || u.tr) return;
    if (r === KEEP || r === "") {
      u.state = "kept";
      cache.set(u.text, KEEP);
      progress();
      return;
    }
    if (!u.block.isConnected || !u.nodes.every((n) => n.parentNode === u.block)) { invalidate(u); return; }
    quiet(() => {
      const tr = document.createElement("ct-tr");
      tr.setAttribute("translate", "no");
      tr.setAttribute("data-ct-unit", u.id);
      if (u.inline) tr.setAttribute("data-inline", "");
      tr.appendChild(build(u, r));
      u.nodes[u.nodes.length - 1].after(tr);
      u.tr = tr;
      setHidden(u, shouldHide());
    });
    u.state = "done";
    cache.set(u.text, r);
    stats.chars += u.plain.length;
    progress();
  }

  function syncAll() {
    const hide = shouldHide();
    quiet(() => { for (const u of units.values()) if (u.tr) setHidden(u, hide); });
  }

  // ---------- Click forwarding: links in the translation act like the originals ----------

  function onClick(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const el = t.closest("ct-tr a, ct-tr [role=link], ct-tr [role=button]");
    if (!el) return;
    const src = cloneSource.get(el);
    if (!src || !src.isConnected) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    src.click();
  }

  // ---------- Page changes (SPAs, infinite scroll, live text) ----------

  const inOurs = (n) => {
    const el = n.nodeType === 1 ? n : n.parentElement;
    return !!el && !!el.closest("ct-tr, ct-status");
  };
  const unitOfTr = (el) => { const u = units.get(el.getAttribute("data-ct-unit")); return u && u.tr === el ? u : null; };
  const noDigits = (s) => s.replace(/[\d\s]/g, "");

  function handleRecords(records) {
    if (!records.length || orphaned || !started) return;
    resetCaches();
    let added = false;
    for (const r of records) {
      const tgt = r.target;
      if (r.type === "characterData") {
        const u = owner.get(tgt);
        if (!u) {
          if (tgt.isConnected && tgt.parentElement && tgt.data.trim() && !inOurs(tgt)) {
            pendingRoots.add(tgt.parentElement); added = true;
          }
          continue;
        }
        if (u.dead) continue;
        const top = u.nodes.includes(tgt);
        if (tgt.data === "" && u.hidden && top) continue;
        const before = u.saved.has(tgt) ? u.saved.get(tgt) : (u.base.get(tgt) ?? "");
        if (noDigits(tgt.data) === noDigits(before)) {
          // Counters and timestamps: keep the translation.
          u.base.set(tgt, tgt.data);
          if (top && u.hidden) quiet(() => { u.saved.set(tgt, tgt.data); tgt.data = ""; });
          continue;
        }
        invalidate(u);
        continue;
      }
      if (r.type !== "childList" || inOurs(tgt)) continue;
      const tu = owner.get(tgt);
      if (tu && !tu.dead) {
        // el.textContent = "4 likes" inside a run: same words, new digits. Adopt the new text node.
        const onlyText = (list) => [...list].every((n) => n.nodeType === 3);
        const join = (list) => [...list].map((n) => n.data).join("");
        if (r.addedNodes.length && onlyText(r.addedNodes) && onlyText(r.removedNodes) &&
            noDigits(join(r.addedNodes)) === noDigits(join(r.removedNodes))) {
          for (const n of r.addedNodes) { owner.set(n, tu); tu.texts.push(n); tu.base.set(n, n.data); }
          continue;
        }
        invalidate(tu);
      }
      for (const n of r.removedNodes) {
        if (n.nodeType === 1 && n.tagName === "CT-TR") { const v = unitOfTr(n); if (v && !v.dead) invalidate(v); continue; }
        const o = owner.get(n);
        if (o && !o.dead) invalidate(o);
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === "CT-TR" || n.tagName === "CT-STATUS")) continue;
        if (n.nodeType !== 1 && n.nodeType !== 3) continue;
        if (n.nodeType === 3 && !n.data.trim()) continue;
        if (n.isConnected && n.parentNode && isInlineNode(n)) {
          for (const sib of [n.previousSibling, n.nextSibling]) {
            if (!sib) continue;
            const o = sib.nodeType === 1 && sib.tagName === "CT-TR" ? unitOfTr(sib) : owner.get(sib);
            if (o && !o.dead && o.block === n.parentNode) invalidate(o);
          }
        }
        const root = n.nodeType === 3 ? n.parentElement : n;
        if (root) { pendingRoots.add(root); added = true; }
      }
    }
    if (added) scheduleTick(300);
  }

  function dropUnit(u) {
    u.dead = true;
    units.delete(u.id);
    const i = queue.indexOf(u);
    if (i >= 0) queue.splice(i, 1);
    unclaim(u);
  }

  function invalidate(u) {
    if (u.dead) return;
    quiet(() => { setHidden(u, false); u.tr?.remove(); u.tr = null; });
    dropUnit(u);
    const b = u.block, now = Date.now();
    const list = (churn.get(b) || []).filter((x) => now - x < 60000);
    list.push(now);
    churn.set(b, list);
    if (list.length > 2) frozen.add(b); // live tickers stay in the original
    if (b.isConnected) pendingRoots.add(b);
    scheduleTick(1000);
    progress();
  }

  function scheduleTick(ms) {
    if (orphaned) return;
    const at = Date.now() + ms;
    if (tickTimer && tickAt >= at) return;
    clearTimeout(tickTimer);
    tickAt = at;
    tickTimer = setTimeout(tick, ms);
  }

  function tick() {
    tickTimer = null;
    if (orphaned || !started) return;
    for (const u of [...units.values()]) {
      if (!u.block.isConnected || !u.nodes.some((n) => n.isConnected)) {
        if (u.tr) quiet(() => { u.tr.remove(); u.tr = null; });
        dropUnit(u);
      }
    }
    const roots = [...pendingRoots].filter((r) => r.isConnected && !inOurs(r));
    pendingRoots = new Set();
    const set = new Set(roots);
    const outer = roots.filter((r) => { for (let p = r.parentNode; p; p = p.parentNode) if (set.has(p)) return false; return true; });
    if (outer.length) {
      const scope = getScope();
      const found = [];
      for (const r of outer) found.push(...collectUnits(r, scope));
      register(found);
    }
    progress();
  }

  // ---------- Scheduling & network ----------

  function register(list) {
    for (const u of list) {
      const t = boxTarget(u.block);
      if (!t) continue;
      let arr = watch.get(t);
      if (!arr) { arr = []; watch.set(t, arr); io.observe(t); }
      arr.push(u); // hidden blocks never intersect, so they cost nothing until shown
    }
    progress();
  }

  function enqueue(u) {
    if (u.dead || u.state !== "new") return;
    u.state = "queued";
    u.queuedAt = Date.now();
    queue.push(u);
    // Brief pause so units arriving together share a batch (fewer requests, fewer tokens).
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
    progress();
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (orphaned || !started || isOriginal()) return;
    for (let i = queue.length - 1; i >= 0; i--) {
      const u = queue[i];
      if (u.dead) queue.splice(i, 1);
      else if (!u.block.isConnected) dropUnit(u);
    }
    if (!queue.length) return progress();
    const vh = innerHeight;
    const meta = new Map();
    for (const u of queue) {
      const r = viewportRect(u);
      const vis = !!r && r.bottom > 0 && r.top < vh;
      const dist = vis ? 0 : !r ? 1e9 : r.top >= vh ? r.top - vh : -r.bottom;
      meta.set(u, { vis, dist });
    }
    queue.sort((a, b) => {
      const A = meta.get(a), B = meta.get(b);
      if (A.vis !== B.vis) return A.vis ? -1 : 1;
      return (A.vis ? 0 : A.dist - B.dist) || a.seq - b.seq;
    });
    const maxInflight = Math.max(1, Number(settings.concurrency) || 8);
    const bc = Number(settings.batchChars) || 1500;
    // Visible text goes in small batches so the first lines come back fast;
    // off-screen text in big ones, since every request costs ~7k tokens.
    const take = (vis, maxChars, maxSegs) => {
      const batch = [];
      let chars = 0;
      // First fit in priority order: a long paragraph that does not fit leaves
      // room for the short lines after it instead of ending the batch.
      for (let i = 0; i < queue.length && batch.length < maxSegs && chars < maxChars;) {
        const u = queue[i];
        if (meta.get(u).vis !== vis || (batch.length && chars + u.text.length > maxChars)) { i++; continue; }
        batch.push(u);
        chars += u.text.length;
        queue.splice(i, 1);
      }
      return batch;
    };
    // A partial off-screen batch waits briefly for more text (scrolling adds
    // units a few at a time); the reader does not see it yet anyway.
    const offWait = () => {
      let chars = 0, oldest = Infinity;
      for (const u of queue) if (!meta.get(u).vis) { chars += u.text.length; oldest = Math.min(oldest, u.queuedAt || 0); }
      const left = OFFSCREEN_WAIT - (Date.now() - oldest);
      return chars >= bc || left <= 0 ? 0 : left;
    };
    while (queue.length && batches.size < maxInflight) {
      let visInflight = 0;
      for (const b of batches) if (b.vis) visInflight++;
      const hasVis = queue.some((u) => meta.get(u).vis);
      const hasOther = queue.some((u) => !meta.get(u).vis);
      let batch, vis;
      if (hasVis && visInflight < 3) { vis = true; batch = take(true, 900, 10); }
      else if (hasOther) {
        const wait = offWait();
        if (wait) { clearTimeout(offTimer); offTimer = setTimeout(flush, wait + 10); break; }
        vis = false; batch = take(false, bc, Math.max(4, Math.round(bc / 75)));
      }
      else break;
      if (!batch.length) break;
      send(batch, vis);
      if (orphaned) return;
    }
    progress();
  }

  function outgoingSettings() {
    const { siteTone, ...rest } = settings;
    return rest;
  }

  function send(batch, vis) {
    let port;
    try { port = chrome.runtime.connect({ name: "translate" }); }
    catch { for (const u of batch) u.state = "new"; orphan(); return; }
    const b = { port, vis, groups: new Map(), timer: 0, closed: false, sentAt: Date.now() };
    const segments = [];
    const byText = new Map();
    for (const u of batch) {
      u.state = "inflight";
      let id = byText.get(u.text);
      if (!id) { id = u.id; byText.set(u.text, id); b.groups.set(id, []); segments.push({ id, text: u.text }); }
      b.groups.get(id).push(u);
    }
    batches.add(b);
    stats.requests++;
    const arm = () => { clearTimeout(b.timer); b.timer = setTimeout(() => endBatch(b, "watchdog"), 90000); };
    port.onMessage.addListener((msg) => { if (b.closed) return; arm(); onBatchMessage(b, msg); });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!b.closed) endBatch(b, "disconnect"); });
    try {
      port.postMessage({ segments, settings: outgoingSettings(), context: document.title });
      arm();
    } catch { endBatch(b, "disconnect"); }
    progress();
  }

  function closeBatch(b) {
    const pending = [];
    for (const g of b.groups.values()) for (const u of g) if (!u.dead) pending.push(u);
    b.groups.clear();
    b.closed = true;
    clearTimeout(b.timer);
    batches.delete(b);
    try { b.port.disconnect(); } catch {}
    return pending;
  }

  function endBatch(b, reason) {
    const pending = closeBatch(b);
    const err = reason === "watchdog"
      ? { error: "Codex가 90초 동안 응답하지 않았어요", code: "timeout", retryable: true }
      : { error: "번역 브리지 연결이 끊겼어요", code: "host_exited", retryable: true };
    for (const u of pending) unitError(u, err);
    flush();
  }

  function addUsage(u) {
    if (!u) return;
    stats.tokensIn += Number(u.input) || 0;
    stats.tokensOut += Number(u.output) || 0;
  }

  function onBatchMessage(b, msg) {
    if (msg.fatal) {
      addUsage(msg.usage);
      const pending = closeBatch(b);
      for (const u of pending) u.state = "parked";
      handleFatal(msg.fatal, b, pending);
      flush();
      return;
    }
    if (msg.done) {
      addUsage(msg.usage);
      if (msg.notice) showNotice({ code: "notice", message: msg.notice, action: "" }, 8000);
      const pending = closeBatch(b);
      for (const u of pending) unitError(u, { error: "번역 결과에서 빠졌어요", code: "bad_output", retryable: true });
      flush();
      return;
    }
    const group = b.groups.get(msg.id);
    if (!group) return;
    b.groups.delete(msg.id);
    for (const u of group) {
      if (u.dead) continue;
      if (msg.keep) applyResult(u, KEEP);
      else if (typeof msg.text === "string") applyResult(u, msg.text);
      else unitError(u, msg);
    }
    progress();
  }

  function unitError(u, msg) {
    if (u.dead) return;
    if (msg.code === "policy") { u.state = "kept"; return; } // keep the original silently
    if (msg.retryable && u.retries < 1) {
      u.retries++;
      u.state = "new";
      const g = gen;
      later(() => { if (g === gen) enqueue(u); }, 2000);
      return;
    }
    u.state = "failed";
    const code = msg.code || "error";
    const now = Date.now();
    const list = (failTimes.get(code) || []).filter((t) => now - t < 10000);
    list.push(now);
    failTimes.set(code, list);
    if (list.length >= 3) showNotice({ code, message: msg.error || "일부 문장을 번역하지 못했어요", action: "" });
    progress();
  }

  function requeue(list) {
    for (const u of list) {
      if (u.dead || (u.state !== "parked" && u.state !== "failed")) continue;
      u.state = "new";
      u.retries = 0;
      enqueue(u);
    }
  }

  function handleFatal(f, b, pending) {
    if (!f.retryable) return showNotice(f);
    if (retryTimer) return; // the scheduled retry picks these units up
    if (b.sentAt < lastAutoRetry) { requeue(pending); return; } // sent before the retry: it counts as covered
    const now = Date.now();
    if (now - lastAutoRetry > 60000) {
      lastAutoRetry = now;
      retryTimer = later(() => {
        retryTimer = null;
        requeue([...units.values()].filter((u) => u.state === "parked"));
        flush();
      }, 3000);
      return;
    }
    showNotice(f);
  }

  // ---------- Progress: badge, data-stats, pill ----------

  let progressTimer = 0, progressRaf = 0, lastBadge = null, pillSince = 0, pillTimer = 0;
  function progress() {
    if (orphaned || progressTimer) return;
    const run = () => {
      clearTimeout(progressTimer); cancelAnimationFrame(progressRaf);
      progressTimer = 0; progressRaf = 0;
      renderProgress();
    };
    progressRaf = requestAnimationFrame(run);
    progressTimer = setTimeout(run, 250); // rAF does not run in background tabs
  }

  function renderProgress() {
    if (orphaned) return;
    const c = { total: 0, queued: 0, inflight: 0, done: 0, kept: 0, failed: 0, parked: 0, visiblePending: 0 };
    const pend = [], fresh = [];
    for (const u of units.values()) {
      c.total++;
      if (u.state === "queued") { c.queued++; pend.push(u); }
      else if (u.state === "inflight") { c.inflight++; pend.push(u); }
      else if (u.state === "done") c.done++;
      else if (u.state === "kept") c.kept++;
      else if (u.state === "failed") c.failed++;
      else if (u.state === "parked") c.parked++;
      else fresh.push(u);
    }
    const check = pend.length + fresh.length <= 300 ? pend.concat(fresh) : pend;
    for (const u of check) if (inViewport(u)) c.visiblePending++;
    const N = c.queued + c.inflight;
    if (isOriginal()) badge("EN", "#777");
    else if (N > 0) badge(N > 999 ? "999+" : String(N), "#5b5bd6");
    else if (c.failed + c.parked > 0) badge("!", "#c62828");
    else badge("");
    if (statusEl) statusEl.setAttribute("data-stats", JSON.stringify({ ...c, ...stats }));
    // The pill only appears when visible text is still waiting after 800ms.
    const want = N > 0 && c.visiblePending > 0 && !isOriginal();
    clearTimeout(pillTimer);
    if (!want) { pillSince = 0; setPill(false); return; }
    const now = Date.now();
    if (!pillSince) pillSince = now;
    const left = 800 - (now - pillSince);
    if (left <= 0) setPill(true, N);
    else pillTimer = setTimeout(progress, left + 20);
  }

  function badge(text, color) {
    const key = text + "|" + (color || "");
    if (key === lastBadge) return;
    lastBadge = key;
    rt({ type: "badge", text, color });
  }

  function rt(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { orphan(); }
  }

  // ---------- <ct-status>: pill and notices, isolated in a shadow root ----------

  let statusEl = null, pillEl = null, boxEl = null, msgEl = null, actEl = null, noticeTimer = 0;
  const STATUS_CSS = `
    .pill{position:fixed;top:8px;left:50%;transform:translateX(-50%);display:none;pointer-events:none;
      font:12px/1.4 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;padding:4px 10px;
      border-radius:999px;background:rgba(255,255,255,.96);color:#333;box-shadow:0 1px 6px rgba(0,0,0,.18);white-space:nowrap}
    .pill.on{display:block}
    .box{position:fixed;top:40px;left:50%;transform:translateX(-50%);display:none;pointer-events:auto;
      box-sizing:border-box;width:max-content;max-width:min(440px,calc(100vw - 32px));padding:10px 32px 10px 14px;
      border-radius:10px;background:#222;color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;
      box-shadow:0 4px 16px rgba(0,0,0,.3)}
    .box.on{display:block}
    .act{color:#c9c9cf;margin-top:2px}
    .x{position:absolute;top:6px;right:8px;border:0;background:none;color:inherit;font:16px/1 sans-serif;cursor:pointer;padding:2px 4px}
    @media (prefers-color-scheme: dark){
      .pill{background:rgba(44,44,46,.96);color:#eee}
      .box{background:#f2f2f4;color:#1d1d1f}.act{color:#55555a}
    }`;

  function ensureStatus() {
    if (statusEl) {
      if (!statusEl.isConnected) document.documentElement.appendChild(statusEl);
      return statusEl;
    }
    statusEl = document.createElement("ct-status");
    statusEl.setAttribute("translate", "no");
    statusEl.setAttribute("style", "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647");
    statusEl.setAttribute("data-notice", "");
    if (settings) statusEl.setAttribute("data-tone", settings.tone);
    const root = statusEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STATUS_CSS;
    pillEl = document.createElement("div");
    pillEl.className = "pill";
    boxEl = document.createElement("div");
    boxEl.className = "box";
    boxEl.setAttribute("role", "status");
    msgEl = document.createElement("div");
    actEl = document.createElement("div");
    actEl.className = "act";
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.setAttribute("aria-label", "닫기");
    x.addEventListener("click", () => boxEl.classList.remove("on"));
    boxEl.append(msgEl, actEl, x);
    root.append(style, pillEl, boxEl);
    document.documentElement.appendChild(statusEl);
    return statusEl;
  }

  function setPill(on, n) {
    if (!pillEl) return;
    if (on) pillEl.textContent = `Codex 번역 중 · ${n}`;
    pillEl.classList.toggle("on", !!on);
  }

  function showNotice(n, ms = 20000) {
    if (!n) return;
    const code = n.code || "error";
    if (code === "notice") {
      if (noticeTexts.has(n.message)) return;
      noticeTexts.add(n.message);
    } else if (code !== "already_target" && code !== "orphaned") {
      if (shownCodes.has(code)) return;
      shownCodes.add(code);
    }
    ensureStatus();
    statusEl.setAttribute("data-notice", code);
    msgEl.textContent = `Codex Translate: ${n.message || "번역하지 못했어요"}`;
    actEl.textContent = n.action || "";
    actEl.style.display = n.action ? "" : "none";
    boxEl.classList.add("on");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => boxEl.classList.remove("on"), ms);
    console.warn("[Codex Translate]", code, n.message, n.action || "");
  }

  // ---------- Tone ----------

  const CASUAL_HOST = /(^|\.)(x|twitter|reddit|ycombinator|youtube)\.com$/;
  const PAPER_HOST = /(^|\.)(wikipedia\.org|arxiv\.org|openreview\.net|aclanthology\.org)$/;

  // Text as the page wrote it (our translations and blanked nodes excluded).
  function origText(el) {
    let s = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      if (t.parentElement?.closest("ct-tr")) continue;
      s += (t.data === "" && owner.get(t)?.saved.get(t)) || t.data;
    }
    return s;
  }

  let paperMemo = null;
  function paperLike() {
    if (paperMemo && paperMemo.href === location.href) return paperMemo.v;
    let v = PAPER_HOST.test(location.hostname) ||
      !!document.querySelector('meta[name="citation_title"], meta[name="dc.title" i]');
    if (!v) {
      const hs = [...document.querySelectorAll("h1,h2,h3,h4")].slice(0, 300)
        .map((h) => origText(h).replace(/\s+/g, " ").trim());
      v = hs.some((t) => /^(\d+\.?\s*)?abstract$/i.test(t)) ||
        hs.filter((t) => /^(\d+\.?\s*)?(introduction|related work|conclusions?|method(s|ology)?|experiments?)$/i.test(t)).length >= 2 ||
        document.querySelectorAll('a[href*="arxiv.org/abs"], a[href*="doi.org/"], a[href*="openreview.net"]').length >= 3;
    }
    paperMemo = { href: location.href, v };
    return v;
  }

  function resolveTone(s) {
    const site = s.siteTone && s.siteTone[location.hostname];
    if (TONES.has(site)) return { tone: site, src: "site" };
    if (TONES.has(s.tone)) return { tone: s.tone, src: "global" };
    if (CASUAL_HOST.test(location.hostname)) return { tone: "haeyo", src: "auto" };
    if (paperLike()) return { tone: "handa", src: "auto" };
    return { tone: "hamnida", src: "auto" };
  }

  function resolve(raw) {
    const s = { ...FALLBACK_DEFAULTS, ...(raw || {}) };
    const { tone, src } = resolveTone(s);
    return { ...s, tone, toneSource: src };
  }

  // Settings whose change makes Option+A translate again instead of showing the original.
  const styleKey = (s) => JSON.stringify([s.target, s.tone, s.fidelity, s.terms, s.instructions, s.glossary, s.model, !!s.fast, s.scope]);

  function announceTone() {
    statusEl?.setAttribute("data-tone", settings.tone);
    rt({ type: "status", tone: settings.tone, toneSource: settings.toneSource });
  }

  // ---------- Lifecycle ----------

  function alreadyTarget() {
    const re = SCRIPT_RE[targetLang()];
    if (!re) return false;
    const txt = (document.body.innerText || "").slice(0, 3000);
    const letters = (txt.match(LETTERS) || []).length;
    if (letters < 20) return false;
    return (txt.match(re) || []).length / letters > 0.5;
  }

  function start() {
    if (alreadyTarget()) {
      const code = targetLang();
      showNotice({ code: "already_target", message: `이미 ${LANG_LABEL[code] || settings.target} 페이지라 번역하지 않았어요`, action: "" }, 6000);
      return false;
    }
    started = true;
    ensureStatus();
    statusEl.setAttribute("data-tone", settings.tone);
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const list = watch.get(e.target) || [];
        watch.delete(e.target);
        for (const u of list) enqueue(u);
      }
    }, { rootMargin: "25% 0px 100% 0px" });
    mo = new MutationObserver(handleRecords);
    register(collectUnits(document.body, getScope()));
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  }

  function applyMode() {
    document.documentElement.classList.toggle("ct-bilingual", settings.mode === "bilingual");
    if (started) syncAll();
  }

  function retranslate() {
    gen++;
    cache = new Map();
    queue.length = 0;
    for (const b of [...batches]) closeBatch(b);
    clearTimeout(retryTimer); retryTimer = null; lastAutoRetry = 0;
    shownCodes.clear();
    failTimes.clear();
    quiet(() => {
      for (const u of units.values()) { setHidden(u, false); u.tr?.remove(); u.tr = null; }
    });
    stats.chars = 0;
    // Rescan from scratch: the scope setting may have changed, and units are cheap to rebuild.
    for (const u of [...units.values()]) dropUnit(u);
    io.disconnect();
    watch = new WeakMap();
    scopeCache = null;
    register(collectUnits(document.body, getScope()));
  }

  function toggle(raw) {
    if (orphaned) return;
    lastRaw = raw || lastRaw || {};
    const next = resolve(lastRaw);
    const root = document.documentElement;
    if (!started) {
      settings = next;
      root.classList.remove("ct-original");
      applyMode();
      if (start()) {
        announceTone();
        rt({ type: "warm", settings: outgoingSettings() });
      }
      return;
    }
    const changed = styleKey(next) !== styleKey(settings);
    settings = next;
    announceTone();
    if (changed) {
      root.classList.remove("ct-original");
      applyMode();
      retranslate();
      return;
    }
    applyMode();
    root.classList.toggle("ct-original");
    syncAll();
    if (!isOriginal()) {
      shownCodes.clear();
      requeue([...units.values()]);
      flush();
    }
    progress();
  }

  function onMessage(msg) {
    if (orphaned || !msg) return;
    if (msg.type === "toggle") toggle(msg.settings);
    else if (msg.type === "retranslate") {
      if (!started) return toggle(msg.settings);
      lastRaw = msg.settings || lastRaw;
      settings = resolve(lastRaw);
      announceTone();
      document.documentElement.classList.remove("ct-original");
      applyMode();
      retranslate();
    }
  }

  function onStorage(changes, area) {
    if (orphaned || !settings || area !== "sync" || !changes.mode) return;
    settings.mode = changes.mode.newValue || "replace";
    if (lastRaw) lastRaw.mode = settings.mode;
    applyMode();
  }

  function stopAll() {
    try { io?.disconnect(); } catch {}
    try { mo?.disconnect(); } catch {}
    clearTimeout(flushTimer); flushTimer = null;
    clearTimeout(offTimer); offTimer = null;
    clearTimeout(tickTimer); tickTimer = null;
    clearTimeout(pillTimer); clearTimeout(progressTimer); cancelAnimationFrame(progressRaf);
    progressTimer = 0;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    retryTimer = null;
    queue.length = 0;
    for (const b of [...batches]) closeBatch(b);
    setPill(false);
  }

  // After the extension is reloaded or updated, scripts left in already-open
  // pages lose their connection. Stop quietly and ask for a page reload.
  function orphan() {
    if (orphaned) return;
    orphaned = true;
    stopAll();
    showNotice({
      code: "orphaned",
      message: "확장이 업데이트되어 이 페이지와의 연결이 끊겼어요",
      action: "페이지를 새로고침한 뒤 다시 번역하세요",
    }, 15000);
  }

  function dispose() {
    orphaned = true;
    stopAll();
    mo = null;
    for (const u of units.values()) { setHidden(u, false); u.tr?.remove(); u.tr = null; }
    units.clear();
    owner = new WeakMap();
    statusEl?.remove();
    statusEl = null;
    document.documentElement.classList.remove("ct-original", "ct-bilingual");
    document.removeEventListener("click", onClick, true);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
    if (window.__codexTranslate === api) delete window.__codexTranslate;
  }

  function alive() {
    if (orphaned) return false;
    try { return !!chrome.runtime?.id && !!chrome.runtime.getURL(""); } catch { return false; }
  }

  document.addEventListener("click", onClick, true);
  try { chrome.runtime.onMessage.addListener(onMessage); } catch {}
  try { chrome.storage.onChanged.addListener(onStorage); } catch {}
  const api = { alive, dispose, toggle: (raw) => toggle(raw) };
  window.__codexTranslate = api;
})();
