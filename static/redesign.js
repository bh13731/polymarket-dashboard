/* ════════════════════════════════════════════════════════════════════════
   The Speculator's Ledger — agent renderer for `/`.

   Reads the inline JSON state injected by templates/index.html
   (`<script id="dashboard-state">…</script>`), adapts the agent's payload
   shapes to the redesign's expected shapes, and renders every section
   client-side using D3.

   The agent's existing per-section partials (used by /api/sections/{name}
   and the SSE stream) are unchanged — this script powers `/` only.

   Every string derived from data is escaped via esc() before it enters
   any innerHTML construction, keeping the trust boundary clean.
   ════════════════════════════════════════════════════════════════════════ */

(() => {
  const stateEl = document.getElementById("dashboard-state");
  if (!stateEl) return;
  let agent;
  try {
    agent = JSON.parse(stateEl.textContent || "{}");
  } catch (e) {
    console.error("dashboard: bad inline state", e);
    return;
  }

  /* ─────────────────  ADAPTERS  (agent payload → redesign shape)  ───────────
     The agent's _build_payloads() returns dicts shaped for the legacy Jinja
     templates. The redesign expects flatter shapes; these helpers translate.
  */
  const _safe = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  function _adaptBankroll(b) {
    if (!b || b.is_empty) return { last_24h: [], last_7d: [], since_reset: [] };
    const map = (arr) =>
      (arr || []).map((p) => ({
        ts: p.ts,
        balance_usd: typeof p.balance_usd === "number" ? p.balance_usd : _safe(p.value),
      }));
    return {
      last_24h: map(b.points_24h),
      last_7d: map(b.points_7d),
      since_reset: map(b.points_since_reset),
    };
  }
  function _adaptStrategies(s) {
    if (!s || !Array.isArray(s.strategies)) return [];
    return s.strategies.map((st) => ({
      name: st.name,
      pl: _safe(st.realised_since_reset_usd),
      open: _safe(st.open_positions),
      deployed: _safe(st.deployed_usd),
      wins: _safe(st.wins),
      losses: _safe(st.losses),
      win_rate: typeof st.win_rate === "number" ? st.win_rate : null,
      llm: !!st.is_llm_strategy,
      usd_per_call:
        typeof st.dollars_per_llm_call === "number" ? st.dollars_per_llm_call : null,
      intents_per_1000:
        typeof st.intents_per_thousand_decisions_24h === "number"
          ? st.intents_per_thousand_decisions_24h
          : 0,
      intents: _safe(st.intents_24h),
      evals: _safe(st.decisions_24h),
    }));
  }
  function _adaptOpenBook(o) {
    if (!o || !Array.isArray(o.items)) return [];
    return o.items.map((it) => ({
      market: it.question || it.market_id || "—",
      outcome: it.outcome_name || "",
      side: it.side || "LONG",
      entry: _safe(it.avg_entry_price),
      mark: _safe(it.mark_price),
      cost: _safe(it.cost_basis_usd),
      unrealised: typeof it.unrealised_pnl_usd === "number" ? it.unrealised_pnl_usd : 0,
      hrs_left: typeof it.hours_to_resolution === "number" ? it.hours_to_resolution : 0,
    }));
  }
  function _adaptRefusals(r) {
    if (!r || !Array.isArray(r.by_reason)) return [];
    return r.by_reason.map((x) => ({ reason_code: x.reason_code, count: _safe(x.count) }));
  }
  function _adaptSettlements(s) {
    if (!s || !Array.isArray(s.last_24h)) return [];
    return s.last_24h.map((it) => ({
      market_id: it.market_id || "",
      outcome: it.outcome || "",
      usd_per_share: _safe(it.payout_per_share_usd),
      total: _safe(it.payout_total_usd),
    }));
  }
  function _adaptSettlements7d(s) {
    if (!s || !Array.isArray(s.buckets_7d)) return [];
    return s.buckets_7d.map((b) => ({
      date: b.date,
      wins: _safe(b.wins),
      losses: _safe(b.losses),
      paid_usd: _safe(b.paid_usd),
    }));
  }
  function _adaptLLM(l) {
    if (!l || !Array.isArray(l.strategies)) return [];
    return l.strategies.map((row) => ({
      strategy: row.strategy_name || row.name || "",
      calls: _safe(row.calls_24h ?? row.calls),
      intents: _safe(row.intents_24h ?? row.intents),
      conv:
        typeof row.conversion === "string"
          ? row.conversion
          : typeof row.intents_per_thousand_decisions_24h === "number"
          ? (row.intents_per_thousand_decisions_24h / 10).toFixed(1) + "%"
          : "—",
      tokens_usd: row.tokens_usd ?? "—",
    }));
  }
  function _adaptDecisions(d) {
    if (!d || !Array.isArray(d.events)) return [];
    return d.events.map((ev) => {
      const ts = ev.ts ? new Date(ev.ts) : null;
      const time =
        ts && !isNaN(ts.getTime())
          ? ts.toISOString().slice(11, 19)
          : String(ev.ts || "").slice(11, 19);
      return {
        time,
        event: ev.kind || "",
        strategy: ev.strategy || "",
        detail: ev.summary || "",
      };
    });
  }
  function _adaptWatchlist(w) {
    if (!w || !Array.isArray(w.items)) return [];
    return w.items.map((it) => ({
      market: it.question || it.market_id || "",
      yes_mid: it.yes_mid != null ? Number(it.yes_mid).toFixed(3) : "—",
      no_mid: it.no_mid != null ? Number(it.no_mid).toFixed(3) : "—",
      spread: it.spread != null ? Number(it.spread).toFixed(4) : "—",
      gates: Array.isArray(it.passed_strategies) ? it.passed_strategies : [],
    }));
  }
  function _buildMeta(agent) {
    const b = agent.bankroll || {};
    const sList = Array.isArray(agent.strategies && agent.strategies.strategies)
      ? agent.strategies.strategies
      : [];
    return {
      mode: agent.mode || "sim",
      refreshed: b.window_end_iso || new Date().toISOString(),
      reset_at: b.ab_reset_iso || b.window_end_iso || new Date().toISOString(),
      bankroll_now: _safe(b.current_usd),
      bankroll_24h_pct: typeof b.delta_24h_pct === "number" ? b.delta_24h_pct : 0,
      bankroll_24h_abs: _safe(b.delta_24h_usd),
      bankroll_reset_pct:
        typeof b.delta_since_reset_pct === "number" ? b.delta_since_reset_pct : 0,
      bankroll_reset_abs: _safe(b.delta_since_reset_usd),
      open_positions: sList.reduce((a, x) => a + _safe(x.open_positions), 0),
      strategies_count: sList.length,
    };
  }

  const data = {
    meta: _buildMeta(agent),
    bankroll: _adaptBankroll(agent.bankroll),
    refusals: _adaptRefusals(agent.refusals),
    settlements_7d: _adaptSettlements7d(agent.settlements),
    settlements: _adaptSettlements(agent.settlements),
    open_book: _adaptOpenBook(agent.open_book),
    llm_activity: _adaptLLM(agent.llm_activity),
    decisions: _adaptDecisions(agent.decisions),
    watchlist: _adaptWatchlist(agent.watchlist),
    strategies: _adaptStrategies(agent.strategies),
  };

  /* ─────────────────────  THEME  ─────────────────────
     Two editions, dark and light. Persist choice across visits. */
  const root = document.documentElement;
  const STORAGE_KEY = "speculators-ledger-theme";
  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    const label = document.querySelector("[data-theme-label]");
    if (label) label.textContent = theme === "light" ? "Night" : "Morning";
  }
  const saved = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } })();
  if (saved === "light" || saved === "dark") applyTheme(saved);
  function readVar(name, fallback) {
    const v = getComputedStyle(root).getPropertyValue(name).trim();
    return v || fallback;
  }
  function bindThemeToggle() {
    const btn = document.querySelector("[data-theme-toggle]");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch {}
      // re-render charts with new theme colors
      const active = document.querySelector("[data-range].is-active");
      renderEquity(active ? active.dataset.range : "since_reset");
      renderSettlements();
    });
  }

  /* ─────────────────────  helpers  ───────────────────── */
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const escAttr = (s) => String(s == null ? "" : s).replace(/"/g, "&quot;");

  const fmtMoney0 = (n) =>
    (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const fmtMoney2 = (n) =>
    (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtSigned = (n, d = 2) =>
    (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(d);
  const fmtPct = (n, d = 2) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n * 100).toFixed(d) + "%";
  const fmtCount = (n) => Number(n).toLocaleString("en-US");

  function fmtResolves(hrs) {
    if (hrs < 0) return { rel: "settled" };
    if (hrs < 1) return { rel: Math.round(hrs * 60) + "m" };
    if (hrs < 48) return { rel: hrs.toFixed(1) + " h" };
    const days = hrs / 24;
    if (days < 30) return { rel: Math.round(days) + " d" };
    if (days < 365) return { rel: (days / 30.4).toFixed(1) + " mo" };
    return { rel: (days / 365).toFixed(1) + " yr" };
  }

  /* ─────────────────────  HERO LEDE & KPIs  ───────────────────── */
  function renderHero() {
    const m = data.meta;
    document.querySelector("[data-bankroll-value]").textContent = m.bankroll_now.toLocaleString(
      "en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    );

    const refr = new Date(m.refreshed);
    const refrStr = refr.toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: "UTC",
    });
    document.querySelector("[data-as-of]").textContent = "as of " + refrStr + " UTC";
    document.querySelector("[data-refreshed]").textContent = refrStr + " UTC";

    const ed = refr.toISOString().slice(0, 10);
    document.querySelector("[data-edition]").textContent = "No. " + ed;
    document.querySelector("[data-colophon-edition]").textContent =
      "Vol. I · No. " + ed + " · Issued " + refrStr + " UTC";

    const totalRefusals = data.refusals.reduce((a, b) => a + b.count, 0);
    document.querySelector("[data-lede-evals]").textContent = totalRefusals.toLocaleString();
    const resetD = new Date(m.reset_at).toLocaleString("en-GB", {
      day: "numeric", month: "short", timeZone: "UTC",
    });
    document.querySelector("[data-lede-reset-date]").textContent = resetD;
    document.querySelector("[data-lede-24h]").textContent = fmtMoney0(Math.abs(m.bankroll_24h_abs));
    document.querySelector("[data-lede-reset]").textContent = fmtMoney0(Math.abs(m.bankroll_reset_abs));
  }

  /* ─────────────────────  I — EQUITY CURVE  ───────────────────── */
  function renderEquity(rangeKey = "since_reset") {
    const rawSeries = data.bankroll[rangeKey] || data.bankroll.since_reset;
    const series = rawSeries.map((d) => ({ ts: new Date(d.ts), v: d.balance_usd }));
    const baseline = series[0].v;
    const last = series[series.length - 1].v;

    const high = series.reduce((a, b) => (b.v > a.v ? b : a));
    const low = series.reduce((a, b) => (b.v < a.v ? b : a));
    const drawdownAbs = high.v - last;
    const drawdownPct = drawdownAbs / high.v;

    // Hourly volatility — resample series into 1h bins (last value per bin),
    // then take stdev of bin-to-bin changes. This avoids the "many ticks
    // within the same second" pathology that distorts naive Δv/Δt.
    let vol1h = 0;
    if (series.length > 2) {
      const bins = new Map();
      for (const p of series) {
        const k = Math.floor(p.ts.getTime() / 3600000);
        bins.set(k, p.v); // last write wins → close-of-bin
      }
      const sortedKeys = [...bins.keys()].sort((a, b) => a - b);
      const closes = sortedKeys.map((k) => bins.get(k));
      if (closes.length > 1) {
        const deltas = [];
        for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i - 1]);
        const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        const varc = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length;
        vol1h = Math.sqrt(varc);
      }
    }
    document.querySelector("[data-stat-high]").textContent = fmtMoney0(high.v);
    document.querySelector("[data-stat-low]").textContent = fmtMoney0(low.v);
    const ddEl = document.querySelector("[data-stat-dd]");
    ddEl.textContent = "−" + fmtMoney0(drawdownAbs) + "  " + fmtPct(-drawdownPct, 1);
    ddEl.classList.add("loss");
    document.querySelector("[data-stat-vol]").textContent = "$" + vol1h.toFixed(0) + "/h";

    const svg = d3.select("[data-equity-chart]");
    svg.selectAll("*").remove();
    const wrapEl = svg.node().parentElement;
    const wrapW = wrapEl.getBoundingClientRect().width || 720;
    const W = Math.max(wrapW, 560);
    const H = 360;
    const M = { top: 18, right: 60, bottom: 32, left: 12 };
    svg.attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "none");

    const x = d3.scaleTime().domain(d3.extent(series, (d) => d.ts)).range([M.left, W - M.right]);
    const yMin = Math.min(d3.min(series, (d) => d.v), baseline) * 0.985;
    const yMax = Math.max(d3.max(series, (d) => d.v), baseline) * 1.015;
    const y = d3.scaleLinear().domain([yMin, yMax]).range([H - M.bottom, M.top]);

    const defs = svg.append("defs");
    const grad = defs.append("linearGradient").attr("id", "equity-gradient")
      .attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
    const oxblood = readVar("--oxblood", "#c25c52");
    grad.append("stop").attr("offset", "0%").attr("stop-color", oxblood).attr("stop-opacity", 0.18);
    grad.append("stop").attr("offset", "100%").attr("stop-color", oxblood).attr("stop-opacity", 0);

    const grid = svg.append("g").attr("class", "grid");
    y.ticks(5).forEach((t) => {
      grid.append("line")
        .attr("x1", M.left).attr("x2", W - M.right)
        .attr("y1", y(t)).attr("y2", y(t));
    });

    svg.append("line").attr("class", "line-baseline")
      .attr("x1", M.left).attr("x2", W - M.right)
      .attr("y1", y(baseline)).attr("y2", y(baseline));
    svg.append("text").attr("class", "annot-label")
      .attr("x", W - M.right - 6).attr("y", y(baseline) - 6)
      .attr("text-anchor", "end")
      .text("RESET $" + Math.round(baseline).toLocaleString());

    const area = d3.area().x((d) => x(d.ts)).y0(H - M.bottom).y1((d) => y(d.v)).curve(d3.curveMonotoneX);
    svg.append("path").attr("class", "area-fill").attr("d", area(series));

    const line = d3.line().x((d) => x(d.ts)).y((d) => y(d.v)).curve(d3.curveMonotoneX);
    svg.append("path").attr("class", "line-equity").attr("d", line(series));

    const xAxis = d3.axisBottom(x)
      .ticks(rangeKey === "last_24h" ? 6 : 5)
      .tickSizeOuter(0)
      .tickFormat(rangeKey === "last_24h" ? d3.timeFormat("%H:%M") : d3.timeFormat("%-d %b"));
    svg.append("g").attr("class", "axis")
      .attr("transform", `translate(0,${H - M.bottom})`)
      .call(xAxis)
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll(".tick line").remove());

    const yAxis = d3.axisRight(y).ticks(5).tickSize(0)
      .tickFormat((d) => "$" + (d / 1000).toFixed(1) + "k");
    svg.append("g").attr("class", "axis")
      .attr("transform", `translate(${W - M.right + 8},0)`)
      .call(yAxis)
      .call((g) => g.select(".domain").remove());

    // Extreme markers — circle at the point, label kept inside the plot.
    [
      { d: high, label: "HIGH " + fmtMoney0(high.v), preferAbove: true },
      { d: low, label: "LOW " + fmtMoney0(low.v), preferAbove: true },
    ].forEach(({ d, label, preferAbove }) => {
      svg.append("circle").attr("class", "marker-extreme")
        .attr("cx", x(d.ts)).attr("cy", y(d.v)).attr("r", 3.5);
      const labelX = Math.min(Math.max(x(d.ts), M.left + 60), W - M.right - 60);
      // Pin label above (or below if it would clip the top).
      let labelY = y(d.v) - 10;
      if (labelY < M.top + 14) labelY = y(d.v) + 18;
      svg.append("text").attr("class", "marker-label")
        .attr("x", labelX).attr("y", labelY).attr("text-anchor", "middle").text(label);
    });

    const focus = svg.append("g").style("display", "none");
    focus.append("line").attr("class", "crosshair-line")
      .attr("y1", M.top).attr("y2", H - M.bottom);
    focus.append("circle").attr("class", "crosshair-dot").attr("r", 4);

    let tip = wrapEl.querySelector(".equity-tooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "equity-tooltip";
      wrapEl.style.position = "relative";
      wrapEl.appendChild(tip);
    }
    const bisect = d3.bisector((d) => d.ts).left;
    svg.append("rect")
      .attr("x", M.left).attr("y", M.top)
      .attr("width", W - M.right - M.left).attr("height", H - M.bottom - M.top)
      .attr("fill", "transparent")
      .on("mouseenter", () => { focus.style("display", null); tip.classList.add("is-visible"); })
      .on("mouseleave", () => { focus.style("display", "none"); tip.classList.remove("is-visible"); })
      .on("mousemove", (ev) => {
        const [mx] = d3.pointer(ev);
        const t = x.invert(mx);
        const i = Math.min(Math.max(bisect(series, t), 1), series.length - 1);
        const d0 = series[i - 1], d1 = series[i];
        const d = t - d0.ts > d1.ts - t ? d1 : d0;
        focus.select("line").attr("x1", x(d.ts)).attr("x2", x(d.ts));
        focus.select("circle").attr("cx", x(d.ts)).attr("cy", y(d.v));

        const ts = d.ts.toLocaleString("en-GB", {
          day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
        });
        // Build via DOM to avoid any HTML interpolation ambiguity.
        tip.replaceChildren();
        const tt = document.createElement("span");
        tt.className = "tt-time";
        tt.textContent = ts + " UTC";
        tip.appendChild(tt);
        tip.appendChild(document.createTextNode(fmtMoney2(d.v) + "  "));
        const pct = document.createElement("span");
        pct.style.color = "var(--ink-dim)";
        pct.textContent = fmtPct((d.v - baseline) / baseline, 1);
        tip.appendChild(pct);

        const wrapBox = wrapEl.getBoundingClientRect();
        const svgBox = svg.node().getBoundingClientRect();
        const ratio = svgBox.width / W;
        tip.style.left = svgBox.left - wrapBox.left + x(d.ts) * ratio + "px";
        tip.style.top = svgBox.top - wrapBox.top + y(d.v) * ratio + "px";
      });
  }

  function bindRangeControls() {
    document.querySelectorAll("[data-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-range]").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        renderEquity(btn.dataset.range);
      });
    });
  }

  /* ─────────────────────  II — STRATEGIES  ───────────────────── */
  const ROMAN_NUMS = ["I","II","III","IV","V","VI","VII","VIII","IX","X"];
  const romanize = (i) => ROMAN_NUMS[i - 1] || "·";
  function computeWilson(wins, n) {
    if (n === 0) return 0;
    const z = 1.96;
    const p = wins / n;
    return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) /
      (1 + (z * z) / n);
  }
  function renderConfidence(on) {
    let html = "";
    for (let i = 0; i < 5; i++)
      html += '<span class="strat-confidence-dot' + (i < on ? " is-on" : "") + '"></span>';
    return html;
  }
  function statCell(label, value, sub) {
    return (
      '<div><span class="strat-stat-label">' + esc(label) + "</span>" +
      '<span class="strat-stat-value">' + value +
      (sub ? '<small>' + esc(sub) + "</small>" : "") +
      "</span></div>"
    );
  }
  function renderStrategies() {
    const strats = data.strategies.slice();
    const active = strats.filter((s) => s.pl !== 0);
    const holding = strats.filter((s) => s.pl === 0 && s.open > 0);
    const dormant = strats.filter((s) => s.pl === 0 && s.open === 0);

    active.sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl));

    const totalLoss = active.reduce((a, b) => a + Math.abs(b.pl), 0);
    document.querySelector("[data-strat-meta]").textContent =
      "Realised " + fmtSigned(-totalLoss, 0) + " across " + active.length +
      " active strategies";
    const bar = document.querySelector("[data-strat-impact-bar]");
    const legend = document.querySelector("[data-strat-impact-legend]");
    bar.replaceChildren();
    legend.replaceChildren();
    // Palette is derived so it tracks the theme.
    const oxbloodC = readVar("--oxblood", "#c25c52");
    const brassC = readVar("--brass", "#d2a25c");
    const brassDeepC = readVar("--brass-deep", "#8a6f3e");
    const palette = [oxbloodC, brassC, brassDeepC, readVar("--iron", "#5e574e"), readVar("--ink-faint", "#463d31")];
    active.forEach((s, i) => {
      const w = (Math.abs(s.pl) / totalLoss) * 100;
      const div = document.createElement("div");
      div.style.width = w + "%";
      div.style.background = palette[i % palette.length];
      div.title = s.name + " · " + fmtMoney0(s.pl) + " · " + w.toFixed(0) + "%";
      bar.appendChild(div);

      const chip = document.createElement("span");
      chip.className = "legend-chip";
      const sw = document.createElement("span");
      sw.className = "legend-swatch";
      sw.style.background = palette[i % palette.length];
      chip.appendChild(sw);
      chip.appendChild(document.createTextNode(s.name + "  " + w.toFixed(0) + "%"));
      legend.appendChild(chip);
    });

    const grid = document.querySelector("[data-strat-grid]");
    grid.replaceChildren();
    const allCards = [...active, ...holding];
    allCards.forEach((s, i) => {
      const isHolding = s.pl === 0 && s.open > 0;
      const tone = s.pl < 0 ? "loss" : s.pl > 0 ? "gain" : "flat";
      const sample = (s.wins || 0) + (s.losses || 0);
      const winLabel = sample === 0 ? "—" : Math.round((s.win_rate || 0) * 100) + "%";
      const winSub = sample === 0 ? "no sample" : "n=" + sample;
      const dotsOn = sample === 0 ? 0 : Math.min(5, Math.floor(Math.log2(sample) - 1));

      const card = document.createElement("article");
      card.className = "strat-card" + (isHolding ? " holding" : "");
      const sharePct = totalLoss > 0 && s.pl < 0 ? (Math.abs(s.pl) / totalLoss) * 100 : 0;
      const ipk = s.intents_per_1000 ?? 0;

      // Each piece of dynamic content is escaped; structural HTML is static.
      card.innerHTML =
        '<div class="strat-rank">' + esc(romanize(i + 1)) + "</div>" +
        '<div class="strat-name-row">' +
        '<span class="strat-name">' + esc(s.name) + "</span>" +
        (s.llm ? '<span class="strat-flag">LLM</span>' : "") +
        (isHolding ? '<span class="strat-flag holding">Holding</span>' : "") +
        "</div>" +
        '<div class="strat-pl ' + tone + '">' +
        esc(s.pl === 0 ? "+0.00" : fmtSigned(s.pl)) +
        "</div>" +
        (s.pl < 0
          ? '<div class="strat-share-row">' +
            '<div class="strat-share-track"><div class="strat-share-fill" style="width:' +
            sharePct.toFixed(1) + '%"></div></div>' +
            '<div class="strat-share-meta"><span>Share of loss</span><strong>' +
            esc(sharePct.toFixed(0)) + "%</strong></div>" +
            "</div>"
          : "") +
        '<dl class="strat-grid-stats">' +
        statCell("Open", esc(s.open)) +
        statCell("Deployed", esc("$" + fmtCount(s.deployed))) +
        statCell(
          "Win rate",
          '<span class="strat-confidence">' + esc(winLabel) + renderConfidence(dotsOn) + "</span>",
          winSub
        ) +
        statCell(
          "Intents / 1k",
          esc(ipk.toFixed(1)),
          esc(s.intents + " / " + s.evals)
        ) +
        statCell("Conv.", sample > 0 ? esc(Math.round((s.win_rate || 0) * 100) + "%") : "—") +
        statCell(
          s.llm ? "$/call" : "Status",
          s.llm
            ? esc(s.usd_per_call != null ? fmtSigned(s.usd_per_call, 4) : "—")
            : isHolding
            ? "Holding"
            : "Active"
        ) +
        "</dl>";
      grid.appendChild(card);
    });

    const dormantEl = document.querySelector("[data-strat-dormant]");
    if (dormant.length === 0) {
      dormantEl.style.display = "none";
    } else {
      dormantEl.replaceChildren();
      const head = document.createElement("div");
      head.className = "strat-dormant-head";
      head.textContent = "Dormant — no positions, no realised P/L";
      const list = document.createElement("div");
      list.className = "strat-dormant-list";
      dormant.forEach((s) => {
        const span = document.createElement("span");
        span.textContent = s.name;
        list.appendChild(span);
      });
      dormantEl.appendChild(head);
      dormantEl.appendChild(list);
    }
  }

  /* ─────────────────────  III — OPEN BOOK  ───────────────────── */
  function renderBook() {
    const sortState = { key: "unrealised", dir: "desc" };
    const counts = {};
    data.open_book.forEach((r) => (counts[r.market] = (counts[r.market] || 0) + 1));

    function compare(a, b, key, dir) {
      const av = a[key], bv = b[key];
      if (typeof av === "string") {
        return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return dir === "asc" ? av - bv : bv - av;
    }
    function render() {
      const tbody = document.querySelector("[data-book-body]");
      tbody.replaceChildren();
      const sorted = data.open_book.slice().sort((a, b) => compare(a, b, sortState.key, sortState.dir));
      sorted.forEach((r) => {
        const paired = counts[r.market] > 1;
        const tone = r.unrealised < 0 ? "loss" : r.unrealised > 0 ? "gain" : "flat";
        const resolves = fmtResolves(r.hrs_left);
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td><div class=\"book-market\">" +
          '<span class="book-market-name" title="' + escAttr(r.market) + '">' + esc(r.market) + "</span>" +
          '<span class="book-market-meta">' + esc(r.outcome.toUpperCase()) +
          (paired ? '<span class="book-pair-flag">paired</span>' : "") +
          "</span></div></td>" +
          '<td><span class="book-side ' + esc(r.side.toLowerCase()) + '">' + esc(r.side) + "</span></td>" +
          '<td class="num">' + esc(r.entry.toFixed(3)) + "</td>" +
          '<td class="num">' + esc(r.mark.toFixed(3)) + "</td>" +
          '<td class="num">' + esc(fmtMoney2(r.cost)) + "</td>" +
          '<td class="num book-pl ' + tone + '">' + esc(fmtSigned(r.unrealised)) + "</td>" +
          '<td class="num"><div class="book-resolves"><span>' + esc(resolves.rel) + "</span></div></td>";
        tbody.appendChild(tr);
      });
    }
    document.querySelectorAll("[data-book-table] th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (sortState.key === key) {
          sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
        } else {
          sortState.key = key;
          sortState.dir = ["entry", "mark", "cost", "unrealised", "hrs_left"].includes(key) ? "desc" : "asc";
        }
        document.querySelectorAll("[data-book-table] th").forEach((x) => x.classList.remove("is-active"));
        th.classList.add("is-active");
        render();
      });
    });
    const netUnreal = data.open_book.reduce((a, b) => a + b.unrealised, 0);
    const netEl = document.querySelector("[data-book-net]");
    netEl.replaceChildren();
    netEl.appendChild(document.createTextNode("Net unrealised · "));
    const span = document.createElement("span");
    span.style.color = "var(--" + (netUnreal < 0 ? "oxblood" : "jade") + ")";
    span.textContent = fmtSigned(netUnreal);
    netEl.appendChild(span);
    render();
  }

  /* ─────────────────────  IV — LIVE TAPE  ───────────────────── */
  function renderTape() {
    const decisions = data.decisions || [];
    const buckets = new Map();
    decisions.forEach((d) => {
      const gate = d.detail.split("::", 1)[0].trim();
      const key = d.strategy + "·" + gate;
      if (!buckets.has(key)) buckets.set(key, { strategy: d.strategy, gate, count: 0, times: [] });
      const b = buckets.get(key);
      b.count += 1;
      b.times.push(d.time);
    });
    const aggs = [...buckets.values()].sort((a, b) => b.count - a.count);
    const max = Math.max(...aggs.map((a) => a.count), 1);

    const totalRefusals = data.refusals.reduce((a, b) => a + b.count, 0);
    document.querySelector("[data-tape-total]").textContent =
      "  ·  " + totalRefusals.toLocaleString() + " refusals across " +
      data.refusals.length + " gates";

    const cont = document.querySelector("[data-tape-aggregates]");
    cont.replaceChildren();
    aggs.slice(0, 10).forEach((a) => {
      const rangeStr = a.times.length ? a.times[0] + " – " + a.times[a.times.length - 1] : "";
      const row = document.createElement("div");
      row.className = "tape-row";
      row.innerHTML =
        '<span class="tape-row-strategy">' + esc(a.strategy) + "</span>" +
        '<span class="tape-row-gate">' + esc(a.gate.replace(/_/g, " ")) + "</span>" +
        '<div class="tape-row-bar"><div class="tape-row-bar-fill" style="width:' +
        ((a.count / max) * 100).toFixed(1) + '%"></div></div>' +
        '<span class="tape-row-count">' + esc(a.count) + "×</span>" +
        '<span class="tape-row-window">' + esc(rangeStr) + "</span>";
      cont.appendChild(row);
    });

    const reasons = data.refusals.slice().sort((a, b) => b.count - a.count);
    const ol = document.querySelector("[data-tape-reasons]");
    ol.replaceChildren();
    reasons.forEach((r) => {
      const li = document.createElement("li");
      li.innerHTML =
        '<span class="tape-reasons-name">' + esc(r.reason_code) + "</span>" +
        '<span class="tape-reasons-count">' + esc(r.count.toLocaleString()) + "</span>";
      ol.appendChild(li);
    });
  }

  /* ─────────────────────  V — WATCHLIST  ───────────────────── */
  function renderWatchlist() {
    const tbody = document.querySelector("[data-watch-body]");
    const watch = data.watchlist || [];
    const deck = document.querySelector("[data-watch-deck]");
    deck.replaceChildren();
    deck.appendChild(document.createTextNode("Live mid-prices & gates that have passed for each watchlist market — "));
    const em = document.createElement("em");
    em.textContent = watch.length + " markets monitored";
    deck.appendChild(em);
    deck.appendChild(document.createTextNode("."));

    function paint(filter = "") {
      tbody.replaceChildren();
      const lower = filter.toLowerCase().trim();
      const filtered = watch.filter((r) => {
        if (!lower) return true;
        return (
          r.market.toLowerCase().includes(lower) ||
          r.gates.some((g) => g.toLowerCase().includes(lower))
        );
      });
      if (filtered.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 4;
        td.className = "watch-empty";
        td.textContent = "no markets match “" + filter + "”";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      filtered.forEach((r) => {
        const yes = parseFloat(r.yes_mid);
        const yesPct = isNaN(yes) ? 0 : yes * 100;
        const display = r.market.length > 78 ? r.market.slice(0, 78) + "…" : r.market;
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td><span title="' + escAttr(r.market) + '">' + esc(display) + "</span></td>" +
          '<td class="num"><span class="watch-yes">' +
          (isNaN(yes) ? "—" : esc(yes.toFixed(3))) +
          '<span class="watch-yes-bar"><span style="width:' + yesPct + '%"></span></span>' +
          "</span></td>" +
          '<td class="num watch-spread">' + esc(r.spread) + "</td>" +
          '<td><div class="watch-gates">' +
          r.gates.map((g) => '<span class="gate-chip">' + esc(g) + "</span>").join("") +
          "</div></td>";
        tbody.appendChild(tr);
      });
    }
    document.querySelector("[data-watch-filter]").addEventListener("input", (e) => {
      paint(e.target.value);
    });
    paint();
  }

  /* ─────────────────────  VI — SYSTEM HEALTH  ───────────────────── */
  function renderLLM() {
    const tbody = document.querySelector("[data-llm-body]");
    tbody.replaceChildren();
    const rows = data.llm_activity.slice().sort((a, b) => b.calls - a.calls);
    const totalCalls = rows.reduce((a, b) => a + b.calls, 0);
    const totalIntents = rows.reduce((a, b) => a + b.intents, 0);
    document.querySelector("[data-llm-total]").textContent =
      totalCalls.toLocaleString() + " calls · " + totalIntents + " intents";

    rows.forEach((r) => {
      const strat = data.strategies.find((s) => s.name === r.strategy);
      let costPerIntent = "—";
      if (strat && strat.usd_per_call != null && r.intents > 0) {
        costPerIntent = fmtSigned((strat.usd_per_call * r.calls) / r.intents, 4);
      }
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(r.strategy) + "</td>" +
        '<td class="num">' + esc(r.calls.toLocaleString()) + "</td>" +
        '<td class="num">' + esc(r.intents.toLocaleString()) + "</td>" +
        '<td class="num dim">' + esc(r.conv) + "</td>" +
        '<td class="num dim">' + esc(costPerIntent) + "</td>";
      tbody.appendChild(tr);
    });
  }

  function renderSettlements() {
    const week = data.settlements_7d || [];
    const totalPaid = week.reduce((a, b) => a + (b.paid_usd || 0), 0);
    const totalWins = week.reduce((a, b) => a + (b.wins || 0), 0);
    const totalLoss = week.reduce((a, b) => a + (b.losses || 0), 0);
    document.querySelector("[data-settle-meta]").textContent =
      totalWins + " W · " + totalLoss + " L · " + fmtMoney0(totalPaid) + " paid";

    const svg = d3.select("[data-settle-chart]");
    svg.selectAll("*").remove();
    const W = svg.node().parentElement.getBoundingClientRect().width || 360;
    const H = 140;
    const M = { top: 12, right: 6, bottom: 22, left: 6 };
    svg.attr("viewBox", `0 0 ${W} ${H}`);
    const x = d3.scaleBand().domain(week.map((d) => d.date)).range([M.left, W - M.right]).padding(0.2);
    const yMax = Math.max(...week.map((d) => Math.max(d.wins, d.losses)), 1);
    const y = d3.scaleLinear().domain([-yMax, yMax]).range([H - M.bottom, M.top]);
    svg.append("g").attr("class", "axis")
      .attr("transform", `translate(0,${y(0)})`)
      .call(d3.axisBottom(x).tickFormat((d) => d.slice(5)).tickSize(0))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll("text").attr("transform", `translate(0,8)`));
    svg.selectAll(".bar-loss").data(week).enter().append("rect")
      .attr("class", "bar-loss")
      .attr("x", (d) => x(d.date)).attr("y", y(0))
      .attr("width", x.bandwidth())
      .attr("height", (d) => y(0) - y(-d.losses));
    svg.selectAll(".bar-gain").data(week).enter().append("rect")
      .attr("class", "bar-gain")
      .attr("x", (d) => x(d.date)).attr("y", (d) => y(d.wins))
      .attr("width", x.bandwidth())
      .attr("height", (d) => y(0) - y(d.wins));

    const ul = document.querySelector("[data-settle-list]");
    ul.replaceChildren();
    data.settlements.slice(0, 6).forEach((s) => {
      const tone = s.total > 0 ? "gain" : s.total < 0 ? "loss" : "flat";
      const li = document.createElement("li");
      li.innerHTML =
        '<span class="settle-mid">market</span>' +
        "<span>" + esc(s.market_id) + "</span>" +
        "<span>" + esc(s.outcome) + " · $/share " + esc(s.usd_per_share.toFixed(4)) + "</span>" +
        '<span class="settle-total ' + tone + '">' + esc(fmtSigned(s.total)) + "</span>";
      ul.appendChild(li);
    });
  }

  /* ─────────────────────  FOLIO NAV scroll-spy  ───────────────────── */
  function bindFolioNav() {
    const sections = [
      "folio-equity",
      "folio-strategies",
      "folio-book",
      "folio-tape",
      "folio-watch",
      "folio-health",
    ];
    const links = new Map(
      sections.map((id) => [id, document.querySelector('[data-folio-link="' + id + '"]')])
    );
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            links.forEach((l) => l && l.classList.remove("is-active"));
            const a = links.get(e.target.id);
            if (a) a.classList.add("is-active");
          }
        });
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: 0 }
    );
    sections.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
  }

  /* ─────────────────────  bootstrap  ───────────────────── */
  renderHero();
  renderEquity();
  bindRangeControls();
  renderStrategies();
  renderBook();
  renderTape();
  renderWatchlist();
  renderLLM();
  renderSettlements();
  bindFolioNav();
  bindThemeToggle();

  let resizeT;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const active = document.querySelector("[data-range].is-active");
      renderEquity(active ? active.dataset.range : "since_reset");
      renderSettlements();
    }, 120);
  });
})();
