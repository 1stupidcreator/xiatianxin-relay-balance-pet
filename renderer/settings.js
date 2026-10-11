'use strict'
var $ = function (id) { return document.getElementById(id) }
var siteTypeSelect = $('siteTypeSelect')
var baseUrlInput = $('baseUrlInput')
var panelEmailInput = $('panelEmailInput')
var panelPasswordInput = $('panelPasswordInput')
var sub2apiFields = $('sub2apiFields')
var deepseekFields = $('deepseekFields')
var pushEnabledInput = $('pushEnabledInput')
var pushUrlInput = $('pushUrlInput')
var pushTestBtn = $('pushTestBtn')
var scaleInput = $('scaleInput')
var scaleVal = $('scaleVal')
var lockInput = $('lockInput')
var fsHideInput = $('fsHideInput')
var manualHideInput = $('manualHideInput')
var visibilityStatus = $('visibilityStatus')
var keyInput = $('keyInput')
var labelInput = $('labelInput')
var urlInput = $('urlInput')
var refreshInput = $('refreshInput')
var snapInput = $('snapInput')
var lowAlertInput = $('lowAlertInput')
var lowThresholdInput = $('lowThresholdInput')
var trackStatsInput = $('trackStatsInput')
var idleInput = $('idleInput')
var idleSecInput = $('idleSecInput')
var showTimeInput = $('showTimeInput')
var bounceInput = $('bounceInput')
var soundInput = $('soundInput')
var dailySpendAlertInput = $('dailySpendAlertInput')
var dailySpendStepInput = $('dailySpendStepInput')
var cacheMonitorInput = $('cacheMonitorInput')
var cacheMonitorThresholdInput = $('cacheMonitorThresholdInput')
var cacheAlertSoundInput = $('cacheAlertSoundInput')
var cachePauseHoursInput = $('cachePauseHoursInput')
var cachePauseBtn = $('cachePauseBtn')
var cacheResumeBtn = $('cacheResumeBtn')
var cacheTestBtn = $('cacheTestBtn')
var cacheTestStatus = $('cacheTestStatus')
var cachePauseStatus = $('cachePauseStatus')
var quotesInput = $('quotesInput')
var quotesTextInput = $('quotesTextInput')
var customImageInput = $('customImageInput')
var imageBtn = $('imageBtn')
var autoStartInput = $('autoStartInput')
var autoStartStatusEl = $('autoStartStatus')
var hotkeyInput = $('hotkeyInput')
var alwaysTopInput = $('alwaysTopInput')
var saveBtn = $('saveBtn')
var testBtn = $('testBtn')
var discardCloseBtn = $('discardCloseBtn')
var statusEl = $('status')

function show(msg, cls) {
  statusEl.textContent = msg
  statusEl.className = cls || ''
}

function applyVisibilityState(state) {
  if (!state) return
  manualHideInput.checked = state.manualHidden === true
  manualHideInput.disabled = false
  visibilityStatus.textContent = state.manualHidden ? '手动隐身中，取消勾选可恢复。'
    : state.temporaryHidden ? '临时隐身中，10 秒到期后自动恢复。'
    : state.fullscreenHidden ? '全屏应用运行中，退出全屏后自动恢复。' : '桌宠当前显示。'
}
window.pet.onVisibilityUpdated(applyVisibilityState)
window.pet.getVisibility().then(applyVisibilityState).catch(function () { visibilityStatus.textContent = '无法读取显示状态，请重新打开设置。' })
manualHideInput.addEventListener('change', function () {
  manualHideInput.disabled = true
  window.pet.setManualHidden(manualHideInput.checked).then(applyVisibilityState).catch(function () {
    window.pet.getVisibility().then(applyVisibilityState)
    show('隐身切换失败，请重试', 'err')
  })
})

function applySiteTypeVisibility() {
  var isSub2 = siteTypeSelect.value !== 'deepseek'
  sub2apiFields.style.display = isSub2 ? '' : 'none'
  deepseekFields.style.display = isSub2 ? 'none' : ''
}

siteTypeSelect.addEventListener('change', function () {
  applySiteTypeVisibility()
  scheduleSave()
})

scaleInput.addEventListener('input', function () {
  scaleVal.textContent = scaleInput.value + '%'
})

