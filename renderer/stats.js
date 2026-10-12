// JWT 账号使用统计窗口：24 / 72 / 144 小时
'use strict'

var canvas = document.getElementById('chart')
var ctx = canvas.getContext('2d')
var cacheCanvas = document.getElementById('cacheChart')
var cacheCtx = cacheCanvas.getContext('2d')
var emptyHint = document.getElementById('emptyHint')
var cacheEmpty = document.getElementById('cacheEmpty')
var cBalance = document.getElementById('cBalance')
var cUsed = document.getElementById('cUsed')
var cToday = document.getElementById('cToday')
var cCacheRate = document.getElementById('cCacheRate')
var cCacheTokens = document.getElementById('cCacheTokens')
var usedLabel = document.getElementById('usedLabel')
var cacheLabel = document.getElementById('cacheLabel')
var title = document.getElementById('windowTitle')
var refreshInfo = document.getElementById('refreshInfo')
var cacheMonitorPanel = document.getElementById('cacheMonitorPanel')
var cacheMonitorRate = document.getElementById('cacheMonitorRate')
var cacheMonitorStatus = document.getElementById('cacheMonitorStatus')
var cacheMonitorInfo = document.getElementById('cacheMonitorInfo')
var localCachePanel = document.getElementById('localCachePanel')
var localCacheSource = document.getElementById('localCacheSource')
var localCacheUpdated = document.getElementById('localCacheUpdated')
var localCacheMessage = document.getElementById('localCacheMessage')
var selectedHours = 24
var drawRequest = 0
var localCacheRefresh = null

var COLORS = {
  line: '#9d7ff5',           // 余额线：紫色，更醒目
  bar: 'rgba(255,139,90,.85)', // 消耗柱：橙色，提高不透明度
  cache: '#3fcf9a',          // 缓存线：青绿色
  grid: '#363631',           // 网格：暖深灰
  text: '#aaa89d'            // 文字：与统计页辅助文字统一
}
function symFor(currency) { return currency === 'CNY' ? '¥ ' : (currency === 'USD' ? '$ ' : '') }
function n(v) { var x = Number(v); return Number.isFinite(x) ? x : 0 }
function fmtNum(v) { return (Math.round(n(v) * 100) / 100).toFixed(2) }
function fmtTokens(v) { v = n(v); if (v >= 1000000) return fmtNum(v / 1000000) + 'M'; if (v >= 1000) return fmtNum(v / 1000) + 'K'; return String(Math.round(v)) }
function pct(v) { return v === null || !Number.isFinite(v) ? '--' : (Math.round(v * 1000) / 10).toFixed(1) + '%' }
function trendDate(value) { var t = new Date(String(value).replace(' ', 'T')).getTime(); return Number.isFinite(t) ? t : NaN }

