(function () {
  "use strict";

  const TIMESTAMP_KEY_SUFFIX = "_at";
  const TIMESTAMP_KEY_EXACT = new Set(
    [
      "date", 
      "timestamp", 
      "ts", 
      "time", 
      "created", 
      "updated", 
      "sent_at", 
      "received_at"
    ]);

  // Raw token / alias → epoch ms (annotations built at inject time so relative stays fresh)
  const timestampMap = new Map();

  // prospect display token → detail URL (see collectProspectLinks)
  const prospectLinkMap = new Map();

  // ── Timestamp helpers ────────────────────────────────────────────────────

  function isLikelyMsEpoch(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
    if (n < 1e12 || n > 1e14) return false;
    return !Number.isNaN(new Date(n).getTime());
  }

  /** Epoch ms from a JSON value (number or hybrid string like "1779075713812--Monday, …"). */
  function parseEpochMsFromValue(v) {
    if (typeof v === "number" && isLikelyMsEpoch(v)) return v;
    if (typeof v === "string") {
      const m = v.match(/^(\d{12,14})\b/);
      if (!m) return null;
      const n = Number(m[1]);
      return isLikelyMsEpoch(n) ? n : null;
    }
    return null;
  }

  /** Epoch ms from text as rendered in the DOM (quotes / comma / composite suffix). */
  function extractEpochMsFromDomText(raw) {
    let s = String(raw || "").trim().replace(/,$/, "");
    s = s.replace(/^["']|["']$/g, "").trim().replace(/,$/, "");
    if (!s) return null;
    const m = s.match(/^(\d{12,14})\b/);
    if (!m) return null;
    const n = Number(m[1]);
    return isLikelyMsEpoch(n) ? n : null;
  }

  const FMT_DATE = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  const FMT_TIME = { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true };

  function formatInZone(ms, timeZone) {
    const d = new Date(ms);
    const datePart = d.toLocaleDateString("en-US", { ...FMT_DATE, timeZone });
    const timePart = d.toLocaleTimeString("en-US", { ...FMT_TIME, timeZone });
    return `${datePart} at ${timePart}`;
  }

  /** Relative time from event → now (past-oriented labels). */
  function formatRelativeAgo(ms) {
    const now = Date.now();
    const diffMs = now - ms;
    const future = diffMs < 0;
    const absSec = Math.abs(diffMs) / 1000;
    const absMin = absSec / 60;
    const absHr = absMin / 60;
    const absDay = absHr / 24;

    function pastLabel() {
      if (absSec < 5) return "just a second ago";
      if (absSec < 60) {
        const s = Math.floor(absSec);
        return s === 1 ? "1 second ago" : `${s} seconds ago`;
      }
      if (absMin < 60) {
        const m = Math.floor(absMin);
        return m === 1 ? "a minute ago" : `${m} minutes ago`;
      }
      if (absHr < 24) {
        const h = Math.floor(absHr);
        return h === 1 ? "1 hour ago" : `${h} hours ago`;
      }
      const d = Math.floor(absDay);
      if (d < 7) return d === 1 ? "1 day ago" : `${d} days ago`;
      const w = Math.floor(d / 7);
      if (w < 5) return w === 1 ? "1 week ago" : `${w} weeks ago`;
      const mo = Math.floor(d / 30);
      if (mo < 12) return mo === 1 ? "1 month ago" : `${mo} months ago`;
      const y = Math.floor(d / 365);
      return y === 1 ? "1 year ago" : `${y} years ago`;
    }

    function futureLabel() {
      if (absSec < 5) return "in just a second";
      if (absSec < 60) {
        const s = Math.ceil(absSec);
        return s === 1 ? "in 1 second" : `in ${s} seconds`;
      }
      if (absMin < 60) {
        const m = Math.ceil(absMin);
        return m === 1 ? "in a minute" : `in ${m} minutes`;
      }
      if (absHr < 24) {
        const h = Math.ceil(absHr);
        return h === 1 ? "in 1 hour" : `in ${h} hours`;
      }
      const d = Math.ceil(absDay);
      if (d < 7) return d === 1 ? "in 1 day" : `in ${d} days`;
      const w = Math.ceil(d / 7);
      if (w < 5) return w === 1 ? "in 1 week" : `in ${w} weeks`;
      const mo = Math.ceil(d / 30);
      if (mo < 12) return mo === 1 ? "in 1 month" : `in ${mo} months`;
      const y = Math.ceil(d / 365);
      return y === 1 ? "in 1 year" : `in ${y} years`;
    }

    return future ? futureLabel() : pastLabel();
  }

  function registerTimestamp(ms, rawAliases) {
    timestampMap.set(String(ms), ms);
    if (typeof rawAliases === "string") timestampMap.set(rawAliases, ms);
    else if (Array.isArray(rawAliases))
      rawAliases.forEach((a) => timestampMap.set(String(a), ms));
  }

  function formatAnnotation(ms) {
    const relative = `🕐 ${formatRelativeAgo(ms)}`;
    return {
      utc: `⏱️ ${formatInZone(ms, "UTC")}`,
      bdt: `🇧🇩 ${formatInZone(ms, "Asia/Dhaka")}`,
      relative,
    };
  }

  function collectTimestamps(obj) {
    if (Array.isArray(obj)) {
      obj.forEach((item) => collectTimestamps(item));
    } else if (obj !== null && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (
          typeof k === "string" &&
          (k.endsWith(TIMESTAMP_KEY_SUFFIX) || TIMESTAMP_KEY_EXACT.has(k.toLowerCase()))
        ) {
          const ms = parseEpochMsFromValue(v);
          if (ms !== null) {
            const aliases = [];
            if (typeof v === "string") aliases.push(v.trim());
            registerTimestamp(ms, aliases.length ? aliases : undefined);
          }
        }
        collectTimestamps(v);
      }
    }
  }

  function resolveWorkspaceForProspect(prospectId, parentObj) {
    const m = prospectId.match(/^(\d+)_/);
    if (m) return m[1];
    const w = parentObj?.workspace_id;
    if (typeof w === "number" && Number.isFinite(w)) return String(Math.trunc(w));
    if (typeof w === "string" && /^\d+$/.test(w.trim())) return w.trim();
    return null;
  }

  function registerProspectLinkTokens(prospectId, href) {
    const id = prospectId.trim();
    prospectLinkMap.set(id, href);
    prospectLinkMap.set(`"${id}"`, href);
    prospectLinkMap.set(`'${id}'`, href);
  }

  function collectProspectLinks(obj) {
    if (Array.isArray(obj)) {
      obj.forEach((item) => collectProspectLinks(item));
    } else if (obj !== null && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (
          typeof k === "string" &&
          k.toLowerCase() === "prospect_id" &&
          typeof v === "string" &&
          v.trim()
        ) {
          const id = v.trim();
          const ws = resolveWorkspaceForProspect(id, obj);
          if (ws) {
            const href = `${location.protocol}//${location.host}/${ws}_prospects?_id=${encodeURIComponent(id)}`;
            registerProspectLinkTokens(id, href);
          }
        }
        collectProspectLinks(v);
      }
    }
  }

  // ── DOM injection ────────────────────────────────────────────────────────

  function makeAnnotationSpan({ utc, bdt, relative }) {
    const wrapper = document.createElement("span");
    wrapper.className = "midb-ts-comment";

    const relSpan = document.createElement("span");
    relSpan.className = "midb-ts-relative";
    relSpan.textContent = relative;

    const sep1 = document.createTextNode("  ");

    const bdtSpan = document.createElement("span");
    bdtSpan.className = "midb-ts-bdt";
    bdtSpan.textContent = bdt;

    const sep2 = document.createTextNode("  ");

    const utcSpan = document.createElement("span");
    utcSpan.className = "midb-ts-utc";
    utcSpan.textContent = utc;

    wrapper.appendChild(relSpan);
    wrapper.appendChild(sep1);
    wrapper.appendChild(bdtSpan);
    wrapper.appendChild(sep2);
    wrapper.appendChild(utcSpan);
    return wrapper;
  }

  function epochMsForDomText(raw) {
    const trimmed = String(raw || "").trim().replace(/,$/, "");
    if (timestampMap.has(trimmed)) return timestampMap.get(trimmed);
    const stripped = trimmed.replace(/^["']|["']$/g, "").trim().replace(/,$/, "");
    if (stripped !== trimmed && timestampMap.has(stripped))
      return timestampMap.get(stripped);
    const extracted = extractEpochMsFromDomText(trimmed);
    if (extracted !== null && timestampMap.has(String(extracted)))
      return timestampMap.get(String(extracted));
    return null;
  }

  /**
   * One text node ends with comma: `"1779029700000,"` → digits node + comma (+ rest).
   */
  function splitTimestampDigitsFromCommaTail(node, ms) {
    const parent = node.parentNode;
    if (!parent) return node;

    const full = node.textContent;
    const m = full.match(/^(\s*)(\d{12,14})(\s*,)(\s*)([\s\S]*)$/);
    if (!m) return node;

    const digits = m[2];
    if (!isLikelyMsEpoch(Number(digits)) || Number(digits) !== ms) return node;

    const head = document.createTextNode(`${m[1]}${digits}`);
    const comma = document.createTextNode(`${m[3]}${m[4]}`);
    const rest = m[5] ? document.createTextNode(m[5]) : null;

    parent.replaceChild(head, node);
    parent.insertBefore(comma, head.nextSibling);
    if (rest) parent.insertBefore(rest, comma.nextSibling);
    return head;
  }

  /** Insert annotations between epoch digits and the JSON comma — handles one-node (`177...,`), text sibling `,`, or element sibling used as comma. */
  function insertTimestampAnnotation(insertAfter, ms) {
    const parent = insertAfter.parentNode;
    if (!parent) return;

    const span = makeAnnotationSpan(formatAnnotation(ms));
    const ns = insertAfter.nextSibling;

    function elementLooksLikeComma(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      const t = el.textContent.replace(/\u00a0/g, " ").trim();
      return t === "," || /^,\s*$/.test(t);
    }

    // JSON viewers sometimes wrap punctuation in an element sibling.
    if (ns && elementLooksLikeComma(ns)) {
      parent.insertBefore(span, ns);
      return;
    }

    // Comma already isolated (e.g. after splitTimestampDigitsFromCommaTail): digits , …
    if (ns && ns.nodeType === Node.TEXT_NODE && /^\s*,\s*$/.test(ns.textContent)) {
      parent.insertBefore(span, ns);
      return;
    }

    // Shared sibling: ", rest..." → digits | annot | comma | rest
    if (ns && ns.nodeType === Node.TEXT_NODE) {
      const m = ns.textContent.match(/^(\s*,)(\s*)([\s\S]*)$/);
      if (m) {
        const commaOnly = document.createTextNode(m[1] + m[2]);

        parent.insertBefore(span, ns);
        parent.insertBefore(commaOnly, ns);

        if (m[3]) ns.textContent = m[3];
        else parent.removeChild(ns);
        return;
      }
    }

    if (insertAfter.nextSibling) parent.insertBefore(span, insertAfter.nextSibling);
    else parent.appendChild(span);
  }

  function injectAnnotations() {
    if (timestampMap.size === 0) return;
    // Skip if we've already annotated this render
    if (document.querySelector(".midb-ts-comment")) return;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          // Skip our own injected spans
          if (
            node.parentElement &&
            node.parentElement.classList.contains("midb-ts-comment")
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          if (
            node.parentElement &&
            node.parentElement.closest(".midb-prospect-link")
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.textContent.trim();
      const ms = epochMsForDomText(raw);
      if (ms !== null) hits.push({ node, ms });
    }

    for (const { node, ms } of hits) {
      const digitsNode = splitTimestampDigitsFromCommaTail(node, ms);
      insertTimestampAnnotation(digitsNode, ms);
    }
  }

  function hrefForProspectDomText(raw) {
    const trimmed = String(raw || "").trim().replace(/,$/, "");
    if (prospectLinkMap.has(trimmed)) return prospectLinkMap.get(trimmed);
    const stripped = trimmed.replace(/^["']|["']$/g, "").trim().replace(/,$/, "");
    if (prospectLinkMap.has(stripped)) return prospectLinkMap.get(stripped);
    return null;
  }

  function injectProspectLinks() {
    if (document.querySelector(".midb-prospect-link")) return;
    if (prospectLinkMap.size === 0) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(".midb-ts-comment, .midb-prospect-link"))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
      const href = hrefForProspectDomText(node.textContent);
      if (href) hits.push({ node, href });
    }

    for (const { node, href } of hits) {
      const parent = node.parentNode;
      if (!parent) continue;
      const a = document.createElement("a");
      a.className = "midb-prospect-link";
      a.href = href;
      a.textContent = node.textContent;
      parent.replaceChild(a, node);
    }
  }

  // ── Raw JSON capture ─────────────────────────────────────────────────────

  function getRawText() {
    const pres = document.querySelectorAll("body > pre, body pre");
    for (const pre of pres) {
      if (
        pre.childNodes.length === 1 &&
        pre.firstChild &&
        pre.firstChild.nodeType === Node.TEXT_NODE
      ) {
        const t = pre.textContent || "";
        const tr = t.replace(/^\uFEFF/, "").trim();
        if (tr.startsWith("{") || tr.startsWith("[")) return t;
      }
    }
    const preFirst = document.querySelector("body > pre");
    if (
      preFirst &&
      preFirst.childNodes.length === 1 &&
      preFirst.firstChild &&
      preFirst.firstChild.nodeType === Node.TEXT_NODE
    ) {
      return preFirst.textContent || "";
    }
    return (document.body?.innerText || document.body?.textContent || "").trim();
  }

  function tryParseJson(text) {
    const t = (text || "").replace(/^\uFEFF/, "").trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  function setup(rawText) {
    const data = tryParseJson(rawText);
    if (!data) return;

    collectTimestamps(data);
    collectProspectLinks(data);
    if (timestampMap.size === 0 && prospectLinkMap.size === 0) return;

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        injectProspectLinks();
        injectAnnotations();
      }, 400);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    injectProspectLinks();
    injectAnnotations();
  }

  function main() {
    const raw = getRawText();
    if (raw) {
      setup(raw);
      return;
    }

    // Body not ready yet — wait for it then capture before any formatter runs
    const bodyObserver = new MutationObserver(() => {
      const pres = document.querySelectorAll("body pre");
      for (const pre of pres) {
        if (
          pre.childNodes.length === 1 &&
          pre.firstChild &&
          pre.firstChild.nodeType === Node.TEXT_NODE
        ) {
          const tr = (pre.textContent || "").replace(/^\uFEFF/, "").trim();
          if (tr.startsWith("{") || tr.startsWith("[")) {
            bodyObserver.disconnect();
            setup(pre.textContent || "");
            return;
          }
        }
      }
    });
    bodyObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // Run as early as possible so we can read the raw <pre> text
  if (document.readyState === "loading") {
    // document_start: DOM not parsed yet
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