var hasSavedPanelPassword = false
var settingsReady = false
var saveQueue = Promise.resolve()
var pendingSaves = 0
var settingsRevision = 0
var savedSettingsRevision = 0
var closingSettings = false
var allowSettingsClose = false
var autoStartRevision = 0
var savedAutoStartRevision = 0
saveBtn.disabled = testBtn.disabled = true
autoStartInput.addEventListener('change', function () { autoStartRevision++ })
function applyAutoStartStatus(state, requested) {
  if (!autoStartStatusEl) return
  autoStartStatusEl.textContent = state && state.enabled ? '已启用（Windows 已确认），登录后自动启动。'
    : requested ? '自启尚未生效，请点击保存重试。' : '开机自启已关闭。'
  autoStartStatusEl.style.color = requested && !(state && state.enabled) ? '#b34b43' : ''
}

// CC Switch 统计读取是独立的运行时开关，不写入账户配置；暂停截止时间由主进程持久化。
var cachePauseUntil = 0
function formatPauseRemaining(until) {
  var ms = Math.max(0, until - Date.now())
  var minutes = Math.ceil(ms / 60000)
  if (minutes >= 60) {
    var hours = Math.floor(minutes / 60)
    var rest = minutes % 60
    return hours + ' 小时' + (rest ? ' ' + rest + ' 分钟' : '')
  }
  return Math.max(1, minutes) + ' 分钟'
}
function applyCachePauseState(state) {
  var until = Number(state && (state.pausedUntil || state.pauseUntil || state.cacheStatsPausedUntil))
  cachePauseUntil = Number.isFinite(until) && until > Date.now() ? until : 0
  if (!cachePauseStatus) return
  var paused = cachePauseUntil > Date.now()
  cachePauseStatus.textContent = paused
    ? 'CC Switch 缓存统计与告警已暂停，剩余约 ' + formatPauseRemaining(cachePauseUntil) + '；JWT 账号统计不受影响。'
    : '当前未暂停 CC Switch 统计读取。'
  cachePauseStatus.className = paused ? 'tip muted' : 'tip'
  if (cachePauseBtn) cachePauseBtn.disabled = paused
  if (cacheResumeBtn) cacheResumeBtn.disabled = !paused
}
function refreshCachePauseState() {
  if (cachePauseUntil && cachePauseUntil <= Date.now()) {
    cachePauseUntil = 0
    applyCachePauseState(null)
  } else {
    applyCachePauseState({ pausedUntil: cachePauseUntil })
  }
}
function readCachePauseState() {
  if (!window.pet.getCacheMonitor) return
  window.pet.getCacheMonitor().then(applyCachePauseState).catch(function () {})
}
function pauseCacheReads(hours) {
  if (window.pet.pauseCacheMonitor) return window.pet.pauseCacheMonitor(hours)
  if (window.pet.setCacheMonitorPause) return window.pet.setCacheMonitorPause(hours)
  return Promise.reject(new Error('当前版本未提供暂停 CC Switch 统计读取接口'))
}
function resumeCacheReads() {
  if (window.pet.resumeCacheMonitor) return window.pet.resumeCacheMonitor()
  if (window.pet.clearCacheMonitorPause) return window.pet.clearCacheMonitorPause()
  return Promise.reject(new Error('当前版本未提供恢复 CC Switch 统计读取接口'))
}
function monitorResultState(result) {
  return result && (result.monitor || result.cacheMonitor || result)
}
if (cachePauseBtn) cachePauseBtn.addEventListener('click', function () {
  var hours = Math.round(Math.max(1, Math.min(168, num(cachePauseHoursInput.value, 1))))
  cachePauseHoursInput.value = hours
  cachePauseBtn.disabled = true
  cacheResumeBtn.disabled = true
  cachePauseStatus.textContent = '正在暂停 CC Switch 统计读取…'
  pauseCacheReads(hours).then(function (result) {
    applyCachePauseState(monitorResultState(result))
    if (!cachePauseUntil) cachePauseStatus.textContent = '暂停请求已发送，正在等待主进程确认。'
  }).catch(function (error) {
    applyCachePauseState({ pausedUntil: cachePauseUntil })
    cachePauseStatus.textContent = (error && error.message) || '暂停失败，请重试。'
    cachePauseStatus.className = 'tip err'
  })
})
if (cacheResumeBtn) cacheResumeBtn.addEventListener('click', function () {
  cacheResumeBtn.disabled = true
  cachePauseBtn.disabled = true
  cachePauseStatus.textContent = '正在恢复 CC Switch 统计读取…'
  resumeCacheReads().then(function (result) {
    applyCachePauseState(monitorResultState(result))
  }).catch(function (error) {
    applyCachePauseState({ pausedUntil: cachePauseUntil })
    cachePauseStatus.textContent = (error && error.message) || '恢复失败，请重试。'
    cachePauseStatus.className = 'tip err'
  })
})
readCachePauseState()
if (window.pet.onCacheMonitorUpdated) window.pet.onCacheMonitorUpdated(applyCachePauseState)
setInterval(refreshCachePauseState, 1000)
function saveCurrentSettings(explicit) {
  if (!settingsReady) return Promise.resolve({ ok: false, error: '设置尚未加载，请稍后重试' })
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  pendingSaves++
  saveQueue = saveQueue.catch(function () {}).then(function () {
    var revision = autoStartRevision
    var editRevision = settingsRevision
    var patch = collect()
    // 普通字段自动保存不重复注册开机自启；手动保存仍可重试同值注册。
    if (explicit !== true && revision === savedAutoStartRevision) delete patch.autoStart
    return window.pet.saveSettings(patch).then(function (result) {
      if (result && result.ok && autoStartRevision === revision) savedAutoStartRevision = revision
      if (result && result.ok) savedSettingsRevision = Math.max(savedSettingsRevision, editRevision)
      applyAutoStartStatus(result && result.autoStartStatus, autoStartInput.checked)
      return result
    })
  }).catch(function (error) { return { ok: false, error: String(error && error.message || '保存失败，请重试') } })
    .finally(function () { pendingSaves-- })
  return saveQueue
}