var monitorStatusText = {
  pending: '等待本地数据', ok: '正常', low: '低于 80%', idle: '最近 1 分钟无有效用量',
  partial: '样本口径不完整', error: '读取失败', disabled: '已关闭', unconfigured: '未找到 CC Switch 数据', paused: '读取已暂停'
}
function monitorTime(value) {
  var t = value ? new Date(value) : null
  return t && Number.isFinite(t.getTime()) ? t.toLocaleTimeString('zh-CN', { hour12: false }) : '--'
}
function cacheWindowDetails(sample) {
  if (!sample) return '等待数据'
  var parts = []
  if (sample.sampleStart && sample.sampleEnd) parts.push(monitorTime(sample.sampleStart) + '—' + monitorTime(sample.sampleEnd))
  parts.push('有效 ' + Math.round(n(sample.validRequests)).toLocaleString('zh-CN') + ' / ' + Math.round(n(sample.requests)).toLocaleString('zh-CN') + ' 次请求')
  if (n(sample.excludedRequests)) parts.push('排除 ' + Math.round(n(sample.excludedRequests)).toLocaleString('zh-CN') + ' 次')
  parts.push('缓存读取 ' + fmtTokens(sample.cacheReadTokens), '缓存写入 ' + fmtTokens(sample.cacheCreationTokens),
    '未缓存输入 ' + fmtTokens(sample.uncachedInputTokens), '总输入 ' + fmtTokens(sample.inputTokens) + ' Token')
  return parts.join(' · ')
}
function renderLocalCacheWindow(key, sample, status) {
  var panel = document.getElementById('localCache' + key)
  var rateEl = document.getElementById('localCache' + key + 'Rate')
  var statusEl = document.getElementById('localCache' + key + 'Status')
  var infoEl = document.getElementById('localCache' + key + 'Info')
  if (!panel) return
  var partial = status === 'ok' && sample && sample.complete === false
  var rate = status === 'ok' && sample && !partial && typeof sample.rate === 'number' && Number.isFinite(sample.rate) ? sample.rate : null
  rateEl.textContent = rate === null ? '--' : pct(Math.max(0, Math.min(1, rate)))
  panel.classList.toggle('low', rate !== null && rate < .8)
  panel.classList.toggle('partial', !!partial)
  if (status !== 'ok') {
    statusEl.textContent = status === 'error' ? '读取失败' : (status === 'paused' ? '已暂停' : '数据不可用')
    infoEl.textContent = status === 'paused' ? 'CC Switch 统计读取已暂停；JWT 账号统计不受影响。' : '恢复数据读取后自动更新。'
    return
  }
  statusEl.textContent = partial ? '样本口径不完整' : (rate === null ? (sample && n(sample.requests) ? '没有有效样本' : '无请求') : (rate < .8 ? '低于 80%' : '正常'))
  infoEl.textContent = cacheWindowDetails(sample) + (partial ? ' · 本窗口不告警' : '')
}
function renderLocalCacheStats(data) {
  if (!localCachePanel) return
  var status = data && data.status || 'error'
  localCachePanel.classList.toggle('error', status === 'error')
  localCacheSource.textContent = (data && data.source || 'CC Switch · 本机 Codex 代理') + ' · 仅本机代理记录，不代表账号全部 Key'
  var age = data && data.sampledAt ? Math.max(0, Math.floor((Date.now() - data.sampledAt) / 1000)) : 0
  localCacheUpdated.textContent = status === 'paused' ? '读取已暂停'
    : data && data.sampledAt ? '采样 ' + monitorTime(data.sampledAt) + ' · ' + age + ' 秒前' : '尚未取得采样'
  renderLocalCacheWindow('Minute', data && data.minute, status)
  renderLocalCacheWindow('Hour', data && data.hour, status)
  var message = '每 30 秒更新显示；手动刷新直接读取，告警每分钟使用新样本。无有效输入 Token 时不告警。'
  if (status === 'unconfigured') message = data.error || '未找到 CC Switch 数据库，请确认本机 Codex 代理已启用请求日志。'
  else if (status === 'error') message = (data && data.error || 'CC Switch 数据读取失败') + '；30 秒后自动重试。'
  else if (status === 'paused') message = 'CC Switch 统计读取已暂停；恢复后立即更新，JWT 账号统计不受影响。'
  else if (data && data.latestRequestAt) message += ' 最新记录 ' + monitorTime(data.latestRequestAt) + '。'
  localCacheMessage.textContent = message
}
async function refreshLocalCacheStats(force) {
  if (localCacheRefresh) {
    if (force !== true) return localCacheRefresh
    await localCacheRefresh
  }
  if (!window.pet || typeof window.pet.getLocalCacheStats !== 'function') {
    renderLocalCacheStats({ status: 'unconfigured', error: '当前桌宠尚未提供本地缓存统计，请重启后查看。' })
    return Promise.resolve()
  }
  localCacheRefresh = Promise.resolve().then(function () { return window.pet.getLocalCacheStats({ force: force === true }) }).then(renderLocalCacheStats)
    .catch(function () { renderLocalCacheStats({ status: 'error', error: 'CC Switch 数据读取失败' }) })
    .finally(function () { localCacheRefresh = null })
  return localCacheRefresh
}
function renderCacheMonitor(m) {
  if (!cacheMonitorPanel) return
  if (!m) { cacheMonitorPanel.style.display = 'none'; return }
  cacheMonitorPanel.style.display = 'flex'
  var status = String(m.status || 'pending')
  var rate = status === 'error' || status === 'unconfigured' || status === 'partial' || status === 'paused' || status === 'pending' || status === 'disabled' || m.complete === false || m.rate === null || typeof m.rate === 'undefined' ? null : Number(m.rate)
  cacheMonitorRate.textContent = Number.isFinite(rate) ? pct(Math.max(0, Math.min(1, rate))) : '--'
  var statusText = monitorStatusText[status] || '等待数据'
  cacheMonitorStatus.textContent = '1 分钟缓存告警 · ' + statusText
  ;['low', 'error', 'pending', 'idle', 'partial', 'ok', 'disabled', 'unconfigured', 'paused'].forEach(function (name) { cacheMonitorPanel.classList.remove(name) })
  cacheMonitorPanel.classList.add(status)
  var parts = ['阈值 80%', 'CC Switch · 本机 Codex 代理']
  if (status === 'ok' || status === 'low' || status === 'idle' || status === 'partial') {
    parts.push(cacheWindowDetails(m))
  }
  if (status === 'unconfigured') parts.push('请确认 CC Switch 本机代理已启用请求日志')
  if (m.error) parts.push(String(m.error))
  else if (status === 'pending') parts.push('每分钟检查最近 60 秒')
  if (status === 'disabled') parts.push('在设置中开启')
  if (status === 'paused') parts.push(m.pausedUntil ? '恢复时间 ' + monitorTime(m.pausedUntil) : '在设置中立即恢复')
  if (status === 'partial') parts.push('样本口径不完整，本窗口不告警')
  if (m.checkedAt) parts.push('检查 ' + monitorTime(m.checkedAt))
  if (m.nextCheckAt && status !== 'disabled' && status !== 'unconfigured') parts.push('下次 ' + monitorTime(m.nextCheckAt))
  cacheMonitorInfo.textContent = parts.join(' · ')
}
function refreshCacheMonitor() {
  if (!window.pet || typeof window.pet.getCacheMonitor !== 'function') {
    if (cacheMonitorPanel) cacheMonitorPanel.style.display = 'none'
    return
  }
  return Promise.resolve(window.pet.getCacheMonitor()).then(renderCacheMonitor).catch(function () { renderCacheMonitor({ status: 'error', threshold: 80, rate: null, checkedAt: null }) })
}

