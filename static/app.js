// polymarket-agent dashboard — client glue.
//
// Responsibilities (M7 cut):
//   * Theme store (Alpine) + localStorage persistence + <html class>.
//   * ECharts bootstrap for bankroll line, refusals bar, settlements 7d W/L,
//     with disposal/re-init across partial swaps.
//   * Sortable client-side table for the open book.
//   * Number-flash on SSE deltas: pre-swap text content is captured per
//     [data-flash-target]; if the post-swap text changed, a 200ms tint
//     class lands on the new node. Tone is read from data-tone="profit"
//     /"loss" when set, else inferred from the parsed numeric delta, and
//     defaults to neutral.
//   * SSE wiring: one EventSource per tab. Listens to the eight named
//     events the server emits (bankroll, strategies, open_book,
//     llm_activity, refusals, settlements, decisions_appended,
//     markets_watchlist) and refreshes the corresponding partials by
//     fetching /api/sections/<name> and swapping innerHTML. Partial
//     swaps re-init Alpine subtrees and re-render charts so SSE events
//     never break Open Book sorting or Watchlist filtering. Reconnects
//     on disconnect with backoff 1s -> 2s -> 5s -> 10s.

(function () {
  "use strict";

  const THEME_KEY = "polymarket-agent.theme";

  // --- theme store (Alpine.js) -------------------------------------------
  document.addEventListener("alpine:init", () => {
    if (typeof Alpine === "undefined") return;
    Alpine.store("theme", {
      value: localStorage.getItem(THEME_KEY) || "dark",
      get label() {
        return this.value === "dark" ? "light mode" : "dark mode";
      },
      toggle() {
        this.value = this.value === "dark" ? "light" : "dark";
        localStorage.setItem(THEME_KEY, this.value);
        document.documentElement.classList.remove("dark", "light");
        document.documentElement.classList.add(this.value);
        document.documentElement.dataset.theme = this.value;
      },
      init() {
        document.documentElement.classList.remove("dark", "light");
        document.documentElement.classList.add(this.value);
      },
    });

    // Sortable client-side table. Each <tr> declares per-column sort
    // values via data-sort-<col> attributes (e.g. data-sort-mark="0.62").
    // Numeric columns emit raw numbers; an empty string means "no value"
    // and always sorts to the bottom regardless of direction so a "—"
    // cell never displaces a real number. The dataset lookup uses the
    // browser's automatic camelCase mapping (data-sort-cost-basis →
    // dataset.sortCostBasis), so the JS key passed to sortBy() is the
    // hyphen-joined column slug.
    function _datasetKey(slug) {
      return (
        "sort" +
        slug.replace(/(^|-)([a-z])/g, (_, _sep, ch) => ch.toUpperCase())
      );
    }
    Alpine.data("sortableTable", () => ({
      sortKey: null,
      sortDir: 1,
      sortBy(key) {
        if (this.sortKey === key) {
          this.sortDir = -this.sortDir;
        } else {
          this.sortKey = key;
          this.sortDir = -1;
        }
        const tbody = this.$el.querySelector("tbody");
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll("tr"));
        const dsKey = _datasetKey(key);
        const dir = this.sortDir;
        rows.sort((a, b) => {
          const av = a.dataset[dsKey];
          const bv = b.dataset[dsKey];
          const aMissing = av === undefined || av === "";
          const bMissing = bv === undefined || bv === "";
          if (aMissing && bMissing) return 0;
          if (aMissing) return 1; // missing always sorts last
          if (bMissing) return -1;
          const an = parseFloat(av);
          const bn = parseFloat(bv);
          if (!Number.isNaN(an) && !Number.isNaN(bn)) {
            return (an - bn) * dir;
          }
          return av.localeCompare(bv) * dir;
        });
        rows.forEach((r) => tbody.appendChild(r));
      },
    }));
  });

  // --- ECharts helpers ---------------------------------------------------
  const charts = new Map();

  function readPayload(name) {
    const node = document.querySelector(
      `script[data-chart-payload="${name}"]`,
    );
    if (!node) return null;
    try {
      return JSON.parse(node.textContent);
    } catch (e) {
      console.warn("dashboard: bad chart payload", name, e);
      return null;
    }
  }

  function ensureChart(name) {
    if (typeof echarts === "undefined") return null;
    const el = document.querySelector(`[data-chart="${name}"]`);
    if (!el) return null;
    let chart = charts.get(name);
    if (chart && chart.getDom() !== el) {
      chart.dispose();
      chart = null;
    }
    if (!chart) {
      chart = echarts.init(el, null, { renderer: "canvas" });
      charts.set(name, chart);
    }
    return chart;
  }

  function chartTextColor() {
    const dark = document.documentElement.classList.contains("dark");
    return dark ? "#a1a1aa" : "#52525b";
  }

  function bankrollOption(points) {
    const color = chartTextColor();
    return {
      grid: { left: 40, right: 8, top: 8, bottom: 24 },
      xAxis: {
        type: "category",
        data: (points || []).map((p) => p.ts),
        axisLine: { lineStyle: { color: "#3f3f46" } },
        axisLabel: { color, fontSize: 10, formatter: (v) => v.slice(11, 16) },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: "rgba(120,120,120,0.15)" } },
        axisLabel: { color, fontSize: 10 },
      },
      series: [
        {
          type: "line",
          showSymbol: false,
          smooth: false,
          lineStyle: { width: 1.5, color: "#fbbf24" },
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(251,191,36,0.18)" },
                { offset: 1, color: "rgba(251,191,36,0)" },
              ],
            },
          },
          data: (points || []).map((p) => p.balance_usd),
        },
      ],
      tooltip: { trigger: "axis", confine: true },
    };
  }

  function refusalsOption(rows) {
    const color = chartTextColor();
    const top = (rows || []).slice(0, 8);
    return {
      grid: { left: 110, right: 8, top: 8, bottom: 24 },
      xAxis: {
        type: "value",
        axisLabel: { color, fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(120,120,120,0.15)" } },
      },
      yAxis: {
        type: "category",
        data: top.map((r) => r.reason_code).reverse(),
        axisLabel: { color, fontSize: 10 },
        axisLine: { lineStyle: { color: "#3f3f46" } },
      },
      series: [
        {
          type: "bar",
          data: top.map((r) => r.count).reverse(),
          itemStyle: { color: "#f43f5e" },
          barWidth: 12,
        },
      ],
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    };
  }

  function settlementsOption(buckets) {
    const color = chartTextColor();
    const dates = (buckets || []).map((b) => b.date.slice(5));
    return {
      grid: { left: 28, right: 8, top: 8, bottom: 24 },
      xAxis: {
        type: "category",
        data: dates,
        axisLabel: { color, fontSize: 9 },
        axisLine: { lineStyle: { color: "#3f3f46" } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color, fontSize: 9 },
        splitLine: { lineStyle: { color: "rgba(120,120,120,0.15)" } },
      },
      series: [
        {
          name: "wins",
          type: "bar",
          stack: "wl",
          itemStyle: { color: "#10b981" },
          data: (buckets || []).map((b) => b.wins),
        },
        {
          name: "losses",
          type: "bar",
          stack: "wl",
          itemStyle: { color: "#f43f5e" },
          data: (buckets || []).map((b) => b.losses),
        },
      ],
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    };
  }

  function renderBankrollChart() {
    const chart = ensureChart("bankroll");
    if (!chart) return;
    const payload = readPayload("bankroll");
    if (!payload) return;
    const root = document.querySelector('[data-chart="bankroll"]');
    const win = (root && root.dataset.chartWindow) || "since_reset";
    chart.setOption(bankrollOption(payload[win] || []), true);
  }

  function renderRefusalsChart() {
    const chart = ensureChart("refusals");
    if (!chart) return;
    chart.setOption(refusalsOption(readPayload("refusals")), true);
  }

  function renderSettlementsChart() {
    const chart = ensureChart("settlements_7d");
    if (!chart) return;
    chart.setOption(settlementsOption(readPayload("settlements_7d")), true);
  }

  function renderAllCharts() {
    renderBankrollChart();
    renderRefusalsChart();
    renderSettlementsChart();
  }

  // The MutationObserver is bound to a specific DOM node; SSE partial
  // swaps replace the [data-chart="bankroll"] subtree, so we must
  // disconnect the old observer and re-bind to the freshly mounted node
  // each time the bankroll_chart section refreshes. Otherwise the
  // 24h/7d/since-reset toggle silently stops re-rendering the chart
  // after the first SSE bankroll event.
  let bankrollWindowObserver = null;

  function watchBankrollWindowToggle() {
    if (bankrollWindowObserver) {
      try { bankrollWindowObserver.disconnect(); } catch (_) {}
      bankrollWindowObserver = null;
    }
    const root = document.querySelector('[data-chart="bankroll"]');
    if (!root) return;
    bankrollWindowObserver = new MutationObserver(() => renderBankrollChart());
    bankrollWindowObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-chart-window"],
    });
  }

  // --- SSE wiring -------------------------------------------------------
  //
  // Server -> client event mapping. Each named SSE event triggers a
  // partial refresh of one or more sections by fetching the
  // /api/sections/<slug> route and swapping the matching
  // <section data-section="<slug>"> innerHTML. The bankroll event
  // refreshes both the headline strip (which carries the live bankroll
  // numbers) and the bankroll chart.
  const EVENT_TO_SECTIONS = {
    bankroll: ["headline", "bankroll_chart"],
    strategies: ["strategies"],
    open_book: ["open_book"],
    llm_activity: ["llm_activity"],
    refusals: ["refusals"],
    settlements: ["settlements"],
    decisions_appended: ["decisions"],
    markets_watchlist: ["watchlist"],
  };

  let evtSource = null;
  let backoffMs = 1000;
  let backoffTimer = null;
  const BACKOFF_LADDER = [1000, 2000, 5000, 10000];
  const pendingSwaps = new Set();
  let swapScheduled = false;

  function setStreamingState(state, label) {
    document.querySelectorAll("[data-streaming-indicator]").forEach((el) => {
      el.dataset.state = state;
      const text = el.querySelector("[data-streaming-label]");
      if (text) text.textContent = label;
    });
  }

  function nextBackoff() {
    const idx = BACKOFF_LADDER.indexOf(backoffMs);
    backoffMs = BACKOFF_LADDER[Math.min(idx + 1, BACKOFF_LADDER.length - 1)];
    return backoffMs;
  }

  function resetBackoff() {
    backoffMs = BACKOFF_LADDER[0];
  }

  function fetchPartial(section) {
    return fetch(`/api/sections/${section}`, {
      headers: { Accept: "text/html" },
      credentials: "same-origin",
    }).then((r) => (r.ok ? r.text() : null));
  }

  // --- number flash --------------------------------------------------
  //
  // Each [data-flash-target] node carries a stable id (e.g.
  // "bankroll-current", "strategy-realised-sharp_consensus"). Before a
  // partial is swapped we capture the current text per id; after the
  // swap, if the same id reappears with different text we apply a brief
  // tint class. Tone is taken from data-tone="profit"|"loss" when the
  // template stamps it explicitly (bankroll deltas), or inferred from
  // the parsed numeric change for plain counters/dollars; otherwise
  // neutral. The keyframes self-clear in 200ms (see app.css), so the
  // class is removed on animationend to keep the DOM tidy and to allow
  // re-flashing on the next change.
  const FLASH_CLASSES = ["flash-profit", "flash-loss", "flash-neutral"];

  function captureFlashSnapshot(root) {
    const snapshot = new Map();
    root.querySelectorAll("[data-flash-target]").forEach((el) => {
      const id = el.dataset.flashTarget;
      if (id) snapshot.set(id, (el.textContent || "").trim());
    });
    return snapshot;
  }

  function parseNumericFromText(text) {
    if (!text) return NaN;
    // Strip commas, percent signs, trailing parens; keep the leading
    // sign + decimal point so "+12.5%" → 12.5 and "-$1,234.56" → -1234.56.
    const m = String(text).replace(/[,%()$]/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }

  function classifyTone(el, prevText, nextText) {
    const explicit = el.dataset.tone;
    if (explicit === "profit" || explicit === "loss") {
      return "flash-" + explicit;
    }
    const prev = parseNumericFromText(prevText);
    const next = parseNumericFromText(nextText);
    if (!Number.isNaN(prev) && !Number.isNaN(next) && prev !== next) {
      return next > prev ? "flash-profit" : "flash-loss";
    }
    return "flash-neutral";
  }

  function applyFlashes(target, prevSnapshot) {
    if (!prevSnapshot || prevSnapshot.size === 0) return;
    target.querySelectorAll("[data-flash-target]").forEach((el) => {
      const id = el.dataset.flashTarget;
      if (!id || !prevSnapshot.has(id)) return;
      const prev = prevSnapshot.get(id);
      const next = (el.textContent || "").trim();
      if (prev === next) return;
      const cls = classifyTone(el, prev, next);
      el.classList.remove(...FLASH_CLASSES);
      // Force reflow so re-applying the same class restarts the
      // animation when the same value flips back on a later swap.
      // eslint-disable-next-line no-unused-expressions
      el.offsetWidth;
      el.classList.add(cls);
      const handler = () => {
        el.classList.remove(cls);
        el.removeEventListener("animationend", handler);
      };
      el.addEventListener("animationend", handler);
    });
  }

  function applyPartial(section, html) {
    if (html === null || html === undefined) return;
    const target = document.querySelector(`[data-section="${section}"]`);
    if (!target) return;
    const prev = captureFlashSnapshot(target);
    target.innerHTML = html;
    // Re-init Alpine on the swapped subtree so x-data / x-on:click
    // bindings on freshly rendered elements work. Idempotent — Alpine
    // skips already-initialised nodes.
    if (window.Alpine && typeof Alpine.initTree === "function") {
      try { Alpine.initTree(target); } catch (_) {}
    }
    // ECharts containers may live inside the swapped HTML; rebuild
    // them so the renderer attaches to the new DOM nodes.
    renderAllCharts();
    applyFlashes(target, prev);
    document.dispatchEvent(
      new CustomEvent("dashboard:section-updated", { detail: { section } }),
    );
  }

  function flushSwaps() {
    swapScheduled = false;
    const sections = Array.from(pendingSwaps);
    pendingSwaps.clear();
    sections.forEach((section) => {
      fetchPartial(section)
        .then((html) => applyPartial(section, html))
        .catch(() => {
          /* network blips are absorbed; the next SSE event re-fetches. */
        });
    });
  }

  function scheduleSectionRefresh(sections) {
    sections.forEach((s) => pendingSwaps.add(s));
    if (swapScheduled) return;
    swapScheduled = true;
    // Coalesce multiple SSE events that arrive in the same tick into a
    // single batch of partial fetches. requestAnimationFrame keeps the
    // refresh aligned with paint and avoids hammering the server when
    // the differ emits a full burst on first connect.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flushSwaps);
    } else {
      setTimeout(flushSwaps, 16);
    }
  }

  function handleSSEEvent(eventName) {
    const sections = EVENT_TO_SECTIONS[eventName];
    if (!sections) return;
    scheduleSectionRefresh(sections);
  }

  function connectSSE() {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
    // Always close any stale source before opening a new one — guards
    // against duplicate connections after a manual reconnect.
    if (evtSource) {
      try { evtSource.close(); } catch (_) {}
      evtSource = null;
    }
    setStreamingState("connecting", "connecting");
    try {
      evtSource = new EventSource("/api/stream");
    } catch (_) {
      setStreamingState("paused", "paused");
      return;
    }
    evtSource.addEventListener("open", () => {
      resetBackoff();
      setStreamingState("live", "streaming");
    });
    evtSource.addEventListener("error", () => {
      setStreamingState("paused", "paused");
      try { evtSource.close(); } catch (_) {}
      evtSource = null;
      const wait = nextBackoff();
      backoffTimer = setTimeout(connectSSE, wait);
    });
    Object.keys(EVENT_TO_SECTIONS).forEach((evt) => {
      evtSource.addEventListener(evt, () => handleSSEEvent(evt));
    });
  }

  // Rebind the bankroll window observer whenever the bankroll_chart
  // section is swapped out by SSE — the previous observer was attached
  // to the old DOM node and no longer fires.
  document.addEventListener("dashboard:section-updated", (ev) => {
    const section = ev && ev.detail && ev.detail.section;
    if (section === "bankroll_chart") {
      watchBankrollWindowToggle();
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    renderAllCharts();
    watchBankrollWindowToggle();
    connectSSE();
  });
})();
