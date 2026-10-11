// 中转站余额桌宠（基座：deepseek-whale-pet）—— 主进程
// 改造点：Sub2API 站点适配（GET /v1/usage）、近24小时使用采样与统计窗口、
// 预留远程推送（Webhook，默认关闭）。原 DeepSeek 模式与全部原有功能保留。
'use strict'

const { app, BrowserWindow, ipcMain, screen, nativeImage, Tray, Menu, Notification, dialog, globalShortcut } = require('electron')

// 允许 Web Audio 无需用户手势即可播放（余额刷新是后台动作）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { capturePlacement, placeWindow } = require('./window-placement')
const { readLocalCacheStats } = require('./ccswitch-cache')

// 自检使用独立配置与离线响应，不覆盖常驻实例的设置、自启或凭据。
const SELF_TEST_MODE = process.argv.some((arg) => ['--smoke-test', '--fs-smoke-test', '--jwt-smoke-test'].includes(arg))
if (SELF_TEST_MODE) {
  const supplied = process.env.WHALE_PET_TEST_USER_DATA
  if (supplied && path.resolve(supplied).toLowerCase() === path.resolve(app.getPath('userData')).toLowerCase()) {
    throw new Error('自检必须使用独立的用户数据目录')
  }
  const testDir = supplied || fs.mkdtempSync(path.join(app.getPath('temp'), 'relay-pet-self-test-'))
  fs.mkdirSync(testDir, { recursive: true })
  app.setPath('userData', testDir)
  if (!supplied) {
    fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({
      apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid', panelEmail: 'fixture@example.invalid',
      panelPassword: 'fixture-password', refreshSec: 0, autoStart: false, autoHideFullscreen: false,
      snap: true, quotesEnabled: false, sound: false,
    }), 'utf8')
    let testLogins = 0
    globalThis.fetch = async (url) => {
      let data
      if (String(url).endsWith('/auth/login')) data = { code: 0, data: { access_token: 'fixture-' + (++testLogins) + '-'.repeat(140), expires_in: 3600 } }
      else if (String(url).endsWith('/dashboard/stats')) data = { code: 0, data: { today_actual_cost: 3.21, today_requests: 7 } }
      else if (String(url).includes('/dashboard/trend')) data = { code: 0, data: { trend: [] } }
      else if (String(url).endsWith('/v1/usage')) data = { remaining: 12, unit: 'CNY', mode: 'unrestricted', usage: { total: { cost: 5 } } }
      else throw new Error('自检未定义的请求')
      return { ok: true, status: 200, json: async () => data }
    }
  }
}

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DEFAULT_SUB2API_BASE = '' // 首次使用由用户配置站点，不内置私人地址
const appIconPath = path.join(__dirname, 'assets', 'app-icon.png')
const DEFAULT_SIZE = 196
const MIN_SIZE = 96
const MAX_SIZE = 292
const MIN_SCALE = 0.6
const MAX_SCALE = 1.4

// ---------------------------------------------------------------------------
// 配置（AppData/relay-balance-pet/config.json）
// ---------------------------------------------------------------------------
const configPath = () => path.join(app.getPath('userData'), 'config.json')
const historyPath = () => path.join(app.getPath('userData'), 'history.json')
const usageHistoryPath = () => path.join(app.getPath('userData'), 'usage-history.json')
const cacheMonitorPath = () => path.join(app.getPath('userData'), 'cache-monitor.json')
const customImagePath = () => path.join(app.getPath('userData'), 'custom-pet.png')

function defaultConfig() {
  return {
    apiKey: '',
    siteType: 'sub2api',       // sub2api | deepseek
    baseUrl: DEFAULT_SUB2API_BASE, // Sub2API 站点根地址
    balanceUrl: '',            // DeepSeek 模式余额接口
    snap: true,
    label: '账号余额',
    refreshSec: 30,
    scale: 1,
    x: null,
    y: null,
    placement: null,       // 显示器与贴边锚点；工作区变化后保持原贴边方向
    lowBalanceAlert: true,
    lowThreshold: 5,
    autoStart: false,
    idleTransparency: true,
    idleSec: 5,
    trackStats: true,
    mood: false,           // 表情功能已移除（保留键位兼容旧配置）
    bounceAnim: true,
    sound: true,
    dailySpendAlertEnabled: true,
    dailySpendAlertStep: 10, // 按账户币种的今日实际消费，每跨一个节点提醒一次
    cacheMonitorEnabled: true,
    cacheAlertThreshold: 80,
    cacheAlertSoundEnabled: true,
    cacheMonitorRepeatAlertEnabled: false,
    ccsStatsPausedUntil: 0,
    quotesEnabled: true,   // 随机语录默认开：未自定义时使用内置 20 条
    quotesText: '',
    customImage: false,
    hotkey: true,
    trayIcon: true,
    showTime: false,       // 气泡默认不显示时间（显示余额+今日已用两行）
    alwaysOnTop: true,      // 是否始终置顶
    lockPosition: true,     // 锁定位置：不可拖动，融入桌面（设置里解锁）
    autoHideFullscreen: true, // 有应用全屏/无边框全屏时自动隐身，退出全屏恢复
    // 预留：远程推送（Webhook），默认关闭；启用后低余额/余额变动会 POST JSON 到 pushUrl
    pushEnabled: false,
    pushUrl: '',
    panelEmail: '',          // 面板账号（可选）：填了即启用账号级真实用量统计
    panelPassword: '',
  }
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    // 仅迁移旧默认名称，保留用户自定义的余额名称；读取不改写配置文件。
    if (c.label === '中转余额') c.label = '账号余额'
    return { ...defaultConfig(), ...c }
  } catch {
    return defaultConfig()
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  const temp = configPath() + '.tmp'
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(temp, configPath())
  } catch (err) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch { /* retain original */ }
    throw new Error('配置保存失败：' + String(err && err.message || err).slice(0, 150))
  }
  return next
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const petSize = (scale) => Math.round(clamp(DEFAULT_SIZE * scale, MIN_SIZE, MAX_SIZE))

let petWin = null
let settingsWin = null
let tray = null
let balanceCache = null
let balanceInFlight = null
let posSaveTimer = null
let balanceFetchCount = 0
let stats = { today: '', todayUsed: 0, lastBalance: null, currency: null, todaySource: 'estimated', todayStale: false }
let statsLoaded = false
let lastLowAlertAt = 0
let cfg = loadConfig()
let petLayout = null
let petLayoutTimer = null
let petRecoveryTimer = null
let petRecoveryAttempts = 0
let isQuitting = false

// CC Switch 本机 Codex 代理：每分钟检查最近 60 秒，有效缓存率低于 80% 即通知。
const CACHE_MONITOR_INTERVAL_MS = 60 * 1000
const LOCAL_CACHE_STATS_TTL_MS = 30 * 1000
const CACHE_NOTIFICATION_TIMEOUT_MS = 8000
const cacheNotificationRefs = new Set()
const cacheNotificationInFlight = new Map()
let cacheMonitor = null
let cacheMonitorLoaded = false
let cacheMonitorTimer = null
let cacheMonitorInFlight = null
let cacheMonitorGeneration = 0
let localCacheStatsCache = null
let localCacheStatsInFlight = null
let localCacheStatsGeneration = 0
let localCacheStatsStartedAt = 0

function cacheMonitorDefault() {
  return {
    version: 3, method: 'ccswitch-minute', sourceId: '', timezone: '',
    lastCheckedMinute: null, lastAlertMinute: null, lastAlertAttemptMinute: null,
    status: 'unconfigured', rate: null, checkedAt: 0, sampledAt: 0,
    sampleStart: 0, sampleEnd: 0, nextCheckAt: 0,
    requests: 0, validRequests: 0, excludedRequests: 0, complete: true,
    inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, uncachedInputTokens: 0,
    alertActive: false, lastAlertAt: 0, error: '',
  }
}

function cacheMonitorTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
}

function cacheMonitorSource(c = loadConfig()) {
  return fingerprint(['ccswitch-minute-codex-proxy-v1', ccSwitchDatabasePath()])
}

function ccSwitchDatabasePath() {
  return path.join(app.getPath('home'), '.cc-switch', 'cc-switch.db')
}

function cacheStatsPauseUntil(c = loadConfig()) {
  const until = Number(c.ccsStatsPausedUntil)
  return Number.isSafeInteger(until) && until > Date.now() ? until : 0
}

function emptyPausedCacheStats(now, pausedUntil) {
  return {
    status: 'paused', source: 'CC Switch · 本机 Codex 代理', sampledAt: now,
    latestRequestAt: null, pausedUntil, error: '', cached: false,
    minute: { sampleStart: now - 60000, sampleEnd: now, requests: 0, validRequests: 0,
      excludedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, uncachedInputTokens: 0, rate: null, complete: true },
    hour: { sampleStart: now - 3600000, sampleEnd: now, requests: 0, validRequests: 0,
      excludedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, uncachedInputTokens: 0, rate: null, complete: true },
  }
}

async function getLocalCacheStats(options = {}) {
  const now = Date.now()
  const pausedUntil = cacheStatsPauseUntil()
  if (pausedUntil) return emptyPausedCacheStats(now, pausedUntil)
  const force = options === true || !!(options && options.force === true)
  const sampledAt = localCacheStatsCache && localCacheStatsCache.value.sampledAt
  const age = now - sampledAt
  if (!force && localCacheStatsCache && age >= 0 && age < LOCAL_CACHE_STATS_TTL_MS
      && Math.floor(sampledAt / CACHE_MONITOR_INTERVAL_MS) === Math.floor(now / CACHE_MONITOR_INTERVAL_MS)) {
    return { ...localCacheStatsCache.value, cached: true }
  }
  if (localCacheStatsInFlight) {
    const flight = localCacheStatsInFlight
    // 跨检查分钟的强制读取不能复用上分钟开始的查询。
    if (force && Math.floor(localCacheStatsStartedAt / CACHE_MONITOR_INTERVAL_MS) !== Math.floor(now / CACHE_MONITOR_INTERVAL_MS)) {
      await flight.catch(() => {})
      return getLocalCacheStats(options)
    }
    return flight
  }
  const generation = localCacheStatsGeneration
  localCacheStatsStartedAt = now
  const request = Promise.resolve().then(() => {
      const until = cacheStatsPauseUntil()
      if (until) return emptyPausedCacheStats(Date.now(), until)
      return readLocalCacheStats(ccSwitchDatabasePath(), Date.now())
    })
    .then(value => {
      const until = cacheStatsPauseUntil()
      if (until) return emptyPausedCacheStats(Date.now(), until)
      if (generation !== localCacheStatsGeneration) return { status: 'pending', error: '读取状态已改变，正在更新' }
      if (value && value.status !== 'paused') localCacheStatsCache = { value }
      return value
    })
    .finally(() => { if (localCacheStatsInFlight === request) localCacheStatsInFlight = null })
  localCacheStatsInFlight = request
  return request
}

function invalidateLocalCacheStats() {
  localCacheStatsGeneration++
  localCacheStatsCache = null
}

function saveCacheMonitor() {
  try {
    fs.mkdirSync(path.dirname(cacheMonitorPath()), { recursive: true })
    fs.writeFileSync(cacheMonitorPath(), JSON.stringify(cacheMonitor), 'utf8')
  } catch (err) { console.error('[cache-monitor] 保存失败：' + String(err && err.message || err)) }
}

function loadCacheMonitor() {
  if (cacheMonitorLoaded && cacheMonitor) return cacheMonitor
  cacheMonitorLoaded = true
  const fresh = cacheMonitorDefault()
  try {
    const saved = JSON.parse(fs.readFileSync(cacheMonitorPath(), 'utf8'))
    cacheMonitor = saved.version === 3 && saved.method === 'ccswitch-minute' ? { ...fresh, ...saved } : fresh
  } catch { cacheMonitor = fresh }
  const sourceId = cacheMonitorSource(loadConfig())
  if (cacheMonitor.sourceId && cacheMonitor.sourceId !== sourceId) {
    cacheMonitor = { ...fresh, sourceId, timezone: cacheMonitorTimezone() }
    saveCacheMonitor()
  } else {
    cacheMonitor.sourceId = sourceId
    cacheMonitor.timezone = cacheMonitorTimezone()
  }
  return cacheMonitor
}

function cacheMonitorThreshold(c = loadConfig()) {
  return 80
}

function cacheMonitorPublic() {
  const c = loadConfig()
  const m = loadCacheMonitor()
  const pausedUntil = cacheStatsPauseUntil(c)
  const enabled = c.cacheMonitorEnabled !== false
  const configured = pausedUntil ? true : fs.existsSync(ccSwitchDatabasePath())
  let status = m.status
  if (pausedUntil) status = 'paused'
  else if (!enabled) status = 'disabled'
  else if (!configured) status = 'unconfigured'
  return {
    status, enabled, threshold: 80, repeatAlertEnabled: true, method: 'ccswitch-minute',
    source: 'CC Switch · 本机 Codex 代理',
    pausedUntil,
    lastCheckedMinute: m.lastCheckedMinute, lastAlertMinute: m.lastAlertMinute,
    soundEnabled: c.cacheAlertSoundEnabled !== false,
    rate: pausedUntil ? null : (Number.isFinite(m.rate) ? m.rate : null),
    checkedAt: m.checkedAt || 0, sampledAt: m.sampledAt || 0,
    sampleStart: m.sampleStart || 0, sampleEnd: m.sampleEnd || 0,
    nextCheckAt: m.nextCheckAt || 0, requests: m.requests || 0,
    validRequests: m.validRequests || 0, excludedRequests: m.excludedRequests || 0, complete: m.complete !== false,
    inputTokens: m.inputTokens || 0, cacheReadTokens: m.cacheReadTokens || 0,
    cacheCreationTokens: m.cacheCreationTokens || 0, uncachedInputTokens: m.uncachedInputTokens || 0, alertActive: !!m.alertActive,
    lastAlertAt: m.lastAlertAt || 0, error: m.error || '',
  }
}

function cacheMonitorSet(patch, persist = true) {
  cacheMonitor = { ...loadCacheMonitor(), ...patch }
  if (persist) saveCacheMonitor()
  if (statsWin && !statsWin.isDestroyed()) statsWin.webContents.send('pet:cache-monitor-updated', cacheMonitorPublic())
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('pet:cache-monitor-updated', cacheMonitorPublic())
  return cacheMonitor
}

