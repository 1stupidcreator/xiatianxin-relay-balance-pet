'use strict'

const fs = require('node:fs')

const SOURCE = 'CC Switch · 本机 Codex 代理'
const REQUIRED_COLUMNS = [
  'created_at', 'app_type', 'data_source', 'status_code', 'input_token_semantics',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens',
]

// CC Switch Codex proxy semantics=1 stores total input, including cache reads
// and writes. Imported session histories use other conventions and can overlap
// proxy records, so this reader deliberately takes only the proxy source.
const WINDOWS_SQL = `
WITH recent AS (
  SELECT created_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    CASE WHEN typeof(status_code) = 'integer' AND status_code BETWEEN 200 AND 299
      THEN 1 ELSE 0 END AS success,
    CASE WHEN typeof(input_token_semantics) = 'integer' AND input_token_semantics = 1
      THEN 1 ELSE 0 END AS known,
    CASE WHEN typeof(input_tokens) = 'integer' AND input_tokens >= 0
      AND typeof(output_tokens) = 'integer' AND output_tokens >= 0
      AND typeof(cache_read_tokens) = 'integer' AND cache_read_tokens >= 0
      AND typeof(cache_creation_tokens) = 'integer' AND cache_creation_tokens >= 0
      AND input_tokens >= cache_read_tokens
      AND input_tokens - cache_read_tokens >= cache_creation_tokens
      THEN 1 ELSE 0 END AS valid,
    CASE WHEN input_tokens IS NULL OR output_tokens IS NULL
      OR cache_read_tokens IS NULL OR cache_creation_tokens IS NULL
      OR input_tokens != 0 OR output_tokens != 0
      OR cache_read_tokens != 0 OR cache_creation_tokens != 0
      THEN 1 ELSE 0 END AS has_usage
  FROM proxy_request_logs
  WHERE app_type = 'codex' AND data_source = 'proxy'
    AND typeof(created_at) = 'integer' AND created_at > ? AND created_at <= ?
), windows AS (
  SELECT 'minute' AS name, * FROM recent WHERE created_at > ?
  UNION ALL
  SELECT 'hour' AS name, * FROM recent
)
SELECT name,
  COUNT(*) AS observed_requests,
  COALESCE(SUM(success), 0) AS requests,
  COALESCE(SUM(CASE WHEN success = 1 AND known = 1 AND valid = 1 AND input_tokens > 0
    THEN 1 ELSE 0 END), 0) AS valid_requests,
  COALESCE(SUM(CASE WHEN success = 1 AND known = 1 AND valid = 1 AND input_tokens = 0
    THEN 1 ELSE 0 END), 0) AS zero_input_requests,
  COALESCE(SUM(CASE WHEN success = 0 OR known = 0 OR valid = 0
    THEN 1 ELSE 0 END), 0) AS excluded_requests,
  COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed_requests,
  COALESCE(SUM(CASE WHEN success = 1 AND known = 0 THEN 1 ELSE 0 END), 0) AS unknown_semantics_requests,
  COALESCE(SUM(CASE WHEN success = 1 AND known = 1 AND valid = 0
    THEN 1 ELSE 0 END), 0) AS invalid_requests,
  COALESCE(SUM(CASE WHEN success = 1 AND has_usage = 1 AND (known = 0 OR valid = 0)
    THEN 1 ELSE 0 END), 0) AS incomplete_requests,
  COALESCE(SUM(CASE WHEN success = 1 AND known = 1 AND valid = 1 AND input_tokens > 0
    THEN input_tokens ELSE 0 END), 0) AS input_tokens,
  COALESCE(SUM(CASE WHEN success = 1 AND known = 1 AND valid = 1 AND input_tokens > 0
    THEN output_tokens ELSE 0 END), 0) AS output_tokens,
  COALESCE(SUM(CASE WHEN success = 1 AND known = 1 AND valid = 1 AND input_tokens > 0
    THEN cache_read_tokens ELSE 0 END), 0) AS cache_read_tokens,
  COALESCE(SUM(CASE WHEN success = 1 AND known = 1 AND valid = 1 AND input_tokens > 0
    THEN cache_creation_tokens ELSE 0 END), 0) AS cache_creation_tokens
FROM windows GROUP BY name`

function emptyWindow(now, duration, complete = false) {
  return {
    sampleStart: now - duration, sampleEnd: now,
    requests: 0, validRequests: 0, excludedRequests: 0,
    observedRequests: 0, failedRequests: 0, zeroInputRequests: 0,
    unknownSemanticsRequests: 0, invalidRequests: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, uncachedInputTokens: 0,
    rate: null, complete,
  }
}