function buildBuckets(samples, accountTrend, hours, range) {
  var now = range ? range.end : Date.now()
  var start = range ? range.start : now - (hours || 24) * 3600000
  var byHour = {}, estimatedByHour = {}, previous = null
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i]; if (!s || !Number.isFinite(s.t) || !Number.isFinite(s.remaining) || s.t > now) continue
    var key = Math.floor(s.t / 3600000)
    if (s.t >= start) {
      var consumed = Number.isFinite(s.estimatedConsumed) ? s.estimatedConsumed
        : previous && s.remaining < previous.remaining ? previous.remaining - s.remaining : 0
      estimatedByHour[key] = (estimatedByHour[key] || 0) + consumed
    }
    previous = s
    if (s.t >= start) byHour[key] = s
  }
  var realByHour = {}
  if (Array.isArray(accountTrend)) for (var j = 0; j < accountTrend.length; j++) {
    var p = accountTrend[j], ts = p && Number.isFinite(p.t) ? p.t : trendDate(p && p.date)
    if (!p || !Number.isFinite(ts) || ts < start || ts > now) continue
    var hk = Math.floor(ts / 3600000), row = realByHour[hk] || { consumed: 0, requests: 0, inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, totalTokens: 0 }
    row.consumed += n(p.actual_cost); row.requests += n(p.requests); row.inputTokens += n(p.input_tokens); row.outputTokens += n(p.output_tokens)
    row.cacheCreation += n(p.cache_creation_tokens); row.cacheRead += n(p.cache_read_tokens); row.totalTokens += n(p.total_tokens)
    row.cacheAvailable = row.cacheAvailable !== false && p.cacheAvailable !== false
    realByHour[hk] = row
  }
  var startHour = Math.floor(start / 3600000), endHour = Math.floor(now / 3600000), buckets = []
  for (var h = startHour; h <= endHour; h++) {
    var sample = byHour[h], real = realByHour[h], remaining = sample && typeof sample.remaining === 'number' ? sample.remaining : null
    var denom = real ? real.cacheRead + real.cacheCreation + real.inputTokens : 0
    buckets.push({ t: h * 3600000, remaining: remaining,
      consumed: real ? real.consumed : (Array.isArray(accountTrend) ? 0 : (estimatedByHour[h] || 0)),
      cacheRate: real && real.cacheAvailable && denom ? real.cacheRead / denom : null,
      hasData: !!sample || !!real })
  }
  return buckets
}

