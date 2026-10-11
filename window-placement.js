'use strict'

// Geometry only: all coordinates are Electron display-independent pixels.
const EDGE_TOLERANCE = 2
const DEFAULT_SIZE = 196
const DEFAULT_RECT = { x: 0, y: 0, width: 1920, height: 1040 }

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function rectangle(value, fallback) {
  value = value || {}
  fallback = fallback || DEFAULT_RECT
  return {
    x: finite(value.x, fallback.x),
    y: finite(value.y, fallback.y),
    width: positive(value.width, fallback.width),
    height: positive(value.height, fallback.height),
  }
}

function displayGeometry(value, fallbackId) {
  value = value || {}
  const bounds = rectangle(value.bounds || value.workArea, DEFAULT_RECT)
  return {
    id: value.id === undefined || value.id === null ? fallbackId : value.id,
    bounds,
    workArea: rectangle(value.workArea, bounds),
  }
}

function safeEnd(origin, length) {
  return finite(origin + length, origin)
}

function ranges(workArea, bounds) {
  return {
    x: Math.max(0, finite(workArea.width - bounds.width, 0)),
    y: Math.max(0, finite(workArea.height - bounds.height, 0)),
  }
}

function fraction(position, origin, length) {
  return length > 0 ? clamp(finite((position - origin) / length, 0), 0, 1) : 0
}

function capturePlacement(bounds, display, snap) {
  const d = displayGeometry(display, 0)
  const b = rectangle(bounds, { ...DEFAULT_RECT, width: DEFAULT_SIZE, height: DEFAULT_SIZE })
  const travel = ranges(d.workArea, b)
  const right = safeEnd(d.workArea.x, travel.x)
  const bottom = safeEnd(d.workArea.y, travel.y)
  let h = null
  let v = null
  if (snap === true) {
    if (Math.abs(b.x - d.workArea.x) <= EDGE_TOLERANCE) h = 'left'
    else if (Math.abs(b.x - right) <= EDGE_TOLERANCE) h = 'right'
    if (Math.abs(b.y - d.workArea.y) <= EDGE_TOLERANCE) v = 'top'
    else if (Math.abs(b.y - bottom) <= EDGE_TOLERANCE) v = 'bottom'
  }
  return {
    version: 1,
    displayId: d.id,
    h,
    v,
    rx: fraction(b.x, d.workArea.x, travel.x),
    ry: fraction(b.y, d.workArea.y, travel.y),
  }
}

function overlap(a, b) {
  const width = Math.max(0, Math.min(safeEnd(a.x, a.width), safeEnd(b.x, b.width)) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(safeEnd(a.y, a.height), safeEnd(b.y, b.height)) - Math.max(a.y, b.y))
  return finite(width * height, Number.MAX_VALUE)
}

function distance(a, b) {
  const dx = Math.max(0, a.x - safeEnd(b.x, b.width), b.x - safeEnd(a.x, a.width))
  const dy = Math.max(0, a.y - safeEnd(b.y, b.height), b.y - safeEnd(a.y, a.height))
  return finite(Math.hypot(dx, dy), Number.MAX_VALUE)
}

function sameId(a, b) {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b)
}

function chooseDisplay(displays, primaryDisplayId, bounds, placement, hasPosition) {
  const saved = placement && displays.find((d) => sameId(d.id, placement.displayId))
  if (saved) return saved
  const primary = displays.find((d) => sameId(d.id, primaryDisplayId)) || displays[0]
  if (!hasPosition) return primary
  let selected = primary
  let bestOverlap = overlap(bounds, selected.bounds)
  let bestDistance = distance(bounds, selected.bounds)
  for (const d of displays) {
    const nextOverlap = overlap(bounds, d.bounds)
    const nextDistance = distance(bounds, d.bounds)
    if (nextOverlap > bestOverlap || (nextOverlap === bestOverlap && nextDistance < bestDistance)) {
      selected = d
      bestOverlap = nextOverlap
      bestDistance = nextDistance
    }
  }
  return selected
}

function axisAnchor(placement, key, first, second, fallback) {
  if (!placement || !Object.prototype.hasOwnProperty.call(placement, key)) return fallback
  return placement[key] === first || placement[key] === second ? placement[key] : null
}

function placeWindow(options) {
  options = options || {}
  let displays = Array.isArray(options.displays)
    ? options.displays.filter((d) => d && typeof d === 'object').map((d, index) => displayGeometry(d, index))
    : []
  if (!displays.length) displays = [displayGeometry(null, options.primaryDisplayId === undefined ? 0 : options.primaryDisplayId)]
  const source = options.bounds || {}
  const size = Math.max(1, Math.round(positive(options.size, positive(source.width, DEFAULT_SIZE))))
  const hasX = typeof source.x === 'number' && Number.isFinite(source.x)
  const hasY = typeof source.y === 'number' && Number.isFinite(source.y)
  const oldBounds = rectangle(source, { ...DEFAULT_RECT, width: size, height: size })
  const saved = options.placement && typeof options.placement === 'object' ? options.placement : null
  const d = chooseDisplay(displays, options.primaryDisplayId, oldBounds, saved, hasX || hasY)
  const target = { x: oldBounds.x, y: oldBounds.y, width: size, height: size }
  const travel = ranges(d.workArea, target)
  const right = safeEnd(d.workArea.x, travel.x)
  const bottom = safeEnd(d.workArea.y, travel.y)
  const inferred = capturePlacement(oldBounds, d, options.snap === true)
  const hasSavedCoordinates = saved && (Number.isFinite(saved.rx) || Number.isFinite(saved.ry) ||
    saved.h === 'left' || saved.h === 'right' || saved.v === 'top' || saved.v === 'bottom')
  const initial = !hasX && !hasY && !hasSavedCoordinates
  const h = axisAnchor(saved, 'h', 'left', 'right', initial ? 'right' : inferred.h)
  const v = axisAnchor(saved, 'v', 'top', 'bottom', initial ? 'bottom' : inferred.v)

  if (options.snap === true) {
    const rx = clamp(finite(saved && saved.rx, initial || !hasX ? 1 : inferred.rx), 0, 1)
    const ry = clamp(finite(saved && saved.ry, initial || !hasY ? 1 : inferred.ry), 0, 1)
    target.x = h === 'left' ? d.workArea.x : h === 'right' ? right : safeEnd(d.workArea.x, travel.x * rx)
    target.y = v === 'top' ? d.workArea.y : v === 'bottom' ? bottom : safeEnd(d.workArea.y, travel.y * ry)
  } else {
    target.x = hasX ? source.x : right
    target.y = hasY ? source.y : bottom
  }
  target.x = Math.round(clamp(finite(target.x, d.workArea.x), d.workArea.x, right))
  target.y = Math.round(clamp(finite(target.y, d.workArea.y), d.workArea.y, bottom))
  const nextPlacement = capturePlacement(target, d, false)
  // Explicit null anchors remain null even if a fraction lands on an edge.
  nextPlacement.h = options.snap === true ? h : null
  nextPlacement.v = options.snap === true ? v : null
  return { bounds: target, placement: nextPlacement, workArea: { ...d.workArea }, displayBounds: { ...d.bounds } }
}

module.exports = { capturePlacement, placeWindow }