// ---------------------------------------------------------------------------
// 消耗统计（按自然日累计，持久化到 history.json）
// ---------------------------------------------------------------------------
function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function loadStats() {
  try {
    const h = JSON.parse(fs.readFileSync(historyPath(), 'utf8'))
    const today = todayKey()
    if (h.today === today) {
      stats = { ...h, today, todayUsed: typeof h.todayUsed === 'number' ? h.todayUsed : null,
        lastBalance: typeof h.lastBalance === 'number' ? h.lastBalance : null }
    } else {
      stats = { ...h, today, todayUsed: panelAuthConfigured() ? null : 0,
        todaySource: panelAuthConfigured() ? 'pending' : 'estimated', todayStale: false, accountUpdatedAt: 0,
        lastBalance: typeof h.lastBalance === 'number' ? h.lastBalance : null }
    }
  } catch {
    stats = { today: todayKey(), todayUsed: panelAuthConfigured() ? null : 0, lastBalance: null,
      todaySource: panelAuthConfigured() ? 'pending' : 'estimated', todayStale: false }
  }
  statsLoaded = true
  return stats
}

function ensureStats() {
  if (!statsLoaded) loadStats()
  const today = todayKey()
  if (stats.today !== today) {
    stats = { ...stats, today, todayUsed: panelAuthConfigured() ? null : 0,
      todaySource: panelAuthConfigured() ? 'pending' : 'estimated', todayStale: false, accountUpdatedAt: 0 }
  }
  return stats
}

function saveStats() {
  try {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true })
    fs.writeFileSync(historyPath(), JSON.stringify(stats), 'utf8')
  } catch (err) { /* ignore */ }
}

function spendAlertStep(value, fallback = 10) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(clamp(n, 0.01, 100000) * 100) / 100 : fallback
}

// 仅新鲜的账号实际消费可触发；节点高水位持久化，防止重启、回调或重复刷新重报。
function updateDailySpendNotice(c, sourceId, allowAlert = true) {
  if (stats.todaySource !== 'account' || stats.todayStale || !Number.isFinite(stats.todayUsed) || stats.todayUsed < 0) return
  const step = spendAlertStep(c.dailySpendAlertStep)
  const enabled = c.dailySpendAlertEnabled !== false && c.trackStats !== false
  const bucket = Math.floor((stats.todayUsed * 100 + 1e-7) / (step * 100))
  const previous = stats.dailySpendNotice
  const sameRule = previous && previous.sourceId === sourceId && previous.currency === stats.currency && previous.step === step && previous.enabled === enabled
  // 首次启用/规则变化建立当前基准；已跟踪的账户跨自然日从零开始。
  const highWater = sameRule ? (previous.day === stats.today ? previous.bucket : 0) : bucket
  stats.dailySpendNotice = { day: stats.today, sourceId, currency: stats.currency, step, enabled,
    bucket: allowAlert ? Math.max(highWater, bucket) : bucket }
  saveStats()
  if (allowAlert && enabled && bucket > highWater && petWin && !petWin.isDestroyed()) {
    // 一次刷新跨多个节点合并为一次，避免连响。
    petWin.webContents.send('pet:daily-spend-alert', {
      todayUsed: stats.todayUsed, threshold: Math.round(bucket * step * 100) / 100,
      step, currency: stats.currency, sound: c.sound !== false, bounceAnim: c.bounceAnim !== false,
    })
  }
}

function recordBalance(nb) {
  if (typeof nb !== 'number' || !isFinite(nb)) return
  ensureStats()
  if (!panelAuthConfigured() && stats.lastBalance !== null && nb < stats.lastBalance) {
    stats.todayUsed = Math.round((stats.todayUsed + (stats.lastBalance - nb)) * 100) / 100
  }
  stats.lastBalance = nb
  saveStats()
}

// ---------------------------------------------------------------------------
// 本机余额采样只补充余额曲线；账号消费和缓存数据直接从 JWT 接口读取。
// 最长查看 144 小时，多留一小时作为余额差值的前一个采样点。
// ---------------------------------------------------------------------------
const USAGE_HISTORY_MAX_POINTS = 18000
let usageHistory = []
let usageHistoryLoaded = false

function loadUsageHistory() {
  if (usageHistoryLoaded) return usageHistory
  usageHistoryLoaded = true
  try {
    const h = JSON.parse(fs.readFileSync(usageHistoryPath(), 'utf8'))
    if (Array.isArray(h.samples)) usageHistory = h.samples
  } catch { usageHistory = [] }
  return usageHistory
}

function saveUsageHistory() {
  try {
    fs.mkdirSync(path.dirname(usageHistoryPath()), { recursive: true })
    fs.writeFileSync(usageHistoryPath(), JSON.stringify({ samples: usageHistory }), 'utf8')
  } catch (err) { /* ignore */ }
}

function appendUsageSample(extra) {
  const now = Date.now()
  const cutoff = now - 145 * 60 * 60 * 1000
  const samples = loadUsageHistory()
  while (samples.length && samples[0].t < cutoff) samples.shift()
  samples.push({ t: now, ...(extra || {}) })
  while (samples.length > USAGE_HISTORY_MAX_POINTS) samples.shift()
  saveUsageHistory()
}

// ---------------------------------------------------------------------------
// 低余额提醒
// ---------------------------------------------------------------------------
function notifyLowBalance(total, currency) {
  const now = Date.now()
  // 至少 10 分钟内不重复提醒
  if (now - lastLowAlertAt < 10 * 60 * 1000) return
  lastLowAlertAt = now
  const sym = currency === 'CNY' ? '¥' : (currency === 'USD' ? '$' : (currency || ''))
  const n = new Notification({
    icon: appIconPath,
    title: '账号余额不足提醒',
    body: '当前余额：' + sym + ' ' + Number(total).toFixed(2) + ' ' + (currency || '') + '\n记得及时充值，避免任务中断～',
  })
  n.show()
  pushEvent('low_balance', { balance: Number(total), currency: currency || '' })
}

// ---------------------------------------------------------------------------
// 远程推送（预留，默认关闭）
// 启用后向 pushUrl POST JSON：{ event, balance, currency, usedToday, requestsToday, ts }
// 兼容 Bark / Server酱 / 企业微信机器人 / 自建 Webhook 等，只做单次 POST，不重试。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 面板登录（可选）：配置了面板账号/密码后，用 JWT 拉账号级真实用量
// （today_actual_cost=今日实际扣除、dashboard/trend=按小时真实消耗，跨全部 Key）
// JWT 只存内存，过期/401 自动重登；未配置或登录失败时回退本地余额差值统计。
// ---------------------------------------------------------------------------
let panelJwt = null
let panelJwtExpiresAt = 0
let panelLoginBlockedUntil = 0   // 登录失败后 5 分钟冷却，避免 30s 轮询反复打登录接口
let panelIdentity = ''
let panelAuthGeneration = 0
let panelLoginInFlight = null
let panelAuthStatus = 'pending'

const panelBaseFor = (c) => (((c.baseUrl || '') || DEFAULT_SUB2API_BASE).trim().replace(/\/+$/, ''))
const PANEL_BASE = () => panelBaseFor(loadConfig())
const fingerprint = (values) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
const accountIdentity = (c) => fingerprint([c.siteType, panelBaseFor(c), c.panelEmail || '', c.panelPassword || ''])
const dataSourceIdentity = (c) => fingerprint([c.siteType, panelBaseFor(c), c.balanceUrl || '', c.apiKey || '', c.panelEmail || ''])

function resetPanelAuth() {
  panelJwt = null
  panelJwtExpiresAt = 0
  panelLoginBlockedUntil = 0
  panelLoginInFlight = null
  panelIdentity = ''
  panelAuthStatus = 'pending'
  panelAuthGeneration++
}