async function flushSettingsBeforeClose() {
  while (saveTimer || pendingSaves || settingsRevision > savedSettingsRevision) {
    var revision = settingsRevision
    var result = await saveCurrentSettings()
    if (!result || !result.ok) return result || { ok: false, error: '关闭前保存失败，请重试' }
    if (revision === settingsRevision && !saveTimer && !pendingSaves && settingsRevision <= savedSettingsRevision) return result
  }
  return { ok: true }
}

function setClosingLock(locked) {
  Array.prototype.forEach.call(document.querySelectorAll('input, select, textarea, button'), function (el) {
    if (el === discardCloseBtn) return
    if (locked) {
      el.dataset.closeWasDisabled = el.disabled ? '1' : '0'
      el.disabled = true
    } else if (Object.prototype.hasOwnProperty.call(el.dataset, 'closeWasDisabled')) {
      el.disabled = el.dataset.closeWasDisabled === '1'
      delete el.dataset.closeWasDisabled
    }
  })
}

function requestSettingsClose() {
  setClosingLock(true)
  discardCloseBtn.disabled = true
  allowSettingsClose = true
  window.pet.closeSettings().then(function (result) {
    if (result && result.ok) return
    allowSettingsClose = false
    closingSettings = false
    setClosingLock(false)
    discardCloseBtn.hidden = false
    discardCloseBtn.disabled = false
    show('设置窗口未能关闭，已保留修改。', 'err')
  }).catch(function () {
    allowSettingsClose = false
    closingSettings = false
    setClosingLock(false)
    discardCloseBtn.hidden = false
    discardCloseBtn.disabled = false
    show('设置窗口未能关闭，已保留修改。', 'err')
  })
}
window.pet.getFullConfig().then(function (c) {
  if (!c) throw new Error('未取得配置')
  siteTypeSelect.value = (c.siteType === 'deepseek') ? 'deepseek' : 'sub2api'
  if (c.baseUrl) baseUrlInput.value = c.baseUrl
  if (c.panelEmail) panelEmailInput.value = c.panelEmail
  hasSavedPanelPassword = !!c.hasPanelPassword
  if (hasSavedPanelPassword) panelPasswordInput.placeholder = '已保存（留空保持不变，输入可修改）'
  pushEnabledInput.checked = !!c.pushEnabled
  if (c.pushUrl) pushUrlInput.value = c.pushUrl
  if (typeof c.scale === 'number') {
    scaleInput.value = String(Math.round(c.scale * 100))
    scaleVal.textContent = Math.round(c.scale * 100) + '%'
  }
  lockInput.checked = c.lockPosition !== false
  fsHideInput.checked = c.autoHideFullscreen !== false
  if (c.apiKey) keyInput.value = c.apiKey
  if (c.label) labelInput.value = c.label
  if (c.balanceUrl) urlInput.value = c.balanceUrl
  if (typeof c.refreshSec === 'number') refreshInput.value = c.refreshSec
  snapInput.checked = c.snap !== false
  lowAlertInput.checked = c.lowBalanceAlert !== false
  if (typeof c.lowThreshold === 'number') lowThresholdInput.value = c.lowThreshold
  trackStatsInput.checked = c.trackStats !== false
  idleInput.checked = c.idleTransparency !== false
  if (typeof c.idleSec === 'number') idleSecInput.value = c.idleSec
  showTimeInput.checked = !!c.showTime
  bounceInput.checked = c.bounceAnim !== false
  soundInput.checked = c.sound !== false
  dailySpendAlertInput.checked = c.dailySpendAlertEnabled !== false
  dailySpendStepInput.value = typeof c.dailySpendAlertStep === 'number' ? c.dailySpendAlertStep : 10
  cacheMonitorInput.checked = c.cacheMonitorEnabled !== false
  cacheMonitorThresholdInput.value = 80
  cacheAlertSoundInput.checked = c.cacheAlertSoundEnabled !== false
  quotesInput.checked = !!c.quotesEnabled
  if (c.quotesText) quotesTextInput.value = c.quotesText
  customImageInput.checked = !!c.customImage
  autoStartInput.checked = !!c.autoStart
  applyAutoStartStatus(c.autoStartStatus, c.autoStart)
  hotkeyInput.checked = c.hotkey !== false
  alwaysTopInput.checked = c.alwaysOnTop !== false
  applySiteTypeVisibility()
  settingsReady = true
  saveBtn.disabled = testBtn.disabled = false
}).catch(function () { show('设置加载失败，请关闭后重新打开；当前配置未改动。', 'err') })

