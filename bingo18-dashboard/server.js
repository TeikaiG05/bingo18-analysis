import express from 'express'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { buildPrediction } from './predictor.js'
import { buildPredictionFromBase } from './predictor_v2.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

process.on('unhandledRejection', (reason) => {
  startupError =
    reason instanceof Error ? reason : new Error(String(reason || 'Unknown rejection'))
  console.error('[process] unhandledRejection:', startupError.message)
})

process.on('uncaughtException', (error) => {
  startupError = error
  console.error('[process] uncaughtException:', error.message)
})

const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 3000)
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : __dirname
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, 'data.json')
const SOURCE_URL = 'https://18.xidnas.site/data/json'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 6000)
const BOOTSTRAP_DELAY_MS = Number(process.env.BOOTSTRAP_DELAY_MS || 3000)
const FULL_SYNC_ON_STARTUP =
  String(process.env.FULL_SYNC_ON_STARTUP || 'false').toLowerCase() === 'true'
const ENABLE_POLLING =
  String(process.env.ENABLE_POLLING || 'true').toLowerCase() === 'true'
let predictionCache = null
let predictionCacheV2 = null
let startupPhase = 'booting'
let startupError = null
let pollTimer = null

app.use(express.static(path.join(__dirname, 'public')))

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [],
      updatedAt: parsed.updatedAt ?? null,
    }
  } catch {
    return { rounds: [], updatedAt: null }
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8')
}

function normalizeStoredRound(round) {
  if (!round || typeof round !== 'object') return null

  const dice = Array.isArray(round.dice)
    ? round.dice.map(Number).filter(Number.isFinite)
    : []
  if (dice.length !== 3) return null

  const sourceDate =
    round.sourceDate ?? (isDateOnlyValue(round.time) ? round.time : null)
  const processTime =
    round.processTime ?? (isDateOnlyValue(round.time) ? null : round.time)
  const rawSourceTime = round.rawSourceTime ?? sourceDate ?? round.time ?? null
  const time =
    round.time ?? processTime ?? sourceDate ?? new Date().toISOString()
  const total = Number(round.total) || dice.reduce((a, b) => a + b, 0)

  return {
    id: String(round.id ?? extractId(round, time, dice)),
    time,
    sourceDate,
    processTime,
    rawSourceTime: rawSourceTime != null ? String(rawSourceTime) : null,
    dice,
    total,
    result: classifyTotal(total),
  }
}

function normalizeStoredRounds(store) {
  const rounds = Array.isArray(store?.rounds) ? store.rounds : []
  const normalized = rounds.map(normalizeStoredRound).filter(Boolean)

  return {
    rounds: normalized,
    updatedAt: store?.updatedAt ?? null,
  }
}

function refreshPredictionCache(store = readData()) {
  predictionCache = buildPrediction(normalizeStoredRounds(store).rounds)
  predictionCacheV2 = buildPredictionFromBase(predictionCache)
  return predictionCache
}

function safeRefreshPredictionCache(store = readData()) {
  try {
    const cache = refreshPredictionCache(store)
    startupError = null
    return cache
  } catch (err) {
    startupError = err
    console.error('[predict] refresh failed:', err.message)
    return null
  }
}

function broadcastReload() {
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send('updated')
    }
  }
}

function toIsoTime(value) {
  if (!value) return null

  const d = new Date(value)
  if (!Number.isNaN(d.getTime())) return d.toISOString()

  return String(value)
}

function isDateOnlyValue(value) {
  if (typeof value !== 'string') return false

  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{2}\/\d{2}\/\d{4}$/.test(value)
  )
}

function extractPrimaryTime(item) {
  return (
    item.time ??
    item.datetime ??
    item.round_time ??
    item.roundTime ??
    item.draw_time ??
    item.drawTime ??
    item.date ??
    item.created_at ??
    item.timestamp ??
    item.ts ??
    item.createdAt ??
    null
  )
}

function extractSourceDate(item) {
  return item.date ?? item.draw_date ?? item.drawDate ?? item.day ?? null
}

function extractProcessTime(item) {
  return (
    item.process_time ??
    item.processTime ??
    item.updated_at ??
    item.updatedAt ??
    null
  )
}

function extractId(item, time, dice) {
  return (
    item.id ??
    item.round ??
    item.ky ??
    item.issue ??
    item.session ??
    `${time || 'unknown'}-${dice.join('-')}`
  )
}