async function loginPanel(cfg) {
  if (!panelBaseFor(cfg)) throw new Error('请先在设置中填写站点地址')
  const identity = accountIdentity(cfg)
  if (panelIdentity !== identity) { resetPanelAuth(); panelIdentity = identity }
  if (panelLoginInFlight) return panelLoginInFlight
  if (Date.now() < panelLoginBlockedUntil) {
    const err = new Error('面板登录冷却中（失败后 5 分钟内不重试）')
    err.code = 'LOGIN_COOLDOWN'
    throw err
  }
  const generation = panelAuthGeneration
  panelAuthStatus = 'logging-in'
  const request = (async () => {
   try {
    const res = await fetch(panelBaseFor(cfg) + '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cfg.panelEmail, password: cfg.panelPassword }),
      signal: AbortSignal.timeout(20000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.code !== 0 || !data.data || !data.data.access_token) {
      const msg = (data && data.message) || ('HTTP ' + res.status)
      const err = new Error('面板登录失败：' + msg)
      err.code = 'LOGIN_' + (data && data.code)
      err.authenticationFailed = res.status === 400 || res.status === 401 || res.status === 403
      throw err
    }
    if (generation !== panelAuthGeneration || identity !== accountIdentity(loadConfig())) {
      throw new Error('登录配置已变更，请重新刷新')
    }
    panelJwt = data.data.access_token
    const ttl = Math.max(1, pickNum(data.data.expires_in) || 86400)
    let expiry = Date.now() + ttl * 1000
    try {
      const claims = JSON.parse(Buffer.from(panelJwt.split('.')[1], 'base64url').toString('utf8'))
      if (Number.isFinite(claims.exp)) expiry = Math.min(expiry, claims.exp * 1000)
    } catch { /* opaque tokens use expires_in */ }
    const margin = Math.min(120000, Math.max(1000, (expiry - Date.now()) * 0.1))
    panelJwtExpiresAt = Math.max(Date.now(), expiry - margin)
    panelLoginBlockedUntil = 0
    panelAuthStatus = 'valid'
    return panelJwt
  } catch (err) {
    // 登录失败（含网络错误）→ 冷却 5 分钟，期间回退本地差值统计
    if (generation === panelAuthGeneration) {
      panelJwt = null
      panelJwtExpiresAt = 0
      panelAuthStatus = 'retrying'
      panelLoginBlockedUntil = Date.now() + (err.authenticationFailed ? 5 * 60 * 1000 : 15000)
    }
    throw err
   }
  })()
  panelLoginInFlight = request
  try { return await request }
  finally { if (panelLoginInFlight === request) panelLoginInFlight = null }
}

async function ensurePanelJwt() {
  const cfg = loadConfig()
  if (!cfg.panelEmail || !cfg.panelPassword) throw new Error('未配置面板账号')
  if (panelIdentity !== accountIdentity(cfg)) { resetPanelAuth(); panelIdentity = accountIdentity(cfg) }
  if (panelJwt && Date.now() < panelJwtExpiresAt) return panelJwt
  return loginPanel(cfg)
}

async function panelAuthedFetch(path) {
  const cfg = loadConfig()
  const identity = accountIdentity(cfg)
  const tryOnce = async (jwt) => fetch(panelBaseFor(cfg) + path, {
    headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  const token = await ensurePanelJwt()
  let res = await tryOnce(token)
  if (res.status === 401) {           // 过期/失效 → 重登一次再试
    if (identity !== accountIdentity(loadConfig())) throw new Error('登录配置已变更')
    if (panelJwt === token) { panelJwt = null; panelJwtExpiresAt = 0 }
    res = await tryOnce(await ensurePanelJwt())
  }
  if (identity !== accountIdentity(loadConfig())) throw new Error('登录配置已变更')
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.code !== 0) {
    if (res.status === 401 && panelIdentity === identity) { panelJwt = null; panelJwtExpiresAt = 0; panelAuthStatus = 'retrying' }
    const msg = (data && data.message) || ('HTTP ' + res.status)
    throw new Error(msg.slice(0, 120))
  }
  return data.data
}

async function getAccountTodayStats() {
  return panelAuthedFetch('/api/v1/usage/dashboard/stats')
}

async function getAccountHourlyTrend(hours = 24) {
  const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai')
  const windowHours = [24, 72, 144].includes(Number(hours)) ? Number(hours) : 24
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  const yst = new Date(d.getTime() - windowHours * 3600 * 1000)
  const ystr = yst.getFullYear() + '-' + p(yst.getMonth() + 1) + '-' + p(yst.getDate())
  return panelAuthedFetch('/api/v1/usage/dashboard/trend?granularity=hour&start_date=' + ystr + '&end_date=' + today + '&timezone=' + tz)
}

function panelAuthConfigured() {
  const c = loadConfig()
  return c.siteType !== 'deepseek' && !!(c.panelEmail && c.panelPassword)
}

function usageHours(value) {
  return [24, 72, 144].includes(Number(value)) ? Number(value) : 24
}

function summarizeAccountTrend(trend, start, end) {
  if (!Array.isArray(trend)) throw new Error('账号接口未返回小时用量')
  const rows = []
  const summary = { actualCost: 0, requests: 0, inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, cacheAvailable: true, cacheRate: null }
  for (const point of trend) {
    if (!point || typeof point.date !== 'string') continue
    const t = new Date(point.date.replace(' ', 'T')).getTime()
    if (!Number.isFinite(t) || t < start || t > end) continue
    const actualCost = pickNum(point.actual_cost)
    if (actualCost === undefined || actualCost < 0) throw new Error('账号小时用量缺少实际扣费金额')
    const count = (field) => Math.max(0, pickNum(point[field]) ?? 0)
    const cacheAvailable = ['input_tokens', 'cache_creation_tokens', 'cache_read_tokens'].every((field) => pickNum(point[field]) !== undefined && pickNum(point[field]) >= 0)
    const row = { t, date: point.date, actual_cost: actualCost, requests: count('requests'),
      input_tokens: count('input_tokens'), output_tokens: count('output_tokens'),
      cache_creation_tokens: count('cache_creation_tokens'), cache_read_tokens: count('cache_read_tokens'),
      total_tokens: count('total_tokens'), cacheAvailable }
    const inputTotal = row.input_tokens + row.cache_creation_tokens + row.cache_read_tokens
    row.cacheRate = cacheAvailable && inputTotal > 0 ? row.cache_read_tokens / inputTotal : null
    rows.push(row)
    summary.actualCost += actualCost
    summary.requests += row.requests
    summary.inputTokens += row.input_tokens
    summary.outputTokens += row.output_tokens
    summary.cacheCreationTokens += row.cache_creation_tokens
    summary.cacheReadTokens += row.cache_read_tokens
    summary.totalTokens += row.total_tokens
    summary.cacheAvailable = summary.cacheAvailable && cacheAvailable
  }
  const inputTotal = summary.inputTokens + summary.cacheCreationTokens + summary.cacheReadTokens
  summary.cacheRate = summary.cacheAvailable && inputTotal > 0 ? summary.cacheReadTokens / inputTotal : null
  return { rows: rows.sort((a, b) => a.t - b.t), summary }
}

function cacheMonitorReset(sourceId = cacheMonitorSource(loadConfig())) {
  cacheMonitor = { ...cacheMonitorDefault(), sourceId, timezone: cacheMonitorTimezone() }
  saveCacheMonitor()
  return cacheMonitor
}

function notifyCacheRate(rate, sample, demo = false) {
  if (demo) return showCacheRateNotification(rate, sample, true)
  const sourceId = cacheMonitorSource(), minute = sample.checkMinute ?? Math.floor(Date.now() / CACHE_MONITOR_INTERVAL_MS) * CACHE_MONITOR_INTERVAL_MS
  const key = sourceId + ':' + minute
  if (cacheNotificationInFlight.has(key)) return cacheNotificationInFlight.get(key)
  const delivery = showCacheRateNotification(rate, sample).then(shown => {
    // 即使确认期间监测开关有变化，已显示的同一分钟仍应去重。
    if (shown && !isQuitting && sourceId === cacheMonitorSource(loadConfig())) {
      cacheMonitorSet({ lastAlertMinute: minute, lastAlertAt: Date.now() })
    }
    return shown
  }).finally(() => {
    if (cacheNotificationInFlight.get(key) === delivery) cacheNotificationInFlight.delete(key)
  })
  cacheNotificationInFlight.set(key, delivery)
  return delivery
}

async function showCacheRateNotification(rate, sample, demo = false) {
  try {
    const c = loadConfig()
    const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const n = new Notification({
    icon: appIconPath,
      title: demo ? '1 分钟缓存告警测试（演示）' : '最近 1 分钟缓存率低于 80%',
      silent: c.cacheAlertSoundEnabled === false,
      body: 'CC Switch · 本机 Codex 代理\n' + time(sample.sampleStart) + '–' + time(sample.sampleEnd) + '\n缓存率 ' + (rate * 100).toFixed(1) + '% · 阈值 80% · ' + sample.validRequests + ' 个有效请求\n'
        + '缓存读取 ' + sample.cacheReadTokens + ' / 总输入 ' + sample.inputTokens + ' Token\n'
        + '缓存写入 ' + sample.cacheCreationTokens + ' · 未缓存输入 ' + sample.uncachedInputTokens + ' Token'
        + (demo ? '\n演示数据，不修改账号统计。' : ''),
    })
    cacheNotificationRefs.add(n)
    if (typeof n.on !== 'function') { cacheNotificationRefs.delete(n); return false }
    n.on('click', () => { openStats(); cacheNotificationRefs.delete(n) })
    n.on('close', () => cacheNotificationRefs.delete(n))
    return await new Promise(resolve => {
      let settled = false, timer = null
      const finish = (shown, error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (!shown) {
          cacheNotificationRefs.delete(n)
          try { n.close() } catch { /* failed notification may already be closed */ }
        }
        console.log('[cache-notification] ' + JSON.stringify({ shown, demo, rate, minute: sample.checkMinute, sampleStart: sample.sampleStart, silent: c.cacheAlertSoundEnabled === false, error: error || '' }))
        resolve(shown)
      }
      n.on('show', () => finish(true))
      n.on('failed', (_event, error) => finish(false, String(error || 'Windows 通知失败')))
      timer = setTimeout(() => finish(false, '等待 Windows 通知确认超时'), CACHE_NOTIFICATION_TIMEOUT_MS)
      try { n.show() } catch (error) { finish(false, String(error.message || error)) }
    })
  } catch (err) {
    console.error('[cache-monitor] 系统通知失败：' + String(err && err.message || err))
    return false
  }
}

function scheduleCacheMonitor(delay) {
  if (cacheMonitorTimer) clearTimeout(cacheMonitorTimer)
  cacheMonitorTimer = null
  if (isQuitting) {
    cacheMonitorSet({ nextCheckAt: 0 })
    return
  }
  const now = Date.now(), minute = Math.floor(now / CACHE_MONITOR_INTERVAL_MS) * CACHE_MONITOR_INTERVAL_MS
  const pausedUntil = cacheStatsPauseUntil()
  const next = pausedUntil || (typeof delay === 'number' ? now + delay : minute + CACHE_MONITOR_INTERVAL_MS)
  cacheMonitorSet({ nextCheckAt: !pausedUntil && loadConfig().cacheMonitorEnabled === false ? 0 : next })
  if (SELF_TEST_MODE || (!pausedUntil && loadConfig().cacheMonitorEnabled === false)) return
  cacheMonitorTimer = setTimeout(() => {
    cacheMonitorTimer = null
    const action = pausedUntil && Date.now() >= pausedUntil ? resumeCacheMonitor() : checkCacheMonitor()
    action.catch(error => {
      cacheMonitorSet({ error: String(error && error.message || error).slice(0, 160) })
      scheduleCacheMonitor()
    })
  }, Math.max(1000, next - now))
}

async function checkCacheMonitor(options = {}) {
  if (isQuitting) return cacheMonitorPublic()
  if (cacheMonitorInFlight) return cacheMonitorInFlight
  const sourceId = cacheMonitorSource(), generation = cacheMonitorGeneration
  const current = () => !isQuitting && generation === cacheMonitorGeneration && sourceId === cacheMonitorSource() && loadConfig().cacheMonitorEnabled !== false && !cacheStatsPauseUntil()
  const request = (async () => {
    const pausedUntil = cacheStatsPauseUntil()
    if (pausedUntil) {
      cacheMonitorSet({ status: 'paused', pausedUntil, alertActive: false, error: '', nextCheckAt: pausedUntil })
      scheduleCacheMonitor(Math.max(1000, pausedUntil - Date.now()))
      return cacheMonitorPublic()
    }
    if (loadConfig().cacheMonitorEnabled === false) {
      cacheMonitorSet({ status: 'disabled', alertActive: false, error: '', nextCheckAt: 0 })
      return cacheMonitorPublic()
    }
    let m = loadCacheMonitor()
    if (m.sourceId !== sourceId) m = cacheMonitorReset(sourceId)
    const now = Date.now(), minute = Math.floor(now / CACHE_MONITOR_INTERVAL_MS) * CACHE_MONITOR_INTERVAL_MS
    if (m.lastCheckedMinute === minute && options.force !== true) {
      scheduleCacheMonitor()
      return cacheMonitorPublic()
    }
    let data
    try {
      // 告警每分钟必须拿到新的 SQLite 快照，不能复用统计页的 30 秒缓存。
      data = options.sample || await getLocalCacheStats({ force: true })
    } catch (error) {
      data = { status: 'error', error: String(error.message || error).slice(0, 160) }
    }
    if (!current()) return cacheMonitorPublic()
    if (!data || data.status !== 'ok' || !data.minute) {
      cacheMonitorSet({ status: data && data.status === 'unconfigured' ? 'unconfigured' : 'error',
        checkedAt: now, rate: null, alertActive: false, sampleStart: now - CACHE_MONITOR_INTERVAL_MS,
        sampleEnd: now, requests: 0, validRequests: 0, excludedRequests: 0,
        inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, uncachedInputTokens: 0,
        lastCheckedMinute: minute, error: data && data.error || 'CC Switch 数据读取失败' })
      scheduleCacheMonitor()
      return cacheMonitorPublic()
    }
    const sample = { ...data.minute, checkMinute: minute }
    const complete = sample.complete !== false
    const rate = complete && sample.inputTokens > 0 && Number.isFinite(sample.rate) ? sample.rate : null
    const low = rate !== null && rate < cacheMonitorThreshold() / 100
    cacheMonitorSet({ ...sample, rate, status: !complete ? 'partial' : rate === null ? 'idle' : low ? 'low' : 'ok',
      checkedAt: now, sampledAt: data.sampledAt || now, lastCheckedMinute: minute,
      alertActive: low, error: complete ? '' : '部分成功请求的 Token 口径不明或无效，本分钟不告警' })
    if (low && m.lastAlertMinute !== minute && m.lastAlertAttemptMinute !== minute) {
      // 发送前持久化尝试槽位；失败、重启和开关切换也不会在同一分钟连发。
      cacheMonitorSet({ lastAlertAttemptMinute: minute })
      const shown = await notifyCacheRate(rate, sample)
      if (!current()) return cacheMonitorPublic()
      if (!shown) {
        cacheMonitorSet({ error: 'Windows 通知未确认；下一分钟按最新数据再检查' })
      }
    }
    scheduleCacheMonitor()
    return cacheMonitorPublic()
  })()
  cacheMonitorInFlight = request
  try { return await request } finally { if (cacheMonitorInFlight === request) cacheMonitorInFlight = null }
}

function startCacheMonitor(options = {}) {
  if (SELF_TEST_MODE) return
  Promise.resolve(cacheMonitorInFlight).catch(() => {}).then(() => checkCacheMonitor(options)).catch(error => {
    cacheMonitorSet({ error: String(error && error.message || error).slice(0, 160) })
    scheduleCacheMonitor()
  })
}

function stopCacheMonitor() {
  cacheMonitorGeneration++
  if (cacheMonitorTimer) clearTimeout(cacheMonitorTimer)
  cacheMonitorTimer = null
  if (cacheMonitorLoaded) cacheMonitorSet({ nextCheckAt: 0 })
}

async function pauseCacheMonitor(hours = 1) {
  const value = Math.round(clamp(Number(hours) || 1, 1, 168))
  const pausedUntil = Date.now() + value * 3600000
  cfg = saveConfig({ ccsStatsPausedUntil: pausedUntil })
  cacheMonitorGeneration++
  if (cacheMonitorTimer) clearTimeout(cacheMonitorTimer)
  cacheMonitorTimer = null
  invalidateLocalCacheStats()
  cacheMonitorSet({ status: 'paused', pausedUntil, alertActive: false, error: '', nextCheckAt: pausedUntil })
  scheduleCacheMonitor(Math.max(1000, pausedUntil - Date.now()))
  return cacheMonitorPublic()
}

async function resumeCacheMonitor() {
  cfg = saveConfig({ ccsStatsPausedUntil: 0 })
  cacheMonitorGeneration++
  if (cacheMonitorTimer) clearTimeout(cacheMonitorTimer)
  cacheMonitorTimer = null
  invalidateLocalCacheStats()
  cacheMonitorSet({ status: 'pending', rate: null, pausedUntil: 0, alertActive: false, error: '', nextCheckAt: 0 })
  // 已经开始的单次只读查询无法取消；等待它结束后再强制读取，避免恢复后拿到旧快照。
  if (cacheMonitorInFlight) await cacheMonitorInFlight.catch(() => {})
  if (localCacheStatsInFlight) await localCacheStatsInFlight.catch(() => {})
  const generation = cacheMonitorGeneration
  // 本地统计与告警开关独立：关闭告警时也必须立即读取；开启时共用这次新样本。
  const sample = await getLocalCacheStats({ force: true })
  if (generation !== cacheMonitorGeneration || cacheStatsPauseUntil()) return cacheMonitorPublic()
  return checkCacheMonitor({ force: true, sample })
}

function pushEvent(event, data) {
  const c = loadConfig()
  if (!c.pushEnabled || !c.pushUrl) return
  const body = JSON.stringify({ event, ...(data || {}), ts: Date.now() })
  fetch(c.pushUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10000),
  }).then((res) => {
    console.log('[push] ' + event + ' -> HTTP ' + res.status)
  }).catch((err) => {
    console.error('[push] ' + event + ' failed:', String(err && err.message || err))
  })
}

// ---------------------------------------------------------------------------
// 桌宠窗口
// ---------------------------------------------------------------------------
function petDisplays() {
  return typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]
}

function getPetGeometry() {
  const b = petWin && !petWin.isDestroyed() ? petWin.getBounds() : petLayout && petLayout.bounds
  if (!b || !petLayout) return null
  return { x: b.x, y: b.y, size: b.width, workArea: petLayout.workArea,
    bounds: petLayout.displayBounds, placement: petLayout.placement }
}

function applyPetLayout(reason = 'display-change') {
  if (!petWin || petWin.isDestroyed() || isQuitting) return
  // 缓存旧工作区的锚点，避免 Windows 先挪动窗口后丢失右/下贴边信息。
  const previous = petLayout || { bounds: petWin.getBounds(), placement: cfg.placement }
  const nextLayout = placeWindow({ displays: petDisplays(), primaryDisplayId: screen.getPrimaryDisplay().id,
    bounds: previous.bounds, size: petSize(cfg.scale), snap: cfg.snap !== false, placement: previous.placement })
  const actual = petWin.getBounds()
  if (JSON.stringify(nextLayout) === JSON.stringify(petLayout) &&
      actual.x === nextLayout.bounds.x && actual.y === nextLayout.bounds.y &&
      actual.width === nextLayout.bounds.width && actual.height === nextLayout.bounds.height) return
  petLayout = nextLayout
  petWin.setBounds(petLayout.bounds)
  schedulePosSave()
  petWin.webContents.send('pet:geometry-updated', getPetGeometry())
  recordLifecycle('layout', { reason, ...getPetGeometry() })
}

function schedulePetLayout() {
  if (petLayoutTimer) clearTimeout(petLayoutTimer)
  petLayoutTimer = setTimeout(() => { petLayoutTimer = null; applyPetLayout() }, 180)
}

function recoverPet(reason, details = {}) {
  if (SELF_TEST_MODE || isQuitting || petRecoveryTimer) return
  recordLifecycle('recover-scheduled', { reason, ...details })
  // 连续崩溃逐渐退避；偶发崩溃快速恢复，避免毫秒级重启循环。
  const delay = Math.min(30000, 500 * Math.pow(2, Math.min(petRecoveryAttempts++, 6)))
  petRecoveryTimer = setTimeout(() => {
    petRecoveryTimer = null
    if (isQuitting) return
    try {
      if (!petWin || petWin.isDestroyed()) { createPetWindow(); applyDisplayMode() }
      else petWin.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(err => {
        logFatal('pet-reload', err); recoverPet('reload-failed')
      })
      recordLifecycle('recover-started', { reason })
    } catch (err) { logFatal('pet-recovery', err); recoverPet(reason) }
  }, delay)
}