function draw() {
  var hours = selectedHours, request = ++drawRequest
  var refreshBtn = document.getElementById('refreshBtn')
  refreshBtn.disabled = true
  refreshInfo.textContent = '正在更新…'
  return window.pet.getUsageWindow(hours).then(function (data) {
    if (!data || request !== drawRequest) return
    var samples = data.samples || [], currency = data.currency || (data.siteType === 'deepseek' ? 'CNY' : 'USD'), sym = symFor(currency)
    // 已配置账号而同步失败时只画余额；不把余额下降估算冒充账号消费。
    var trend = data.accountConfigured && !data.accountAuth ? [] : data.accountTrend
    var buckets = buildBuckets(samples, trend, hours, { start: data.windowStart, end: data.windowEnd })
    var summary = data.accountSummary, last = null
    for (var i = samples.length - 1; i >= 0; i--) if (typeof (samples[i] || {}).remaining === 'number') { last = samples[i]; break }
    title.textContent = '使用与缓存统计'
    usedLabel.textContent = hours + ' 小时消耗' + (data.accountConfigured ? '' : '（估算）')
    cacheLabel.textContent = hours + ' 小时缓存命中率'
    document.getElementById('kBalance').textContent = data.mode === 'quota_limited' ? '当前余额（Key 额度）' : '当前余额'
    cBalance.textContent = last ? sym + fmtNum(last.remaining) : '--'
    var estimate = buckets.reduce(function (sum, b) { return sum + b.consumed }, 0)
    cUsed.textContent = summary ? sym + fmtNum(summary.actualCost) : (data.accountConfigured ? '--' : sym + fmtNum(estimate))
    cToday.textContent = typeof data.todayUsed === 'number' ? sym + fmtNum(data.todayUsed) + (data.todayStale ? ' *' : '') : '--'
    cToday.title = (data.todayStale ? '待同步，保留上次金额。' : '') + (data.accountUpdatedAt ? '上次账号同步：' + new Date(data.accountUpdatedAt).toLocaleString('zh-CN', { hour12: false }) : '')
    cCacheRate.textContent = summary ? pct(summary.cacheRate) : '--'
    var cacheAvailable = summary && summary.cacheAvailable
    cCacheTokens.textContent = cacheAvailable ? fmtTokens(summary.cacheReadTokens) : '--'
    document.getElementById('cRequests').textContent = summary ? summary.requests.toLocaleString('zh-CN') : '--'
    document.getElementById('cTokens').textContent = summary ? fmtTokens(summary.totalTokens) : '--'
    document.getElementById('cacheBreakdown').textContent = cacheAvailable
      ? '缓存读取 ' + fmtTokens(summary.cacheReadTokens) + ' · 缓存写入 ' + fmtTokens(summary.cacheCreationTokens) + ' · 未缓存输入 ' + fmtTokens(summary.inputTokens)
      : '缓存字段尚不可用'
    var hasData = buckets.some(function (b) { return b.hasData }), hasCache = buckets.some(function (b) { return b.cacheRate !== null })
    emptyHint.style.display = hasData ? 'none' : 'block'; cacheEmpty.style.display = hasCache ? 'none' : 'flex'
    cacheEmpty.textContent = data.accountError ? '账号统计暂时无法更新' : (cacheAvailable ? '这个时段没有输入 Token' : '登录面板账号后可查看缓存数据')
    drawChart(buckets); drawCacheChart(buckets)
    refreshInfo.textContent = data.accountError || ('更新于 ' + new Date(data.windowEnd).toLocaleTimeString('zh-CN', { hour12: false }) + (data.accountAuth ? ' · 账号真实数据' : ' · 本地估算'))
    var dateFormat = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    document.getElementById('rangeInfo').textContent = new Date(data.windowStart).toLocaleString('zh-CN', dateFormat) + ' — ' + new Date(data.windowEnd).toLocaleString('zh-CN', dateFormat) + ' · 按小时汇总，包含当前小时'
  }).catch(function () {
    if (request !== drawRequest) return
    refreshInfo.textContent = '统计更新失败，已显示的数据可能过期；可点击刷新重试'
  }).finally(function () { if (request === drawRequest) refreshBtn.disabled = false })
}