function publicError(message) {
  const error = new Error(message)
  error.publicMessage = message
  return error
}

function safeInteger(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw publicError('CC Switch 本地统计数值超出可安全读取的范围')
  }
  return number
}

function applyWindow(base, row) {
  const window = {
    ...base,
    requests: safeInteger(row.requests),
    validRequests: safeInteger(row.valid_requests),
    excludedRequests: safeInteger(row.excluded_requests),
    observedRequests: safeInteger(row.observed_requests),
    failedRequests: safeInteger(row.failed_requests),
    zeroInputRequests: safeInteger(row.zero_input_requests),
    unknownSemanticsRequests: safeInteger(row.unknown_semantics_requests),
    invalidRequests: safeInteger(row.invalid_requests),
    inputTokens: safeInteger(row.input_tokens),
    outputTokens: safeInteger(row.output_tokens),
    cacheReadTokens: safeInteger(row.cache_read_tokens),
    cacheCreationTokens: safeInteger(row.cache_creation_tokens),
    complete: safeInteger(row.incomplete_requests) === 0,
  }
  window.uncachedInputTokens = window.inputTokens - window.cacheReadTokens - window.cacheCreationTokens
  window.rate = window.complete && window.inputTokens > 0
    ? window.cacheReadTokens / window.inputTokens : null
  return window
}

function readableError(error) {
  if (error && error.publicMessage) return error.publicMessage
  if (/busy|locked/i.test(String(error && error.message || ''))) {
    return 'CC Switch 数据库繁忙，请稍后重试'
  }
  if (error && error.code === 'EACCES') return '无法读取 CC Switch 本地数据库：访问被拒绝'
  return '无法读取 CC Switch 本地统计，请检查数据库状态与版本'
}

function readLocalCacheStats(dbPath, now = Date.now()) {
  const result = {
    status: 'error', source: SOURCE, sampledAt: now,
    latestRequestAt: null, error: '',
    minute: emptyWindow(now, 60000), hour: emptyWindow(now, 3600000),
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    result.error = '本地统计采样时间无效'
    return result
  }
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    result.status = 'unconfigured'
    result.error = '尚未找到 CC Switch 本地数据库'
    return result
  }

  let database
  try {
    const stat = fs.statSync(dbPath)
    if (!stat.isFile()) throw publicError('CC Switch 数据库路径不是文件')
    const { DatabaseSync } = require('node:sqlite')
    database = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false })
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200')

    const columns = new Set(database.prepare('PRAGMA table_info(proxy_request_logs)').all().map(row => row.name))
    const missing = REQUIRED_COLUMNS.filter(column => !columns.has(column))
    if (missing.length) throw publicError('CC Switch 本地统计数据结构不兼容：缺少必要字段')

    // Keep both queries in one short read-only snapshot. Integer seconds are
    // compared with millisecond-derived boundaries without rounding, yielding
    // (start, end] and excluding future rows even with a fractional end second.
    database.exec('BEGIN')
    const latestStatement = database.prepare(`
      SELECT MAX(created_at) AS latest FROM proxy_request_logs
      WHERE app_type = 'codex' AND data_source = 'proxy'
        AND typeof(created_at) = 'integer' AND created_at <= ?`)
    latestStatement.setReadBigInts(true)
    const latest = latestStatement.get(now / 1000).latest

    const statement = database.prepare(WINDOWS_SQL)
    statement.setReadBigInts(true)
    const rows = statement.all((now - 3600000) / 1000, now / 1000, (now - 60000) / 1000)
    database.exec('COMMIT')

    result.minute.complete = true
    result.hour.complete = true
    for (const row of rows) {
      if (row.name === 'minute') result.minute = applyWindow(result.minute, row)
      else if (row.name === 'hour') result.hour = applyWindow(result.hour, row)
    }
    result.latestRequestAt = latest === null ? null : safeInteger(latest) * 1000
    if (result.latestRequestAt !== null && !Number.isSafeInteger(result.latestRequestAt)) {
      throw publicError('CC Switch 本地统计时间超出可安全读取的范围')
    }
    result.status = 'ok'
    return result
  } catch (error) {
    result.status = error && error.code === 'ENOENT' ? 'unconfigured' : 'error'
    result.error = result.status === 'unconfigured' ? '尚未找到 CC Switch 本地数据库' : readableError(error)
    result.latestRequestAt = null
    result.minute = emptyWindow(now, 60000)
    result.hour = emptyWindow(now, 3600000)
    return result
  } finally {
    if (database) {
      try { database.close() } catch {}
    }
  }
}

module.exports = { readLocalCacheStats }