function extractDice(item) {
  let dice =
    item.dice ?? item.nums ?? item.numbers ?? item.values ?? item.result

  if (typeof dice === 'string') {
    const parsed = dice
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite)
    if (parsed.length === 3) return parsed
  }

  if (Array.isArray(dice)) {
    const parsed = dice.map(Number).filter(Number.isFinite)
    if (parsed.length === 3) return parsed
  }

  let parsed = [item.d1, item.d2, item.d3].map(Number).filter(Number.isFinite)
  if (parsed.length === 3) return parsed

  parsed = [item.n1, item.n2, item.n3].map(Number).filter(Number.isFinite)
  if (parsed.length === 3) return parsed

  parsed = [item.x1, item.x2, item.x3].map(Number).filter(Number.isFinite)
  if (parsed.length === 3) return parsed

  return []
}

function normalizeRound(item) {
  const dice = extractDice(item)
  if (dice.length !== 3) {
    throw new Error(
      `Could not parse 3 dice values from item: ${JSON.stringify(item)}`,
    )
  }

  const rawTime = extractPrimaryTime(item)
  const sourceDate = extractSourceDate(item)
  const processTime = extractProcessTime(item)
  const normalizedRawTime = toIsoTime(rawTime)
  const normalizedSourceDate = toIsoTime(sourceDate)
  const normalizedProcessTime = toIsoTime(processTime)
  const time =
    (isDateOnlyValue(rawTime) ? normalizedProcessTime : normalizedRawTime) ??
    normalizedRawTime ??
    normalizedProcessTime ??
    normalizedSourceDate ??
    new Date().toISOString()
  const total =
    Number(item.total ?? item.tot ?? item.sum) ||
    dice.reduce((a, b) => a + b, 0)

  return {
    id: String(extractId(item, time, dice)),
    time,
    sourceDate: normalizedSourceDate,
    processTime: normalizedProcessTime,
    rawSourceTime: rawTime != null ? String(rawTime) : null,
    dice,
    total,
    result: classifyTotal(total),
  }
}

async function fetchSourceRows() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  })

  if (!res.ok) {
    throw new Error(`Source request failed: HTTP ${res.status}`)
  }

  const json = await res.json()
  const rows = Array.isArray(json)
    ? json
    : (json.rounds ?? json.data ?? json.items ?? json.results ?? [])

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Source payload did not contain a valid data array')
  }

  return rows
}

async function syncAllRoundsFromSource() {
  const rows = await fetchSourceRows()

  const mapped = []
  for (const item of rows) {
    try {
      mapped.push(normalizeRound(item))
    } catch (err) {
      console.error('[sync] skipped invalid row:', err.message)
    }
  }

  mapped.reverse()

  writeData({
    rounds: mapped,
    updatedAt: new Date().toISOString(),
  })
  refreshPredictionCache({
    rounds: mapped,
    updatedAt: new Date().toISOString(),
  })

  console.log(`[sync] synced ${mapped.length} rounds`)
}

function backfillMissingRoundFields(store) {
  let changed = false
  const rounds = store.rounds.map((round, index, list) => {
    const normalized = normalizeStoredRound(round)
    if (!normalized) return round

    if (!normalized.processTime && normalized.sourceDate && index > 0) {
      const newer = normalizeStoredRound(list[index - 1])
      if (newer?.processTime) {
        const newerDate = new Date(newer.processTime)
        if (!Number.isNaN(newerDate.getTime())) {
          const inferred = new Date(newerDate.getTime() + 6 * 60 * 1000)
          normalized.processTime = inferred.toISOString()
          normalized.time = normalized.processTime
        }
      }
    }

    const same = JSON.stringify(round) === JSON.stringify(normalized)
    if (!same) changed = true
    return normalized
  })

  return changed
    ? {
        rounds,
        updatedAt: new Date().toISOString(),
      }
    : store
}

async function fetchLatestRoundFromSource() {
  const rows = await fetchSourceRows()
  return normalizeRound(rows[rows.length - 1])
}