function num(v, dft) {
  var n = parseFloat(v)
  return isFinite(n) ? n : dft
}

function collect() {
  return {
    apiKey: keyInput.value.trim(),
    siteType: siteTypeSelect.value === 'deepseek' ? 'deepseek' : 'sub2api',
    baseUrl: baseUrlInput.value.trim(),
    panelEmail: panelEmailInput.value.trim(),
    panelPassword: panelPasswordInput.value ? panelPasswordInput.value : (hasSavedPanelPassword ? undefined : ''),
    pushEnabled: pushEnabledInput.checked,
    pushUrl: pushUrlInput.value.trim(),
    label: labelInput.value.trim() || (siteTypeSelect.value === 'deepseek' ? 'DeepSeek 余额' : '账号余额'),
    balanceUrl: urlInput.value.trim(),
    scale: Math.round(num(scaleInput.value, 100)) / 100,
    lockPosition: lockInput.checked,
    autoHideFullscreen: fsHideInput.checked,
    refreshSec: Math.max(0, Math.min(3600, Math.round(num(refreshInput.value, 30)))),
    snap: snapInput.checked,
    lowBalanceAlert: lowAlertInput.checked,
    lowThreshold: Math.max(0, num(lowThresholdInput.value, 5)),
    trackStats: trackStatsInput.checked,
    idleTransparency: idleInput.checked,
    idleSec: Math.max(1, Math.min(300, Math.round(num(idleSecInput.value, 5)))),
    showTime: showTimeInput.checked,
    bounceAnim: bounceInput.checked,
    sound: soundInput.checked,
    dailySpendAlertEnabled: dailySpendAlertInput.checked,
    dailySpendAlertStep: Math.round(Math.max(0.01, Math.min(100000, num(dailySpendStepInput.value, 10))) * 100) / 100,
    cacheMonitorEnabled: cacheMonitorInput.checked,
    cacheAlertThreshold: 80,
    cacheAlertSoundEnabled: cacheAlertSoundInput.checked,
    quotesEnabled: quotesInput.checked,
    quotesText: quotesTextInput.value,
    customImage: customImageInput.checked,
    autoStart: autoStartInput.checked,
    hotkey: hotkeyInput.checked,
    alwaysOnTop: alwaysTopInput.checked,
  }
}

