// 账号余额桌宠 —— 渲染层
// 拖拽(屏幕坐标)、四分之一吸附(可关)、镜像、Q弹、缩放、点击刷新、右键隐身10秒、自定义名称。
// 新增：悬停详情、闲置半透明、变动弹跳、提示音效、随机语录、自定义图片、今日消耗。
'use strict'

var MIN_SCALE = 0.6
var MAX_SCALE = 1.4
var STEP = 0.1
var CLICK_SQ = 9
var ANIM_MS = 700
var CHANGE_MS = 900
var QUOTE_SHOW_MS = 4000
var QUOTE_INTERVAL_MS = 30000

// 内置默认语录（20 条）：启用随机语录且未自定义文本时使用
var DEFAULT_QUOTES = [
  '我帮你盯着余额呢～',
  '余额还稳，放心冲！',
  '今天也要元气满满地写代码呀',
  '省着点花哦，细水长流～',
  '省下的都是赚到的',
  '今天的余额还好吗？',
  '稳住，我们能赢！',
  '今天也是省钱的一天',
  '别担心，我盯着呢',
  '用得起，但要省着用哦',
  '休息一下，余额没变',
  '加油打工人！',
  '早点休息，我替你守夜',
  '歇一会儿，喝口水吧～',
  '余额和快乐都要充值哦',
  '今天调用顺利吗？',
  '伸个懒腰，继续干活～',
  '额度有限，灵感无限',
  '省一点是一点，慢慢攒起来',
  '有事随时叫我，我一直在',
]

var root = document.getElementById('root')
var body = document.getElementById('body')
var img = document.getElementById('img')
var labelEl = document.getElementById('labelEl')
var amountEl = document.getElementById('amountEl')
var hintEl = document.getElementById('hintEl')
var timeEl = document.getElementById('timeEl')

var state = {
  scale: 1,
  h: null,
  hOff: 0,
  v: null,
  vOff: 0,
  left: 0,
  top: 0,
  size: 196,
  snap: true,
  locked: true,
  label: '账号余额',
  refreshSec: 30,
  balance: null,
  currency: null,
  granted: null,
  toppedUp: null,
  cachedAt: null,
  status: 'loading',
  message: '',
  lowThreshold: 5,
  flags: {
    showTime: false,
    idleTransparency: true, idleSec: 5,
    bounceAnim: true, sound: true,
    quotesEnabled: false, quotesText: '',
    customImage: false,
  },
  quotes: [],
}
var busy = false
var settleTimer = null
var amountSettleTimer = null
var drag = null
var dragFrame = null
var animId = null
var quoteTimer = null
var idleOn = false
var pointerInside = false
var screen = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

function fmt(balance, currency) {
  var num = Number(balance)
  var fixed = isFinite(num) ? num.toFixed(2) : '--'
  if (currency === 'CNY') return '¥ ' + fixed
  if (currency === 'USD') return '$ ' + fixed
  return fixed + (currency ? ' ' + currency : '')
}

function applyLabel(text) {
  state.label = text || '账号余额'
  labelEl.textContent = state.label
  scheduleCardFit()
}

// 金额完整显示；较长的名称和状态在小卡片中按可用宽度缩放。
var cardFitFrame = null
function fitCardText() {
  var value = hintEl.querySelector('.dshp-today-value')
  var caption = hintEl.querySelector('.dshp-today-label')
  // Parents must be reset before children: a child measurement must not use
  // the preceding frame's scaled hint font or dimensions.
  var elements = [labelEl, amountEl, hintEl, timeEl, caption, value].filter(Boolean)
  elements.forEach(function (el) { el.style.fontSize = '' })
  ;[labelEl, amountEl, timeEl, caption, value].filter(Boolean).forEach(function (el) {
    var range = document.createRange()
    range.selectNodeContents(el)
    var natural = range.getBoundingClientRect().width
    if (natural > el.clientWidth - 1 && el.clientWidth > 0) {
      var base = parseFloat(getComputedStyle(el).fontSize)
      el.style.fontSize = base * Math.max(1, el.clientWidth - 1) / natural + 'px'
    }
  })
  // Keep the oval stable while fitting its content, including optional time and long status messages.
  var box = document.getElementById('textBox'), css = getComputedStyle(box)
  var available = box.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)
  for (var i = 0; i < 6; i++) {
    var used = [labelEl, amountEl, hintEl, timeEl].reduce(function (sum, el) { return sum + el.getBoundingClientRect().height }, 0)
    if (used <= available || used <= 0) break
    var ratio = Math.max(1, available - 1) / used
    var sizes = elements.map(function (el) { return parseFloat(getComputedStyle(el).fontSize) })
    elements.forEach(function (el, index) { el.style.fontSize = sizes[index] * ratio + 'px' })
  }
}
function scheduleCardFit() {
  if (cardFitFrame !== null) return
  cardFitFrame = requestAnimationFrame(function () { cardFitFrame = null; fitCardText() })
}
var cardTextObserver = new MutationObserver(scheduleCardFit)
;[labelEl, amountEl, hintEl, timeEl].forEach(function (el) { cardTextObserver.observe(el, { childList: true, characterData: true, subtree: true }) })
window.addEventListener('resize', scheduleCardFit)
document.fonts.ready.then(scheduleCardFit)
scheduleCardFit()

