/* ============================================================================
   polymarket-agent dashboard — "Night Desk" renderer (design-refresh v2)
   Dependency-free. Reads the embedded #bootstrap-data payload (or fetches
   ./data.json in dev / for liveness) and draws the whole operator view.
   Payload shape == polymarket_agent.dashboard.app._build_payloads().
   All DOM built with textContent / element nodes — no HTML string injection.

   v2 design principles (multi-lens critique, 2026-06-10):
   - every figure appears exactly ONCE, in its best encoding;
   - loss-red is rationed to true exceptions, not ambient direction;
   - the NAV line gets a data-fitted axis; composition gets its own 0-based
     strip (a zero-forced shared axis flattened the drawdown);
   - attention comes before the deep tables; the tape is deduplicated;
   - health tells the truth: fresh data + zero trades = "gated", not "live".
   ========================================================================== */
(function () {
  "use strict";

  var MINUS = "−";
  var app = document.getElementById("app");

  /* ---------- UI state (persisted across re-renders) --------------------- */
  var ui = {
    range: "since_reset",
    ledgerSort: { key: "roi", dir: -1 },
    bookSort: { key: "unrealised", dir: 1 },
    watch: "",
    dormantOpen: false,
    bookOpen: null            // cluster-name -> bool; null = use defaults
  };
  var state = null;     // raw payload
  var els = {};         // live element refs for in-place updates
  var pollTimer = null, ageTimer = null, pollFails = 0;

  /* ---------- formatting -------------------------------------------------- */
  function nf(v, dp) {
    return Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function money(v, dp) {
    if (v == null || isNaN(v)) return "—";
    dp = dp == null ? 2 : dp;
    return (v < 0 ? MINUS : "") + "$" + nf(v, dp);
  }
  function moneySigned(v, dp) {
    if (v == null || isNaN(v)) return "—";
    dp = dp == null ? 2 : dp;
    return (v > 0 ? "+" : v < 0 ? MINUS : "") + "$" + nf(v, dp);
  }
  function moneyCompact(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v), str;
    if (a >= 1000) str = "$" + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + "k";
    else str = "$" + a.toFixed(0);
    return (v < 0 ? MINUS : "") + str;
  }
  function pctSigned(v, dp) {
    if (v == null || isNaN(v)) return "";
    dp = dp == null ? 1 : dp;
    return (v > 0 ? "+" : v < 0 ? MINUS : "") + Math.abs(v).toFixed(dp) + "%";
  }
  function pctFrac(v, dp) {
    if (v == null || isNaN(v)) return "—";
    dp = dp == null ? 0 : dp;
    return (v < 0 ? MINUS : "") + Math.abs(v * 100).toFixed(dp) + "%";
  }
  function intc(v) { return v == null ? "—" : Number(v).toLocaleString("en-US"); }
  function sgn(v) { return v > 0 ? "pos" : v < 0 ? "neg" : ""; }
  // Color policy: routine values are neutral ink with a sign; saturated
  // profit/loss color is reserved for exceptions the eye must find.
  function exc(v, threshold) { return Math.abs(v || 0) >= (threshold == null ? 50 : threshold) ? sgn(v) : ""; }

  function parseTs(str) { var t = Date.parse(str); return isNaN(t) ? null : t; }
  function ageMs(iso) { var t = parseTs(iso); return t == null ? null : Date.now() - t; }
  function relAge(ms) {
    if (ms == null) return "unknown";
    var m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + "h " + (m % 60) + "m ago";
    return Math.floor(hr / 24) + "d ago";
  }
  function resolves(hrs) {
    if (hrs == null) return "—";
    if (hrs < 0) return "expired";
    if (hrs < 48) return hrs.toFixed(0) + "h";
    var d = hrs / 24;
    return d.toFixed(d < 10 ? 1 : 0) + "d";
  }
  function shortDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  }
  function clockTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return String(iso || "");
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  /* ---------- tiny DOM builders (text/nodes only) ------------------------ */
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "dataset") { for (var d in v) e.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === "on" && typeof v === "function") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    if (kids != null) add(e, kids);
    return e;
  }
  function add(e, c) {
    if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) add(e, c[i]); }
    else if (c == null || c === false) { /* skip */ }
    else if (c.nodeType) e.appendChild(c);
    else e.appendChild(document.createTextNode(String(c)));
  }
  function clear(e) { if (e) e.replaceChildren(); }
  var SVGNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ---------- derivations ------------------------------------------------ */
  function navOf(p) { return p && p.nav_usd != null ? p.nav_usd : (p ? p.balance_usd : null); }
  function navStats(st) {
    // Net asset value = cash + market value of open positions. The raw cash
    // bankroll overstates drawdown because deployed capital still has value.
    var b = st.bankroll || {};
    var ob = (st.open_book || {}).items || [];
    var cash = b.cash_now_usd != null ? b.cash_now_usd : b.current_usd;
    var deployed = b.deployed_cost_usd != null ? b.deployed_cost_usd
      : ob.reduce(function (a, it) { return a + (it.cost_basis_usd || 0); }, 0);
    var unreal = b.unrealised_total_usd != null ? b.unrealised_total_usd
      : ob.reduce(function (a, it) { return a + (it.unrealised_pnl_usd || 0); }, 0);
    var posval = b.positions_value_usd != null ? b.positions_value_usd : ((deployed || 0) + (unreal || 0));
    var nav = b.nav_usd != null ? b.nav_usd : ((cash || 0) + posval);
    var navDelta = b.nav_delta_since_reset_usd, navPct = b.nav_delta_since_reset_pct;
    if (navDelta == null) {  // fallback when the backend hasn't supplied it
      var pts = b.points_since_reset || [];
      var resetNav = pts.length ? navOf(pts[0]) : nav;
      navDelta = nav - resetNav; navPct = resetNav ? navDelta / resetNav * 100 : null;
    }
    var fees = b.fees_other_usd;
    if (fees == null && navDelta != null && b.realised_total_usd != null) {
      fees = navDelta - b.realised_total_usd - (unreal || 0);
    }
    return {
      cash: cash, deployed: deployed, unreal: unreal, posval: posval, nav: nav,
      navDelta: navDelta, navPct: navPct, realised: b.realised_total_usd,
      fees: fees, cashDelta: b.delta_since_reset_usd, cashPct: b.delta_since_reset_pct,
      // The reconciliation identity must balance; if it doesn't, the UI says
      // so out loud instead of rendering a tidy ≡ over broken numbers.
      reconciles: (navDelta != null && b.realised_total_usd != null)
        ? Math.abs((b.realised_total_usd + (unreal || 0) + (fees || 0)) - navDelta) <= 1
        : true
    };
  }
  function deriveEquity(points) {
    if (!points || !points.length) return null;
    var high = -Infinity, low = Infinity, peak = -Infinity, maxdd = 0, peakIdx = 0;
    var rets = [], prev = null;
    for (var i = 0; i < points.length; i++) {
      var b = navOf(points[i]);
      if (b > high) high = b;
      if (b < low) low = b;
      if (b > peak) { peak = b; peakIdx = i; }
      if (peak > 0) maxdd = Math.max(maxdd, (peak - b) / peak);
      if (prev != null && prev !== 0) rets.push((b - prev) / prev);
      prev = b;
    }
    var mean = rets.reduce(function (a, b) { return a + b; }, 0) / (rets.length || 1);
    var varc = rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (rets.length || 1);
    return {
      high: high, low: low, maxdd: maxdd, vol: Math.sqrt(varc),
      first: navOf(points[0]), last: navOf(points[points.length - 1]),
      peak: peak, peakIdx: peakIdx
    };
  }
  function prepStrategies(arr) {
    return (arr || []).map(function (st) {
      var realised = st.realised_since_reset_usd || 0;
      var deployed = st.deployed_usd || 0;
      var roi = deployed > 0 ? realised / deployed : null;
      var group = Math.abs(realised) <= 0.01 ? "dormant" : (realised > 0 ? "earning" : "bleeding");
      return Object.assign({}, st, { realised: realised, deployed: deployed, roi: roi, group: group });
    });
  }
  function pairedConditions(items) {
    var m = {}, paired = {};
    (items || []).forEach(function (it) {
      var c = it.condition_id; if (!c) return;
      (m[c] = m[c] || {})[it.token_id] = 1;
    });
    for (var c in m) if (Object.keys(m[c]).length > 1) paired[c] = 1;
    return paired;
  }

  /* ---------- open-book theme clustering ---------------------------------
     The flat list hides the structural fact that most of the book is one
     correlated macro bet. Clustering is a conservative token heuristic —
     families we can defend, everything else falls into "Other markets". */
  var THEMES = [
    [/iran|hormuz|strait/i, "Iran & Hormuz"],
    [/world cup|fifa/i, "FIFA World Cup"],
    [/nba|nfl|mlb|nhl|padres|giants|thunder|lakers|yankees/i, "US sports"],
    [/bitcoin|btc|ethereum|\beth\b|crypto|microstrategy|coinbase|solana/i, "Crypto"],
    [/\bfed\b|interest rate|inflation|cpi|gdp|recession/i, "Macro & rates"],
    [/ukraine|russia/i, "Ukraine–Russia"],
    [/taiwan|china/i, "China–Taiwan"]
  ];
  function themeOf(question) {
    var q = String(question || "");
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i][0].test(q)) return THEMES[i][1];
    return "Other markets";
  }
  function clusterBook(items) {
    var by = {};
    (items || []).forEach(function (it) {
      var expired = it.hours_to_resolution != null && it.hours_to_resolution < 0;
      var key = expired ? "Awaiting settlement" : themeOf(it.question);
      var c = by[key] || (by[key] = { name: key, items: [], cost: 0, unreal: 0, settling: expired });
      c.items.push(it);
      c.cost += it.cost_basis_usd || 0;
      c.unreal += it.unrealised_pnl_usd || 0;
    });
    var clusters = Object.keys(by).map(function (k) { return by[k]; });
    clusters.sort(function (a, b) {
      if (a.settling !== b.settling) return a.settling ? 1 : -1;  // settling last
      return b.cost - a.cost;
    });
    return clusters;
  }

  /* ---------- health & attention flags ----------------------------------- */
  function latestDataIso(st) {
    // Freshness must track the latest *data*, not the payload build time:
    // bankroll.window_end_iso is set to "now" on every request, so it can
    // never reveal a stalled agent/DB writer. Anchor on the newest bankroll
    // observation (falling back to the last equity point, then build time).
    var b = st.bankroll || {};
    if (b.as_of_iso) return b.as_of_iso;
    var p = b.points_since_reset || b.points_7d || b.points_24h;
    if (p && p.length) return p[p.length - 1].ts;
    return b.window_end_iso || null;
  }
  function healthOf(st) {
    var iso = latestDataIso(st);
    var ms = ageMs(iso), cls = "is-live", txt = "Live";
    // Tuned for an ~hourly mirror over ~hourly bankroll cadence: a fresh
    // public snapshot stays green; a multi-hour gap means the agent or the
    // publish pipeline has stalled.
    if (ms == null) { cls = "is-stale"; txt = "Unknown"; }
    else if (ms > 8 * 3600e3) { cls = "is-stale"; txt = "Stale"; }
    else if (ms > 2 * 3600e3) { cls = "is-warn"; txt = "Lagging"; }
    return { cls: cls, txt: txt, ms: ms, iso: iso };
  }
  function tradingStateOf(st) {
    // Fresh data is only half the truth — a live process that places zero
    // trades because every signal hits a gate is "gated", not "trading".
    var strat = (st.strategies || {}).strategies || [];
    var intents = strat.reduce(function (a, s2) { return a + (s2.intents_24h || 0); }, 0);
    var ev = (st.decisions || {}).events || [];
    var acted = ev.some(function (e) {
      var k = (e.kind || "").toLowerCase();
      return k && k.indexOf("refus") < 0 && (k.indexOf("fill") >= 0 || k.indexOf("order") >= 0 || k.indexOf("intent") >= 0);
    });
    var ref = st.refusals || {};
    var topGate = (ref.by_reason && ref.by_reason[0]) || null;
    return {
      intents: intents, acted: acted, refusals: ref.total || 0,
      gated: !acted && intents === 0 && (ref.total || 0) > 0,
      topGate: topGate
    };
  }
  // One severity-ordered flag list, computed once and shared by the status
  // bar (top alert chip) and the Attention panel. sev: bad > warn > ok.
  function computeFlags(st) {
    var flags = [];
    var hh = healthOf(st);
    if (hh.cls === "is-stale") flags.push({ sev: "bad", ico: "!", head: "Data is stale", note: "Last update " + relAge(hh.ms) + " — the mirror or the agent may be stalled." });
    else if (hh.cls === "is-warn") flags.push({ sev: "warn", ico: "~", head: "Data lagging", note: "Last update " + relAge(hh.ms) + "." });

    var ns = navStats(st);
    if (!ns.reconciles) {
      flags.push({ sev: "bad", ico: "≠", head: "Reconciliation does not balance", note: "realised + unrealised + fees do not sum to the net-worth change — treat decomposed figures with suspicion." });
    }

    var ts = tradingStateOf(st);
    if (ts.gated) {
      var gateNote = intc(ts.refusals) + " signals refused in the window";
      if (ts.topGate) gateNote += " · top gate: " + ts.topGate.reason_code + " (" + Math.round(ts.topGate.count / Math.max(ts.refusals, 1) * 100) + "%)";
      flags.push({ sev: "warn", ico: "⛔", head: "0 trades — every signal gated", note: gateNote + "." });
    } else if (ts.refusals > 0 && ts.topGate && ts.topGate.count / ts.refusals >= 0.6) {
      flags.push({ sev: "warn", ico: "⚑", head: Math.round(ts.topGate.count / ts.refusals * 100) + "% of refusals: " + ts.topGate.reason_code, note: intc(ts.refusals) + " refusals dominated by one gate — check it isn't mis-set." });
    }

    // Fees/other — the NAV residual (same number the reconciliation shows).
    // Never flag the cash-vs-NAV wedge here: that is deployed capital, and it
    // is explained in the hero, not "unexplained".
    if (ns.fees != null && Math.abs(ns.fees) > Math.max(50, Math.abs(ns.navDelta || 0) * 0.10)) {
      flags.push({ sev: "warn", ico: "≈", head: "Fees/other " + moneySigned(ns.fees, 0), note: "Residual of the net-worth change not in realised or unrealised P/L." });
    }

    var items = (st.open_book || {}).items || [];
    var clusters = clusterBook(items).filter(function (c) { return !c.settling; });
    var costAll = clusters.reduce(function (a, c) { return a + c.cost; }, 0);
    if (clusters.length && costAll > 0) {
      var top = clusters[0], share = top.cost / costAll;
      if (share >= 0.4) flags.push({ sev: "warn", ico: "◉", head: "Concentration: " + top.name + " = " + Math.round(share * 100) + "% of deployed", note: top.items.length + " positions, " + moneyCompact(top.cost) + " at cost — one thesis dominates the book." });
    }

    var strat = prepStrategies((st.strategies || {}).strategies);
    var worst = strat.slice().sort(function (a, b) { return a.realised - b.realised; })[0];
    if (worst && worst.realised < -100) flags.push({ sev: "warn", ico: "▼", head: "Biggest bleed: " + worst.name, note: moneySigned(worst.realised, 0) + " realised since reset" + (worst.roi != null ? " · ROI " + pctFrac(worst.roi, 0) : "") + "." });
    var best = strat.slice().sort(function (a, b) { return b.realised - a.realised; })[0];
    if (best && best.realised > 1) flags.push({ sev: "ok", ico: "▲", head: "Top earner: " + best.name, note: moneySigned(best.realised, 0) + " realised" + (best.roi != null ? " · ROI " + pctFrac(best.roi, 0) : "") + "." });
    if (!flags.length) flags.push({ sev: "ok", ico: "✓", head: "Nothing flagged", note: "No staleness, gate cliffs or unexplained P/L." });

    var rank = { bad: 0, warn: 1, ok: 2 };
    flags.sort(function (a, b) { return rank[a.sev] - rank[b.sev]; });
    return flags;
  }

  /* ---------- status bar -------------------------------------------------- */
  function renderStatusbar(st, flags) {
    var hh = healthOf(st);
    var ts = tradingStateOf(st);
    var openN = (st.open_book && st.open_book.count) || 0;
    var theme = document.documentElement.getAttribute("data-theme") || "dark";

    // Health verdict is composite: freshness first, then trading state.
    var verdict = hh.txt, vcls = hh.cls;
    if (hh.cls === "is-live" && ts.gated) { verdict = "Gated"; vcls = "is-warn"; }

    var ageEl = h("span", { class: "health-age", text: relAge(hh.ms) });
    var cluster = h("div", { class: "statusbar-cluster" });

    // Top alert chip — the single most severe flag, always in view.
    var alert = (flags || []).find(function (f) { return f.sev === "bad" || f.sev === "warn"; });
    if (alert) {
      cluster.appendChild(h("span", { class: "alert-chip is-" + alert.sev, title: alert.note }, [
        h("span", { class: "alert-ico", text: alert.ico }),
        h("span", { class: "alert-txt", text: alert.head })
      ]));
    }
    cluster.appendChild(h("span", { class: "health " + vcls, title: (hh.iso || "") + (ts.gated ? " · fresh data, zero trades placed" : "") }, [
      h("span", { class: "health-dot" }),
      h("span", { class: "health-text", text: verdict }),
      ageEl
    ]));
    cluster.appendChild(h("span", { class: "chip is-mode" }, [document.createTextNode("mode "), h("b", { text: st.mode || "—" })]));
    cluster.appendChild(h("span", { class: "chip" }, [h("b", { text: intc(openN) }), document.createTextNode(" open")]));
    cluster.appendChild(h("button", {
      class: "edition-toggle", type: "button", "data-theme-toggle": "1",
      "aria-label": "Toggle morning / night edition", onclick: toggleTheme
    }, [
      h("span", { class: "ico", text: theme === "light" ? "☾" : "☀" }),
      h("span", { class: "lbl", text: theme === "light" ? "Night" : "Morning" })
    ]));

    var bar = h("header", { class: "statusbar" }, h("div", { class: "statusbar-inner" }, [
      h("div", { class: "brand" }, [
        h("span", { class: "brand-mark" }, ["polymarket", h("b", { text: "·" }), "agent"]),
        h("span", { class: "brand-sub", text: "trading desk" })
      ]),
      cluster
    ]));
    els.age = ageEl;
    return bar;
  }

  /* ---------- standings (hero) -------------------------------------------
     Consolidated: the giant NAV figure + delta, ONE relief lane carrying the
     page's thesis (NAV vs cash), ONE allocation/decomposition block, and a
     four-tile KPI rail of facts that appear nowhere else. No prose recital,
     no triple-stated numbers. */
  function renderStandings(st) {
    var ns = navStats(st);
    var b = st.bankroll || {};
    var strat = prepStrategies((st.strategies || {}).strategies);
    var profitable = strat.filter(function (s2) { return s2.group === "earning"; }).length;
    var openCount = (st.open_book || {}).count || ((st.open_book || {}).items || []).length;
    var eq = deriveEquity(b.points_since_reset);

    var sec = h("section", { class: "standings reveal", id: "standings" });
    var resetDate = b.ab_reset_iso ? shortDate(b.ab_reset_iso) : "—";

    sec.appendChild(h("div", { class: "eyebrow" }, [
      h("span", { text: "Net asset value" }), h("span", { class: "rule" }),
      h("span", { text: "cash + open positions · since reset " + resetDate })
    ]));

    var grid = h("div", { class: "standings-grid" });

    // -- left: the number, its delta, and the one-line thesis.
    var lead = h("div", { class: "standings-lead" });
    lead.appendChild(h("div", { class: "figure" }, [
      h("span", { class: "figure-cur", text: "$" }),
      h("span", { class: "figure-num", text: ns.nav != null ? nf(ns.nav, 2) : "—" })
    ]));
    lead.appendChild(h("div", { class: "figure-delta" }, [
      h("span", { class: sgn(ns.navDelta), text: moneySigned(ns.navDelta) }),
      h("span", { class: "pct " + sgn(ns.navPct), text: pctSigned(ns.navPct) }),
      h("span", { class: "since", text: "net worth since reset" })
    ]));
    lead.appendChild(reliefLane(ns));
    grid.appendChild(lead);

    // -- right rail: allocation + decomposition (once), then the KPI rail.
    var rail = h("div", { class: "standings-rail" });
    rail.appendChild(navBlock(ns, openCount));

    var dd = eq ? eq.maxdd : null;
    var has24h = ((b.points_24h || []).length > 0);
    var d24u = b.nav_delta_24h_usd != null ? b.nav_delta_24h_usd : b.delta_24h_usd;
    var d24p = b.nav_delta_24h_pct != null ? b.nav_delta_24h_pct : b.delta_24h_pct;
    var items = (st.open_book || {}).items || [];
    var nextHrs = items.reduce(function (a, it) {
      var hrs = it.hours_to_resolution;
      return (hrs != null && hrs >= 0 && (a == null || hrs < a)) ? hrs : a;
    }, null);
    var soon = items.filter(function (it) { return it.hours_to_resolution != null && it.hours_to_resolution >= 0 && it.hours_to_resolution <= 48; }).length;
    var kpis = h("dl", { class: "kpis" }, [
      kpi("Max drawdown", h("span", { class: "num", text: dd != null ? MINUS + (dd * 100).toFixed(1) + "%" : "—" }), "on NAV, since reset"),
      // Absence and a true zero must not share an encoding: with no 24h
      // points in this snapshot, say "no data", not a confident $0.00.
      has24h
        ? kpi("24-hour", h("span", { class: "num " + exc(d24u, 25), text: moneySigned(d24u, 2) }), d24p != null ? pctSigned(d24p) : null)
        : kpi("24-hour", h("span", { class: "num dim", text: "—" }), "no 24h data in this snapshot"),
      kpi("Strategies", h("span", { class: "num", text: intc(strat.length) }), profitable + " in profit"),
      kpi("Next resolve", h("span", { class: "num", text: nextHrs != null ? resolves(nextHrs) : "—" }), soon ? soon + " resolve within 48h" : null)
    ]);
    rail.appendChild(kpis);
    grid.appendChild(rail);

    sec.appendChild(grid);
    return sec;
  }
  function kpi(label, valueNode, sub) {
    return h("div", { class: "kpi" }, [
      h("dt", { text: label }),
      h("dd", {}, [valueNode, sub ? h("small", { text: sub }) : null])
    ]);
  }
  // The single comparative insight the page exists to deliver, as a
  // first-class element in relief colors (amber = context, not alarm).
  function reliefLane(ns) {
    var lane = h("div", { class: "relief" });
    if (ns.navPct == null || ns.cashPct == null) return lane;
    var pts = ns.navPct - ns.cashPct;
    lane.appendChild(h("span", { class: "relief-cash" }, [
      document.createTextNode("cash line "),
      h("b", { class: "num", text: pctSigned(ns.cashPct) })
    ]));
    lane.appendChild(h("span", { class: "relief-arrow", text: "▸" }));
    lane.appendChild(h("span", { class: "relief-pts" }, [
      h("b", { class: "num", text: pctSigned(pts, 1).replace("%", " pts") }),
      document.createTextNode(" of that is capital deployed, not lost")
    ]));
    return lane;
  }
  // ONE allocation + decomposition block: where the money is, why it changed.
  function navBlock(ns, openCount) {
    var wrap = h("div", { class: "recon navblock" });
    if (ns.nav == null) return wrap;
    var cash = ns.cash || 0, pos = ns.posval || 0, total = (cash + pos) || 1;
    wrap.appendChild(h("div", { class: "recon-label", text: "Where the money is · " + openCount + " open positions" }));
    var bar = h("div", { class: "recon-bar" });
    bar.appendChild(h("div", { class: "recon-seg cash", style: "width:" + (cash / total * 100) + "%" }));
    bar.appendChild(h("div", { class: "recon-seg positions", style: "width:" + (pos / total * 100) + "%" }));
    wrap.appendChild(bar);
    wrap.appendChild(h("div", { class: "recon-keys" }, [
      h("span", { class: "k" }, [h("span", { class: "sw", style: "background:var(--cash)" }), document.createTextNode("cash "), h("span", { class: "num", text: money(cash, 0) + " · " + Math.round(cash / total * 100) + "%" })]),
      h("span", { class: "k" }, [h("span", { class: "sw", style: "background:var(--amber)" }), document.createTextNode("positions "), h("span", { class: "num", text: money(pos, 0) + " · " + Math.round(pos / total * 100) + "%" })]),
      h("span", { class: "k faint" }, [document.createTextNode("at cost "), h("span", { class: "num", text: money(ns.deployed, 0) })])
    ]));
    if (ns.navDelta != null && ns.realised != null) {
      wrap.appendChild(h("div", { class: "recon-label drivers-label", text: "Why it changed" }));
      if (!ns.reconciles) {
        wrap.appendChild(h("div", { class: "recon-keys recon-broken", text: "⚠ reconciliation does not balance — decomposed figures are suspect" }));
      } else {
        wrap.appendChild(h("div", { class: "recon-keys" }, [
          h("span", { class: "k", style: "color:var(--ink)" }, [document.createTextNode("net "), h("span", { class: "num " + sgn(ns.navDelta), text: moneySigned(ns.navDelta, 0) }), document.createTextNode(" ≡")]),
          h("span", { class: "k" }, [document.createTextNode("realised "), h("span", { class: "num", text: moneySigned(ns.realised, 0) })]),
          h("span", { class: "k" }, [document.createTextNode("unrealised "), h("span", { class: "num", text: moneySigned(ns.unreal, 0) })]),
          h("span", { class: "k" }, [document.createTextNode("fees/other "), h("span", { class: "num", text: moneySigned(ns.fees, 0) })])
        ]));
      }
    }
    return wrap;
  }

  /* ---------- folio header helper ---------------------------------------- */
  function folio(num, id, title, deck, controls) {
    var head = h("header", { class: "folio-head" }, [
      h("div", { class: "folio-num", text: num }),
      h("div", { class: "folio-titles" }, [
        h("h2", { class: "folio-title", text: title }),
        deck ? h("p", { class: "folio-deck" }, deck) : null
      ]),
      controls || h("span")
    ]);
    return h("section", { class: "folio reveal", id: id }, head);
  }

  /* ---------- I — net asset value chart -----------------------------------
     Two honest panels: the NAV line on a data-fitted axis (so the drawdown
     reads at full resolution), and a thin 0-based composition strip below
     (so cash-vs-deployed reads at true magnitude). A zero-forced single
     panel flattened the very decline the page exists to show. */
  function renderEquity(st) {
    var b = st.bankroll || {};
    var has24h = ((b.points_24h || []).length > 0);
    var sec = folio("I", "equity", "Net asset value",
      ["NAV on its own scale; the strip below shows how it splits into cash and deployed capital. The curve values positions at cost — the ring at the end marks them to market."],
      seg([["last_24h", "24H", !has24h], ["last_7d", "7D"], ["since_reset", "Reset"]], ui.range, function (r) {
        ui.range = r; drawEquity(st);
      }));
    var rail = h("div", { class: "equity-rail" });
    var plot = h("div", { class: "equity-plot" });
    var svg = s("svg", { class: "equity-svg", preserveAspectRatio: "none", viewBox: "0 0 800 300" });
    var tip = h("div", { class: "equity-tip" });
    plot.appendChild(svg);
    plot.appendChild(h("div", { class: "equity-axis-y", "data-axis-y": "1" }));
    plot.appendChild(h("div", { class: "equity-overlays", "data-overlays": "1" }));
    plot.appendChild(tip);
    var comp = h("div", { class: "equity-comp" });
    var compSvg = s("svg", { class: "equity-comp-svg", preserveAspectRatio: "none", viewBox: "0 0 800 64" });
    comp.appendChild(compSvg);
    comp.appendChild(h("span", { class: "comp-label", text: "composition" }));
    var xaxis = h("div", { class: "equity-axis-x", "data-axis-x": "1" });
    var legend = h("div", { class: "equity-legend" }, [
      h("span", { class: "k" }, [h("span", { class: "swline" }), document.createTextNode("net asset value (at cost)")]),
      h("span", { class: "k" }, [h("span", { class: "sw", style: "background:var(--cash)" }), document.createTextNode("cash")]),
      h("span", { class: "k" }, [h("span", { class: "sw", style: "background:var(--amber)" }), document.createTextNode("deployed")]),
      h("span", { class: "k faint", text: "dotted = opening NAV · dot = peak · ring = marked to market" })
    ]);
    sec.appendChild(h("div", { class: "equity" }, [rail, h("div", { class: "equity-main" }, [plot, comp, xaxis, legend])]));
    els.equityRail = rail; els.equitySvg = svg; els.equityTip = tip; els.equityPlot = plot;
    els.equityComp = compSvg; els.equityMainBox = sec;
    setTimeout(function () { drawEquity(st); }, 0);
    return sec;
  }
  function rangePoints(st) {
    var b = st.bankroll || {};
    var pts = b["points_" + (ui.range === "last_24h" ? "24h" : ui.range === "last_7d" ? "7d" : "since_reset")];
    if ((!pts || !pts.length) && b.points_since_reset) pts = b.points_since_reset;
    return pts || [];
  }
  function drawEquity(st) {
    var svg = els.equitySvg; if (!svg) return;
    var compSvg = els.equityComp;
    clear(svg); clear(compSvg);
    var pts = rangePoints(st);
    var eq = deriveEquity(pts);
    var ns = navStats(st);
    clear(els.equityRail);
    [["Peak NAV", eq ? money(eq.peak, 0) : "—", ""],
     ["Low NAV", eq ? money(eq.low, 0) : "—", ""],
     ["Drawdown", eq ? MINUS + (eq.maxdd * 100).toFixed(1) + "%" : "—", ""],
     ["Volatility", eq ? (eq.vol * 100).toFixed(2) + "%" : "—", ""]
    ].forEach(function (r) {
      els.equityRail.appendChild(h("div", { class: "rail-item" }, [
        h("span", { class: "rail-label", text: r[0] }),
        h("span", { class: "rail-value " + r[2], text: r[1] })
      ]));
    });
    var overlays = els.equityPlot.querySelector("[data-overlays]"); clear(overlays);
    var yAxis = els.equityPlot.querySelector("[data-axis-y]"); clear(yAxis);
    var xAxis = els.equityMainBox.querySelector("[data-axis-x]"); clear(xAxis);
    if (!pts.length) {
      var t = s("text", { x: 400, y: 150, "text-anchor": "middle", fill: "var(--ink-faint)" });
      t.textContent = "no bankroll points yet"; svg.appendChild(t); return;
    }

    var W = 800, H = 300, padL = 6, padR = 10, padT = 14, padB = 8;
    var xs = pts.map(function (p) { return parseTs(p.ts) || 0; });
    var tmin = xs[0], tmax = xs[xs.length - 1] || tmin + 1;
    var cashv = pts.map(function (p) { return p.balance_usd || 0; });
    var navv = pts.map(function (p) { return navOf(p) || 0; });
    var baseline = navv[0];  // opening NAV for the window

    // Data-fitted y-domain: the NAV move fills the panel; baseline stays in frame.
    var lo = Math.min(Math.min.apply(null, navv), baseline);
    var hi = Math.max(Math.max.apply(null, navv), baseline);
    var span = (hi - lo) || 1;
    var ymin = lo - span * 0.10, ymax = hi + span * 0.08;
    var X = function (t) { return padL + (tmax === tmin ? 0.5 : (t - tmin) / (tmax - tmin)) * (W - padL - padR); };
    var Y = function (v) { return H - padB - (v - ymin) / (ymax - ymin) * (H - padT - padB); };

    var grid = s("g", { class: "grid" });
    for (var i = 0; i <= 3; i++) {
      var gv = ymin + (ymax - ymin) * (i / 3);
      var gy = Y(gv);
      grid.appendChild(s("line", { x1: padL, x2: W - padR, y1: gy, y2: gy }));
      if (i > 0) yAxis.appendChild(h("span", { class: "ax-y", style: "top:" + (gy / H * 100) + "%", text: moneyCompact(gv) }));
    }
    svg.appendChild(grid);

    // Shaded gap between opening NAV and the curve — the drawdown itself.
    var dGap = "M " + X(xs[0]).toFixed(2) + " " + Y(baseline).toFixed(2);
    pts.forEach(function (p, i) { dGap += " L " + X(xs[i]).toFixed(2) + " " + Y(navv[i]).toFixed(2); });
    dGap += " L " + X(xs[xs.length - 1]).toFixed(2) + " " + Y(baseline).toFixed(2) + " Z";
    var up = eq.last >= baseline;
    svg.appendChild(s("path", { class: "area " + (up ? "up" : "down"), d: dGap }));

    var bl = s("line", { class: "baseline", x1: padL, x2: W - padR, y1: Y(baseline), y2: Y(baseline) });
    bl.setAttribute("vector-effect", "non-scaling-stroke"); svg.appendChild(bl);
    overlays.appendChild(h("span", { class: "eq-base-label", style: "top:" + (Y(baseline) / H * 100) + "%", text: "opening " + moneyCompact(baseline) }));

    var dNav = "";
    pts.forEach(function (p, i) { dNav += (i ? "L" : "M") + " " + X(xs[i]).toFixed(2) + " " + Y(navv[i]).toFixed(2) + " "; });
    var nl = s("path", { class: "line nav", d: dNav }); nl.setAttribute("vector-effect", "non-scaling-stroke"); svg.appendChild(nl);

    var pk = s("circle", { class: "peak", cx: X(xs[eq.peakIdx]), cy: Y(eq.peak), r: 3.2 });
    pk.setAttribute("vector-effect", "non-scaling-stroke"); svg.appendChild(pk);

    // End-of-line: latest at-cost NAV, plus a marked-to-market ring when the
    // marked value (hero figure) diverges — so chart and hero visibly agree.
    var lastX = X(xs[xs.length - 1]), lastY = Y(navv[navv.length - 1]);
    overlays.appendChild(h("span", { class: "eq-end-label", style: "top:" + (lastY / H * 100) + "%", text: moneyCompact(navv[navv.length - 1]) + " at cost" }));
    if (ns.nav != null && ymin < ns.nav && ns.nav < ymax && Math.abs(ns.nav - navv[navv.length - 1]) / Math.max(navv[navv.length - 1], 1) > 0.005) {
      var ring = s("circle", { class: "marked-ring", cx: lastX, cy: Y(ns.nav), r: 4 });
      ring.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(ring);
      overlays.appendChild(h("span", { class: "eq-end-label marked", style: "top:" + (Y(ns.nav) / H * 100) + "%", text: "marked " + moneyCompact(ns.nav) }));
    }

    var cross = s("line", { class: "equity-cross", y1: padT, y2: H - padB });
    cross.setAttribute("vector-effect", "non-scaling-stroke");
    var cdot = s("circle", { class: "equity-cdot", r: 3.5 });
    svg.appendChild(cross); svg.appendChild(cdot);

    // ---- composition strip (0-based, honest magnitudes) ----
    var CH = 64, cymax = Math.max.apply(null, navv) * 1.04 || 1;
    var CY = function (v) { return CH - (v / cymax) * (CH - 4); };
    var dCash = "M " + X(xs[0]).toFixed(2) + " " + CH;
    pts.forEach(function (p, i) { dCash += " L " + X(xs[i]).toFixed(2) + " " + CY(cashv[i]).toFixed(2); });
    dCash += " L " + X(xs[xs.length - 1]).toFixed(2) + " " + CH + " Z";
    compSvg.appendChild(s("path", { class: "area cash", d: dCash }));
    var dDep = "M " + X(xs[0]).toFixed(2) + " " + CY(navv[0]).toFixed(2);
    pts.forEach(function (p, i) { dDep += " L " + X(xs[i]).toFixed(2) + " " + CY(navv[i]).toFixed(2); });
    for (var j = pts.length - 1; j >= 0; j--) { dDep += " L " + X(xs[j]).toFixed(2) + " " + CY(cashv[j]).toFixed(2); }
    dDep += " Z";
    compSvg.appendChild(s("path", { class: "area deployed", d: dDep }));
    var ccross = s("line", { class: "equity-cross", y1: 0, y2: CH });
    ccross.setAttribute("vector-effect", "non-scaling-stroke");
    compSvg.appendChild(ccross);

    xAxis.appendChild(h("span", { class: "ax-x l", text: shortDate(pts[0].ts) }));
    xAxis.appendChild(h("span", { class: "ax-x r", text: shortDate(pts[pts.length - 1].ts) }));

    function onMove(ev) {
      var rect = svg.getBoundingClientRect();
      var fx = (ev.clientX - rect.left) / rect.width;
      var tx = tmin + fx * (tmax - tmin);
      var idx = 0, best = Infinity;
      for (var i = 0; i < xs.length; i++) { var dd2 = Math.abs(xs[i] - tx); if (dd2 < best) { best = dd2; idx = i; } }
      var px = X(xs[idx]), py = Y(navv[idx]);
      var dep = navv[idx] - cashv[idx];
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.style.opacity = 1;
      ccross.setAttribute("x1", px); ccross.setAttribute("x2", px); ccross.style.opacity = 1;
      cdot.setAttribute("cx", px); cdot.setAttribute("cy", py); cdot.style.opacity = 1;
      var tip = els.equityTip;
      clear(tip);
      tip.appendChild(h("span", { class: sgn(navv[idx] - baseline), text: "NAV " + money(navv[idx], 0) }));
      tip.appendChild(h("span", { class: "t-sub", text: "cash " + money(cashv[idx], 0) + " · deployed " + money(dep, 0) }));
      tip.appendChild(h("span", { class: "t-date", text: new Date(xs[idx]).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) }));
      tip.style.left = (px / W * 100) + "%"; tip.style.top = (py / H * 100) + "%"; tip.style.opacity = 1;
    }
    function onLeave() { cross.style.opacity = 0; ccross.style.opacity = 0; cdot.style.opacity = 0; els.equityTip.style.opacity = 0; }
    svg.addEventListener("mousemove", onMove);
    svg.addEventListener("mouseleave", onLeave);
  }

  /* ---------- II — attention & tape ---------------------------------------
     Promoted above the deep tables: "what needs me" must not live below
     ~4,000px of rows. Flags are severity-sorted and capped; the tape is
     deduplicated into counted runs with an agent-state verdict. */
  function renderActivity(st, flags) {
    var sec = folio("II", "activity", "Attention & tape", ["What needs you, then what the agent has been doing."]);
    var grid = h("div", { class: "activity-grid" });
    grid.appendChild(attentionPanel(st, flags));
    grid.appendChild(tapePanel(st));
    sec.appendChild(grid);
    return sec;
  }
  function attentionPanel(st, flags) {
    var panel = h("div", { class: "panel" }, h("p", { class: "panel-title", text: "Attention" }));
    (flags || []).slice(0, 4).forEach(function (f) {
      panel.appendChild(h("div", { class: "flag " + f.sev }, [
        h("span", { class: "flag-ico", text: f.ico }),
        h("div", { class: "flag-body" }, [h("div", { class: "flag-head", text: f.head }), h("div", { class: "flag-note", text: f.note })])
      ]));
    });
    panel.appendChild(settlementsWeek(st));
    return panel;
  }
  function settlementsWeek(st) {
    var sm = st.settlements || {};
    var buckets = sm.buckets_7d || [];
    var wrap = h("div", { style: "margin-top:1.1rem" });
    var paid = (sm.totals_24h && sm.totals_24h.paid_usd) || 0;
    wrap.appendChild(h("p", { class: "panel-title", style: "margin-top:.4rem" }, [
      "Settlements · 7 days",
      h("span", { class: "dim", style: "text-transform:none;letter-spacing:0;float:right", text: "24h paid " + money(paid, 0) })
    ]));
    if (!buckets.length) { wrap.appendChild(h("p", { class: "folio-empty", text: "no settlements yet" })); return wrap; }
    var maxN = Math.max.apply(null, buckets.map(function (b) { return (b.wins || 0) + (b.losses || 0); }).concat([1]));
    var week = h("div", { class: "settle-week" });
    buckets.forEach(function (b) {
      var stack = h("div", { class: "settle-stack" });
      if (b.wins) stack.appendChild(h("div", { class: "settle-bar win", style: "height:" + (b.wins / maxN * 100) + "%", title: b.wins + " wins" }));
      if (b.losses) stack.appendChild(h("div", { class: "settle-bar loss", style: "height:" + (b.losses / maxN * 100) + "%", title: b.losses + " losses" }));
      week.appendChild(h("div", { class: "settle-day" }, [stack, h("div", { class: "settle-d", text: (b.date || "").slice(8) })]));
    });
    wrap.appendChild(week);
    return wrap;
  }
  function tapeReason(e) {
    var sum = String(e.summary || "");
    var cut = sum.indexOf("::");
    var r = (cut >= 0 ? sum.slice(0, cut) : sum).trim();
    return r || (e.kind || "event");
  }
  function tapePanel(st) {
    var panel = h("div", { class: "panel" }, h("p", { class: "panel-title", text: "Recent tape" }));
    var ev = (st.decisions || {}).events || [];
    if (!ev.length) { panel.appendChild(h("p", { class: "folio-empty", text: "no decisions yet" })); return panel; }

    var isAction = function (e) {
      var k = (e.kind || "").toLowerCase();
      return k.indexOf("refus") < 0 && (k.indexOf("fill") >= 0 || k.indexOf("order") >= 0 || k.indexOf("intent") >= 0 || k.indexOf("settle") >= 0);
    };
    // Verdict line: when the whole window is refusals, say the one true thing.
    if (!ev.some(isAction)) {
      var counts = {};
      ev.forEach(function (e) { var r = tapeReason(e); counts[r] = (counts[r] || 0) + 1; });
      var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
      panel.appendChild(h("p", { class: "tape-verdict" }, [
        h("b", { text: "0 trades in this window" }),
        document.createTextNode(" — every signal hit a gate · top: "),
        h("span", { class: "num", text: top + " ×" + counts[top] })
      ]));
    }

    // Dedupe consecutive same-strategy/same-reason events into counted runs.
    var runs = [];
    ev.forEach(function (e) {
      var key = (e.strategy || "—") + "|" + tapeReason(e) + "|" + (e.kind || "");
      var last = runs[runs.length - 1];
      if (last && last.key === key) { last.count++; last.t1 = e.ts; return; }
      runs.push({ key: key, strategy: e.strategy || "—", reason: tapeReason(e), kind: (e.kind || "").toLowerCase(), count: 1, t0: e.ts, t1: e.ts, action: isAction(e) });
    });
    runs.sort(function (a, b) { return (b.action ? 1 : 0) - (a.action ? 1 : 0); });  // real actions first

    var ul = h("ul", { class: "tape" });
    runs.slice(0, 10).forEach(function (r) {
      var tag = r.kind.indexOf("refus") >= 0 ? ["refused", "refused"] :
        r.kind.indexOf("intent") >= 0 ? ["intent", "intent"] :
        r.kind.indexOf("fill") >= 0 || r.kind.indexOf("order") >= 0 ? ["buy", "fill"] :
        r.kind.indexOf("settle") >= 0 ? ["settle", "settled"] : ["intent", r.kind || "event"];
      var when = r.count > 1 && clockTime(r.t1) !== clockTime(r.t0)
        ? clockTime(r.t1) + "–" + clockTime(r.t0) : clockTime(r.t0);
      ul.appendChild(h("li", {}, [
        h("span", { class: "tape-time", text: when }),
        h("span", { class: "tape-what" }, [
          h("span", { class: "strat", text: r.strategy + " " }),
          h("span", { class: "dim", text: r.reason }),
          r.count > 1 ? h("span", { class: "tape-mult", text: "×" + r.count }) : null
        ]),
        h("span", { class: "tape-tag " + tag[0], text: tag[1] })
      ]));
    });
    panel.appendChild(ul);
    return panel;
  }

  /* ---------- III — strategy ledger ---------------------------------------
     The dominant graphic now encodes SKILL (signed ROI, clamped) — the deck
     promised "ranked by skill, not size" and the bar must agree. Dormant
     strategies collapse to one expandable line. Red is reserved for the
     worst bleeders and group subtotals; the earning minority gets green. */
  var ROI_CLAMP = 1.5;  // ±150% — beyond this the bar saturates (tiny-deploy outliers)
  var LEDGER_COLS = [
    { key: "name", label: "Strategy", cls: "t-name" },
    { key: "pl", label: "P/L" }, { key: "roi", label: "ROI" },
    { key: "win", label: "Win" }, { key: "wl", label: "W–L" },
    { key: "resolved", label: "Closed" }, { key: "deployed", label: "Deployed" },
    { key: "bar", label: "ROI, diverging", cls: "contrib-cell" }
  ];
  function ledgerVal(s2, key) {
    switch (key) {
      case "name": return s2.name; case "pl": return s2.realised; case "roi": return s2.roi;
      case "win": return s2.win_rate; case "wl": return s2.closed_count; case "resolved": return s2.closed_count;
      case "deployed": return s2.deployed; case "bar": return s2.roi;
    }
  }
  function renderLedger(st) {
    var strat = prepStrategies((st.strategies || {}).strategies);
    var profitable = strat.filter(function (s2) { return s2.group === "earning"; }).length;
    var sec = folio("III", "strategies", "Strategy ledger",
      ["Ranked by skill — the bar is ROI (realised P/L over capital deployed), diverging from zero. Grouped by whether they earn, bleed, or sit dormant."],
      h("span", { class: "folio-meta", text: profitable + " of " + strat.length + " in profit" }));
    var box = h("div", { class: "ledger-scroll" });
    els.ledgerBox = box;
    sec.appendChild(box);
    buildLedger(strat);
    return sec;
  }
  function buildLedger(strat) {
    var box = els.ledgerBox; clear(box);
    if (!strat.length) { box.appendChild(h("p", { class: "folio-empty", text: "no strategies have traded yet" })); return; }
    // Saturated red is reserved for the two worst bleeders.
    var worstSet = {};
    strat.filter(function (s2) { return s2.group === "bleeding"; })
      .sort(function (a, b) { return a.realised - b.realised; })
      .slice(0, 2).forEach(function (s2) { worstSet[s2.name] = 1; });

    var table = h("table", { class: "ledger-table" });
    var thr = h("tr");
    LEDGER_COLS.forEach(function (c) {
      var sorted = ui.ledgerSort.key === c.key;
      thr.appendChild(h("th", {
        class: (c.cls || "") + (sorted ? " is-sort" : ""),
        "aria-sort": sorted ? (ui.ledgerSort.dir < 0 ? "descending" : "ascending") : "none",
        onclick: (function (key) { return function () { sortLedger(key); }; })(c.key)
      }, [c.label, h("span", { class: "arrow", text: sorted ? (ui.ledgerSort.dir < 0 ? "↓" : "↑") : "↕" })]));
    });
    table.appendChild(h("thead", {}, thr));

    [["earning", "Earning"], ["bleeding", "Bleeding"]].forEach(function (g) {
      var rows = strat.filter(function (s2) { return s2.group === g[0]; });
      if (!rows.length) return;
      rows.sort(function (a, b) { return cmpVal(ledgerVal(a, ui.ledgerSort.key), ledgerVal(b, ui.ledgerSort.key)) * ui.ledgerSort.dir; });
      var groupSum = rows.reduce(function (a, s2) { return a + s2.realised; }, 0);
      var tb = h("tbody");
      tb.appendChild(h("tr", { class: "lg-row" }, h("td", { colspan: LEDGER_COLS.length }, h("div", { class: "ledger-group-head" }, [
        h("span", { class: "ledger-group-name " + g[0], text: g[1] }),
        h("span", { class: "ledger-group-count", text: rows.length }),
        h("span", { class: "ledger-group-sum " + sgn(groupSum), text: moneySigned(groupSum, 0) })
      ]))));
      rows.forEach(function (s2) { tb.appendChild(ledgerRow(s2, worstSet)); });
      table.appendChild(tb);
    });

    // Dormant: one expandable summary line instead of 8 rows of dashes.
    var dorm = strat.filter(function (s2) { return s2.group === "dormant"; });
    if (dorm.length) {
      var holding = dorm.filter(function (s2) { return s2.deployed > 0; });
      var dormDeployed = dorm.reduce(function (a, s2) { return a + s2.deployed; }, 0);
      var tb2 = h("tbody");
      tb2.appendChild(h("tr", { class: "lg-row dormant-toggle", onclick: function () { ui.dormantOpen = !ui.dormantOpen; buildLedger(prepStrategies((state.strategies || {}).strategies)); } },
        h("td", { colspan: LEDGER_COLS.length }, h("div", { class: "ledger-group-head" }, [
          h("span", { class: "dorm-chev" + (ui.dormantOpen ? " open" : ""), text: "▸" }),
          h("span", { class: "ledger-group-name dormant", text: "Dormant" }),
          h("span", { class: "ledger-group-count", text: dorm.length + " strategies · nothing realised" }),
          h("span", { class: "ledger-group-sum dim", text: holding.length + " holding " + moneyCompact(dormDeployed) + " unresolved · " + (dorm.length - holding.length) + " idle" })
        ]))));
      if (ui.dormantOpen) {
        dorm.sort(function (a, b) { return b.deployed - a.deployed; });
        dorm.forEach(function (s2) { tb2.appendChild(ledgerRow(s2, {})); });
      }
      table.appendChild(tb2);
    }
    box.appendChild(table);
  }
  function ledgerRow(s2, worstSet) {
    // M5 drawdown kill-switch badge — same numbers as the risk engine's
    // strategy_drawdown_kill_switch refusals (shared assessment helper).
    var ks = s2.kill_switch;
    var ksTag = null;
    if (ks && ks.status && ks.status !== "OK") {
      var ksTone = (ks.status === "TRIPPED" || ks.status === "DATA_UNAVAILABLE") ? " tag-danger" : "";
      var ksTitle = "trailing " + (ks.trailing_days || 0) + "d realised: " +
        (ks.trailing_pnl_usd == null ? "n/a" : moneySigned(ks.trailing_pnl_usd, 2)) +
        " | floor " + moneySigned(ks.floor_usd, 0) + " | " + (ks.action || "");
      ksTag = h("span", { class: "tag" + ksTone, text: ks.status.toLowerCase().replace(/_/g, " "), title: ksTitle });
    }
    var nameCell = h("td", { class: "ledger-name" }, [s2.name, ksTag, s2.is_llm_strategy ? h("span", { class: "tag", text: "LLM" }) : null]);
    var winCell = h("td", {}, s2.win_rate == null ? "—" : h("span", { class: "win-cell" }, [
      h("span", { text: pctFrac(s2.win_rate, 0) }),
      h("span", { class: "win-track" }, h("span", { class: "win-fill", style: "width:" + (s2.win_rate * 100) + "%" }))
    ]));
    // ROI diverging bar, clamped so tiny-deploy outliers can't dominate;
    // bars on thin capital render dimmer (a −1756% ROI on $13 is noise).
    var roiC = s2.roi == null ? 0 : Math.max(-ROI_CLAMP, Math.min(ROI_CLAMP, s2.roi));
    var w = Math.abs(roiC) / ROI_CLAMP * 50;
    var thin = s2.deployed < 20;
    var bar = h("td", { class: "contrib-cell" }, h("div", { class: "contrib" }, [
      h("div", { class: "contrib-mid" }),
      s2.roi != null ? h("div", { class: "contrib-bar " + (s2.roi >= 0 ? "pos" : "neg") + (thin ? " thin" : ""), style: "width:" + w + "%", title: "ROI " + pctFrac(s2.roi, 0) + (thin ? " on only " + moneyCompact(s2.deployed) + " deployed" : "") }) : null
    ]));
    // Color policy: earning rows green; only the worst bleeders saturated red;
    // every other negative stays neutral ink (the sign carries direction).
    var tone = s2.group === "earning" ? "pos" : (worstSet[s2.name] ? "neg" : "");
    return h("tr", { class: "ledger-row" }, [
      nameCell,
      h("td", {}, h("span", { class: tone, text: moneySigned(s2.realised, 0) })),
      h("td", {}, h("span", { class: tone, text: s2.roi == null ? "—" : pctFrac(s2.roi, 0) })),
      winCell,
      h("td", { class: "dim", text: s2.wins + "–" + s2.losses }),
      h("td", { class: "dim", text: intc(s2.closed_count) }),
      h("td", { text: moneyCompact(s2.deployed) }),
      bar
    ]);
  }
  function sortLedger(key) {
    if (ui.ledgerSort.key === key) ui.ledgerSort.dir *= -1;
    else ui.ledgerSort = { key: key, dir: key === "name" ? 1 : -1 };
    buildLedger(prepStrategies((state.strategies || {}).strategies));
  }

  /* ---------- IV — open book ----------------------------------------------
     Grouped by theme so correlated bets read as the single thesis they are,
     with per-cluster subtotals, a concentration strip, sparklines from the
     payload, and expired positions parked under "awaiting settlement". */
  var BOOK_COLS = [
    { key: "market", label: "Position", cls: "t-market" },
    { key: "spark", label: "Trend", nosort: true },
    { key: "entry", label: "Entry" }, { key: "mark", label: "Mark" },
    { key: "cost", label: "Cost" }, { key: "unrealised", label: "Unrealised" },
    { key: "hrs", label: "Resolves" }
  ];
  function bookVal(it, key) {
    switch (key) {
      case "market": return (it.question || "").toLowerCase(); case "entry": return it.avg_entry_price;
      case "mark": return it.mark_price; case "cost": return it.cost_basis_usd;
      case "unrealised": return it.unrealised_pnl_usd; case "hrs": return it.hours_to_resolution;
    }
  }
  function renderBook(st) {
    var ob = st.open_book || {};
    var items = ob.items || [];
    var net = items.reduce(function (a, it) { return a + (it.unrealised_pnl_usd || 0); }, 0);
    var sec = folio("IV", "book", "Open book",
      ["Grouped by theme — correlated bets are one thesis, not diversification. ", h("span", { class: "book-paired", text: "paired" }), " marks both sides of one market held."],
      h("span", { class: "folio-meta" }, ["net unrealised ", h("span", { class: "num " + exc(net), text: moneySigned(net, 0) })]));
    var conc = h("div", { class: "concentration" });
    els.bookConc = conc; sec.appendChild(conc);
    var box = h("div", { class: "book-scroll" });
    els.bookBox = box; sec.appendChild(box);
    buildBook(items);
    return sec;
  }
  function bookOpenDefault(c) {
    if (c.settling) return false;
    return Math.abs(c.unreal) >= 25 || c.cost >= 300;
  }
  function buildBook(items) {
    var box = els.bookBox; clear(box);
    var conc = els.bookConc; clear(conc);
    if (!items.length) { box.appendChild(h("p", { class: "folio-empty", text: "no open positions" })); return; }
    var paired = pairedConditions(items);
    var clusters = clusterBook(items);
    if (ui.bookOpen == null) {
      ui.bookOpen = {};
      clusters.forEach(function (c) { ui.bookOpen[c.name] = bookOpenDefault(c); });
    }

    // Concentration strip: cost share by theme (live clusters only).
    var live = clusters.filter(function (c) { return !c.settling; });
    var costAll = live.reduce(function (a, c) { return a + c.cost; }, 0);
    if (live.length > 1 && costAll > 0) {
      var palette = ["var(--amber)", "var(--gold)", "var(--cash)", "var(--ink-faint)"];
      var bar = h("div", { class: "conc-bar" });
      var keys = h("div", { class: "conc-keys" });
      live.slice(0, 4).forEach(function (c, i) {
        var share = c.cost / costAll;
        bar.appendChild(h("div", { class: "conc-seg", style: "width:" + (share * 100) + "%; background:" + palette[i % palette.length] }));
        keys.appendChild(h("span", { class: "k" }, [
          h("span", { class: "sw", style: "background:" + palette[i % palette.length] }),
          document.createTextNode(c.name + " "),
          h("span", { class: "num dim", text: Math.round(share * 100) + "%" })
        ]));
      });
      var rest = live.slice(4).reduce(function (a, c) { return a + c.cost; }, 0);
      if (rest > 0) bar.appendChild(h("div", { class: "conc-seg", style: "width:" + (rest / costAll * 100) + "%; background:var(--panel-2)" }));
      conc.appendChild(h("div", { class: "recon-label", text: "Deployed capital by theme" }));
      conc.appendChild(bar); conc.appendChild(keys);
    }

    var table = h("table", { class: "book-table" });
    var thr = h("tr");
    BOOK_COLS.forEach(function (c) {
      if (c.nosort) { thr.appendChild(h("th", { class: c.cls || "", text: c.label })); return; }
      var iss = ui.bookSort.key === c.key;
      thr.appendChild(h("th", {
        class: (c.cls || "") + (iss ? " is-sort" : ""),
        "aria-sort": iss ? (ui.bookSort.dir < 0 ? "descending" : "ascending") : "none",
        onclick: (function (key) { return function () { sortBook(key); }; })(c.key)
      }, [c.label, h("span", { class: "arrow", text: iss ? (ui.bookSort.dir < 0 ? "↓" : "↑") : "↕" })]));
    });
    table.appendChild(h("thead", {}, thr));

    clusters.forEach(function (c) {
      var open = !!ui.bookOpen[c.name];
      var tb = h("tbody");
      tb.appendChild(h("tr", { class: "lg-row cluster-toggle", onclick: (function (name) { return function () { ui.bookOpen[name] = !ui.bookOpen[name]; buildBook((state.open_book || {}).items || []); }; })(c.name) },
        h("td", { colspan: BOOK_COLS.length }, h("div", { class: "ledger-group-head" }, [
          h("span", { class: "dorm-chev" + (open ? " open" : ""), text: "▸" }),
          h("span", { class: "ledger-group-name " + (c.settling ? "dormant" : ""), text: c.name }),
          h("span", { class: "ledger-group-count", text: c.items.length + (c.items.length === 1 ? " position" : " positions") + " · " + moneyCompact(c.cost) + " at cost" }),
          h("span", { class: "ledger-group-sum " + exc(c.unreal), text: moneySigned(c.unreal, 0) })
        ]))));
      if (open) {
        var rows = c.items.slice().sort(function (a, b) { return cmpVal(bookVal(a, ui.bookSort.key), bookVal(b, ui.bookSort.key)) * ui.bookSort.dir; });
        rows.forEach(function (it) { tb.appendChild(bookRow(it, paired)); });
      }
      table.appendChild(tb);
    });
    box.appendChild(table);
  }
  function sparkCell(it) {
    var pts = it.sparkline || [];
    if (pts.length < 2) return h("td", { class: "spark-cell faint", text: "—" });
    var W = 64, H = 20, pad = 2;
    var vals = pts.map(function (p) { return p.price; });
    var lo = Math.min.apply(null, vals.concat([it.avg_entry_price != null ? it.avg_entry_price : Infinity]));
    var hi = Math.max.apply(null, vals.concat([it.avg_entry_price != null ? it.avg_entry_price : -Infinity]));
    var span = (hi - lo) || 1;
    var X = function (i) { return pad + i / (pts.length - 1) * (W - pad * 2); };
    var Y = function (v) { return H - pad - (v - lo) / span * (H - pad * 2); };
    var svg = s("svg", { class: "spark", viewBox: "0 0 " + W + " " + H, width: W, height: H });
    if (it.avg_entry_price != null) {
      svg.appendChild(s("line", { class: "spark-entry", x1: pad, x2: W - pad, y1: Y(it.avg_entry_price), y2: Y(it.avg_entry_price) }));
    }
    var d = "";
    pts.forEach(function (p, i) { d += (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.price).toFixed(1) + " "; });
    svg.appendChild(s("path", { class: "spark-line", d: d }));
    svg.appendChild(s("circle", { class: "spark-end " + (sgn(it.unrealised_pnl_usd) || "flat"), cx: X(pts.length - 1), cy: Y(vals[vals.length - 1]), r: 2 }));
    return h("td", { class: "spark-cell" }, svg);
  }
  function bookRow(it, paired) {
    var upct = (it.unrealised_pnl_usd != null && it.cost_basis_usd) ? it.unrealised_pnl_usd / it.cost_basis_usd : null;
    var oc = (it.outcome_name || "").toUpperCase();
    return h("tr", { class: "book-row" }, [
      h("td", { class: "book-mkt" }, [
        h("span", { class: "book-q", text: it.question || it.market_id }),
        h("span", { class: "book-sub" }, [
          h("span", { class: "outcome " + (oc === "YES" ? "yes" : oc === "NO" ? "no" : ""), text: it.outcome_name || it.side || "" }),
          paired[it.condition_id] ? h("span", { class: "book-paired", text: "paired" }) : null
        ])
      ]),
      sparkCell(it),
      h("td", { text: it.avg_entry_price != null ? it.avg_entry_price.toFixed(3) : "—" }),
      h("td", { text: it.mark_price != null ? it.mark_price.toFixed(3) : "—" }),
      h("td", { text: moneyCompact(it.cost_basis_usd) }),
      // Neutral ink for routine moves; saturated only when the move is material.
      h("td", {}, it.unrealised_pnl_usd == null ? "—" : h("span", { class: exc(it.unrealised_pnl_usd) }, [
        moneySigned(it.unrealised_pnl_usd, 0),
        upct != null ? h("small", { class: "dim", text: " " + pctSigned(upct * 100, 0) }) : null
      ])),
      h("td", { class: "dim", text: resolves(it.hours_to_resolution) })
    ]);
  }
  function sortBook(key) {
    if (ui.bookSort.key === key) ui.bookSort.dir *= -1;
    else ui.bookSort = { key: key, dir: key === "market" ? 1 : -1 };
    buildBook((state.open_book || {}).items || []);
  }

  /* ---------- V — reference (collapsible) -------------------------------- */
  function renderReference(st) {
    var det = h("details", { class: "folio reveal reference", id: "reference" });
    det.appendChild(h("summary", {}, [
      h("div", { class: "folio-num", text: "V" }),
      h("div", { class: "folio-titles" }, [
        h("h2", { class: "folio-title", text: "Reference & diagnostics" }),
        h("p", { class: "folio-deck", text: "Watchlist and LLM spend — open when you need the detail." })
      ]),
      h("span", { class: "chev", text: "▸" })
    ]));
    var grid = h("div", { class: "ref-grid" });

    var wl = (st.watchlist || {}).items || [];
    var wblock = h("div", { class: "ref-block" });
    wblock.appendChild(h("div", { class: "ref-h" }, [
      h("span", { text: "Watchlist" }),
      h("input", { class: "watch-filter", type: "search", placeholder: "filter market / gate…", value: ui.watch, oninput: function (e) { ui.watch = e.target.value; buildWatch(wl); } })
    ]));
    var wbox = h("div"); els.watchBox = wbox; wblock.appendChild(wbox); buildWatch(wl);
    grid.appendChild(wblock);

    var llm = (st.llm_activity || {}).strategies || [];
    var lblock = h("div", { class: "ref-block" });
    lblock.appendChild(h("div", { class: "ref-h" }, [h("span", { text: "LLM activity · 24h" }),
      h("span", { class: "dim", text: intc((st.llm_activity || {}).total_calls) + " calls" })]));
    if (!llm.length) lblock.appendChild(h("p", { class: "folio-empty", text: "no LLM activity in the last 24h" }));
    else {
      lblock.appendChild(h("table", { class: "mini-table" }, [
        h("thead", {}, h("tr", {}, [th("Strategy", "l"), th("Calls"), th("Intents"), th("Conv"), th("$/call")])),
        h("tbody", {}, llm.map(function (r) {
          return h("tr", {}, [
            h("td", { class: "l", text: r.name }),
            h("td", { text: intc(r.calls) }), h("td", { text: intc(r.intents) }),
            h("td", { text: r.conversion == null ? "—" : pctFrac(r.conversion, 1) }),
            h("td", { text: r.token_cost_usd == null ? "—" : money(r.token_cost_usd, 3) })
          ]);
        }))
      ]));
    }
    grid.appendChild(lblock);
    det.appendChild(grid);
    return det;
  }
  function th(label, cls) { return h("th", { class: cls || "", text: label }); }
  function buildWatch(items) {
    var box = els.watchBox; clear(box);
    var q = ui.watch.trim().toLowerCase();
    var rows = items.filter(function (it) {
      if (!q) return true;
      return (it.question || "").toLowerCase().indexOf(q) >= 0 ||
        (it.passed_strategies || []).join(" ").toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) { box.appendChild(h("p", { class: "folio-empty", text: q ? "no matches" : "no markets observed today" })); return; }
    box.appendChild(h("table", { class: "mini-table" }, [
      h("thead", {}, h("tr", {}, [th("Market", "l"), th("Yes"), th("Spread"), th("Gates", "l")])),
      h("tbody", {}, rows.slice(0, 40).map(function (it) {
        return h("tr", {}, [
          h("td", { class: "l", title: it.question, text: it.question || it.market_id }),
          h("td", { text: it.yes_mid == null ? "—" : Number(it.yes_mid).toFixed(3) }),
          h("td", { text: it.spread == null ? "—" : Number(it.spread).toFixed(3) }),
          h("td", { class: "l" }, (it.passed_strategies || []).length
            ? it.passed_strategies.map(function (g) { return h("span", { class: "gate", text: g }); })
            : h("span", { class: "faint", text: "—" }))
        ]);
      }))
    ]));
  }

  /* ---------- shared sort comparator ------------------------------------ */
  function cmpVal(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1; if (b == null) return -1;   // nulls last
    if (typeof a === "string" || typeof b === "string") return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /* ---------- segmented control ------------------------------------------
     opts: [value, label, disabled?]. Disabled pills render but can't be
     picked — used when a range genuinely has no data. */
  function seg(opts, active, onpick) {
    return h("div", { class: "seg" }, opts.map(function (o) {
      return h("button", {
        type: "button",
        class: (o[0] === active ? "is-active" : "") + (o[2] ? " is-disabled" : ""),
        disabled: o[2] ? "disabled" : null,
        title: o[2] ? "no data for this range in the current snapshot" : null,
        onclick: o[2] ? null : function (ev) {
          var box = ev.currentTarget.closest(".seg");
          if (box) box.querySelectorAll("button").forEach(function (bn) { bn.classList.remove("is-active"); });
          ev.currentTarget.classList.add("is-active");
          onpick(o[0]);
        }, text: o[1]
      });
    }));
  }

  /* ---------- theme ------------------------------------------------------ */
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    var next = cur === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("pmdash-theme", next); } catch (e) {}
    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      btn.querySelector(".ico").textContent = next === "light" ? "☾" : "☀";
      btn.querySelector(".lbl").textContent = next === "light" ? "Night" : "Morning";
    }
  }

  /* ---------- full render ------------------------------------------------ */
  function render(st, animate) {
    state = st; window.__st = st;
    var scrollY = window.scrollY;
    var flags = computeFlags(st);
    var frag = document.createDocumentFragment();
    frag.appendChild(renderStatusbar(st, flags));
    var wrap = h("div", { class: "wrap" });
    wrap.appendChild(renderStandings(st));
    wrap.appendChild(renderEquity(st));
    wrap.appendChild(renderActivity(st, flags));   // attention before the deep tables
    wrap.appendChild(renderLedger(st));
    wrap.appendChild(renderBook(st));
    wrap.appendChild(renderReference(st));
    frag.appendChild(wrap);
    clear(app);
    app.appendChild(frag);
    if (!animate) {
      app.querySelectorAll(".reveal").forEach(function (el) { el.style.animation = "none"; el.style.opacity = 1; el.style.transform = "none"; });
      window.scrollTo(0, scrollY);
    } else {
      app.querySelectorAll(".reveal").forEach(function (el, i) { el.style.animationDelay = (i * 70) + "ms"; });
    }
    detectBanner();
    tickAge();
  }
  function detectBanner() {
    var b = document.querySelector(".snapshot-banner");
    document.documentElement.style.setProperty("--snap-banner-h", b ? b.offsetHeight + "px" : "0px");
  }
  function tickAge() {
    if (els.age && state) els.age.textContent = relAge(ageMs(latestDataIso(state)));
  }

  /* ---------- liveness --------------------------------------------------- */
  function startPolling() {
    if (ageTimer) clearInterval(ageTimer);
    ageTimer = setInterval(tickAge, 30000);
    schedulePoll(60000);
  }
  function schedulePoll(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }
  function poll() {
    fetch("data.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (data) {
      pollFails = 0;
      var prev = state && state.bankroll && state.bankroll.window_end_iso;
      var next = data && data.bankroll && data.bankroll.window_end_iso;
      if (next && next !== prev) render(data, false);
      schedulePoll(60000);
    }).catch(function () {
      pollFails++;
      if (pollFails >= 3) return;            // static mirror / offline — stop quietly
      schedulePoll(120000);
    });
  }

  /* ---------- boot ------------------------------------------------------- */
  function readEmbedded() {
    var node = document.getElementById("bootstrap-data");
    if (!node) return null;
    var txt = (node.textContent || "").trim();
    if (!txt) return null;
    try { var d = JSON.parse(txt); return (d && d.bankroll) ? d : null; } catch (e) { return null; }
  }
  function boot() {
    var embedded = readEmbedded();
    if (embedded) { render(embedded, true); startPolling(); return; }
    fetch("data.json", { cache: "no-store" }).then(function (r) { return r.json(); })
      .then(function (d) { render(d, true); startPolling(); })
      .catch(function () {
        clear(app);
        app.appendChild(h("div", { class: "boot" }, h("p", { class: "boot-noscript", text: "No data available (no embedded payload and data.json could not be fetched)." })));
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