// 任何开关/输入改动后自动保存（防抖 500ms），不用手动点保存
var saveTimer = null
function scheduleSave() {
  if (!settingsReady) return
  settingsRevision++
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(function () {
    saveTimer = null
    saveCurrentSettings().then(function (r) {
      show(r && r.ok ? '已自动保存 ✓' : ((r && r.error) || '保存失败'), r && r.ok ? 'ok' : 'err')
    }).catch(function () { show('保存失败，请重试', 'err') })
  }, 500)
}
Array.prototype.forEach.call(document.querySelectorAll('input, textarea'), function (el) {
  if (el === manualHideInput || el === cachePauseHoursInput) return
  el.addEventListener('change', scheduleSave)
  el.addEventListener('input', scheduleSave)
})

saveBtn.addEventListener('click', async function () {
  var r = await saveCurrentSettings(true)
  show(r && r.ok ? '已保存。桌宠已用新配置自动刷新。' : ((r && r.error) || '保存失败'), r && r.ok ? 'ok' : 'err')
})

// 关闭窗口前提交最后一次编辑，避免防抖或排队中的保存被销毁。
window.addEventListener('beforeunload', function (event) {
  if (!settingsReady || allowSettingsClose || (!saveTimer && !pendingSaves && settingsRevision <= savedSettingsRevision)) return
  event.preventDefault()
  event.returnValue = false
  if (closingSettings) return
  closingSettings = true
  flushSettingsBeforeClose().then(function (result) {
    if (!result || !result.ok) {
      closingSettings = false
      discardCloseBtn.hidden = false
      discardCloseBtn.disabled = false
      show((result && result.error) || '关闭前保存失败，请重试', 'err')
      return
    }
    requestSettingsClose()
  })
})
discardCloseBtn.addEventListener('click', function () {
  if (closingSettings) return
  closingSettings = true
  discardCloseBtn.hidden = true
  requestSettingsClose()
})

testBtn.addEventListener('click', async function () {
  var r = await saveCurrentSettings(true)
  if (!r || !r.ok) { show('保存失败', 'err'); return }
  show('正在测试…', 'muted')
  var b = await window.pet.getBalance()
  if (b && b.ok) {
    show('✅ 连接成功，当前余额：' + (b.currency === 'CNY' ? '¥ ' : '') + Number(b.totalBalance).toFixed(2) + (b.currency !== 'CNY' && b.currency ? ' ' + b.currency : ''), 'ok')
  } else {
    show('❌ ' + ((b && b.error) || '测试失败'), 'err')
  }
})

imageBtn.addEventListener('click', async function () {
  var r = await window.pet.chooseImage()
  if (r && r.ok) {
    customImageInput.checked = true
    show('✅ 图片已设置，保存后生效。', 'ok')
  } else {
    show('未选择或读取失败。', 'err')
  }
})

pushTestBtn.addEventListener('click', async function () {
  var r = await saveCurrentSettings()
  if (!r || !r.ok) { show('保存失败', 'err'); return }
  if (!pushEnabledInput.checked || !pushUrlInput.value.trim()) { show('请先启用推送并填写 URL。', 'err'); return }
  show('正在发送测试推送…', 'muted')
  var t = await window.pet.testPush()
  if (t && t.ok) show('✅ 测试推送已发送（HTTP ' + t.status + '）', 'ok')
  else show('❌ ' + ((t && (t.error || ('HTTP ' + t.status))) || '推送失败'), 'err')
})

cacheTestBtn.addEventListener('click', async function () {
  cacheTestBtn.disabled = true
  cacheTestStatus.textContent = '正在发送测试通知…'
  try {
    var result = await window.pet.testCacheAlert()
    cacheTestStatus.textContent = result && result.shown
      ? 'Windows 已确认测试通知。声音使用上方的“缓存告警声音”开关。'
      : 'Windows 未确认通知，请检查系统通知权限或勿扰设置后重试。'
  } catch (error) {
    cacheTestStatus.textContent = '测试通知失败，请重试。'
  } finally {
    cacheTestBtn.disabled = false
  }
})