function applyFlags(c) {
  if (!c) return
  var f = state.flags
  if (typeof c.showTime === 'boolean') { f.showTime = c.showTime; applyTime() }
  if (typeof c.idleTransparency === 'boolean') f.idleTransparency = c.idleTransparency
  if (typeof c.idleSec === 'number') f.idleSec = c.idleSec
  if (typeof c.bounceAnim === 'boolean') f.bounceAnim = c.bounceAnim
  if (typeof c.sound === 'boolean') f.sound = c.sound
  if (typeof c.quotesEnabled === 'boolean') f.quotesEnabled = c.quotesEnabled
  if (typeof c.quotesText === 'string') {
    f.quotesText = c.quotesText
    state.quotes = c.quotesText.split(/[;；\n]+/).map(function (s) { return s.trim() }).filter(function (s) { return s.length > 0 })
    if (state.quotes.length === 0) state.quotes = DEFAULT_QUOTES.slice()
  }
  if (typeof c.quotesEnabled === 'boolean' && c.quotesEnabled && state.quotes.length === 0) {
    state.quotes = DEFAULT_QUOTES.slice()
  }
  if (typeof c.lowThreshold === 'number') state.lowThreshold = c.lowThreshold
  if (typeof c.customImage === 'boolean') f.customImage = c.customImage
  applyHoverOpacity()
}

var timeShown = ''
var clockTimer = null
function applyTime() {
  root.classList.toggle('dshp-has-time', state.flags.showTime)
  timeEl.style.display = state.flags.showTime ? 'block' : 'none'
  scheduleCardFit()
  updateTime()
  if (clockTimer) clearInterval(clockTimer)
  clockTimer = state.flags.showTime ? setInterval(updateTime, 1000) : null
}
function updateTime() {
  var d = new Date()
  var p = function (n) { return String(n).padStart(2, '0') }
  var txt = p(d.getHours()) + ':' + p(d.getMinutes())
  if (txt !== timeShown) { timeShown = txt; timeEl.textContent = txt }
}

var imageRequest = 0
function applyImage() {
  var request = ++imageRequest
  if (!state.flags.customImage) {
    root.classList.remove('dshp-custom-image')
    img.src = '../assets/portrait.png'
    return
  }
  window.pet.getImageUrl().then(function (r) {
    if (request !== imageRequest) return
    var custom = !!(r && r.url)
    root.classList.toggle('dshp-custom-image', custom)
    img.src = custom ? r.url : '../assets/portrait.png'
  }).catch(function () {
    if (request !== imageRequest) return
    root.classList.remove('dshp-custom-image')
    img.src = '../assets/portrait.png'
  })
}

// ---------------------------------------------------------------------------
// 音效（Web Audio 合成，无需音频文件）
// ---------------------------------------------------------------------------
var audioCtx = null
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () {})
    }
    return audioCtx
  } catch (err) { return null }
}
function beep(kind) {
  if (!state.flags.sound) return
  var ctx = ensureAudio()
  if (!ctx) return
  try {
    var t = ctx.currentTime
    var notes = kind === 'up' ? [880, 1318.5] : (kind === 'down' ? [523.25, 392] : [392, 392])
    notes.forEach(function (freq, idx) {
      var osc = ctx.createOscillator()
      var gain = ctx.createGain()
      osc.type = 'sine'
      var start = t + idx * 0.12
      osc.frequency.setValueAtTime(freq, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.3)
    })
  } catch (err) { /* ignore */ }
}
// 首次用户点击时解锁音频（兼容自动播放策略）
function unlockAudio() {
  var ctx = ensureAudio()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {})
}
root.addEventListener('pointerdown', unlockAudio)