function createPetWindow(posOverride) {
  const size = petSize(cfg.scale)
  // 融入桌面：不占任务栏，只留托盘图标
  const skipTaskbar = true

  const legacyPlacement = !petLayout && (!cfg.placement || cfg.placement.version !== 1) && !posOverride && Number.isFinite(cfg.x) && Number.isFinite(cfg.y)
  petLayout = placeWindow({ displays: petDisplays(), primaryDisplayId: screen.getPrimaryDisplay().id,
    bounds: posOverride || (petLayout && petLayout.bounds) || { x: cfg.x, y: cfg.y, width: size, height: size },
    size, snap: cfg.snap !== false, placement: (petLayout && petLayout.placement) || cfg.placement })
  if (legacyPlacement && cfg.snap !== false) {
    // 旧版未保存锚点，沿用原四分之一吸附规则迁移；中间位置仍保留。
    const wa = petLayout.workArea
    const cx = cfg.x + size / 2, cy = cfg.y + size / 2
    petLayout.placement.h = cx < wa.x + wa.width / 4 ? 'left' : cx > wa.x + wa.width * 3 / 4 ? 'right' : null
    petLayout.placement.v = cy < wa.y + wa.height / 4 ? 'top' : cy > wa.y + wa.height * 3 / 4 ? 'bottom' : null
    petLayout = placeWindow({ displays: petDisplays(), primaryDisplayId: screen.getPrimaryDisplay().id,
      bounds: petLayout.bounds, size, snap: true, placement: petLayout.placement })
  }
  const { x, y } = petLayout.bounds

  petWin = new BrowserWindow({
    icon: appIconPath,
    width: size,
    height: size,
    x,
    y,
    transparent: true,
    title: 'relay-balance-pet',   // ASCII 标题：供端到端测试 FindWindow 定位（无任务栏/边框，用户不可见）
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !SELF_TEST_MODE,
    },
  })

  petWin.setSkipTaskbar(true)
  petWin.on('show', () => {
    if (petWin && !petWin.isDestroyed()) petWin.setSkipTaskbar(true)
  })
  petWin.setAlwaysOnTop(true, 'screen-saver')
  const currentWindow = petWin
  currentWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(err => {
    logFatal('pet-load', err); recoverPet('load-failed')
  })
  currentWindow.webContents.on('render-process-gone', (_event, details) => {
    if (currentWindow === petWin) recoverPet('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
  })
  currentWindow.webContents.on('did-finish-load', () => {
    if (currentWindow !== petWin || currentWindow.isDestroyed()) return
    currentWindow.webContents.send('pet:geometry-updated', getPetGeometry())
  })
  currentWindow.on('close', event => {
    if (!isQuitting && !SELF_TEST_MODE) { event.preventDefault(); recordLifecycle('close-prevented') }
  })
  petWin.once('ready-to-show', () => {
    if (SELF_TEST_MODE && !isFsSmokeTest) return
    applyVisibility()
    recordAutoStart('window-ready', { visible: petWin.isVisible() })
    recordLifecycle('window-ready', { visible: petWin.isVisible(), geometry: getPetGeometry() })
  })
  currentWindow.on('closed', () => {
    if (petWin !== currentWindow) return
    petWin = null
    recoverPet('window-closed')
  })
  schedulePosSave()
}

function schedulePosSave() {
  if (posSaveTimer) clearTimeout(posSaveTimer)
  posSaveTimer = setTimeout(() => {
    posSaveTimer = null
    if (!petWin || petWin.isDestroyed()) return
    const [x, y] = petWin.getPosition()
    cfg = saveConfig({ x, y, placement: petLayout && petLayout.placement })
  }, 500)
}

// ---------------------------------------------------------------------------
// 余额拉取（主进程代理，key 不出主进程）
// siteType=sub2api：GET {baseUrl}/v1/usage（Bearer API Key，含余额+今日/累计用量）
// siteType=deepseek：原版 GET /user/balance
// ---------------------------------------------------------------------------
function pickNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

async function fetchSub2ApiBalance(cfgNow, key) {
  const base = ((cfgNow.baseUrl || '') || DEFAULT_SUB2API_BASE).trim().replace(/\/+$/, '')
  if (!base) return { ok: false, code: 'MISSING_BASE_URL', error: '请先在设置中填写站点地址', transient: false }
  try {
    const address = new URL(base)
    if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error('invalid address')
  } catch {
    return { ok: false, code: 'INVALID_BASE_URL', error: '站点地址须为完整的 HTTP(S) 地址，不含账号、密码或查询参数', transient: false }
  }
  const res = await fetch(base + '/v1/usage', {
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = (data && data.message) || ('HTTP ' + res.status)
    return { ok: false, code: 'HTTP_' + res.status, error: String(msg).slice(0, 200), transient: res.status >= 500 }
  }
  // 字段优先级：remaining → balance → quota.remaining；
  // 都没有时（Key 只设了 5h/1d/7d 速率限制）→ 取最紧窗口的限额剩余
  const remaining = pickNum(data.remaining) ?? pickNum(data.balance) ?? pickNum(data.quota && data.quota.remaining)
  let totalBalance = remaining
  let rateWindow, rateLimit, rateUsed
  if (totalBalance === undefined && Array.isArray(data.rate_limits) && data.rate_limits.length) {
    const rl = data.rate_limits
      .filter((w) => pickNum(w.remaining) !== undefined)
      .sort((a, b) => pickNum(a.remaining) - pickNum(b.remaining))[0]
    if (rl) {
      totalBalance = pickNum(rl.remaining)
      rateWindow = rl.window
      rateLimit = pickNum(rl.limit)
      rateUsed = pickNum(rl.used)
    }
  }
  if (totalBalance === undefined) {
    return { ok: false, code: 'EMPTY', error: '响应中未找到余额字段', transient: true }
  }
  const quota = data.quota || {}
  const usage = data.usage || {}
  const today = usage.today || {}
  return {
    ok: true,
    totalBalance,
    currency: (data.unit || (quota.unit) || 'USD').toUpperCase(),
    isAvailable: data.isValid !== false && data.status !== 'disabled',
    quotaLimit: pickNum(quota.limit) ?? rateLimit,
    quotaUsed: pickNum(quota.used) ?? rateUsed,
    quotaMode: data.mode,
    rateWindow,
    planName: typeof data.planName === 'string' && data.planName ? data.planName : undefined,
    usedToday: pickNum(today.cost) ?? pickNum(today.actual_cost) ?? 0,
    requestsToday: pickNum(today.requests) ?? 0,
    tokensToday: pickNum(today.total_tokens) ?? 0,
    usageTotalCost: pickNum(usage.total && usage.total.cost) ?? 0,
    cachedAt: Date.now(),
  }
}

async function fetchBalance() {
  balanceFetchCount++
  const cfgNow = loadConfig()
  const key = String(cfgNow.apiKey || '').trim()
  if (!key) return { ok: false, code: 'NO_KEY', error: '未配置 API Key（右键托盘 → 设置）' }
  if (balanceInFlight) return balanceInFlight
  const sourceId = dataSourceIdentity(cfgNow)
  const request = (async () => {
    try {
      const payload = cfgNow.siteType === 'deepseek'
        ? await fetchDeepSeekBalance(cfgNow, key)
        : await fetchSub2ApiBalance(cfgNow, key)
      if (!payload.ok) {
        if (!payload.transient) console.error('[relay-pet]', payload.code, payload.error)
        return payload
      }
      if (sourceId !== dataSourceIdentity(loadConfig())) return { ok: false, code: 'CONFIG_CHANGED', error: '配置已变更，请重新刷新', transient: true }
      ensureStats()
      // 面板登录态：拉账号级真实今日消耗（actual_cost=实际扣除，跨全部 Key）
      if (panelAuthConfigured()) {
        try {
          const acc = await getAccountTodayStats()
          const actual = pickNum(acc && acc.today_actual_cost)
          if (actual !== undefined && actual >= 0) {
            payload.usedToday = actual
            payload.requestsToday = acc.today_requests ?? payload.requestsToday
            payload.accountAuth = true
          } else {
            throw new Error('账号统计未返回实际扣除金额')
          }
        } catch (err) {
          payload.accountAuth = false
          payload.accountError = '账号统计暂时无法更新'
        }
      }
      if (sourceId !== dataSourceIdentity(loadConfig())) return { ok: false, code: 'CONFIG_CHANGED', error: '配置已变更，请重新刷新', transient: true }
      // 消耗统计
      if (cfgNow.trackStats) {
        recordBalance(Number(payload.totalBalance))
        // 今日消耗：登录态用账号级真实值（actual_cost=实际扣除）；未登录回退本地余额差值累计
        // （接口 /v1/usage 的 usage.today 是"这把 Key 自己"的用量，钱包模式下恒 0，不能直接用）
        if (cfgNow.siteType !== 'deepseek') {
          stats.currency = payload.currency
          stats.mode = payload.quotaMode
          if (payload.accountAuth && typeof payload.usedToday === 'number') {
            stats.todayUsed = payload.usedToday
            stats.todaySource = 'account'
            stats.todayStale = false
            stats.accountUpdatedAt = Date.now()
          } else if (panelAuthConfigured()) {
            if (stats.todaySource !== 'account') { stats.todayUsed = null; stats.todaySource = 'pending' }
            stats.todayStale = true
          } else {
            stats.todaySource = 'estimated'
            stats.todayStale = false
          }
          saveStats()
          updateDailySpendNotice(cfgNow, sourceId)
          // 24h 采样：仅 Sub2API 模式（接口一次带回全部统计）
          appendUsageSample({
            remaining: payload.totalBalance,
            usedToday: stats.todayUsed,
            tokensToday: payload.tokensToday,
            requestsToday: payload.requestsToday,
            totalCost: payload.usageTotalCost,
          })
        }
      }
      payload.todaySource = stats.todaySource
      payload.todayStale = stats.todayStale
      balanceCache = { at: Date.now(), payload, sourceId }
      // 低余额提醒
      if (cfgNow.lowBalanceAlert && Number(payload.totalBalance) >= 0 && Number(payload.totalBalance) < Number(cfgNow.lowThreshold)) {
        notifyLowBalance(payload.totalBalance, payload.currency)
      }
      return payload
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 200)
      if (balanceCache && balanceCache.sourceId === sourceId && Date.now() - balanceCache.at < 10 * 60 * 1000) {
        if (stats.todaySource === 'account') stats.todayStale = true
        return { ...balanceCache.payload, stale: true, todayStale: stats.todayStale, error: msg }
      }
      return { ok: false, code: 'ERROR', error: msg, transient: true }
    }
  })()
  balanceInFlight = request
  try { return await request }
  finally { if (balanceInFlight === request) balanceInFlight = null }
}

