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

  function injectAnnotations() {
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
      const parent = node.parentNode;
      if (!parent) continue;
      const span = makeAnnotationSpan(formatAnnotation(ms));
      // Insert immediately after the text node
      if (node.nextSibling) {
        parent.insertBefore(span, node.nextSibling);
      } else {
        parent.appendChild(span);
      }
    }
  }

  // ── Raw JSON capture ─────────────────────────────────────────────────────

  function getRawText() {
    const pre = document.querySelector("body > pre");
    if (
      pre &&
      pre.childNodes.length === 1 &&
      pre.firstChild &&
      pre.firstChild.nodeType === Node.TEXT_NODE
    ) {
      return pre.textContent || "";
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
    if (timestampMap.size === 0) return;

    // Watch for JSON Viewer Pro (or any formatter) to finish rendering,
    // then inject our annotations. Debounce so we only run once after
    // the DOM settles.
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        injectAnnotations();
      }, 400);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Also try immediately in case the formatter already ran
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
      const pre = document.querySelector("body > pre");
      if (pre) {
        bodyObserver.disconnect();
        setup(pre.textContent || "");
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