// ---------------------------------------------------------------------------
// 弹跳（表情已按需求移除）
// ---------------------------------------------------------------------------
function bounce() {
  if (!state.flags.bounceAnim) return
  body.classList.remove('dshp-bounce')
  void body.offsetWidth  // 强制重绘以重启动画
  body.classList.add('dshp-bounce')
}

window.pet.onDailySpendAlert(function (notice) {
  if (!notice) return
  // 事件携带本次请求的最新开关，避免设置保存与配置刷新之间的先后差异。
  applyFlags({ sound: notice.sound, bounceAnim: notice.bounceAnim })
  bounce()
  beep('up')
})

// ---------------------------------------------------------------------------
// 随机语录
// ---------------------------------------------------------------------------
function scheduleQuote() {
  if (quoteTimer) clearTimeout(quoteTimer)
  quoteTimer = null
  if (!state.flags.quotesEnabled || state.quotes.length === 0) return
  quoteTimer = setTimeout(function () {
    quoteTimer = null
    var q = state.quotes[Math.floor(Math.random() * state.quotes.length)]
    var saved = hintEl.textContent
    hintEl.textContent = q
    setTimeout(function () {
      if (hintEl.textContent === q) render()
    }, QUOTE_SHOW_MS)
    scheduleQuote()
  }, QUOTE_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// 闲置半透明
// ---------------------------------------------------------------------------
function applyHoverOpacity() {
  var shouldDim = state.flags.idleTransparency && !pointerInside
  idleOn = shouldDim
  root.classList.toggle('dshp-idle', shouldDim)
  window.pet.setIdle(shouldDim).catch(function () {})
}

// 测试钩子：返回音频上下文状态（自检用）
window.__dshpAudioTest = function () {
  var ctx = ensureAudio()
  return ctx ? ctx.state : 'none'
}

// ---------------------------------------------------------------------------
// 余额
// ---------------------------------------------------------------------------
function refresh(manual) {
  if (busy) return
  busy = true
  // 自动/手动刷新都保留旧数字，新值到达后直接从旧值滚动动画；
  // 只有首次加载（还没有任何余额）才显示加载态
  if (state.balance === null) { state.status = 'loading'; render() }
  var fb = window.__dshpFakeBalance
  var balancePromise = (fb !== null && fb !== undefined)
    ? Promise.resolve(typeof fb === 'function' ? fb() : fb)
    : window.pet.getBalance()
  balancePromise
    .then(function (data) {
      if (data && data.ok) {
        var nb = Number(data.totalBalance)
        var nc = String(data.currency || 'CNY')
        var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency)
        var currencyChanged = state.currency !== null && nc !== state.currency
        state.balance = nb
        state.currency = nc
        state.granted = data.grantedBalance
        state.toppedUp = data.toppedUpBalance
        state.cachedAt = data.cachedAt
        state.message = data.stale ? '网络抖动，沿用上次余额' : ''
        var low = state.lowThreshold > 0 && nb < state.lowThreshold
        if (low) {
          amountEl.classList.add('dshp-low')
        } else {
          amountEl.classList.remove('dshp-low')
        }
        if (changed && !currencyChanged) {
          state.status = 'changing'
          animateAmount(shownAmount(), nb, nc, ANIM_MS)
          if (amountSettleTimer) clearTimeout(amountSettleTimer)
          amountSettleTimer = setTimeout(function () {
            amountSettleTimer = null
            if (state.status === 'changing') { state.status = 'ok'; render() }
          }, CHANGE_MS)
        } else {
          if (animId === null) amountEl.textContent = fmt(nb, nc)
          state.status = 'ok'
          render()
        }
        // 今日已用：读本地余额差值统计（跨 Key 真实消耗；接口值是本 Key 级，钱包模式下恒 0）
        updateTodayUsedFromStats()
      } else {
        state.status = 'error'
        state.message = (data && data.error) ? String(data.error) : '获取失败'
        render()
      }
    })
    .catch(function () {
      state.status = 'error'
      state.message = '获取失败'
      render()
    })
    .finally(function () { busy = false })
}

function shownAmount() {
  var txt = amountEl.textContent.replace(/[^\d.\-]/g, '')
  var n = parseFloat(txt)
  return isFinite(n) ? n : state.balance
}

function animateAmount(from, to, currency, duration) {
  if (animId) cancelAnimationFrame(animId)
  if (from === null || !isFinite(from)) { amountEl.textContent = fmt(to, currency); return }
  var t0 = performance.now()
  function frame(t) {
    var p = clamp((t - t0) / duration, 0, 1)
    var e = 1 - Math.pow(1 - p, 3)
    var cur = from + (to - from) * e
    amountEl.textContent = fmt(cur, currency)
    if (p < 1) animId = requestAnimationFrame(frame)
    else animId = null
  }
  animId = requestAnimationFrame(frame)
}

function render() {
  if (state.status === 'changing') return
  if (state.status === 'ok') {
    amountEl.textContent = fmt(state.balance, state.currency)
    // 气泡第二行：今日已用（错误/加载态时该行显示状态信息）
    renderTodayHint()
  } else if (state.status === 'loading') {
    amountEl.textContent = '--'
    hintEl.textContent = '加载中…'
  } else {
    amountEl.textContent = state.balance !== null ? fmt(state.balance, state.currency) : '--'
    hintEl.textContent = state.message || '获取失败'
  }
}

function renderTodayHint() {
  var text = todayLine(), amount = text.slice('今日已用 '.length)
  if (hintEl.textContent === text && hintEl.querySelector('.dshp-today-value')) return
  var caption = document.createElement('span'), value = document.createElement('span')
  caption.className = 'dshp-today-label'
  caption.textContent = '今日已用'
  value.className = 'dshp-today-value'
  value.textContent = amount
  hintEl.replaceChildren(caption, document.createTextNode(' '), value)
}

// 今日已用文本：用本地余额差值统计（跨 Key 真实消耗）
function todayLine() {
  var v = lastKnownTodayUsed
  var sym = state.currency === 'CNY' ? '¥ ' : (state.currency === 'USD' ? '$ ' : '')
  return '今日已用 ' + sym + (isFinite(Number(v)) && v !== null ? Number(v).toFixed(2) : '--')
}

var lastKnownTodayUsed = null
function updateTodayUsedFromStats() {
  window.pet.getStats().then(function (st) {
    lastKnownTodayUsed = st && typeof st.todayUsed === 'number' ? st.todayUsed : null
    hintEl.title = st && st.todaySource === 'pending' ? '账号统计尚未同步，请检查设置中的面板账号'
      : (st && st.todayStale ? '账号统计暂时无法更新，保留上次已同步数据'
      : (st && st.todaySource === 'account' ? '账号今日实际扣除金额（包含全部 Key）' : '根据本地余额变化估算')
      )
    if (state.status === 'ok') render()
  })
}

// ---------------------------------------------------------------------------
// 缩放（改由设置窗口调节；桌宠本体不再显示 +/- 按钮）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 拖拽 + Q弹
// ---------------------------------------------------------------------------
var dragFrameId = null
var lockedTap = null   // 锁定态下记录按下位置，用于区分"轻点刷新"与"想拖动"
function scheduleExpress() {
  if (dragFrameId) return
  dragFrameId = requestAnimationFrame(function () {
    dragFrameId = null
    express()
  })
}

function onPointerDown(e) {
  if (e.button !== 0) return
  if (state.locked) {
    // 锁定（融入桌面）：不允许拖动；轻点仍刷新
    lockedTap = { x: e.clientX, y: e.clientY, moved: false }
    return
  }
  try { root.setPointerCapture(e.pointerId) } catch (err) {}
  var rect = root.getBoundingClientRect()
  drag = {
    active: true,
    pointerId: e.pointerId,
    ready: false,
    startScreenX: e.screenX,
    startScreenY: e.screenY,
    grabX: 0,
    grabY: 0,
    w: rect.width,
    h: rect.height,
    moved: false,
    vp: screen.workArea
  }
  root.classList.add('dshp-dragging')
  pressDown()
  var currentDrag = drag
  window.pet.getPosition().then(function (pos) {
    if (drag !== currentDrag || !currentDrag.active) return
    currentDrag.grabX = currentDrag.startScreenX - pos.x
    currentDrag.grabY = currentDrag.startScreenY - pos.y
    currentDrag.ready = true
  })
}

function onPointerMove(e) {
  if (lockedTap) {
    var dx = e.clientX - lockedTap.x, dy = e.clientY - lockedTap.y
    if (dx * dx + dy * dy >= CLICK_SQ) lockedTap.moved = true
    return
  }
  if (!drag || !drag.active || !drag.ready) return
  var mx = e.screenX - drag.startScreenX
  var my = e.screenY - drag.startScreenY
  if (mx * mx + my * my >= CLICK_SQ) drag.moved = true
  var wa = drag.vp
  state.left = clamp(e.screenX - drag.grabX, wa.x, Math.max(wa.x, wa.x + wa.width - drag.w))
  state.top = clamp(e.screenY - drag.grabY, wa.y, Math.max(wa.y, wa.y + wa.height - drag.h))
  scheduleExpress()
}

function endDrag(e, clickAllowed) {
  if (!drag || !drag.active) return
  drag.active = false
  pressUp()
  root.classList.remove('dshp-dragging')
  try {
    if (root.hasPointerCapture && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId)
  } catch (err) {}
  if (clickAllowed && !drag.moved) { refresh(true); return }
  if (dragFrameId) { cancelAnimationFrame(dragFrameId); dragFrameId = null }
  var wa = drag.vp
  var left = clamp(e.screenX - drag.grabX, wa.x, Math.max(wa.x, wa.x + wa.width - drag.w))
  var top = clamp(e.screenY - drag.grabY, wa.y, Math.max(wa.y, wa.y + wa.height - drag.h))
  if (state.snap) {
    var centerX = left + drag.w / 2
    var centerY = top + drag.h / 2
    if (centerX < wa.x + wa.width / 4) { state.h = 'left'; state.hOff = 0 }
    else if (centerX > wa.x + wa.width * 3 / 4) { state.h = 'right'; state.hOff = 0 }
    else { state.h = null; state.hOff = left }
    if (centerY < wa.y + wa.height / 4) { state.v = 'top'; state.vOff = 0 }
    else if (centerY > wa.y + wa.height * 3 / 4) { state.v = 'bottom'; state.vOff = 0 }
    else { state.v = null; state.vOff = top }
  } else {
    state.h = null
    state.v = null
    state.hOff = left
    state.vOff = top
  }
  state.left = left
  state.top = top
  settle()
}

// 抓取时只做轻微等比缩放，避免非等比压扁导致拖动时桌宠看起来在变形/放大
var SQUISH = 'scale(0.96)'
function pressDown() { body.style.transform = SQUISH }
function pressUp() { body.style.transform = 'scale(1)' }

root.addEventListener('pointerdown', onPointerDown)
root.addEventListener('pointermove', onPointerMove)
root.addEventListener('pointerup', function (e) {
  if (e.button !== 0) return
  if (state.locked) {
    if (lockedTap && !lockedTap.moved) refresh(true)
    lockedTap = null
    return
  }
  endDrag(e, true)
})
root.addEventListener('pointercancel', function (e) { lockedTap = null; endDrag(e, false) })
window.addEventListener('resize', function () {
  window.pet.getGeometry().then(function (geometry) {
    applyGeometry(geometry)
    scheduleCardFit()
  })
})

// ---------------------------------------------------------------------------
// 位置/吸附
// ---------------------------------------------------------------------------
var geometryRequest = 0
function applyGeometry(geometry) {
  if (!geometry) return
  state.left = geometry.x
  state.top = geometry.y
  state.size = geometry.size
  screen = { workArea: geometry.workArea, bounds: geometry.bounds }
  state.h = geometry.placement ? geometry.placement.h : null
  state.v = geometry.placement ? geometry.placement.v : null
  updateMirror()
}
window.pet.onGeometryUpdated(function (geometry) {
  geometryRequest++
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
  cancelPetInteraction()
  applyGeometry(geometry)
  scheduleCardFit()
})
function express() {
  var request = ++geometryRequest
  return window.pet.setPosition(state.left, state.top).then(function (geometry) {
    if (request === geometryRequest) applyGeometry(geometry)
    return geometry
  })
}

function settle() {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(function () {
    settleTimer = null
    var wa = screen.workArea
    var s = state.size
    var left, top
    if (state.snap) {
      left = state.h === 'left' ? wa.x : (state.h === 'right' ? wa.x + wa.width - s : state.left)
      top = state.v === 'top' ? wa.y : (state.v === 'bottom' ? wa.y + wa.height - s : state.top)
      left = state.h === null ? clamp(left, wa.x, Math.max(wa.x, wa.x + wa.width - s)) : left
      top = state.v === null ? clamp(top, wa.y, Math.max(wa.y, wa.y + wa.height - s)) : top
    } else {
      left = clamp(state.left, wa.x, Math.max(wa.x, wa.x + wa.width - s))
      top = clamp(state.top, wa.y, Math.max(wa.y, wa.y + wa.height - s))
    }
    state.left = left
    state.top = top
    updateMirror()
    express()
  }, 0)
}

function updateMirror() {
  if (state.snap && state.h === 'left') root.classList.add('dshp-left')
  else root.classList.remove('dshp-left')
}

// ---------------------------------------------------------------------------
// 右键临时隐身：菜单功能统一从托盘进入
// ---------------------------------------------------------------------------
function cancelPetInteraction() {
  lockedTap = null
  if (drag) {
    drag.active = false
    try {
      if (root.hasPointerCapture(drag.pointerId)) root.releasePointerCapture(drag.pointerId)
    } catch (err) {}
    drag = null
  }
  if (dragFrameId) { cancelAnimationFrame(dragFrameId); dragFrameId = null }
  root.classList.remove('dshp-dragging')
  pressUp()
}
window.addEventListener('contextmenu', function (e) {
  e.preventDefault()
  cancelPetInteraction()
  pointerInside = false
  applyHoverOpacity()
  window.pet.hideTemporarily()
})

// ---------------------------------------------------------------------------
// 悬停详情 + 闲置
// ---------------------------------------------------------------------------
root.addEventListener('pointerenter', function () { pointerInside = true; applyHoverOpacity() })
root.addEventListener('pointerleave', function () { pointerInside = false; applyHoverOpacity() })
window.addEventListener('blur', function () { pointerInside = !document.hidden && root.matches(':hover'); applyHoverOpacity() })
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    cancelPetInteraction()
    pointerInside = false
  } else {
    pointerInside = root.matches(':hover')
  }
  applyHoverOpacity()
})