function drawChart(buckets) {
  var W = canvas.width, H = canvas.height, padL = 90, padR = 90, padT = 30, padB = 56, iw = W - padL - padR, ih = H - padT - padB
  ctx.clearRect(0, 0, W, H); var vals = buckets.filter(function (b) { return b.remaining !== null }).map(function (b) { return b.remaining }), maxV = vals.length ? Math.max.apply(null, vals) : 1, minV = vals.length ? Math.min.apply(null, vals) : 0, span = maxV - minV
  maxV += span * .12 + .5; minV = Math.max(0, minV - span * .08 - .5); var maxC = 0; buckets.forEach(function (b) { maxC = Math.max(maxC, b.consumed) }); var barMax = maxC * 1.3 || 1
  function xAt(i) { return padL + (buckets.length <= 1 ? iw / 2 : iw * i / (buckets.length - 1)) } function yAt(v) { return padT + ih * (1 - (v - minV) / (maxV - minV || 1)) }
  ctx.strokeStyle = COLORS.grid; ctx.fillStyle = COLORS.text; ctx.lineWidth = 1; ctx.font = '20px "Microsoft YaHei", sans-serif'
  for (var g = 0; g <= 4; g++) { var gy = padT + ih * g / 4; ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(fmtNum(maxV - (maxV - minV) * g / 4), padL - 10, gy + 7) }
  ctx.textAlign = 'left'
  for (var right = 0; right <= 4; right++) {
    ctx.fillText(fmtNum(barMax * (1 - right / 4)), W - padR + 10, padT + ih * right / 4 + 7)
  }
  ctx.textAlign = 'center'; var step = Math.ceil((buckets.length - 1) / 6); for (var t = 0; t < buckets.length; t += step || 1) { var d = new Date(buckets[t].t); ctx.fillText(String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':00', xAt(t), H - 18) }
  ctx.fillStyle = COLORS.bar; var barW = Math.max(3, iw / buckets.length * .45); buckets.forEach(function (b, i) { if (!b.consumed) return; var bx = xAt(i) - barW / 2, by = padT + ih * (1 - b.consumed / barMax); ctx.fillRect(bx, by, barW, padT + ih - by) })
  ctx.strokeStyle = COLORS.line; ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; var started = false; ctx.beginPath(); buckets.forEach(function (b, i) { if (b.remaining === null) { started = false; return } var px = xAt(i), py = yAt(b.remaining); if (!started) { ctx.moveTo(px, py); started = true } else ctx.lineTo(px, py) }); ctx.stroke()
  ctx.fillStyle = COLORS.line
  buckets.forEach(function (b, i) {
    if (b.remaining === null) return
    ctx.beginPath(); ctx.arc(xAt(i), yAt(b.remaining), 5.5, 0, Math.PI * 2); ctx.fill()
  })
}

