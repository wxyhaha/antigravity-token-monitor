(() => {
  const POLL_MS = 1500;
  const $ = (id) => document.getElementById(id);

  const state = {
    selectedConvId: '', // '' = auto-follow host conversationId
    activeTab: 'live',
    data: null,
    searchQuery: '',
    modelFilter: '',
    sortBy: 'newest',
  };

  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f8fafc)';
    document.documentElement.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const nums = (color.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = color.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function fmtNum(n) {
    const v = Number(n || 0);
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 100_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toLocaleString('en-US');
  }

  function fmtDur(ms) {
    const v = Number(ms || 0);
    if (v <= 0) return '—';
    if (v < 1000) return `${v}ms`;
    return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}s`;
  }

  function fmtClock(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDateShort(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function modelTone(modelName, modelSlug, modelRole) {
    const text = `${modelName} ${modelSlug}`.toLowerCase();
    if (modelRole === '规划' || text.includes('orchestrator')) return 'planner';
    if (modelRole === '执行' || text.includes('worker') || text.includes('flash')) return 'worker';
    if (text.includes('hydrogen')) return 'hydrogen';
    if (text.includes('claude')) return 'claude';
    return 'other';
  }

  function modelColorHex(tone) {
    const isDark = document.documentElement.dataset.theme === 'dark';
    if (tone === 'planner') return isDark ? '#818cf8' : '#4338ca';
    if (tone === 'worker') return isDark ? '#38bdf8' : '#0369a1';
    if (tone === 'hydrogen') return isDark ? '#34d399' : '#047857';
    if (tone === 'claude') return isDark ? '#fbbf24' : '#b45309';
    return isDark ? '#a78bfa' : '#6d28d9';
  }

  const KNOWN_MODELS_BY_NAME = {
    'Orchestrator (Argon)': { slug: 'gemini-pro-orchestrator-g1-pro', role: '规划' },
    'Gemini Flash': { slug: 'gemini-flash-worker-agy', role: '执行' },
    'Gemini 4 Hydrogen (XHigh)': { slug: 'gemini-4-hydrogen', role: '' },
    'Gemini 4 Argon (Medium)': { slug: 'gemini-4-argon-trial', role: '' },
    'Gemini 4 Argon (High)': { slug: 'gemini-4-argon-trial', role: '' },
    'Gemini 3.8 Flash (High)': { slug: 'gemini-3.8-flash', role: '' },
    'Gemini 3.8 Flash (Medium)': { slug: 'gemini-3.8-flash-n', role: '' },
    'Gemini 3.7 Flash': { slug: 'gemini-3.7-flash', role: '' },
    'Model #1298': { displayName: 'Gemini 3.7 Flash', slug: 'gemini-3.7-flash', role: '' },
    'Model #1318': { displayName: 'Gemini 3.8 Flash (High)', slug: 'gemini-3.8-flash', role: '' },
    'Claude Sonnet 5.5 (High)': { slug: 'claude-sonnet-5-5-high', role: '' },
  };

  function ensureEnrichedConv(conv) {
    if (!conv || !Array.isArray(conv.steps)) return conv;

    let currentRound = 1;
    let prevStep = null;
    for (const s of conv.steps) {
      const known = KNOWN_MODELS_BY_NAME[s.modelName];
      if (known?.displayName) s.modelName = known.displayName;
      if (!s.modelSlug) s.modelSlug = known?.slug || '';
      if (s.modelRole == null || s.modelRole === '') {
        let role = known?.role || '';
        if (!role && s.modelSlug) {
          if (s.modelSlug.includes('orchestrator')) role = '规划';
          else if (s.modelSlug.includes('worker')) role = '执行';
        }
        s.modelRole = role;
      }

      if (!s.roundIndex) {
        if (prevStep && (prevStep.summary === '直接回复' || (s.createdAtMs && prevStep.completedAtMs && s.createdAtMs - prevStep.completedAtMs > 25000))) {
          currentRound++;
        }
        s.roundIndex = currentRound;
      }
      if (!s.roundPrompt) s.roundPrompt = `第 ${s.roundIndex} 轮对话`;
      prevStep = s;
    }

    if (!Array.isArray(conv.modelBreakdown) || !conv.modelBreakdown.length) {
      const mMap = new Map();
      for (const s of conv.steps) {
        const key = `${s.modelName}|${s.modelSlug}`;
        let entry = mMap.get(key);
        if (!entry) {
          entry = {
            modelName: s.modelName,
            modelSlug: s.modelSlug,
            modelRole: s.modelRole,
            callCount: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            bodyTokens: 0,
            totalDurationMs: 0,
            peakTps: 0,
          };
          mMap.set(key, entry);
        }
        entry.callCount++;
        entry.inputTokens += s.inputTokens || 0;
        entry.cacheReadTokens += s.cacheReadTokens || 0;
        entry.outputTokens += s.outputTokens || 0;
        entry.thinkingTokens += s.thinkingTokens || 0;
        entry.bodyTokens += s.bodyTokens || 0;
        entry.totalDurationMs += s.totalMs || 0;
        if ((s.tps || 0) > entry.peakTps) entry.peakTps = s.tps;
      }
      conv.modelBreakdown = [...mMap.values()]
        .map((m) => ({
          ...m,
          avgTps: m.totalDurationMs > 0 && m.outputTokens > 0
            ? +(m.outputTokens / (m.totalDurationMs / 1000)).toFixed(1)
            : 0,
        }))
        .sort((a, b) => b.callCount - a.callCount || b.outputTokens - a.outputTokens);
    }

    if (!Array.isArray(conv.rounds) || !conv.rounds.length) {
      const rMap = new Map();
      for (const s of conv.steps) {
        let r = rMap.get(s.roundIndex);
        if (!r) {
          r = {
            roundIndex: s.roundIndex,
            prompt: s.roundPrompt || `第 ${s.roundIndex} 轮对话`,
            callCount: 0,
            totalInputTokens: 0,
            totalCacheReadTokens: 0,
            totalOutputTokens: 0,
            totalDurationMs: 0,
            modelsMap: new Map(),
            steps: [],
          };
          rMap.set(s.roundIndex, r);
        }
        r.callCount++;
        r.totalInputTokens += s.inputTokens || 0;
        r.totalCacheReadTokens += s.cacheReadTokens || 0;
        r.totalOutputTokens += s.outputTokens || 0;
        r.totalDurationMs += s.totalMs || 0;
        r.steps.push(s);

        const mk = `${s.modelName}|${s.modelSlug}`;
        const existingM = r.modelsMap.get(mk);
        if (existingM) existingM.count++;
        else r.modelsMap.set(mk, { modelName: s.modelName, modelSlug: s.modelSlug, modelRole: s.modelRole, count: 1 });
      }
      conv.rounds = [...rMap.values()]
        .sort((a, b) => a.roundIndex - b.roundIndex)
        .map((r) => ({
          roundIndex: r.roundIndex,
          prompt: r.prompt,
          callCount: r.callCount,
          modelsUsed: [...r.modelsMap.values()],
          totalInputTokens: r.totalInputTokens,
          totalCacheReadTokens: r.totalCacheReadTokens,
          totalOutputTokens: r.totalOutputTokens,
          totalDurationMs: r.totalDurationMs,
          avgTps: r.totalDurationMs > 0 && r.totalOutputTokens > 0
            ? +(r.totalOutputTokens / (r.totalDurationMs / 1000)).toFixed(1)
            : 0,
          steps: r.steps,
        }));
    }

    return conv;
  }

  function renderModelBadge(modelName, modelSlug, modelRole, count = null) {
    const tone = modelTone(modelName, modelSlug, modelRole);
    const roleTag = modelRole ? `<span class="role-chip">${esc(modelRole)}</span>` : '';
    const countTag = count !== null ? ` ×${count}` : '';
    const tip = modelSlug ? `模型标识: ${modelSlug}` : modelName;
    return `<span class="model-badge" data-tone="${tone}" title="${esc(tip)}">${roleTag}${esc(modelName)}${countTag}</span>`;
  }

  function hostConvId() {
    const params = new URLSearchParams(location.search);
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  async function fetchStats() {
    const targetId = state.selectedConvId || hostConvId();
    const qs = targetId ? `?conversationId=${encodeURIComponent(targetId)}` : '';
    const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fetcher(`/api/stats${qs}`, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    render();
  }

  function renderSelector(conversations, activeId) {
    const sel = $('conv-select');
    const prevValue = state.selectedConvId;
    const options = [`<option value="">🎯 自动跟随当前对话</option>`];
    for (const c of conversations) {
      const marker = c.id === activeId && !prevValue ? ' (当前)' : '';
      options.push(
        `<option value="${esc(c.id)}">[${esc(c.surface)}] ${esc(c.title)}${marker} · ${fmtNum(c.totalAllTokens)} tok</option>`,
      );
    }
    sel.innerHTML = options.join('');
    sel.value = prevValue;
  }

  function renderModelBreakdown(conv) {
    const wrap = $('model-breakdown');
    const list = conv?.modelBreakdown || [];
    $('model-count-tag').textContent = list.length ? `${list.length} 个模型 · ${conv.callCount} 次调用` : '—';
    if (!list.length) {
      wrap.innerHTML = `<div class="empty-inline">暂无模型调用记录</div>`;
      return;
    }

    wrap.innerHTML = list
      .map((m) => `
        <div class="model-row">
          <div class="model-row-top">
            <div class="model-id-group">
              ${renderModelBadge(m.modelName, m.modelSlug, m.modelRole)}
              ${m.modelSlug ? `<span class="model-slug">${esc(m.modelSlug)}</span>` : ''}
            </div>
            <span class="step-tps">${m.avgTps} tok/s</span>
          </div>
          <div class="model-row-stats">
            <span>调用 <b>${m.callCount}</b> 次</span>
            <span>输出 <b>${fmtNum(m.outputTokens)}</b> (思 ${fmtNum(m.thinkingTokens)} + 答 ${fmtNum(m.bodyTokens)})</span>
            <span>新增 ${fmtNum(m.inputTokens)} · 缓存 ${fmtNum(m.cacheReadTokens)}</span>
            <span>峰值 ${m.peakTps} tok/s</span>
          </div>
        </div>
      `)
      .join('');
  }

  function renderChart(steps) {
    const wrap = $('chart-wrap');
    if (!steps || !steps.length) {
      wrap.innerHTML = `<div class="empty-inline">暂无模型调用记录</div>`;
      return;
    }

    const slice = steps.slice(-28);
    const w = 360;
    const h = 136;
    const padL = 6;
    const padR = 6;
    const padT = 18;
    const padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const maxTps = Math.max(10, ...slice.map((s) => s.tps || 0));
    const maxCtx = Math.max(1000, ...slice.map((s) => s.contextTokens || 0));
    const n = slice.length;
    const stepX = n > 1 ? plotW / (n - 1) : plotW / 2;
    const barW = Math.max(4, Math.min(16, plotW / Math.max(n, 4) - 2));

    const bars = [];
    const pts = [];
    const dots = [];

    slice.forEach((s, idx) => {
      const cx = n > 1 ? padL + idx * stepX : padL + plotW / 2;
      const barH = Math.max(2, ((s.contextTokens || 0) / maxCtx) * plotH);
      const barY = padT + plotH - barH;
      const tone = modelTone(s.modelName, s.modelSlug, s.modelRole);
      const dotColor = modelColorHex(tone);

      bars.push(
        `<rect x="${(cx - barW / 2).toFixed(1)}" y="${barY.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="rgba(59,130,246,0.28)"><title>第${s.roundIndex}轮 #${s.stepIndex} [${s.modelName}] 上下文 ${fmtNum(s.contextTokens)} | TPS ${s.tps}</title></rect>`,
      );

      const y = padT + plotH - ((s.tps || 0) / maxTps) * plotH;
      pts.push(`${cx.toFixed(1)},${y.toFixed(1)}`);
      dots.push(
        `<circle cx="${cx.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${dotColor}" stroke="var(--tm-card)" stroke-width="1"><title>第${s.roundIndex}轮 #${s.stepIndex} [${s.modelName}]: ${s.tps} tok/s (${s.outputTokens} out / ${fmtDur(s.totalMs)})</title></circle>`,
      );
    });

    const latest = slice[slice.length - 1];
    wrap.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="TPS 与上下文趋势图">
        <line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="var(--tm-border)" stroke-width="1"/>
        ${bars.join('')}
        ${pts.length > 1 ? `<polyline fill="none" stroke="var(--tm-cyan)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/>` : ''}
        ${dots.join('')}
        <text x="${padL}" y="12" fill="var(--tm-fg-sec)" font-size="10" font-weight="600">峰值 ${maxTps.toFixed(1)} tok/s · 上下文峰值 ${fmtNum(maxCtx)}</text>
        <text x="${w - padR}" y="${h - 4}" text-anchor="end" fill="var(--tm-fg-muted)" font-size="10" font-weight="500">最近 ${slice.length} 次调用 (最新 #${latest.stepIndex})</text>
      </svg>
    `;
  }

  function renderRoundsTimeline(conv) {
    const wrap = $('rounds-timeline');
    const rounds = conv?.rounds ? [...conv.rounds].reverse() : [];
    $('rounds-count-tag').textContent = rounds.length ? `共 ${rounds.length} 轮` : '—';
    if (!rounds.length) {
      wrap.innerHTML = `<div class="empty-inline">等待本次对话产生模型响应…</div>`;
      return;
    }

    wrap.innerHTML = rounds
      .map((r) => {
        const modelTags = r.modelsUsed
          .map((m) => renderModelBadge(m.modelName, m.modelSlug, m.modelRole, m.count))
          .join('');
        const stepsHtml = [...r.steps]
          .reverse()
          .map((s) => {
            const streamText = s.streamTps ? ` · 流 ${s.streamTps}` : '';
            return `
              <div class="round-step-row">
                <div class="round-step-top">
                  <div class="round-step-left">
                    <span class="step-idx-tag">#${s.stepIndex}</span>
                    ${renderModelBadge(s.modelName, s.modelSlug, s.modelRole)}
                  </div>
                  <span class="step-tps">${s.tps} tok/s${streamText}</span>
                </div>
                <div class="round-step-summary">${esc(s.summary)}</div>
                <div class="round-step-metrics">
                  输出 ${fmtNum(s.outputTokens)} (思${fmtNum(s.thinkingTokens)}+答${fmtNum(s.bodyTokens)}) · 新增 ${fmtNum(s.inputTokens)} · 缓存 ${fmtNum(s.cacheReadTokens)} (${s.cacheHitRate}%) · ${fmtDur(s.totalMs)}
                </div>
              </div>
            `;
          })
          .join('');

        return `
          <article class="round-group">
            <div class="round-header">
              <div class="round-title-row">
                <span class="round-num">第 ${r.roundIndex} 轮对话</span>
                <span class="round-stats">${r.callCount} 步 · ${r.avgTps} tok/s · 输出 ${fmtNum(r.totalOutputTokens)}</span>
              </div>
              <div class="round-prompt">${esc(r.prompt)}</div>
              <div class="round-models">${modelTags}</div>
            </div>
            <div class="round-steps">${stepsHtml}</div>
          </article>
        `;
      })
      .join('');
  }

  function phaseClass(phase) {
    if (phase === 'ERROR') return 'phase-error';
    if (phase === 'RETRYING') return 'phase-retrying';
    if (phase === 'MODEL_STREAMING') return 'phase-streaming';
    if (phase === 'TOOL_RUNNING') return 'phase-tool';
    if (phase === 'MODEL_WAITING') return 'phase-waiting';
    return 'phase-idle';
  }

  function renderLiveFlow(conv, serverErrors) {
    const pill = $('flow-phase-pill');
    const banner = $('flow-status-banner');
    const errBox = $('flow-error-box');
    const pipe = $('flow-pipeline');

    const ls = conv?.liveState || {
      isActive: Boolean(conv?.isWorking),
      phase: conv?.isWorking ? 'MODEL_WAITING' : 'IDLE',
      label: conv?.isWorking ? '请求处理中' : '空闲 / 本轮已完成',
      detail: conv ? '等待新请求…' : '暂无活跃对话',
      elapsedMs: 0,
      stallWarning: false,
    };

    pill.className = `flow-phase-pill ${phaseClass(ls.phase)}`;
    pill.textContent = ls.elapsedMs > 0 && ls.isActive
      ? `${ls.label} · ${fmtDur(ls.elapsedMs)}`
      : ls.label;

    banner.className = 'flow-status-banner';
    if (ls.phase === 'ERROR') banner.classList.add('is-error');
    else if (ls.phase === 'RETRYING' || ls.stallWarning) banner.classList.add('is-warn');

    const stallTag = ls.stallWarning && ls.phase !== 'ERROR'
      ? `<span class="mono-tag">等待较久 / 请留意异常</span>`
      : '';
    banner.innerHTML = `
      <div class="flow-status-main">
        <span>${esc(ls.label)}</span>
        ${stallTag}
      </div>
      <div class="flow-status-detail">${esc(ls.detail)}</div>
    `;

    const combinedErrors = [];
    if (Array.isArray(conv?.recentErrors)) {
      for (const e of conv.recentErrors.slice(0, 3)) {
        combinedErrors.push(
          `#${e.stepIndex ?? '?'} [${e.label}] ${e.modelName ? `${e.modelName}: ` : ''}${e.message}`,
        );
      }
    }
    if (Array.isArray(serverErrors) && serverErrors.length && ls.isActive) {
      for (const se of serverErrors.slice(0, 2)) {
        combinedErrors.push(`[后台日志 ${se.time || ''}] ${se.source}: ${se.message}`);
      }
    }

    if (combinedErrors.length) {
      errBox.style.display = 'flex';
      errBox.innerHTML = `
        <div class="flow-error-title">检测到后台异常 / 重试记录（避免无效等待）</div>
        ${combinedErrors.map((line) => `<div class="flow-error-item">${esc(line)}</div>`).join('')}
      `;
    } else {
      errBox.style.display = 'none';
      errBox.innerHTML = '';
    }

    const items = Array.isArray(conv?.livePipeline) ? [...conv.livePipeline].reverse() : [];
    if (!items.length) {
      pipe.innerHTML = `<div class="empty-inline">当前轮次暂无步骤轨迹</div>`;
      return;
    }

    pipe.innerHTML = items
      .map((item) => {
        let rowCls = '';
        let stCls = '';
        if (item.status === 2) {
          rowCls = 'status-running';
          stCls = 'st-running';
        } else if (item.status === 1) {
          rowCls = 'status-pending';
        } else if (item.status === 7 || (item.apiErrors && item.apiErrors.some((e) => e.isTerminal))) {
          rowCls = 'status-error';
          stCls = 'st-error';
        } else if (item.status === 3) {
          stCls = 'st-done';
        }

        const modelBadge = item.modelName
          ? renderModelBadge(item.modelName, item.modelSlug, item.modelRole)
          : '';
        const errLines = [];
        if (item.errorMessage) errLines.push(item.errorMessage);
        if (Array.isArray(item.apiErrors)) {
          for (const ae of item.apiErrors) {
            errLines.push(`[${ae.label}] ${ae.message}`);
          }
        }
        const errHtml = errLines.length
          ? `<div class="pipe-err">${esc(errLines[errLines.length - 1])}</div>`
          : '';

        return `
          <div class="pipe-row ${rowCls}">
            <div class="pipe-left">
              <div class="pipe-head">
                <span class="step-idx-tag">#${item.stepIndex}</span>
                <span class="pipe-kind">${esc(item.kindLabel)}</span>
                ${modelBadge}
              </div>
              <div class="pipe-title">${esc(item.title)}</div>
              ${errHtml}
            </div>
            <div class="pipe-right">
              <span class="pipe-status ${stCls}">${esc(item.statusLabel)}</span>
              <span class="pipe-time">${item.elapsedMs > 0 ? fmtDur(item.elapsedMs) : fmtClock(item.createdAtMs)}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderLive(conv, serverErrors) {
    const liveBadge = $('live-badge');
    const liveText = $('live-text');
    const phase = conv?.liveState?.phase;
    if (phase === 'ERROR') {
      liveBadge.classList.add('working');
      liveText.textContent = '后台报错';
    } else if (conv?.isWorking) {
      liveBadge.classList.add('working');
      liveText.textContent = conv?.liveState?.label || '模型生成中…';
    } else {
      liveBadge.classList.remove('working');
      liveText.textContent = '实时监控';
    }

    renderLiveFlow(conv, serverErrors);

    $('model-pill').textContent = conv?.modelName || '—';
    $('model-pill').title = conv?.title || '';

    if (!conv) {
      $('kpi-tps').textContent = '0.0';
      $('kpi-tps-sub').textContent = '平均 — · 峰值 —';
      $('kpi-output').textContent = '0';
      $('kpi-calls-sub').textContent = '0 次调用';
      $('kpi-output-sub').textContent = '思考 0 · 回复 0';
      $('bar-think').style.width = '0%';
      $('bar-body').style.width = '0%';
      $('kpi-ctx').textContent = '0';
      $('kpi-input-sub').textContent = '新增 0 · 缓存 0';
      $('kpi-cache').textContent = '0%';
      $('kpi-ttft-unit').textContent = 'TTFT —';
      $('bar-cache').style.width = '0%';
      $('kpi-latency-sub').textContent = '平均单步耗时 —';
      renderModelBreakdown(null);
      renderChart([]);
      renderRoundsTimeline(null);
      return;
    }

    const latestTps = conv.latestStep ? conv.latestStep.tps : conv.avgTps;
    $('kpi-tps').textContent = Number(latestTps || 0).toFixed(1);
    const streamSub = conv.peakStreamTps ? ` · 流峰 ${conv.peakStreamTps}` : '';
    $('kpi-tps-sub').textContent = `平均 ${conv.avgTps} · 峰值 ${conv.peakTps}${streamSub}`;

    $('kpi-output').textContent = fmtNum(conv.totalOutputTokens);
    $('kpi-calls-sub').textContent = `${conv.callCount} 次调用`;
    const thinkPct = conv.totalOutputTokens > 0 ? (conv.totalThinkingTokens / conv.totalOutputTokens) * 100 : 0;
    const bodyPct = conv.totalOutputTokens > 0 ? Math.max(0, 100 - thinkPct) : 0;
    $('bar-think').style.width = `${thinkPct.toFixed(1)}%`;
    $('bar-body').style.width = `${bodyPct.toFixed(1)}%`;
    $('kpi-output-sub').textContent = `思考 ${fmtNum(conv.totalThinkingTokens)} · 回复 ${fmtNum(conv.totalBodyTokens)}`;

    $('kpi-ctx').textContent = fmtNum(conv.latestContextTokens || conv.peakContextTokens);
    $('kpi-input-sub').textContent = `新增 ${fmtNum(conv.totalInputTokens)} · 缓存 ${fmtNum(conv.totalCacheReadTokens)}`;

    $('kpi-cache').textContent = `${conv.cacheHitRate}%`;
    $('kpi-ttft-unit').textContent = `TTFT ${fmtDur(conv.avgTtftMs)}`;
    $('bar-cache').style.width = `${Math.min(100, conv.cacheHitRate)}%`;
    $('kpi-latency-sub').textContent = `单步均耗 ${fmtDur(conv.avgStepMs)} · 窗口峰值 ${fmtNum(conv.peakContextTokens)}`;

    renderModelBreakdown(conv);
    renderChart(conv.steps);
    renderRoundsTimeline(conv);
  }

  function renderStepModelFilter(conv) {
    const sel = $('step-model-filter');
    const models = conv?.modelBreakdown || [];
    const options = [`<option value="">全部模型</option>`];
    for (const m of models) {
      options.push(`<option value="${esc(m.modelName)}">${esc(m.modelName)} (${m.callCount})</option>`);
    }
    sel.innerHTML = options.join('');
    if (models.some((m) => m.modelName === state.modelFilter)) {
      sel.value = state.modelFilter;
    } else {
      state.modelFilter = '';
      sel.value = '';
    }
  }

  function renderSteps(conv) {
    renderStepModelFilter(conv);
    const listEl = $('steps-list');
    const steps = conv?.steps ? [...conv.steps] : [];
    $('steps-badge').textContent = String(steps.length);

    const q = state.searchQuery.trim().toLowerCase();
    const filtered = steps.filter((s) => {
      if (state.modelFilter && s.modelName !== state.modelFilter) return false;
      if (!q) return true;
      return (
        s.summary.toLowerCase().includes(q) ||
        s.modelName.toLowerCase().includes(q) ||
        s.modelSlug.toLowerCase().includes(q) ||
        s.roundPrompt.toLowerCase().includes(q)
      );
    });

    filtered.sort((a, b) => {
      if (state.sortBy === 'oldest') return a.stepIndex - b.stepIndex;
      if (state.sortBy === 'tps') return b.tps - a.tps;
      if (state.sortBy === 'output') return b.outputTokens - a.outputTokens;
      if (state.sortBy === 'duration') return b.totalMs - a.totalMs;
      return b.stepIndex - a.stepIndex;
    });

    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-inline">没有匹配的模型调用步骤</div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map(
        (s) => `
      <article class="step-card">
        <div class="step-top">
          <span class="step-title">第 ${s.roundIndex} 轮 · #${s.stepIndex} · ${esc(s.summary)}</span>
          <span class="step-tps">${s.tps} tok/s</span>
        </div>
        <div class="step-model-row">
          ${renderModelBadge(s.modelName, s.modelSlug, s.modelRole)}
          ${s.modelSlug ? `<span class="model-slug">${esc(s.modelSlug)}</span>` : ''}
        </div>
        <div class="step-meta">
          <span>${fmtClock(s.completedAtMs)}</span>
          <span>耗时 ${fmtDur(s.totalMs)} (TTFT ${fmtDur(s.ttftMs)})</span>
        </div>
        <div class="metrics-pills">
          <span class="pill">输出 ${fmtNum(s.outputTokens)} (思 ${fmtNum(s.thinkingTokens)} + 答 ${fmtNum(s.bodyTokens)})</span>
          <span class="pill">新增 ${fmtNum(s.inputTokens)}</span>
          <span class="pill">缓存 ${fmtNum(s.cacheReadTokens)} (${s.cacheHitRate}%)</span>
          ${s.streamTps ? `<span class="pill">流式 ${s.streamTps} tok/s</span>` : ''}
        </div>
      </article>
    `,
      )
      .join('');
  }

  function renderGlobal(global, conversations, activeId) {
    $('global-badge').textContent = String(global?.conversationCount || 0);
    $('global-summary').innerHTML = `
      <article class="kpi-card">
        <div class="kpi-label">累计总输出 / 调用</div>
        <div class="kpi-value-row">
          <span class="kpi-value accent-emerald">${fmtNum(global.totalOutputTokens)}</span>
          <span class="kpi-unit">${global.totalCalls} 次</span>
        </div>
        <div class="kpi-sub">思考 ${fmtNum(global.totalThinkingTokens)} · 回复 ${fmtNum(global.totalBodyTokens)}</div>
      </article>
      <article class="kpi-card">
        <div class="kpi-label">全局缓存命中 &amp; 均速</div>
        <div class="kpi-value-row">
          <span class="kpi-value accent-violet">${global.cacheHitRate}%</span>
          <span class="kpi-unit">${global.avgTps} tok/s</span>
        </div>
        <div class="kpi-sub">新增 ${fmtNum(global.totalInputTokens)} · 缓存 ${fmtNum(global.totalCacheReadTokens)}</div>
      </article>
    `;

    const listEl = $('global-list');
    if (!conversations.length) {
      listEl.innerHTML = `<div class="empty-inline">未发现本地对话数据库</div>`;
      return;
    }

    listEl.innerHTML = conversations
      .map(
        (c) => `
      <article class="conv-card ${c.id === activeId ? 'selected' : ''}" data-conv-id="${esc(c.id)}">
        <div class="conv-top">
          <span class="conv-title">${esc(c.title)}</span>
          <span class="surface-tag">${esc(c.surface)}</span>
        </div>
        <div class="conv-meta">
          <span>${esc((c.modelsSummary && c.modelsSummary.length ? c.modelsSummary.join(' + ') : c.modelName))}</span>
          <span>${c.roundCount || 1} 轮 · ${c.callCount} 步</span>
          <span>${fmtDateShort(c.lastActivityMs)}</span>
        </div>
        <div class="metrics-pills">
          <span class="pill accent-cyan">均速 ${c.avgTps} tok/s</span>
          <span class="pill">输出 ${fmtNum(c.totalOutputTokens)}</span>
          <span class="pill">新增 ${fmtNum(c.totalInputTokens)}</span>
          <span class="pill">缓存 ${c.cacheHitRate}%</span>
        </div>
      </article>
    `,
      )
      .join('');
  }

  function render() {
    if (!state.data) return;
    const { conversations, global, serverErrors } = state.data;
    const activeConversation = ensureEnrichedConv(state.data.activeConversation);
    const activeId = activeConversation?.id || '';
    renderSelector(conversations, activeId);
    renderLive(activeConversation, serverErrors);
    renderSteps(activeConversation);
    renderGlobal(global, conversations, activeId);
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab').forEach((btn) => {
      const on = btn.dataset.tab === tabName;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('conv-select').addEventListener('change', (e) => {
    state.selectedConvId = e.target.value;
    fetchStats().catch(console.error);
  });

  $('refresh-btn').addEventListener('click', () => {
    fetchStats().catch(console.error);
  });

  $('step-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    if (state.data) renderSteps(state.data.activeConversation);
  });

  $('step-model-filter').addEventListener('change', (e) => {
    state.modelFilter = e.target.value;
    if (state.data) renderSteps(state.data.activeConversation);
  });

  $('step-sort').addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    if (state.data) renderSteps(state.data.activeConversation);
  });

  $('global-list').addEventListener('click', (e) => {
    const card = e.target.closest('.conv-card');
    if (!card) return;
    state.selectedConvId = card.dataset.convId || '';
    switchTab('live');
    fetchStats().catch(console.error);
  });

  fetchStats().catch(console.error);
  setInterval(() => {
    fetchStats().catch(() => {});
  }, POLL_MS);
})();