async function pollLatestRound() {
  try {
    const store = readData()
    const latest = await fetchLatestRoundFromSource()

    const existingIndex = store.rounds.findIndex(
      (r) => String(r.id) === String(latest.id),
    )
    if (existingIndex >= 0) {
      const merged = normalizeStoredRound({
        ...store.rounds[existingIndex],
        ...latest,
      })
      if (
        JSON.stringify(store.rounds[existingIndex]) !== JSON.stringify(merged)
      ) {
        store.rounds[existingIndex] = merged
        store.updatedAt = new Date().toISOString()
        writeData(store)
        refreshPredictionCache(store)
        broadcastReload()
        console.log('[crawler] refreshed existing round:', latest.id)
      } else {
        console.log('[crawler] no new round')
      }
      return
    }

    store.rounds.unshift(latest)
    store.updatedAt = new Date().toISOString()

    writeData(store)
    refreshPredictionCache(store)
    broadcastReload()

    console.log('[crawler] added new round:', latest)
  } catch (err) {
    console.error('[crawler] error:', err.message)
  }
}

app.get('/data/json', (req, res) => {
  res.json(readData())
})

app.get('/selective', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selective.html'))
})

app.get('/selective-v2', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selective-v2.html'))
})

app.get('/stats', (req, res) => {
  const store = readData()

  const large = store.rounds.filter(
    (r) => classifyTotal(r.total) === 'Big',
  ).length
  const small = store.rounds.filter(
    (r) => classifyTotal(r.total) === 'Small',
  ).length
  const draw = store.rounds.filter(
    (r) => classifyTotal(r.total) === 'Draw',
  ).length

  res.json({
    totalRoundsStored: store.rounds.length,
    updatedAt: store.updatedAt,
    showingLatest: Math.min(50, store.rounds.length),
    large,
    small,
    draw,
  })
})

app.get('/healthz', (req, res) => {
  const store = readData()
  res.json({
    ok: true,
    service: 'bingo18-dashboard',
    phase: startupPhase,
    startupError: startupError ? startupError.message : null,
    updatedAt: store.updatedAt,
    totalRounds: Array.isArray(store.rounds) ? store.rounds.length : 0,
  })
})

app.get('/predict', (req, res) => {
  if (!predictionCache) {
    safeRefreshPredictionCache()
  }
  if (!predictionCache) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction cache is warming up. Retry shortly.',
      phase: startupPhase,
      error: startupError ? startupError.message : null,
    })
  }
  res.json(predictionCache)
})

app.get('/predict-v2', (req, res) => {
  if (!predictionCache || !predictionCacheV2) {
    safeRefreshPredictionCache()
  }
  if (!predictionCacheV2) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V2 cache is warming up. Retry shortly.',
      phase: startupPhase,
      error: startupError ? startupError.message : null,
    })
  }
  res.json(predictionCacheV2)
})

app.get('/export/csv', (req, res) => {
  const store = readData()

  const lines = [
    'id,time,sourceDate,processTime,rawSourceTime,d1,d2,d3,total,result',
    ...store.rounds.map(
      (r) =>
        `${r.id},${r.time},${r.sourceDate ?? ''},${r.processTime ?? ''},${r.rawSourceTime ?? ''},${r.dice[0]},${r.dice[1]},${r.dice[2]},${r.total},${classifyTotal(r.total)}`,
    ),
  ]

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="bingo18.csv"')
  res.send(lines.join('\n'))
})

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    if (msg.toString() === 'ping') {
      ws.send('pong')
    }
  })
})

async function bootstrapServer() {
  startupPhase = 'preparing_local_data'

  try {
    const initialStore = readData()
    const normalizedStore = backfillMissingRoundFields(initialStore)
    if (JSON.stringify(normalizedStore) !== JSON.stringify(initialStore)) {
      writeData(normalizedStore)
    }

    startupPhase = 'building_cache'
    safeRefreshPredictionCache(normalizedStore)

    if (FULL_SYNC_ON_STARTUP) {
      startupPhase = 'syncing_source'
      await syncAllRoundsFromSource()
      safeRefreshPredictionCache(readData())
    }
  } catch (err) {
    startupError = err
    console.error('[startup] bootstrap failed:', err.message)
  }

  startupPhase = 'ready'

  if (ENABLE_POLLING && !pollTimer) {
    pollTimer = setInterval(pollLatestRound, POLL_INTERVAL_MS)
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`)
  console.log(
    `[startup] bootstrapDelay=${BOOTSTRAP_DELAY_MS}ms polling=${ENABLE_POLLING ? `on/${POLL_INTERVAL_MS}ms` : 'off'} fullSync=${FULL_SYNC_ON_STARTUP}`,
  )
  setTimeout(() => {
    bootstrapServer().catch((err) => {
      startupError = err
      startupPhase = 'ready'
      console.error('[startup] bootstrap crashed:', err.message)
    })
  }, BOOTSTRAP_DELAY_MS)
})
