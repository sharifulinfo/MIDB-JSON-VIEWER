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

  // Known JSON string forms → { field, copyText, href?, filterHref? } (see collectMidbFieldLinks)
  const midbFieldLinkMap = new Map();

  /** Elasticsearch `_index` for prospect filter URLs (captureElasticsearchIndex). */
  let midbElasticsearchIndex = null;

  /**
   * Extra keys: copy + index filter only (no entity “open” link). Append more names here later.
   * Matching is case-insensitive on JSON keys.
   */
  const MIDB_EXTRA_COPY_FILTER_FIELDS = [
    "sent",
    "seen",
    "user_id",
    "type",
    "source",
    "email_id",
    "status",
    "sycn_status",
    "label_id",
    "trigger_type",
    "trigger_value",
    "label_delay",
    "workflow_id",
    "webhook_id",
  ];

  const MIDB_EXTRA_COPY_FILTER_KEYS = new Set(
    MIDB_EXTRA_COPY_FILTER_FIELDS.map((name) => name.toLowerCase()),
  );

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

  function resolveWorkspaceFromIdAndParent(entityId, parentObj) {
    const m = String(entityId).match(/^(\d+)_/);
    if (m) return m[1];
    const w = parentObj?.workspace_id;
    if (typeof w === "number" && Number.isFinite(w)) return String(Math.trunc(w));
    if (typeof w === "string" && /^\d+$/.test(w.trim())) return w.trim();
    return null;
  }

  function originBase() {
    return `${location.protocol}//${location.host}`;
  }

  function extractElasticsearchIndex(data) {
    if (data === null || typeof data !== "object") return null;

    if (Array.isArray(data)) {
      for (const item of data) {
        const x = extractElasticsearchIndex(item);
        if (x) return x;
      }
      return null;
    }

    if (typeof data._index === "string") {
      const t = data._index.trim();
      if (t) return t;
    }

    const hits = data.hits?.hits;
    if (Array.isArray(hits)) {
      for (const h of hits) {
        if (h && typeof h === "object" && typeof h._index === "string" && h._index.trim())
          return h._index.trim();
      }
    }

    return null;
  }

  function captureElasticsearchIndex(data) {
    midbElasticsearchIndex = extractElasticsearchIndex(data);
  }

  function normalizeMidbLinkValue(v) {
    if (v == null) return null;
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
    if (typeof v === "string" && v.trim()) return v.trim();
    return null;
  }

  function hrefWsScopedEntity(entityId, parentObj, pathSegment) {
    const id = normalizeMidbLinkValue(entityId);
    if (!id) return null;
    const ws = resolveWorkspaceFromIdAndParent(id, parentObj);
    if (!ws) return null;
    return `${originBase()}/${ws}_${pathSegment}?_id=${encodeURIComponent(id)}`;
  }

  function registerMidbLinkTokens(displayValue, entry) {
    const id = String(displayValue).trim();
    midbFieldLinkMap.set(id, entry);
    midbFieldLinkMap.set(`"${id}"`, entry);
    midbFieldLinkMap.set(`'${id}'`, entry);
  }

  /** `{origin}/{_index}?{field}=…` when `_index` was captured from the payload. */
  const MIDB_ES_FILTER_FIELDS = new Set([
    "prospect_id",
    "mailbox_id",
    "workspace_id",
    "channel_id",
    ...MIDB_EXTRA_COPY_FILTER_KEYS,
  ]);

  function elasticsearchIndexFilterHref(fieldKey, normalizedId) {
    if (!MIDB_ES_FILTER_FIELDS.has(fieldKey)) return null;
    if (
      typeof midbElasticsearchIndex !== "string" ||
      !/^[\w.-]+$/.test(midbElasticsearchIndex)
    )
      return null;
    return `${originBase()}/${midbElasticsearchIndex}?${fieldKey}=${encodeURIComponent(
      normalizedId,
    )}`;
  }

  /** `/{index}?_id=` using the hit's `_index`, else the `_index` captured from the payload. */
  function elasticsearchHitDocOpenUrl(hitObj, normalizedDocId) {
    if (!normalizedDocId) return null;
    const fromHit =
      typeof hitObj._index === "string" && /^[\w.-]+$/.test(hitObj._index.trim())
        ? hitObj._index.trim()
        : null;
    const fallback =
      typeof midbElasticsearchIndex === "string" &&
      /^[\w.-]+$/.test(midbElasticsearchIndex)
        ? midbElasticsearchIndex
        : null;
    const idx = fromHit || fallback;
    if (!idx) return null;
    return `${originBase()}/${idx}?_id=${encodeURIComponent(normalizedDocId)}`;
  }

  /** True when `_index` names a MIDB prospect Elasticsearch index (`441_prospects`, …). */
  function hitIndexLooksLikeProspects(hitObj) {
    const fromHit =
      typeof hitObj._index === "string" ? hitObj._index.trim().toLowerCase() : "";
    if (fromHit) {
      return (
        /^[\w.-]+$/.test(fromHit) &&
        (fromHit === "prospects" || fromHit.endsWith("_prospects"))
      );
    }
    const global =
      typeof midbElasticsearchIndex === "string"
        ? midbElasticsearchIndex.trim().toLowerCase()
        : "";
    return (
      global &&
      /^[\w.-]+$/.test(global) &&
      (global === "prospects" || global.endsWith("_prospects"))
    );
  }

  /** Extra MIDB tabs (workflow / webhook / labeling) — used for `prospect_id` and for ES `_id` on `*_prospects` indexes. */
  function prospectMidbJobLinks(normalizedProspectId) {
    const qp = encodeURIComponent(normalizedProspectId);
    const b = originBase();
    return [
      {
        href: `${b}/workflow_jobs?prospect_id=${qp}`,
        tooltip: "Workflow job — MIDB workflow_jobs for this prospect_id",
        className: "midb-json-act-prospect-job midb-json-act-prospect-job-workflow",
      },
      {
        href: `${b}/webhook_jobs?prospect_id=${qp}`,
        tooltip: "Webhook job — MIDB webhook_jobs for this prospect_id",
        className: "midb-json-act-prospect-job midb-json-act-prospect-job-webhook",
      },
      {
        href: `${b}/labeling_logs?prospect_id=${qp}`,
        tooltip: "Labeling job — MIDB labeling_logs for this prospect_id",
        className: "midb-json-act-prospect-job midb-json-act-prospect-job-labeling",
      },
    ];
  }

  function collectMidbFieldLinks(obj) {
    if (Array.isArray(obj)) {
      obj.forEach((item) => collectMidbFieldLinks(item));
    } else if (obj !== null && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof k === "string") {
          const key = k.toLowerCase();
          const normalized = normalizeMidbLinkValue(v);

          let href = null;
          if (normalized) {
            if (key === "prospect_id") {
              href = hrefWsScopedEntity(v, obj, "prospects");
              const filterHref = elasticsearchIndexFilterHref(key, normalized);
              const payload = {
                field: key,
                copyText: normalized,
                prospectJobLinks: prospectMidbJobLinks(normalized),
              };
              if (href) payload.href = href;
              if (filterHref) payload.filterHref = filterHref;
              registerMidbLinkTokens(normalized, payload);
            } else if (key === "mailbox_id") href = hrefWsScopedEntity(v, obj, "mailbox");
            else if (key === "workspace_id")
              href = `${originBase()}/ws_metadata?_id=${encodeURIComponent(normalized)}`;
            else if (key === "channel_id")
              href = `${originBase()}/channels?_id=${encodeURIComponent(normalized)}`;

            if (href && key !== "prospect_id") {
              const filterHref = elasticsearchIndexFilterHref(key, normalized);
              const payload = { href, field: key, copyText: normalized };
              if (filterHref) payload.filterHref = filterHref;
              registerMidbLinkTokens(normalized, payload);
            }
          }

          if (key === "_id" && normalized) {
            const docUrl = elasticsearchHitDocOpenUrl(obj, normalized);
            const payload = {
              field: "_id",
              copyText: normalized,
            };
            if (docUrl) {
              payload.href = docUrl;
              payload.filterHref = docUrl;
            }
            if (hitIndexLooksLikeProspects(obj)) {
              payload.prospectJobLinks = prospectMidbJobLinks(normalized);
            }
            registerMidbLinkTokens(normalized, payload);
          } else if (!href && MIDB_EXTRA_COPY_FILTER_KEYS.has(key) && normalized) {
            const filterHref = elasticsearchIndexFilterHref(key, normalized);
            const payload = { field: key, copyText: normalized };
            if (filterHref) payload.filterHref = filterHref;
            registerMidbLinkTokens(normalized, payload);
          }
        }
        collectMidbFieldLinks(v);
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
            node.parentElement.closest(".midb-json-inline, a.midb-json-link")
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

  function midbLinkEntryForDomText(raw) {
    const trimmed = String(raw || "").trim().replace(/,$/, "");
    if (midbFieldLinkMap.has(trimmed)) return midbFieldLinkMap.get(trimmed);
    const stripped = trimmed.replace(/^["']|["']$/g, "").trim().replace(/,$/, "");
    if (midbFieldLinkMap.has(stripped)) return midbFieldLinkMap.get(stripped);
    return null;
  }

  function copyStringToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() =>
        copyStringToClipboardExec(text),
      );
      return;
    }
    copyStringToClipboardExec(text);
  }

  function copyStringToClipboardExec(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
  }

  /** Shared “open in new tab” glyph for toolbar links */
  const MIDB_EXTERNAL_LINK_PATH =
    "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7ZM14 3h7v7h2V3h-9v2Zm-1.83 11.83 1.41 1.41L19 6.41V10h2V3h-7v2h3.59Z";

  /** Fixed 14×14 SVGs — avoids emoji/font metrics jitter next to padded JSON strings. */
  function appendMidbToolbarSvg(parent, pathD, viewBox) {
    const vb = viewBox || "0 0 24 24";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", vb);
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", pathD);
    svg.appendChild(p);
    parent.appendChild(svg);
  }

  /** Copy + optional open link + optional index filter (`href` / `filterHref` omitted when not applicable). */
  function midbFieldActionBar(entry) {
    const acts = document.createElement("span");
    acts.className = "midb-json-actions";

    const kindLabel =
      entry.field === "_id" ? "document _id" : entry.field.replace(/_/g, " ");
    const copyLabel = `Copy ${kindLabel}`;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "midb-json-act midb-json-act-copy";
    copyBtn.title = copyLabel;
    copyBtn.setAttribute("aria-label", copyLabel);
    appendMidbToolbarSvg(
      copyBtn,
      "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z",
    );
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof entry.copyText === "string" && entry.copyText)
        copyStringToClipboard(entry.copyText);
    });

    acts.appendChild(copyBtn);
    let btnCount = 1;

    const hasOpen = typeof entry.href === "string" && entry.href;
    if (hasOpen) {
      btnCount++;
      const openLabel = `Open ${kindLabel}`;
      const openA = document.createElement("a");
      openA.className = "midb-json-act midb-json-act-open";
      openA.href = entry.href;
      openA.title = openLabel;
      openA.setAttribute("aria-label", openLabel);
      appendMidbToolbarSvg(
        openA,
        MIDB_EXTERNAL_LINK_PATH,
      );
      acts.appendChild(openA);
    }

    const hasFilter = typeof entry.filterHref === "string" && entry.filterHref;
    if (hasFilter) {
      btnCount++;
      const filterLabel =
        entry.field === "_id"
          ? "Filter this index by document _id"
          : `Filter index by ${kindLabel}`;
      const filterA = document.createElement("a");
      filterA.className = "midb-json-act midb-json-act-filter";
      filterA.href = entry.filterHref;
      filterA.title = filterLabel;
      filterA.setAttribute("aria-label", filterLabel);
      appendMidbToolbarSvg(
        filterA,
        "M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0C8.01 14 6 11.99 6 9.5S8.01 5 10.5 5 15 7.01 15 9.5 12.99 14 10.5 14Z",
      );
      acts.appendChild(filterA);
    }

    const jobLinks = Array.isArray(entry.prospectJobLinks) ? entry.prospectJobLinks : [];
    for (const job of jobLinks) {
      if (job && typeof job.href === "string" && job.href) {
        btnCount++;
        const jobA = document.createElement("a");
        jobA.className = `midb-json-act ${job.className || "midb-json-act-prospect-job"}`;
        jobA.href = job.href;
        const tip =
          typeof job.tooltip === "string" && job.tooltip
            ? job.tooltip
            : "Open related MIDB page for this prospect";
        jobA.title = tip;
        jobA.setAttribute("aria-label", tip);
        appendMidbToolbarSvg(jobA, MIDB_EXTERNAL_LINK_PATH);
        acts.appendChild(jobA);
      }
    }

    acts.classList.add(`midb-json-actions--count-${btnCount}`);
    return acts;
  }

  /**
   * One text node `"id", …` split so `"` wrappers stay inside the syntax string span,
   * and action icons become siblings AFTER that span (not inside quoted text).
   */
  function splitJsonQuotedScalarOneNode(text) {
    const m = String(text).match(
      /^(\s*)(["'`\u201c\u201d])((?:[^"'`\\\u201c\u201d]|\\.)*)(["'`\u201c\u201d])([\s\S]*)$/,
    );
    if (!m) return null;
    return {
      outerLead: m[1],
      openQuote: m[2],
      inner: m[3],
      closeQuote: m[4],
      afterQuotes: m[5],
    };
  }

  /** Stable class/id string for JSON highlighters — `element.className` is not always a JS string (SVG etc.). */
  function elementHaystack(el) {
    if (!el) return "";
    if (typeof el.className === "string") return el.className + " " + (el.id || "");
    try {
      if (el instanceof SVGElement && el.className && el.className.baseVal !== undefined)
        return el.className.baseVal + " " + (el.id || "");
    } catch (_) {}
    const c = el.getAttribute("class") || el.getAttribute("className") || "";
    return c + " " + (el.id || "");
  }

  /**
   * First (innermost) ancestor that looks like a *value* JSON string wrapper.
   * If class detection fails midb stays on immediate parent — glue wrap still lifts icons logically.
   */
  function innermostJsonStringHueWrapper(textNode) {
    const RX =
      /\bhljs-string\b|\bhljs-literal\b|\bhljs-addition\b|\bmonaco-token-string\b|StringLiteral|string-literal|jsonformatterstring|json-formatter-string|json-formatter-row-value|formatter-string|--json-|objectBox-string|StringItem|mtk\d+\b|string-value|ace_string|string\b/i;

    let el = textNode.parentElement;
    while (el && el !== document.documentElement) {
      if (RX.test(elementHaystack(el))) return el;
      el = el.parentElement;
    }
    return textNode.parentElement;
  }

  function injectMidbFieldLinks() {
    if (document.querySelector(".midb-json-inline, a.midb-json-link")) return;
    if (midbFieldLinkMap.size === 0) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(".midb-ts-comment, .midb-json-inline, a.midb-json-link"))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
      const entry = midbLinkEntryForDomText(node.textContent);
      if (entry) hits.push({ node, entry });
    }

    for (const { node, entry } of hits) {
      const parent = node.parentNode;
      if (!parent) continue;
      if (node.parentElement && node.parentElement.closest(".midb-json-inline, a.midb-json-link"))
        continue;

      const showFieldToolbar = typeof entry.copyText === "string" && Boolean(entry.copyText);

      if (showFieldToolbar) {
        const replaceParent = parent;
        const tintShell = innermostJsonStringHueWrapper(node);
        const acts = midbFieldActionBar(entry);

        const q = splitJsonQuotedScalarOneNode(node.textContent);
        const parsedMatchesCopy =
          q &&
          typeof entry.copyText === "string" &&
          entry.copyText === q.inner.trim();

        if (parsedMatchesCopy) {
          const frag = document.createDocumentFragment();
          frag.appendChild(document.createTextNode(`${q.outerLead}${q.openQuote}`));
          const valSpanEl = document.createElement("span");
          valSpanEl.className = "midb-json-value";
          valSpanEl.textContent = q.inner;
          frag.appendChild(valSpanEl);
          frag.appendChild(document.createTextNode(`${q.closeQuote}${q.afterQuotes}`));
          replaceParent.replaceChild(frag, node);
        } else {
          const valFallback = document.createElement("span");
          valFallback.className = "midb-json-value";
          valFallback.textContent = node.textContent;
          replaceParent.replaceChild(valFallback, node);
        }

        const glueParent = tintShell.parentNode;
        const glue = document.createElement("span");
        glue.className = "midb-json-inline";
        glue.setAttribute("data-midb-field", entry.field);

        if (glueParent) {
          glueParent.insertBefore(glue, tintShell);
          glue.appendChild(tintShell);
          glue.appendChild(acts);
        } else {
          acts.classList.add("midb-json-actions-fallback");
          tintShell.appendChild(acts);
        }
        continue;
      }

      if (typeof entry.href === "string" && entry.href) {
        const a = document.createElement("a");
        a.className = "midb-json-link";
        a.setAttribute("data-midb-field", entry.field);
        a.href = entry.href;
        const label = `Open ${entry.field.replace(/_/g, " ")}`;
        a.title = label;
        a.setAttribute("aria-label", label);
        a.textContent = node.textContent;
        parent.replaceChild(a, node);
      }
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
    captureElasticsearchIndex(data);
    collectMidbFieldLinks(data);
    if (timestampMap.size === 0 && midbFieldLinkMap.size === 0) return;

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        injectMidbFieldLinks();
        injectAnnotations();
      }, 400);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    injectMidbFieldLinks();
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