function drawCacheChart(buckets) {
  var W = cacheCanvas.width, H = cacheCanvas.height, padL = 90, padR = 30, padT = 22, padB = 42, iw = W - padL - padR, ih = H - padT - padB
  cacheCtx.clearRect(0, 0, W, H); function xAt(i) { return padL + (buckets.length <= 1 ? iw / 2 : iw * i / (buckets.length - 1)) } function yAt(v) { return padT + ih * (1 - v) }
  cacheCtx.strokeStyle = COLORS.grid; cacheCtx.fillStyle = COLORS.text; cacheCtx.lineWidth = 1; cacheCtx.font = '18px "Microsoft YaHei", sans-serif'
  for (var g = 0; g <= 4; g++) { var gy = padT + ih * g / 4; cacheCtx.beginPath(); cacheCtx.moveTo(padL, gy); cacheCtx.lineTo(W - padR, gy); cacheCtx.stroke(); cacheCtx.textAlign = 'right'; cacheCtx.fillText((100 - g * 25) + '%', padL - 10, gy + 6) }
  cacheCtx.textAlign = 'center'; var step = Math.ceil((buckets.length - 1) / 6); for (var t = 0; t < buckets.length; t += step || 1) { var d = new Date(buckets[t].t); cacheCtx.fillText(String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':00', xAt(t), H - 12) }
  cacheCtx.strokeStyle = COLORS.cache; cacheCtx.lineWidth = 5; cacheCtx.lineJoin = 'round'; cacheCtx.lineCap = 'round'; var started = false; cacheCtx.beginPath(); buckets.forEach(function (b, i) { if (b.cacheRate === null) { started = false; return } var px = xAt(i), py = yAt(b.cacheRate); if (!started) { cacheCtx.moveTo(px, py); started = true } else cacheCtx.lineTo(px, py) }); cacheCtx.stroke()
  // 没有请求的小时保持缺口，单个有数据的小时也必须能看见。
  cacheCtx.fillStyle = COLORS.cache
  buckets.forEach(function (b, i) {
    if (b.cacheRate === null) return
    cacheCtx.beginPath(); cacheCtx.arc(xAt(i), yAt(b.cacheRate), 5.5, 0, Math.PI * 2); cacheCtx.fill()
  })
}

Array.prototype.forEach.call(document.querySelectorAll('[data-hours]'), function (button) {
  button.addEventListener('click', function () {
    selectedHours = Number(button.getAttribute('data-hours'))
    Array.prototype.forEach.call(document.querySelectorAll('[data-hours]'), function (b) {
      b.classList.toggle('active', b === button)
      b.setAttribute('aria-pressed', String(b === button))
    })
    cUsed.textContent = cCacheRate.textContent = cCacheTokens.textContent = '--'
    draw()
  })
})
function refreshAll() {
  refreshLocalCacheStats(true)
  refreshCacheMonitor()
  return draw()
}
document.getElementById('refreshBtn').addEventListener('click', refreshAll)
window.pet.onConfigUpdated(refreshAll)
if (window.pet && typeof window.pet.onCacheMonitorUpdated === 'function') window.pet.onCacheMonitorUpdated(function (monitor) {
  renderCacheMonitor(monitor)
  if (monitor && monitor.status === 'paused') renderLocalCacheStats({ status: 'paused', pausedUntil: monitor.pausedUntil })
  else refreshLocalCacheStats()
})
refreshLocalCacheStats()
refreshCacheMonitor()
window.__localCachePoll = setInterval(refreshLocalCacheStats, 30000)
window.__cacheMonitorPoll = setInterval(refreshCacheMonitor, 30000)
draw(); setInterval(draw, 30000)