// 原 DeepSeek 官方接口逻辑，抽出为独立函数（行为与原版一致）
async function fetchDeepSeekBalance(cfgNow, key) {
  const url = (cfgNow.balanceUrl || '').trim() || BALANCE_URL
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(20000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + res.status)
    return { ok: false, code: 'HTTP_' + res.status, error: String(msg).slice(0, 200), transient: res.status >= 500 }
  }
  const info = Array.isArray(data.balance_infos) && data.balance_infos[0]
  if (!info) return { ok: false, code: 'EMPTY', error: '接口未返回余额数据', transient: true }
  return {
    ok: true,
    totalBalance: info.total_balance,
    currency: info.currency || 'CNY',
    isAvailable: info.is_available !== false,
    grantedBalance: info.granted_balance,
    toppedUpBalance: info.topped_up_balance,
    cachedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// 设置窗口
// ---------------------------------------------------------------------------
function revealSettingsWindow(window = settingsWin) {
  if (SELF_TEST_MODE || !window || window !== settingsWin || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  const bounds = window.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height)
  const x = Math.round(clamp(bounds.x, area.x, area.x + area.width - width))
  const y = Math.round(clamp(bounds.y, area.y, area.y + area.height - height))
  if (x !== bounds.x || y !== bounds.y || width !== bounds.width || height !== bounds.height) window.setBounds({ x, y, width, height })
  window.setSkipTaskbar(false)
  if (!window.isVisible()) window.show()
  window.focus()
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    revealSettingsWindow()
    return
  }
  settingsWin = new BrowserWindow({
    icon: appIconPath,
    width: 560,
    height: 790,
    title: '账号余额桌宠 · 设置',
    skipTaskbar: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const window = settingsWin
  window.setMenuBarVisibility(false)
  const reveal = () => { if (!SELF_TEST_MODE) revealSettingsWindow(window) }
  window.once('ready-to-show', reveal)
  window.webContents.once('did-finish-load', reveal)
  window.webContents.on('render-process-gone', (_event, details) => {
    logFatal('settings-renderer', new Error(details.reason || 'renderer exited'))
    if (!window.isDestroyed()) window.destroy()
  })
  window.loadFile(path.join(__dirname, 'renderer', 'settings.html')).catch(error => {
    logFatal('settings-load', error)
    if (!window.isDestroyed()) window.destroy()
  })
  window.on('closed', () => { if (settingsWin === window) settingsWin = null })
}

// ---------------------------------------------------------------------------
// 统计窗口（近24小时使用统计）
// ---------------------------------------------------------------------------
let statsWin = null
function revealStatsWindow() {
  if (SELF_TEST_MODE || !statsWin || statsWin.isDestroyed()) return
  if (statsWin.isMinimized()) statsWin.restore()
  const b = statsWin.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const width = Math.min(b.width, wa.width), height = Math.min(b.height, wa.height)
  const x = Math.round(clamp(b.x, wa.x, wa.x + wa.width - width))
  const y = Math.round(clamp(b.y, wa.y, wa.y + wa.height - height))
  if (x !== b.x || y !== b.y || width !== b.width || height !== b.height) statsWin.setBounds({ x, y, width, height })
  statsWin.setSkipTaskbar(true)
  if (!statsWin.isVisible()) statsWin.show()
  statsWin.focus()
}
function openStats() {
  if (statsWin && !statsWin.isDestroyed()) {
    revealStatsWindow()
    return
  }
  statsWin = new BrowserWindow({
    icon: appIconPath,
    width: 880,
    height: 800,
    minWidth: 660,
    minHeight: 520,
    title: '账号余额桌宠 · 使用与缓存统计',
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  statsWin.setMenuBarVisibility(false)
  const window = statsWin
  window.once('ready-to-show', revealStatsWindow)
  // 隐藏窗口可能没有 ready-to-show；页面加载完也恢复显示，不能只聚焦一个隐藏窗口。
  window.webContents.once('did-finish-load', revealStatsWindow)
  window.webContents.on('render-process-gone', (_event, details) => {
    logFatal('stats-renderer', new Error(details.reason || 'renderer exited'))
    if (!window.isDestroyed()) window.destroy()
  })
  window.loadFile(path.join(__dirname, 'renderer', 'stats.html')).catch(error => {
    logFatal('stats-load', error)
    if (!window.isDestroyed()) window.destroy()
  })
  window.on('closed', () => { if (statsWin === window) statsWin = null })
}

// 主动测试只发一条 Windows 通知，不写入真实缓存率或分钟去重记录。
async function showCacheAlertDemo() {
  const before = getCacheMonitor()
  const end = Date.now()
  const sample = { requests: 5, validRequests: 5, inputTokens: 10000, cacheReadTokens: 6000,
    cacheCreationTokens: 500, uncachedInputTokens: 3500, sampleStart: end - CACHE_MONITOR_INTERVAL_MS, sampleEnd: end }
  const shown = await notifyCacheRate(.6, sample, true)
  const result = { shown, rate: .6, threshold: 80, sample, actualMonitor: getCacheMonitor(),
    actualMonitorUnchanged: JSON.stringify(before) === JSON.stringify(getCacheMonitor()), demoOnly: true, at: Date.now() }
  console.log('[cache-alert-demo] ' + JSON.stringify(result))
  if (process.env.WHALE_PET_LIVE_CHECK_DIR) fs.writeFileSync(path.join(process.env.WHALE_PET_LIVE_CHECK_DIR, 'cache-alert-demo.json'), JSON.stringify(result, null, 2), 'utf8')
  return result
}

// ---------------------------------------------------------------------------
// 桌宠仅保留托盘入口；任务栏只允许设置窗口出现。
// ---------------------------------------------------------------------------
function applyDisplayMode() {
  if (!petWin || petWin.isDestroyed()) return
  petWin.setAlwaysOnTop(loadConfig().alwaysOnTop !== false, 'screen-saver')
  applyVisibility()
  updateTray(true)
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function buildTrayImage() {
  try {
    return nativeImage.createFromPath(appIconPath).resize({ width: 16, height: 16 })
  } catch {
    return nativeImage.createEmpty()
  }
}

function updateTray(enabled) {
  if (!enabled) {
    if (tray) { tray.destroy(); tray = null }
    return
  }
  if (tray) return
  tray = new Tray(buildTrayImage())
  tray.setToolTip('账号余额桌宠')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '🔄 立即刷新', click: () => { if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:refresh') } },
    { label: '📊 使用与缓存统计…', click: () => openStats() },
    { label: '⚙️ 设置…', click: () => openSettings() },
    { label: '✕ 退出', click: () => app.quit() },
  ]))
  tray.on('click', () => setManualHidden(false))
}

// ---------------------------------------------------------------------------
// 全局热键
// ---------------------------------------------------------------------------
function updateHotkey(enabled) {
  if (SELF_TEST_MODE) return
  globalShortcut.unregisterAll()
  // 手动隐身热键（始终可用）：直接切换桌宠可见性，与全屏隐身互不干扰
  try {
    globalShortcut.register('Control+Shift+H', () => {
      setManualHidden(!manualHidden)
    })
  } catch (err) { /* ignore */ }
  if (!enabled) return
  globalShortcut.register('Control+Shift+R', () => {
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:refresh')
  })
}

// ---------------------------------------------------------------------------
// 全屏自动隐身：常驻 PowerShell 监听前台窗口，
// 检测到全屏/无边框全屏（覆盖整个显示器且无标题栏，排除 explorer/自身）→ 隐藏桌宠，退出恢复
// ---------------------------------------------------------------------------
let fsProc = null
let fsFullscreen = false
let manualHidden = false   // Ctrl+Shift+H 手动隐身
const TEMPORARY_HIDE_MS = 10000
let temporaryHiddenUntil = 0
let temporaryHideTimer = null

function getPetVisibility() {
  return { manualHidden, temporaryHidden: temporaryHiddenUntil > Date.now(), temporaryHiddenUntil,
    fullscreenHidden: fsFullscreen, visible: !!(petWin && !petWin.isDestroyed() && petWin.isVisible()) }
}

function setManualHidden(hidden) {
  if (typeof hidden !== 'boolean') return { ok: false, ...getPetVisibility() }
  manualHidden = hidden
  applyVisibility()
  return { ok: true, ...getPetVisibility() }
}

function clearTemporaryHide() {
  if (temporaryHideTimer) clearTimeout(temporaryHideTimer)
  temporaryHideTimer = null
  temporaryHiddenUntil = 0
}

function hidePetTemporarily() {
  if (!petWin || petWin.isDestroyed()) return { ok: false, durationMs: TEMPORARY_HIDE_MS }
  clearTemporaryHide()
  temporaryHiddenUntil = Date.now() + TEMPORARY_HIDE_MS
  temporaryHideTimer = setTimeout(() => {
    temporaryHideTimer = null
    temporaryHiddenUntil = 0
    applyVisibility()
  }, TEMPORARY_HIDE_MS)
  applyVisibility()
  return { ok: true, durationMs: TEMPORARY_HIDE_MS }
}

const FS_WATCHER_PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class U32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$last = -1
while ($true) {
  $fs = 0
  $h = [U32]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $wpid = [uint32]0
    [void][U32]::GetWindowThreadProcessId($h, [ref]$wpid)
    $pname = ''
    $p = Get-Process -Id $wpid -ErrorAction SilentlyContinue
    if ($p) { $pname = $p.ProcessName }
    if ($pname -ne 'explorer' -and $pname -ne 'electron') {
      $r = New-Object 'U32+RECT'
      [void][U32]::GetWindowRect($h, [ref]$r)
      $style = [U32]::GetWindowLong($h, -16)
      $noCaption = (($style -band 0x00C00000) -eq 0)
      # 任一显示器的完整覆盖（全屏/窗口化全屏可发生在任意屏幕）
      if ($noCaption) {
        foreach ($sc in [System.Windows.Forms.Screen]::AllScreens) {
          $b = $sc.Bounds
          if ($r.Left -le ($b.X + 2) -and $r.Top -le ($b.Y + 2) -and $r.Right -ge ($b.X + $b.Width - 2) -and $r.Bottom -ge ($b.Y + $b.Height - 2)) { $fs = 1; break }
        }
      }
    }
  }
  if ($fs -ne $last) { Write-Output ("FS=" + $fs); [Console]::Out.Flush(); $last = $fs }
  Start-Sleep -Milliseconds 800
}
`

let fsGen = 0                 // 监听器代际：防止旧进程的 exit 回调触发重启循环
let fsRestartTimer = null

function stopFullscreenWatcher() {
  fsGen++
  if (fsRestartTimer) { clearTimeout(fsRestartTimer); fsRestartTimer = null }
  if (fsProc) {
    try { fsProc.removeAllListeners('exit'); fsProc.kill() } catch { /* ignore */ }
    fsProc = null
  }
}

function applyVisibility() {
  if (!petWin || petWin.isDestroyed()) return
  // 创建、恢复隐身和保存设置都固定排除桌宠，禁止显示模式把它放回任务栏。
  petWin.setSkipTaskbar(true)
  if (SELF_TEST_MODE && !isFsSmokeTest) return
  if (temporaryHiddenUntil > Date.now() || manualHidden || fsFullscreen) {
    if (petWin.isVisible()) petWin.hide()
  } else {
    if (!petWin.isVisible()) petWin.showInactive()
  }
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('pet:visibility-updated', getPetVisibility())
}

function scheduleFsWatcherRestart() {
  if (fsRestartTimer) return
  fsRestartTimer = setTimeout(() => {
    fsRestartTimer = null
    if (loadConfig().autoHideFullscreen !== false) startFullscreenWatcher()
  }, 5000)
}

function startFullscreenWatcher() {
  if (SELF_TEST_MODE) return   // 自检不启动后台监听进程
  stopFullscreenWatcher()
  fsFullscreen = false
  applyVisibility()
  const c = loadConfig()
  if (c.autoHideFullscreen === false) return
  const gen = fsGen
  try {
    fsProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', FS_WATCHER_PS], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    fsProc.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line === 'FS=1') { fsFullscreen = true; console.log('[fs-watch] FS=1 -> hide'); applyVisibility() }
        else if (line === 'FS=0') { fsFullscreen = false; console.log('[fs-watch] FS=0 -> restore'); applyVisibility() }
      }
    })
    fsProc.stderr.on('data', () => { /* 忽略诊断输出 */ })
    fsProc.on('exit', () => {
      if (gen !== fsGen) return            // 主动重启/停止导致的退出，不管
      fsProc = null
      scheduleFsWatcherRestart()           // 意外退出 → 5 秒后自动拉起
    })
  } catch (err) {
    console.error('[fs-watch] spawn failed:', String(err && err.message || err))
  }
}

app.on('before-quit', () => { clearTemporaryHide(); stopFullscreenWatcher() })

// ---------------------------------------------------------------------------
// 全局异常静默：未捕获异常/Promise 拒绝不再弹系统错误对话框，写入 error.log 供排查
// ---------------------------------------------------------------------------
function logFatal(kind, err) {
  try {
    const line = new Date().toISOString() + ' [' + kind + '] ' + String((err && err.stack) || err) + '\n'
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), line.slice(0, 4000), 'utf8')
  } catch { /* ignore */ }
  console.error('[' + kind + ']', String((err && err.stack) || err).slice(0, 500))
}
function recordLifecycle(event, details = {}) {
  if (SELF_TEST_MODE) return
  try {
    const file = path.join(app.getPath('userData'), 'lifecycle.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file) && fs.statSync(file).size > 131072) {
      if (fs.existsSync(file + '.previous')) fs.unlinkSync(file + '.previous')
      fs.renameSync(file, file + '.previous')
    }
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n', 'utf8')
  } catch { /* 诊断失败不影响桌宠运行。 */ }
}
process.on('uncaughtException', (err) => logFatal('uncaughtException', err))
process.on('unhandledRejection', (err) => logFatal('unhandledRejection', err))

// ---------------------------------------------------------------------------
// 开机自启
// ---------------------------------------------------------------------------
function updateAutoStart(enabled) {
  if (SELF_TEST_MODE) return { ok: true, enabled: false, skipped: true }
  try {
    const options = autoStartOptions()
    app.setLoginItemSettings({
      ...options, name: 'com.relay.balance-pet',
      openAtLogin: !!enabled, enabled: !!enabled,
    })
    const status = getAutoStartStatus()
    if (!status.ok || status.enabled !== !!enabled) {
      return { ...status, ok: false, error: status.error || '开机自启未生效，请点击保存重试或检查 Windows 启动应用设置。' }
    }
    console.log('[relay-pet] autoStart verified=' + enabled + ' path=' + options.path)
    return { ...status, ok: true }
  } catch (err) {
    console.error('[relay-pet] setLoginItemSettings failed:', err)
    return { ok: false, enabled: false, error: '开机自启设置失败：' + String(err.message || err).slice(0, 180) }
  }
}

function autoStartOptions() {
  // 便携版必须注册外部 exe；开发版必须传绝对项目目录，含空格时加引号。
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  const args = app.isPackaged || portable ? [] : [app.getAppPath()]
  return { path: portable || process.execPath,
    args: [...args, '--autostart'].map(arg => /\s/.test(arg) ? '"' + arg + '"' : arg) }
}

function getAutoStartStatus() {
  if (SELF_TEST_MODE) return { ok: true, enabled: false, skipped: true }
  try {
    const options = autoStartOptions()
    const state = app.getLoginItemSettings(options)
    const normalize = value => String(value || '').replace(/^"|"$/g, '').toLowerCase()
    // Electron launchItems.args 只回传位置参数，不包括 -- 开头的开关。
    // openAtLogin 使用完整 path/args 查询；额外精确核对同名用户项及项目参数。
    const positionalArgs = args => (args || []).filter(arg => !String(arg).startsWith('--')).map(normalize)
    const exact = (state.launchItems || []).find(item => item.name === 'com.relay.balance-pet' && item.scope === 'user' &&
      normalize(item.path) === normalize(options.path) && JSON.stringify(positionalArgs(item.args)) === JSON.stringify(positionalArgs(options.args)))
    const enabled = !!state.openAtLogin && (process.platform !== 'win32' || !!(exact && exact.enabled))
    return { ok: true, enabled }
  } catch (err) {
    return { ok: false, enabled: false, error: '无法确认 Windows 开机自启状态：' + String(err.message || err).slice(0, 180) }
  }
}

function recordAutoStart(stage, details = {}) {
  if (SELF_TEST_MODE || !process.argv.includes('--autostart')) return
  try {
    const log = path.join(app.getPath('userData'), 'startup.log')
    fs.mkdirSync(path.dirname(log), { recursive: true })
    if (fs.existsSync(log) && fs.statSync(log).size > 65536) fs.renameSync(log, log + '.previous')
    fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, stage, ...details }) + '\n', 'utf8')
  } catch { /* 诊断日志失败不影响启动。 */ }
}

// ---------------------------------------------------------------------------
// 自定义图片
// ---------------------------------------------------------------------------
async function chooseCustomImage() {
  const r = await dialog.showOpenDialog(settingsWin || petWin, {
    title: '选择桌宠图片（建议 1026×1026 PNG）',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  })
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false }
  try {
    const src = r.filePaths[0]
    fs.copyFileSync(src, customImagePath())
    cfg = saveConfig({ customImage: true })
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:config-updated')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('pet:get-balance', () => fetchBalance())
function getCacheMonitor() { return cacheMonitorPublic() }
ipcMain.handle('pet:get-cache-monitor', () => getCacheMonitor())
ipcMain.handle('pet:get-local-cache-stats', (_e, options) => getLocalCacheStats({ force: !!(options && options.force === true) }))
ipcMain.handle('pet:pause-cache-monitor', (_e, hours) => pauseCacheMonitor(hours))
ipcMain.handle('pet:resume-cache-monitor', () => resumeCacheMonitor())
let cacheAlertTestInFlight = null
ipcMain.handle('pet:test-cache-alert', () => {
  if (!cacheAlertTestInFlight) {
    cacheAlertTestInFlight = showCacheAlertDemo().finally(() => { cacheAlertTestInFlight = null })
  }
  return cacheAlertTestInFlight
})
async function getUsageWindow(hours = 24) {
  ensureStats()
  const c = loadConfig()
  const windowHours = usageHours(hours)
  const windowEnd = Date.now()
  // 最近 N 个小时段，包含当前未满小时；与面板的小时聚合口径一致。
  const windowStart = Math.floor(windowEnd / 3600000) * 3600000 - (windowHours - 1) * 3600000
  const sourceId = dataSourceIdentity(c)
  const samples = loadUsageHistory().filter((p) => p && p.t >= windowStart - 3600000 && p.t <= windowEnd)
  const currency = stats.currency || (c.siteType === 'deepseek' ? 'CNY' : (samples.length ? 'USD' : ''))
  // 登录态：附账号级按小时真实消耗（actual_cost）
  let accountTrend = null
  let accountAuth = false
  let accountSummary = null
  let accountError = ''
  if (panelAuthConfigured()) {
    try {
      const t = await getAccountHourlyTrend(windowHours)
      const result = summarizeAccountTrend(t && t.trend, windowStart, windowEnd)
      accountTrend = result.rows
      accountSummary = result.summary
      accountAuth = true
    } catch (err) { accountError = '账号用量暂时无法更新：' + String(err && err.message || err).slice(0, 120) }
  }
  if (sourceId !== dataSourceIdentity(loadConfig())) throw new Error('账号配置已变更，请重新刷新统计')
  return {
    siteType: c.siteType || 'sub2api',
    currency,
    mode: stats.mode || '',
    samples,
    todayUsed: stats.todayUsed,
    todayKey: stats.today,
    todaySource: stats.todaySource,
    todayStale: stats.todayStale,
    accountAuth,
    accountTrend,
    hours: windowHours, windowStart, windowEnd,
    accountConfigured: c.siteType !== 'deepseek' && !!(c.panelEmail && c.panelPassword),
    accountSummary, accountError,
  }
}
ipcMain.handle('pet:get-usage-window', (_e, hours) => getUsageWindow(hours))
// 兼容旧的统计页面调用；默认仍返回 24 小时。
ipcMain.handle('pet:get-usage-24h', () => getUsageWindow(24))
ipcMain.handle('pet:open-stats', () => openStats())
ipcMain.handle('pet:test-push', async () => {
  const c = loadConfig()
  if (!c.pushUrl) return { ok: false, error: '未填写推送 URL' }
  try {
    const res = await fetch(c.pushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test', balance: stats.lastBalance, currency: stats.currency || '', ts: Date.now() }),
      signal: AbortSignal.timeout(10000),
    })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err).slice(0, 200) }
  }
})
ipcMain.handle('pet:get-screen', () => {
  const geometry = getPetGeometry()
  if (geometry) return { workArea: geometry.workArea, bounds: geometry.bounds }
  const display = screen.getPrimaryDisplay()
  return { workArea: display.workArea, bounds: display.bounds }
})
ipcMain.handle('pet:get-geometry', () => getPetGeometry())
ipcMain.handle('pet:get-position', () => {
  if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0 }
  const [x, y] = petWin.getPosition()
  return { x, y }
})
ipcMain.handle('pet:set-position', (_e, { x, y }) => {
  if (!petWin || petWin.isDestroyed()) return { x: 0, y: 0 }
  // 用 setBounds 显式固定宽高再移动：Windows 显示缩放非 100% 时，setPosition 拖动无边框
  // 窗口会按移动方向被拉伸放大；这里锁定为正方形，避免拖动时变形（修复「拖动放大」）
  const size = petSize(cfg.scale)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return getPetGeometry()
  const nx = Math.round(x)
  const ny = Math.round(y)
  petLayout = placeWindow({ displays: petDisplays(), primaryDisplayId: screen.getPrimaryDisplay().id,
    bounds: { x: nx, y: ny, width: size, height: size }, size, snap: false })
  const display = petDisplays().find(d => String(d.id) === String(petLayout.placement.displayId)) || screen.getPrimaryDisplay()
  petLayout.placement = capturePlacement(petLayout.bounds, display, cfg.snap !== false)
  petWin.setBounds(petLayout.bounds)
  schedulePosSave()
  return getPetGeometry()
})
ipcMain.handle('pet:get-size', () => {
  const scale = loadConfig().scale
  return { size: petSize(scale), scale, minSize: MIN_SIZE, maxSize: MAX_SIZE }
})
ipcMain.handle('pet:set-scale', (_e, { scale }) => {
  const next = Math.round(clamp(scale, MIN_SCALE, MAX_SCALE) * 10) / 10
  cfg = saveConfig({ scale: next })
  if (petWin && !petWin.isDestroyed()) {
    applyPetLayout('scale-change')
  }
  return { scale: next, size: petSize(next) }
})
ipcMain.handle('pet:get-config', () => {
  const c = loadConfig()
  return {
    hasKey: !!c.apiKey.trim(), scale: c.scale,
    snap: c.snap !== false, label: c.label || '账号余额', refreshSec: c.refreshSec,
    lowBalanceAlert: !!c.lowBalanceAlert, lowThreshold: c.lowThreshold,
    idleTransparency: c.idleTransparency !== false, idleSec: c.idleSec,
    trackStats: c.trackStats !== false, bounceAnim: c.bounceAnim !== false,
    sound: c.sound !== false, quotesEnabled: !!c.quotesEnabled, quotesText: c.quotesText || '',
    dailySpendAlertEnabled: c.dailySpendAlertEnabled !== false, dailySpendAlertStep: spendAlertStep(c.dailySpendAlertStep),
    cacheMonitorEnabled: c.cacheMonitorEnabled !== false, cacheAlertThreshold: cacheMonitorThreshold(c),
    cacheMonitorRepeatAlertEnabled: false,
    cacheAlertSoundEnabled: c.cacheAlertSoundEnabled !== false,
    ccsStatsPausedUntil: cacheStatsPauseUntil(c),
    customImage: !!c.customImage, hotkey: c.hotkey !== false, trayIcon: c.trayIcon !== false,
    autoStart: !!c.autoStart, autoStartStatus: getAutoStartStatus(), alwaysOnTop: c.alwaysOnTop !== false,
    showTime: !!c.showTime, lockPosition: c.lockPosition !== false,
    autoHideFullscreen: c.autoHideFullscreen !== false,
  }
})
ipcMain.handle('pet:get-full-config', () => {
  const c = loadConfig()
  return {
    apiKey: c.apiKey, siteType: c.siteType || 'sub2api', baseUrl: c.baseUrl || '',
    balanceUrl: c.balanceUrl || '', pushEnabled: !!c.pushEnabled, pushUrl: c.pushUrl || '',
    snap: c.snap !== false,
    label: c.label || '账号余额', refreshSec: c.refreshSec, scale: c.scale,
    lowBalanceAlert: !!c.lowBalanceAlert, lowThreshold: c.lowThreshold,
    idleTransparency: c.idleTransparency !== false, idleSec: c.idleSec,
    trackStats: c.trackStats !== false, bounceAnim: c.bounceAnim !== false,
    sound: c.sound !== false, quotesEnabled: !!c.quotesEnabled, quotesText: c.quotesText || '',
    dailySpendAlertEnabled: c.dailySpendAlertEnabled !== false, dailySpendAlertStep: spendAlertStep(c.dailySpendAlertStep),
    cacheMonitorEnabled: c.cacheMonitorEnabled !== false, cacheAlertThreshold: cacheMonitorThreshold(c),
    cacheMonitorRepeatAlertEnabled: false,
    cacheAlertSoundEnabled: c.cacheAlertSoundEnabled !== false,
    ccsStatsPausedUntil: cacheStatsPauseUntil(c),
    customImage: !!c.customImage, hotkey: c.hotkey !== false, trayIcon: c.trayIcon !== false,
    autoStart: !!c.autoStart, autoStartStatus: getAutoStartStatus(), alwaysOnTop: c.alwaysOnTop !== false,
    showTime: !!c.showTime, lockPosition: c.lockPosition !== false,
    autoHideFullscreen: c.autoHideFullscreen !== false,
    panelEmail: c.panelEmail || '', hasPanelPassword: !!(c.panelPassword || ''),
  }
})
ipcMain.handle('pet:save-settings', (_e, settings) => {
  const s = settings || {}
  const cur = loadConfig()
  const bool = function (v, dft) { return typeof v === 'boolean' ? v : dft }
  // 部分保存（只传个别字段）时，未传的字段一律保留现值，不允许被空值/默认值覆盖
  const apiKey = s.apiKey === undefined ? cur.apiKey : String(s.apiKey || '').trim()
  const balanceUrl = s.balanceUrl === undefined ? (cur.balanceUrl || '') : String(s.balanceUrl || '').trim()
  const siteType = (s.siteType === 'deepseek' || s.siteType === 'sub2api') ? s.siteType : (cur.siteType || 'sub2api')
  const baseUrl = s.baseUrl === undefined ? (cur.baseUrl || '') : String(s.baseUrl || '').trim()
  const pushEnabled = bool(s.pushEnabled, !!cur.pushEnabled)
  const pushUrl = s.pushUrl === undefined ? (cur.pushUrl || '') : String(s.pushUrl || '').trim()
  const autoHideFullscreen = bool(s.autoHideFullscreen, cur.autoHideFullscreen !== false)
  const fsWatcherChanged = autoHideFullscreen !== (cur.autoHideFullscreen !== false)
  const panelEmail = s.panelEmail === undefined ? (cur.panelEmail || '') : String(s.panelEmail || '').trim()
  const panelPassword = s.panelPassword === undefined ? (cur.panelPassword || '') : String(s.panelPassword || '')
  const panelAuthChanged = panelEmail !== (cur.panelEmail || '') || panelPassword !== (cur.panelPassword || '') || baseUrl !== (cur.baseUrl || '') || siteType !== cur.siteType
  const label = s.label === undefined ? (cur.label || '账号余额')
    : (String(s.label || '').trim() || (siteType === 'deepseek' ? 'DeepSeek 余额' : '账号余额'))
  let refreshSec = Number(s.refreshSec)
  if (!Number.isFinite(refreshSec)) refreshSec = s.refreshSec === undefined ? (cur.refreshSec ?? 30) : 30
  refreshSec = Math.round(clamp(refreshSec, 0, 3600))
  let lowThreshold = Number(s.lowThreshold)
  if (!Number.isFinite(lowThreshold)) lowThreshold = s.lowThreshold === undefined ? (cur.lowThreshold ?? 5) : 5
  lowThreshold = clamp(lowThreshold, 0, 100000)
  // 尺寸（设置滑条调节，0.6–1.4）；变化时即时生效到桌宠窗口
  let nextScale = cur.scale
  if (s.scale !== undefined && Number.isFinite(Number(s.scale))) {
    nextScale = Math.round(clamp(Number(s.scale), MIN_SCALE, MAX_SCALE) * 10) / 10
  }
  const scaleChanged = nextScale !== cur.scale
  const patch = {
    apiKey, siteType, baseUrl, balanceUrl, pushEnabled, pushUrl, autoHideFullscreen, panelEmail, panelPassword,
    snap: bool(s.snap, cur.snap !== false),
    label,
    refreshSec,
    scale: nextScale,
    lockPosition: bool(s.lockPosition, cur.lockPosition !== false),
    lowBalanceAlert: bool(s.lowBalanceAlert, !!cur.lowBalanceAlert),
    lowThreshold,
    idleTransparency: bool(s.idleTransparency, cur.idleTransparency !== false),
    idleSec: clamp(Number(s.idleSec) || cur.idleSec || 5, 1, 300),
    trackStats: bool(s.trackStats, cur.trackStats !== false),
    bounceAnim: bool(s.bounceAnim, cur.bounceAnim !== false),
    sound: bool(s.sound, cur.sound !== false),
    dailySpendAlertEnabled: bool(s.dailySpendAlertEnabled, cur.dailySpendAlertEnabled !== false),
    dailySpendAlertStep: s.dailySpendAlertStep === undefined ? spendAlertStep(cur.dailySpendAlertStep)
      : spendAlertStep(s.dailySpendAlertStep, spendAlertStep(cur.dailySpendAlertStep)),
    cacheMonitorEnabled: bool(s.cacheMonitorEnabled, cur.cacheMonitorEnabled !== false),
    cacheAlertThreshold: 80,
    cacheMonitorRepeatAlertEnabled: false,
    cacheAlertSoundEnabled: bool(s.cacheAlertSoundEnabled, cur.cacheAlertSoundEnabled !== false),
    quotesEnabled: bool(s.quotesEnabled, !!cur.quotesEnabled),
    quotesText: s.quotesText === undefined ? (cur.quotesText || '') : String(s.quotesText || '').trim(),
    customImage: bool(s.customImage, !!cur.customImage),
    hotkey: bool(s.hotkey, cur.hotkey !== false),
    trayIcon: bool(s.trayIcon, cur.trayIcon !== false),
    autoStart: bool(s.autoStart, !!cur.autoStart),
    alwaysOnTop: bool(s.alwaysOnTop, cur.alwaysOnTop !== false),
    showTime: bool(s.showTime, !!cur.showTime),
  }
  const oldSource = dataSourceIdentity(cur)
  // 显式提交时，即使勾选值不变也重新注册和回查；失败不写入“已启用”。
  let autoStartResult = null
  if (s.autoStart !== undefined || patch.autoStart !== cur.autoStart) {
    autoStartResult = updateAutoStart(patch.autoStart)
    if (!autoStartResult.ok) return { ok: false, error: autoStartResult.error, autoStartStatus: autoStartResult }
  }
  const newSource = dataSourceIdentity({ ...cur, ...patch })
  const archiveDir = path.join(app.getPath('userData'), 'source-history')
  try {
    if (oldSource !== newSource) {
      fs.mkdirSync(archiveDir, { recursive: true })
      for (const name of ['history.json', 'usage-history.json']) {
        const original = path.join(app.getPath('userData'), name)
        if (fs.existsSync(original)) fs.copyFileSync(original, path.join(archiveDir, oldSource + '-' + name))
      }
    }
    cfg = saveConfig(patch)
  }
  catch (err) {
    if (autoStartResult && !SELF_TEST_MODE) updateAutoStart(cur.autoStart)
    return { ok: false, error: String(err.message || err), autoStartStatus: getAutoStartStatus() }
  }
  if (panelAuthChanged) resetPanelAuth()
  if (cfg.cacheMonitorEnabled !== cur.cacheMonitorEnabled) {
    cacheMonitorGeneration++
    stopCacheMonitor()
    startCacheMonitor({ force: true })
  }
  const statsTrackingChanged = cfg.trackStats !== cur.trackStats
  const spendRuleChanged = cfg.dailySpendAlertEnabled !== cur.dailySpendAlertEnabled || cfg.dailySpendAlertStep !== cur.dailySpendAlertStep
  if (statsTrackingChanged || spendRuleChanged) {
    ensureStats()
    stats.dailySpendNotice = null
    if (!statsTrackingChanged) updateDailySpendNotice(cfg, newSource, false)
    saveStats()
  }
  if (oldSource !== newSource) {
    balanceCache = null
    balanceInFlight = null
    stats = { today: todayKey(), todayUsed: panelAuthConfigured() ? null : 0, lastBalance: null,
      currency: null, todaySource: panelAuthConfigured() ? 'pending' : 'estimated', todayStale: false }
    statsLoaded = true
    usageHistory = []
    usageHistoryLoaded = true
    saveStats()
    saveUsageHistory()
    for (const name of ['history.json', 'usage-history.json']) {
      const saved = path.join(archiveDir, newSource + '-' + name)
      if (fs.existsSync(saved)) {
        try { fs.copyFileSync(saved, path.join(app.getPath('userData'), name)) }
        catch (err) { console.error('[stats] 恢复历史失败：' + String(err.message || err)) }
      }
    }
    loadStats()
    usageHistoryLoaded = false
    loadUsageHistory()
  }
  if (petWin && !petWin.isDestroyed() && (scaleChanged || cfg.snap !== cur.snap)) {
    if (cfg.snap !== cur.snap && petLayout) {
      const display = petDisplays().find(d => String(d.id) === String(petLayout.placement.displayId)) || screen.getPrimaryDisplay()
      petLayout.placement = capturePlacement(petLayout.bounds, display, cfg.snap !== false)
    }
    applyPetLayout('settings-change')
  }
  applyDisplayMode()
  if (cfg.hotkey !== cur.hotkey) updateHotkey(cfg.hotkey)
  if (fsWatcherChanged) startFullscreenWatcher()
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('pet:refresh')
    petWin.webContents.send('pet:config-updated')
  }
  return { ok: true, hasKey: !!apiKey, autoStartStatus: autoStartResult || getAutoStartStatus() }
})
ipcMain.handle('pet:save-key', (_e, { apiKey }) => {
  cfg = saveConfig({ apiKey: String(apiKey || '').trim() })
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:refresh')
  return { ok: true, hasKey: !!cfg.apiKey.trim() }
})
ipcMain.handle('pet:get-stats', () => {
  ensureStats()
  return { ...stats, accountConfigured: panelAuthConfigured(), accountAuth: panelAuthStatus === 'valid' }
})
ipcMain.handle('pet:set-idle', (_e, { idle }) => {
  if (petWin && !petWin.isDestroyed()) {
    // Renderer dims the character separately so the balance bubble stays readable.
    petWin.setOpacity(1)
  }
  return { idle: !!idle }
})
ipcMain.handle('pet:get-image-url', () => {
  const c = loadConfig()
  if (c.customImage && fs.existsSync(customImagePath())) {
    return { url: pathToFileURL(customImagePath()).href }
  }
  return { url: '' }
})
ipcMain.handle('pet:choose-image', () => chooseCustomImage())
ipcMain.handle('pet:open-settings', () => openSettings())
ipcMain.handle('pet:close-settings', (event) => {
  if (!settingsWin || settingsWin.isDestroyed() || event.sender !== settingsWin.webContents) return { ok: false }
  settingsWin.close()
  return { ok: true }
})
ipcMain.handle('pet:hide-temporarily', () => hidePetTemporarily())
ipcMain.handle('pet:get-visibility', () => getPetVisibility())
ipcMain.handle('pet:set-manual-hidden', (_e, hidden) => setManualHidden(hidden))
ipcMain.handle('pet:quit', () => {
  if (posSaveTimer) clearTimeout(posSaveTimer)
  app.quit()
})

// ---------------------------------------------------------------------------
// 启动（单实例 + whenReady）
// ---------------------------------------------------------------------------
const isSmokeTest = process.argv.includes('--smoke-test')
const isFsSmokeTest = process.argv.includes('--fs-smoke-test')
const isJwtSmokeTest = process.argv.includes('--jwt-smoke-test')
const isCaptureDemo = process.argv.includes('--capture-demo')

const gotLock = app.requestSingleInstanceLock()
recordAutoStart('launch', { project: app.getAppPath(), lockAcquired: gotLock })
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--open-stats')) { openStats(); return }
    if (petWin && !petWin.isDestroyed()) {
      applyVisibility()
      if (petWin.isVisible()) petWin.focus()
    }
  })

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.relay.balance-pet')
    const autoStartResult = updateAutoStart(cfg.autoStart)
    if (!autoStartResult.ok) console.error('[autostart] ' + autoStartResult.error)
    recordAutoStart('ready', { autoStartEnabled: autoStartResult.enabled, registrationOk: autoStartResult.ok })
    console.log('[boot] userData=' + app.getPath('userData'))
    recordLifecycle('started', { launch: process.argv.includes('--autostart') ? 'autostart' : 'manual' })
    loadStats()
    screen.on('display-metrics-changed', schedulePetLayout)
    screen.on('display-added', schedulePetLayout)
    screen.on('display-removed', schedulePetLayout)
    createPetWindow()
    applyDisplayMode()
    updateHotkey(cfg.hotkey)
    startFullscreenWatcher()
    startCacheMonitor()
    if (process.argv.includes('--open-stats')) openStats()

    // 部署验收：只在显式指定时验证当前实例，验收后继续正常常驻。
    if (process.argv.includes('--verify-live')) {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      for (let i = 0; i < 30 && petWin.webContents.isLoading(); i++) await delay(100)
      const balance = await fetchBalance()
      await delay(300)
      let entered, held, left
      const hoverRendering = {}
      const renderedOpacity = () => petWin.webContents.executeJavaScript(`(() => ({
        image: Number(getComputedStyle(document.getElementById('img')).opacity),
        bubble: Number(getComputedStyle(document.getElementById('textBox')).opacity)
      }))()`)
      try {
        petWin.webContents.debugger.attach('1.3')
        const mouse = (x, y) => petWin.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
        await mouse(-10, -10)
        await mouse(80, 80)
        await delay(100)
        entered = petWin.getOpacity()
        hoverRendering.entered = await renderedOpacity()
        await delay(1600)
        held = petWin.getOpacity()
        hoverRendering.held = await renderedOpacity()
        await mouse(-10, -10)
        await delay(200)
        left = petWin.getOpacity()
        hoverRendering.left = await renderedOpacity()
      } finally {
        if (petWin.webContents.debugger.isAttached()) petWin.webContents.debugger.detach()
      }
      const appearance = await petWin.webContents.executeJavaScript(`(() => {
        const hint = document.querySelector('.dshp-hint'), el = hint.querySelector('.dshp-today-value') || hint, css = getComputedStyle(el)
        const background = getComputedStyle(document.getElementById('textBox')).backgroundColor
        const luminance = color => color.slice(color.indexOf('(') + 1, color.lastIndexOf(')')).split(',').slice(0, 3).map(Number)
          .map(c => { const v = c / 255; return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4) })
          .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
        return { text: hint.textContent, color: css.color, weight: css.fontWeight, background,
          clipped: el.scrollWidth > el.clientWidth + 1 || hint.scrollHeight > hint.clientHeight + 1,
          contrast: (luminance(background) + .05) / (luminance(css.color) + .05) }
      })()`)
      const currentConfig = loadConfig()
      const settingsCheck = new BrowserWindow({ width: 560, height: 790, show: false, skipTaskbar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
      let spendSettings
      try {
        await settingsCheck.loadFile(path.join(__dirname, 'renderer', 'settings.html'))
        await delay(250)
        spendSettings = await settingsCheck.webContents.executeJavaScript(`(() => {
          const enabled = document.getElementById('dailySpendAlertInput'), step = document.getElementById('dailySpendStepInput')
          enabled.closest('.group').scrollIntoView({ block: 'start' })
          return { enabled: enabled.checked, step: Number(step.value), sound: document.getElementById('soundInput').checked, bounce: document.getElementById('bounceInput').checked, repeat: false,
            cacheSound: document.getElementById('cacheAlertSoundInput').checked, manualHidden: document.getElementById('manualHideInput').checked }
        })()`)
        if (process.env.WHALE_PET_LIVE_CHECK_DIR) fs.writeFileSync(path.join(process.env.WHALE_PET_LIVE_CHECK_DIR, 'production-spend-settings.png'), (await settingsCheck.webContents.capturePage()).toPNG())
      } finally { settingsCheck.close() }
      const spendSettingsValid = spendSettings.enabled === (currentConfig.dailySpendAlertEnabled !== false)
        && spendSettings.step === spendAlertStep(currentConfig.dailySpendAlertStep)
        && spendSettings.sound === (currentConfig.sound !== false) && spendSettings.bounce === (currentConfig.bounceAnim !== false)
        && spendSettings.repeat === false
        && spendSettings.cacheSound === (currentConfig.cacheAlertSoundEnabled !== false) && spendSettings.manualHidden === manualHidden
      const result = { accountAuth: balance.accountAuth === true, todaySource: stats.todaySource,
        todayUsed: stats.todayUsed, entered, held, left, hoverRendering, appearance, spendSettings, spendSettingsValid,
        spendNotice: stats.dailySpendNotice,
        pass: spendSettingsValid && !!stats.dailySpendNotice && balance.accountAuth === true && stats.todaySource === 'account' && entered > .95 && held > .95 && left > .95
          && hoverRendering.entered.image === 1 && hoverRendering.held.image === 1
          && Math.abs(hoverRendering.left.image - (currentConfig.idleTransparency === false ? 1 : .4)) < .02
          && Math.abs(hoverRendering.left.bubble - (currentConfig.idleTransparency === false ? 1 : .92)) < .02
          && appearance.contrast >= 7 && Number(appearance.weight) >= 700 && !appearance.clipped }
      try {
        const usage24 = await getUsageWindow(24)
        result.usageCheck = { accountAuth: usage24.accountAuth, hours: usage24.hours,
          cacheAvailable: !!(usage24.accountSummary && usage24.accountSummary.cacheAvailable),
          cacheRate: usage24.accountSummary && usage24.accountSummary.cacheRate,
          rows: Array.isArray(usage24.accountTrend) ? usage24.accountTrend.length : 0 }
        result.pass = result.pass && usage24.accountAuth === true && usage24.hours === 24
          && result.usageCheck.cacheAvailable && Number.isFinite(result.usageCheck.cacheRate)
      } catch (err) {
        result.usageCheck = { accountAuth: false, error: String(err && err.message || err).slice(0, 160) }
        result.pass = false
      }
      if (cacheMonitorInFlight) await cacheMonitorInFlight
      result.cacheMonitor = getCacheMonitor()
      result.cacheMonitorReady = result.cacheMonitor.enabled
        && ['pending', 'ok', 'low', 'idle'].includes(result.cacheMonitor.status)
        && result.cacheMonitor.nextCheckAt > Date.now()
      const monitorCheck = new BrowserWindow({ width: 880, height: 940, show: false, skipTaskbar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
      try {
        await monitorCheck.loadFile(path.join(__dirname, 'renderer', 'stats.html'))
        await delay(300)
        result.cacheMonitorUI = await monitorCheck.webContents.executeJavaScript(`(() => ({
          status: document.getElementById('cacheMonitorStatus').textContent,
          rate: document.getElementById('cacheMonitorRate').textContent,
          details: document.getElementById('cacheMonitorInfo').textContent,
          visible: getComputedStyle(document.getElementById('cacheMonitorPanel')).display !== 'none'
        }))()`)
        if (process.env.WHALE_PET_LIVE_CHECK_DIR) fs.writeFileSync(path.join(process.env.WHALE_PET_LIVE_CHECK_DIR, 'production-cache-monitor.png'), (await monitorCheck.webContents.capturePage()).toPNG())
      } finally { monitorCheck.close() }
      result.pass = result.pass && result.cacheMonitorReady && result.cacheMonitorUI.visible
      if (process.env.WHALE_PET_LIVE_CHECK_DIR) {
        fs.mkdirSync(process.env.WHALE_PET_LIVE_CHECK_DIR, { recursive: true })
        // 保持手动/全屏隐身；截图时仅临时允许后台绘制，验收完成后恢复节流。
        const backgroundThrottling = petWin.webContents.getBackgroundThrottling()
        let captureWindow
        petWin.webContents.setBackgroundThrottling(false)
        try {
          await delay(150)
          // 原窗口保持隐身，用相同尺寸的离屏窗口绘制其静态实时 DOM。
          const snapshot = await petWin.webContents.executeJavaScript(`(() => {
            const html = document.documentElement.cloneNode(true)
            html.querySelectorAll('script').forEach(el => el.remove())
            const images = [...document.images]
            html.querySelectorAll('img').forEach((el, index) => el.setAttribute('src', images[index].src))
            return '<!DOCTYPE html>' + html.outerHTML
          })()`)
          const snapshotPath = path.join(process.env.WHALE_PET_LIVE_CHECK_DIR, 'production-view.html')
          fs.writeFileSync(snapshotPath, snapshot, 'utf8')
          const [width, height] = petWin.getContentSize()
          captureWindow = new BrowserWindow({ width, height, transparent: true, frame: false, show: false, skipTaskbar: true,
            webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } })
          let captureTimeout
          try {
            const image = await Promise.race([
              (async () => {
                await captureWindow.loadFile(snapshotPath)
                const loaded = await captureWindow.webContents.executeJavaScript(`Promise.all([...document.images].map(img => img.complete ? Promise.resolve(img.naturalWidth > 0) : new Promise(resolve => { img.onload = () => resolve(true); img.onerror = () => resolve(false) })))`)
                if (!loaded.every(Boolean)) throw new Error('Production preview image failed to load')
                await delay(100)
                return captureWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
              })(),
              new Promise((_, reject) => { captureTimeout = setTimeout(() => reject(new Error('Production screenshot timed out')), 5000) }),
            ])
            const png = image.toPNG()
            fs.writeFileSync(path.join(process.env.WHALE_PET_LIVE_CHECK_DIR, 'production-pet.png'), png)
            result.capture = { method: 'live-dom-offscreen', sourceHidden: !petWin.isVisible(), previewHidden: !captureWindow.isVisible(), bytes: png.length }
          } finally {
            clearTimeout(captureTimeout)
          }
        } catch (err) {
          result.capture = { error: String(err && err.message || err).slice(0, 160) }
          result.pass = false
        } finally {
          if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy()
          petWin.webContents.setBackgroundThrottling(backgroundThrottling)
        }
        fs.writeFileSync(path.join(process.env.WHALE_PET_LIVE_CHECK_DIR, 'production-acceptance.json'), JSON.stringify(result, null, 2), 'utf8')
      }
      console.log('[verify-live] ' + JSON.stringify(result))
    }
    if (process.argv.includes('--demo-cache-alert')) await showCacheAlertDemo()

    if (isSmokeTest) {
      let smokePassed = true
      // 等首次余额就绪（接口慢时最长 15s），避免固定 3.5s 截到加载态
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (petWin && !petWin.isDestroyed()) {
          const txt = await petWin.webContents.executeJavaScript(`document.querySelector('.dshp-amount') ? document.querySelector('.dshp-amount').textContent : ''`).catch(() => '')
          if (txt && txt !== '--' && !txt.includes('加载')) break
        }
      }
      if (petWin && !petWin.isDestroyed()) {
        try {
          const info = await petWin.webContents.executeJavaScript(`(() => {
            const el = (s) => document.querySelector(s)
            return {
              pet: !!el('.dshp-root'),
              imgLoaded: !!el('.dshp-img') && el('.dshp-img').complete && el('.dshp-img').naturalWidth > 0,
              label: el('.dshp-label') ? el('.dshp-label').textContent : null,
              time: el('.dshp-time') ? el('.dshp-time').textContent : null,
              amount: el('.dshp-amount') ? el('.dshp-amount').textContent : null,
              hint: el('.dshp-hint') ? el('.dshp-hint').textContent : null,
              bodyText: document.body.innerText,
            }
          })()`)
          console.log('[smoke] DOM=' + JSON.stringify(info))
          if (!info.pet || !info.imgLoaded || !/\d+\.\d{2}/.test(info.amount || '')) smokePassed = false
          try {
            await petWin.webContents.executeJavaScript(`window.pet.setPosition(120, 130)`)
            await new Promise((r) => setTimeout(r, 400))
            const pos = await petWin.webContents.executeJavaScript(`window.pet.getPosition()`)
            console.log('[smoke] pos-ipc=' + JSON.stringify(pos))
            if (pos.x !== 120 || pos.y !== 130) smokePassed = false
          } catch (err) { smokePassed = false; console.error('[smoke] pos-ipc failed:', err) }
          const image = await petWin.webContents.capturePage()
          const outDir = process.env.WHALE_PET_SMOKE_DIR || app.getPath('temp')
          fs.mkdirSync(outDir, { recursive: true })
          const shot = path.join(outDir, 'whale-pet-smoke.png')
          fs.writeFileSync(shot, image.toPNG())
          const bmp = nativeImage.createFromBuffer(image.toPNG()).toBitmap()
          let opaque = 0
          const total = bmp.length / 4
          for (let i = 0; i < bmp.length; i += 4) if (bmp[i + 3] > 8) opaque++
          console.log('[smoke] pixels total=' + total + ' opaque=' + opaque + ' ratio=' + (opaque / total).toFixed(3))
          if (!total || opaque / total < 0.05) smokePassed = false
          console.log('[smoke] screenshot=' + shot)

          // 设置窗口检查
          openSettings()
          await new Promise((r) => setTimeout(r, 1800))
          if (settingsWin && !settingsWin.isDestroyed()) {
            const sinfo = await settingsWin.webContents.executeJavaScript(
              `(() => ({
                title: document.title,
                hasInput: !!document.getElementById('keyInput'),
                hasLabel: !!document.getElementById('labelInput'),
                hasSnap: !!document.getElementById('snapInput'),
                hasUrl: !!document.getElementById('urlInput'),
                hasRefresh: !!document.getElementById('refreshInput'),
                hasLow: !!document.getElementById('lowAlertInput'),
                hasThreshold: !!document.getElementById('lowThresholdInput'),
                hasAutoStart: !!document.getElementById('autoStartInput'),
                hasIdle: !!document.getElementById('idleInput'),
                hasStats: !!document.getElementById('trackStatsInput'),
                hasBounce: !!document.getElementById('bounceInput'),
                hasSound: !!document.getElementById('soundInput'),
                hasCacheMonitor: !!document.getElementById('cacheMonitorInput'),
                hourlyThresholdFixed: document.getElementById('cacheMonitorThresholdInput')?.readOnly === true && document.getElementById('cacheMonitorThresholdInput')?.value === '80',
                oldCacheRepeatRemoved: !document.getElementById('cacheMonitorRepeatInput'),
                hasQuotes: !!document.getElementById('quotesInput'),
                hasImage: !!document.getElementById('imageBtn'),
                hasHotkey: !!document.getElementById('hotkeyInput'),
                hasAlwaysTop: !!document.getElementById('alwaysTopInput'),
                hasShowTime: !!document.getElementById('showTimeInput'),
              }))()`
            )
            console.log('[smoke] settings=' + JSON.stringify(sinfo))
            if (Object.entries(sinfo).some(([key, value]) => key !== 'title' && value !== true)) smokePassed = false
          // 布局自检：body 不应滚动（避免双滚动条），只有内层滚动区滚动
          try {
            const lay = await settingsWin.webContents.executeJavaScript(`(() => {
              const sc = document.querySelector('.scroll')
              return {
                winH: window.innerHeight,
                bodyScrollH: document.body.scrollHeight,
                bodyOverflow: document.body.scrollHeight - window.innerHeight,
                scrollOverflow: sc ? sc.scrollHeight - sc.clientHeight : -1
              }
            })()`)
            console.log('[smoke] settings-layout=' + JSON.stringify(lay))
            if (lay.bodyOverflow > 1) smokePassed = false
          } catch (err) { smokePassed = false; console.error('[smoke] settings-layout failed:', err) }
          // 设置窗口复选框是否反映保存的值（idleTransparency 应为 false）
          try {
            const boxes = await settingsWin.webContents.executeJavaScript(`(() => ({
              idle: document.getElementById('idleInput').checked,
              snap: document.getElementById('snapInput').checked,
              lock: document.getElementById('lockInput').checked,
            }))()`)
            console.log('[smoke] settings-boxes=' + JSON.stringify(boxes))
          // 自动保存自检：勾选 snap 开关（不点保存），等 1 秒看配置是否自动写入
          try {
            const snapBefore = loadConfig().snap
            await settingsWin.webContents.executeJavaScript(`(() => {
              var el = document.getElementById('snapInput')
              el.checked = true
              el.dispatchEvent(new Event('change', { bubbles: true }))
            })()`)
            await new Promise((r) => setTimeout(r, 1200))
            const snapAfter = loadConfig().snap
            console.log('[smoke] auto-save snap before=' + snapBefore + ' after=' + snapAfter)
            if (snapAfter !== true) smokePassed = false
          } catch (err) { smokePassed = false; console.error('[smoke] auto-save test failed:', err) }
          } catch (err) { smokePassed = false; console.error('[smoke] settings-boxes failed:', err) }
          // 音频状态检查（音效功能）
          try {
            const audioState = await petWin.webContents.executeJavaScript(`window.__dshpAudioTest()`)
            console.log('[smoke] audio-state=' + audioState)
            if (audioState !== 'running') smokePassed = false
          // 打印桌宠实际应用的功能开关（验证设置记忆）
          try {
            const flags = await petWin.webContents.executeJavaScript(`window.__dshpFlags ? window.__dshpFlags() : null`)
            const cfgState = await petWin.webContents.executeJavaScript(`window.__dshpConfig ? window.__dshpConfig() : null`)
            console.log('[smoke] applied-flags=' + JSON.stringify(flags) + ' cfg=' + JSON.stringify(cfgState))
            // 部分保存保真自检：只传 displayMode 字段不应破坏其他配置（任务栏模式已删，借字段做探针）
            try {
              const before = loadConfig()
              await settingsWin.webContents.executeJavaScript(`window.pet.saveSettings({ displayMode: 'tray' })`)
              await new Promise((r) => setTimeout(r, 800))
              const after = loadConfig()
              const preserved = before.apiKey === after.apiKey && before.baseUrl === after.baseUrl &&
                before.scale === after.scale && before.lockPosition === after.lockPosition && before.refreshSec === after.refreshSec
              console.log('[smoke] partial-save-preserve=' + (preserved ? 'PASS' : 'FAIL'))
              if (!preserved) smokePassed = false
            } catch (err) { smokePassed = false; console.error('[smoke] partial-save test failed:', err) }
          } catch (err) { smokePassed = false; console.error('[smoke] flags check failed:', err) }
          // 刷新不闪 "--" 自检：模拟余额 10.00 -> 9.50，过程中数字应保持旧值并滚动
          try {
            const flashTest = await petWin.webContents.executeJavaScript(`(async () => {
              // 第一次：把余额设成 10.00
              window.__dshpSetFakeBalance({ ok: true, totalBalance: '10.00', currency: 'CNY' })
              window.__dshpTestRefresh()
              for (var firstWait = 0; firstWait < 40; firstWait++) {
                await new Promise(function (r) { setTimeout(r, 100) })
                if (window.__dshpTestState().status === 'ok' && window.__dshpTestState().amount.includes('10.00')) break
              }
              var before = window.__dshpTestState()
              // 第二次：余额变成 9.50，且请求有 350ms 延迟（模拟自动刷新进行中）
              window.__dshpSetFakeBalance(function () {
                return new Promise(function (r) { setTimeout(function () {
                  r({ ok: true, totalBalance: '9.50', currency: 'CNY' })
                }, 350) })
              })
              window.__dshpTestRefresh()
              await new Promise(function (r) { setTimeout(r, 120) })   // 请求进行中：数字应保持 10.00，绝不是 "--"
              var during = window.__dshpTestState()
              for (var secondWait = 0; secondWait < 40; secondWait++) {
                await new Promise(function (r) { setTimeout(r, 100) })
                if (window.__dshpTestState().status === 'ok' && window.__dshpTestState().amount.includes('9.50')) break
              }
              var after = window.__dshpTestState()
              window.__dshpSetFakeBalance(null)
              return { before: before, during: during, after: after }
            })()`)
            console.log('[smoke] refresh-flash=' + JSON.stringify(flashTest))
            if (flashTest.during.amount === '--' || !String(flashTest.after.amount).includes('9.50')) smokePassed = false
          } catch (err) {
            smokePassed = false
            console.error('[smoke] refresh-flash test failed:', err)
          }
          } catch (err) { smokePassed = false; console.error('[smoke] audio check failed:', err) }
          } else { smokePassed = false }
        } catch (err) {
          smokePassed = false
          console.error('[smoke] failed:', err)
        }
      } else { smokePassed = false }
      console.log('[smoke] ' + (smokePassed ? 'PASS' : 'FAIL'))
      app.exit(smokePassed ? 0 : 1)
      return
    }

    if (isFsSmokeTest) {
      // 全屏隐身管道自检：不真开全屏，直接翻转 fsFullscreen 验证隐/显与恢复
      await new Promise((r) => setTimeout(r, 2500))
      const vis0 = petWin.isVisible()
      fsFullscreen = true
      applyVisibility()
      await new Promise((r) => setTimeout(r, 400))
      const vis1 = petWin.isVisible()
      fsFullscreen = false
      applyVisibility()
      await new Promise((r) => setTimeout(r, 400))
      const vis2 = petWin.isVisible()
      console.log('[fs-smoke] visible before=' + vis0 + ' duringFullscreen=' + vis1 + ' afterRestore=' + vis2)
      const pass = vis0 === true && vis1 === false && vis2 === true
      console.log('[fs-smoke] ' + (pass ? 'PASS' : 'FAIL'))
      app.exit(pass ? 0 : 1)
      return    }

    if (isJwtSmokeTest) {
      // JWT 过期重登自检：登录 → 把过期时间拨到过去 → 再取 → 应自动重登成功
      await new Promise((r) => setTimeout(r, 1500))
      try {
        const t1 = await ensurePanelJwt()
        panelJwtExpiresAt = Date.now() - 1000
        const t2 = await ensurePanelJwt()
        const ok = !!(t2 && t2.length > 100)
        console.log('[jwt-smoke] len1=' + (t1 || '').length + ' len2=' + (t2 || '').length + ' relogin=' + ok)
        console.log('[jwt-smoke] ' + (ok ? 'PASS' : 'FAIL'))
        app.exit(ok ? 0 : 1)
      } catch (err) {
        console.log('[jwt-smoke] FAIL: ' + String(err && err.message || err))
        app.exit(1)
      }
      return
    }

    if (isCaptureDemo) {
      const outDir = process.env.WHALE_PET_CAPTURE_DIR || app.getPath('temp')
      fs.mkdirSync(outDir, { recursive: true })
      const save = async (w, name) => {
        if (!w || w.isDestroyed()) return
        const img = await w.webContents.capturePage()
        fs.writeFileSync(path.join(outDir, name), img.toPNG())
        console.log('[capture] ' + name)
      }
      await new Promise((r) => setTimeout(r, 3500))   // 等首次余额
      if (petWin && !petWin.isDestroyed()) {
        await save(petWin, 'shot-balance.png')
        // 余额上涨 -> 情绪 😊
        await petWin.webContents.executeJavaScript(`window.__dshpSetFakeBalance({ ok: true, totalBalance: '9.99', currency: 'CNY' })`)
        await petWin.webContents.executeJavaScript(`window.__dshpTestRefresh()`)
        await new Promise((r) => setTimeout(r, 1600))
        await save(petWin, 'shot-updated.png')
        // 低余额 -> 😰 红色
        await petWin.webContents.executeJavaScript(`window.__dshpSetFakeBalance({ ok: true, totalBalance: '2.00', currency: 'CNY' })`)
        await petWin.webContents.executeJavaScript(`window.__dshpTestRefresh()`)
        await new Promise((r) => setTimeout(r, 1600))
        await save(petWin, 'shot-low.png')
        // 恢复真实余额
        await petWin.webContents.executeJavaScript(`window.__dshpSetFakeBalance(null)`)
        await petWin.webContents.executeJavaScript(`window.__dshpTestRefresh()`)
        await new Promise((r) => setTimeout(r, 1200))
        // 设置窗口
        openSettings()
        await new Promise((r) => setTimeout(r, 1600))
        if (settingsWin && !settingsWin.isDestroyed()) await save(settingsWin, 'shot-settings.png')
        console.log('[capture] done -> ' + outDir)
      }
      app.quit()
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (!isQuitting && !SELF_TEST_MODE) recoverPet('window-all-closed')
  else if (SELF_TEST_MODE && process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  isQuitting = true
  recordLifecycle('quit-requested')
  if (petLayoutTimer) clearTimeout(petLayoutTimer)
  if (petRecoveryTimer) clearTimeout(petRecoveryTimer)
  if (posSaveTimer) clearTimeout(posSaveTimer)
  if (petWin && !petWin.isDestroyed()) {
    try { const [x, y] = petWin.getPosition(); cfg = saveConfig({ x, y, placement: petLayout && petLayout.placement }) }
    catch (err) { logFatal('quit-save', err) }
  }
  stopCacheMonitor()
})