// ---------------------------------------------------------------------------
// 配置更新
// ---------------------------------------------------------------------------
window.pet.onConfigUpdated(function () {
  window.pet.getConfig().then(function (c) {
    if (!c) return
    if (typeof c.snap === 'boolean') state.snap = c.snap
    if (typeof c.lockPosition === 'boolean') state.locked = c.lockPosition
    if (typeof c.label === 'string') applyLabel(c.label)
    if (typeof c.refreshSec === 'number') {
      state.refreshSec = c.refreshSec
      startAutoRefresh()
    }
    applyFlags(c)
    applyImage()
    scheduleQuote()
    settle()
  })
})

// ---------------------------------------------------------------------------
// 定时刷新
// ---------------------------------------------------------------------------
var refreshTimer = null
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  var sec = state.refreshSec
  if (sec > 0) {
    refreshTimer = setInterval(function () { refresh(false) }, sec * 1000)
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
Promise.all([window.pet.getPosition(), window.pet.getScreen(), window.pet.getSize(), window.pet.getConfig(), window.pet.getGeometry()])
  .then(function (res) {
    state.left = res[0].x
    state.top = res[0].y
    screen = res[1]
    state.size = res[2].size
    state.scale = res[2].scale
    applyGeometry(res[4])
    if (res[3]) {
      if (typeof res[3].scale === 'number') state.scale = res[3].scale
      if (typeof res[3].snap === 'boolean') state.snap = res[3].snap
      if (typeof res[3].lockPosition === 'boolean') state.locked = res[3].lockPosition
      if (typeof res[3].label === 'string') applyLabel(res[3].label)
      if (typeof res[3].refreshSec === 'number') state.refreshSec = res[3].refreshSec
      applyFlags(res[3])
    } else {
      applyLabel('账号余额')
    }
    applyImage()
    applyTime()
    pointerInside = root.matches(':hover')
    applyHoverOpacity()
    startAutoRefresh()
    scheduleQuote()
    settle()
    refresh(false)
  })
  .catch(function () {
    applyLabel('账号余额')
    refresh(false)
  })

window.pet.onRefreshRequested(function () { refresh(true) })

// 测试钩子（仅自检使用）
window.__dshpTestRefresh = function () { refresh(false) }
window.__dshpTestState = function () { return { amount: amountEl.textContent, status: state.status } }
window.__dshpSetFakeBalance = function (v) { window.__dshpFakeBalance = v }
window.__dshpFlags = function () { return JSON.parse(JSON.stringify(state.flags)) }
window.__dshpConfig = function () { return { snap: state.snap, label: state.label, refreshSec: state.refreshSec } }
