import express from 'express'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { fork } from 'child_process'
import { WebSocketServer } from 'ws'
import { buildTemporalFlowBundle } from './temporal_flow.js'
import {
  adaptPredictionPayload,
  adaptTopTotalRecords,
  buildAdaptiveResultProbabilities,
  selectAdaptiveTopTotalRecords,
} from './prediction_postprocessor.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

process.on('unhandledRejection', (reason) => {
  startupError =
    reason instanceof Error
      ? reason
      : new Error(String(reason || 'Unknown rejection'))
  console.error('[process] unhandledRejection:', startupError.message)
})

process.on('uncaughtException', (error) => {
  startupError = error
  console.error('[process] uncaughtException:', error.message)
})

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3000)
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : __dirname
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, 'data.json')
const PREDICTION_SNAPSHOTS_FILE = path.join(
  DATA_DIR,
  'prediction-snapshots.json',
)
const CONSENSUS_V16_AI_MEMORY_FILE = path.join(
  DATA_DIR,
  'consensus-v16-ai-memory.json',
)
const LOCAL_AI_MEMORY_FILE = path.join(DATA_DIR, 'local-ai-memory.json')
const V9_MEMORY_FILE = path.join(DATA_DIR, 'v9-memory.json')
const LOCAL_AI_MEMORY_MIN_SAMPLES = Math.max(
  50,
  Number(process.env.LOCAL_AI_MEMORY_MIN_SAMPLES || 200),
)
const LOCAL_AI_MEMORY_BACKFILL_TARGET = Math.max(
  LOCAL_AI_MEMORY_MIN_SAMPLES,
  Number(process.env.LOCAL_AI_MEMORY_BACKFILL_TARGET || 220),
)
const RESULT_ORDER = ['Small', 'Draw', 'Big']
const SOURCE_URL = 'https://18.xidnas.site/data/json'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 12000)
const BOOTSTRAP_DELAY_MS = Number(process.env.BOOTSTRAP_DELAY_MS || 50)
const FULL_SYNC_ON_STARTUP =
  String(process.env.FULL_SYNC_ON_STARTUP || 'false').toLowerCase() === 'true'
const BACKFILL_ON_GAP =
  String(process.env.BACKFILL_ON_GAP || 'true').toLowerCase() === 'true'
const FULL_SYNC_INTERVAL_MS = Number(
  process.env.FULL_SYNC_INTERVAL_MS || 400000,
)
const ENABLE_POLLING =
  String(process.env.ENABLE_POLLING || 'true').toLowerCase() === 'true'
let predictionCache = null
let predictionCacheV2 = null
let predictionCacheV3 = null
let predictionCacheV4 = null
let predictionCacheV5 = null
let predictionCacheV6 = null
let predictionCacheV7 = null
let predictionCacheV8 = null
let predictionCacheV9 = null
let consensusV16AICache = null
let consensusV16AIBuildState = 'idle'
let consensusV16AIBuildPromise = null
let consensusV16AIBacktestState = 'idle'
let consensusV16AIBacktestPromise = null
let consensusV16AIReplayTimer = null
let consensusV16AIWorker = null
let snapshotBuildWorker = null
let localAIBackfillWorker = null
let startupPhase = 'booting'
let startupError = null
let pollTimer = null
let fullSyncTimer = null
let cacheBuildState = 'idle'
let cacheBuildTimer = null
let predictorFnsPromise = null
let cacheIsStale = false
let localAIBackfillState = 'idle'
let fullSyncState = 'idle'
let fullSyncPromise = null

app.use(express.static(path.join(__dirname, 'public')))

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function applyConsensusRecoveryBias(totalScores, roundsDesc = [], temporalFlow = null) {
  for (let total = 3; total <= 18; total += 1) {
    if (!totalScores.has(total)) totalScores.set(total, 0.000001)
  }

  const latestResult =
    temporalFlow?.summary?.anchors?.latestResult ||
    roundsDesc?.[0]?.result ||
    classifyTotal(Number(roundsDesc?.[0]?.total))
  const resultStreak = temporalFlow?.summary?.resultStreak || {
    key: null,
    length: 0,
  }
  const streakLength = Number(resultStreak?.length || 0)
  const recentTotals = Array.isArray(roundsDesc)
    ? roundsDesc
        .slice(0, 24)
        .map((round) => Number(round?.total))
        .filter(Number.isFinite)
    : []
  const shortSet = new Set(recentTotals.slice(0, 12))
  const wideSet = new Set(recentTotals)
  const ordered = Array.from(totalScores.values())
    .map((value) => Math.max(0.000001, Number(value) || 0))
    .sort((a, b) => a - b)
  const median = ordered[Math.floor(ordered.length / 2)] || 0.000001
  const lowerQuartile = ordered[Math.floor(ordered.length * 0.25)] || 0.000001

  for (let total = 3; total <= 18; total += 1) {
    const currentScore = Math.max(0.000001, Number(totalScores.get(total) || 0))
    const scarcity =
      currentScore < median
        ? clamp((median - currentScore) / Math.max(median, 0.000001), 0, 1.4)
        : 0
    const underExposed = currentScore <= lowerQuartile
    let factor = 1

    factor += scarcity * 0.072
    if (underExposed) factor += 0.022
    if (!shortSet.has(total)) factor += 0.017
    if (!wideSet.has(total)) factor += 0.013
    if ((total <= 5 || total >= 15) && underExposed) factor += 0.01

    if (latestResult === 'Draw') {
      if (total === 10 || total === 11) factor *= streakLength >= 2 ? 0.5 : 0.6
      else if (total === 9 || total === 12)
        factor *= streakLength >= 2 ? 0.76 : 0.86
      else if (total <= 8 || total >= 13)
        factor *= streakLength >= 2 ? 1.12 : 1.08
      else factor *= 1.04
    }

    totalScores.set(total, Math.max(0.000001, currentScore * factor))
  }
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

function readPredictionSnapshots() {
  try {
    const raw = fs.readFileSync(PREDICTION_SNAPSHOTS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function hydrateCachesFromSnapshots(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false
  predictionCache = snapshot.v1 ?? null
  predictionCacheV2 = snapshot.v2 ?? null
  predictionCacheV3 = snapshot.v3 ?? null
  predictionCacheV4 = snapshot.v4 ?? null
  predictionCacheV5 = snapshot.v5 ?? null
  predictionCacheV6 = snapshot.v6 ?? null
  predictionCacheV7 = snapshot.v7 ?? null
  predictionCacheV8 = snapshot.v8 ?? null
  predictionCacheV9 = snapshot.v9 ?? null
  consensusV16AICache = null
  consensusV16AIBuildState = 'idle'
  return Boolean(
    predictionCache &&
    predictionCacheV2 &&
    predictionCacheV3 &&
    predictionCacheV4 &&
    predictionCacheV5 &&
    predictionCacheV6 &&
    predictionCacheV7 &&
    predictionCacheV8 &&
    predictionCacheV9,
  )
}

function readConsensusV16AIMemory() {
  try {
    const raw = fs.readFileSync(CONSENSUS_V16_AI_MEMORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const allChecks = Array.isArray(parsed?.allTotalChecks)
      ? parsed.allTotalChecks
      : Array.isArray(parsed?.recentTotalChecks)
        ? parsed.recentTotalChecks
        : []
    return {
      createdAt: parsed?.createdAt ?? null,
      latestRoundId:
        parsed?.latestRoundId != null ? String(parsed.latestRoundId) : null,
      sampleSize: Number(parsed?.sampleSize || 0),
      totalHitRate: Number(parsed?.totalHitRate || 0),
      recentTotalChecks: allChecks,
      allTotalChecks: allChecks,
    }
  } catch {
    return {
      createdAt: null,
      latestRoundId: null,
      sampleSize: 0,
      totalHitRate: 0,
      recentTotalChecks: [],
      allTotalChecks: [],
    }
  }
}

function writeConsensusV16AIMemory(data) {
  fs.writeFileSync(
    CONSENSUS_V16_AI_MEMORY_FILE,
    JSON.stringify(data, null, 2),
    'utf8',
  )
}

function appendConsensusRecentCheck(round) {
  const current = consensusV16AICache?.current
  if (!current || String(current.nextRoundId || '') !== String(round?.id || ''))
    return null

  const predictedTotals = Array.isArray(current.topTotals)
    ? current.topTotals
        .slice(0, 3)
        .map((item) => Number(item.total))
        .filter(Number.isFinite)
    : []
  if (!predictedTotals.length) return null

  const actualTotal = Number(round.total)
  const actualResult = round.result || classifyTotal(actualTotal)
  const hit = predictedTotals.includes(actualTotal)
  const memory = readConsensusV16AIMemory()
  const previousChecks = Array.isArray(memory.allTotalChecks)
    ? memory.allTotalChecks
    : Array.isArray(memory.recentTotalChecks)
      ? memory.recentTotalChecks
      : []
  const nextChecks = [
    {
      id: String(round.id),
      predictedTotals,
      actualTotal,
      actualResult,
      hit,
      leadTotal: current.topTotals?.[0]?.total ?? null,
      leadProbability: current.topTotals?.[0]
        ? Number(
            (Number(current.topTotals[0].normalized || 0) * 100).toFixed(2),
          )
        : 0,
    },
    ...previousChecks.filter((item) => String(item.id) !== String(round.id)),
  ]

  const totalHits = nextChecks.filter((item) => item.hit).length
  const nextMemory = {
    createdAt: new Date().toISOString(),
    latestRoundId: String(round.id),
    sampleSize: nextChecks.length,
    totalHitRate: nextChecks.length ? totalHits / nextChecks.length : 0,
    allTotalChecks: nextChecks,
    recentTotalChecks: nextChecks.slice(0, 7),
  }
  writeConsensusV16AIMemory(nextMemory)

  if (consensusV16AICache) {
    consensusV16AICache = {
      ...consensusV16AICache,
      backtest: {
        ...nextMemory,
        pending: false,
      },
    }
  }

  return nextMemory
}

function readLocalAIMemory() {
  try {
    const raw = fs.readFileSync(LOCAL_AI_MEMORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      updatedAt: parsed?.updatedAt ?? null,
      pendingPrediction: parsed?.pendingPrediction ?? null,
      history: Array.isArray(parsed?.history)
        ? parsed.history.map(normalizeLocalAIHistoryEntry)
        : [],
    }
  } catch {
    return {
      updatedAt: null,
      pendingPrediction: null,
      history: [],
    }
  }
}

function writeLocalAIMemory(data) {
  fs.writeFileSync(LOCAL_AI_MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8')
}

function numericRoundIdValue(value) {
  const numeric = Number(String(value || '').replace(/\D/g, ''))
  return Number.isFinite(numeric) ? numeric : null
}

function hasUsablePendingPrediction(pending) {
  return (
    pending &&
    String(pending?.roundId || '').trim() &&
    Array.isArray(pending?.predictedTotals) &&
    pending.predictedTotals.map(Number).filter(Number.isFinite).length >= 1
  )
}

function inferLocalAIReplayHistoryEntry(item) {
  if (!item || typeof item !== 'object') return false
  if (item?.missingPrediction === true) return true
  if (item?.replayedPrediction === true) return true

  const predictionSource = String(
    item?.predictionSource || item?.source || '',
  ).toLowerCase()
  if (
    predictionSource === 'backfill-replay' ||
    predictionSource === 'missing-history'
  ) {
    return true
  }
  if (
    predictionSource === 'live-lock' ||
    predictionSource === 'live-pending'
  ) {
    return false
  }

  const createdAt = String(item?.createdAt || '')
  const resolvedAt = String(item?.resolvedAt || '')
  if (createdAt && resolvedAt && createdAt === resolvedAt) {
    return true
  }

  return false
}

function normalizeLocalAIHistoryEntry(item) {
  if (!item || typeof item !== 'object') return item
  const replayedPrediction = inferLocalAIReplayHistoryEntry(item)
  return {
    ...item,
    replayedPrediction,
    predictionSource:
      item?.predictionSource ||
      (replayedPrediction ? 'backfill-replay' : 'live-lock'),
  }
}

function splitLocalAIHistory(history = []) {
  return (Array.isArray(history) ? history : []).reduce(
    (acc, item) => {
      const normalized = normalizeLocalAIHistoryEntry(item)
      if (!normalized) return acc
      if (normalized.replayedPrediction) acc.replayHistory.push(normalized)
      else acc.liveHistory.push(normalized)
      acc.allHistory.push(normalized)
      return acc
    },
    { allHistory: [], liveHistory: [], replayHistory: [] },
  )
}

function buildLocalAIHistoryBuckets(history = []) {
  const { allHistory, liveHistory, replayHistory } = splitLocalAIHistory(history)
  const liveLearningHistory = liveHistory.slice(0, 48).map((item) => ({
    ...item,
    learningWeight: 1,
  }))
  const replayWarmupCount = Math.max(
    0,
    Math.min(36, liveHistory.length >= 12 ? 18 : 36) - liveLearningHistory.length,
  )
  const replayLearningHistory = replayHistory
    .slice(0, replayWarmupCount)
    .map((item) => ({
      ...item,
      learningWeight: liveLearningHistory.length ? 0.22 : 0.35,
    }))
  const learningHistory = [...liveLearningHistory, ...replayLearningHistory]

  return {
    allHistory,
    liveHistory,
    replayHistory,
    learningHistory: learningHistory.length
      ? learningHistory
      : replayHistory.slice(0, 24).map((item) => ({
          ...item,
          learningWeight: 0.35,
        })),
    adaptiveHistory: liveHistory.length
      ? liveHistory.slice(0, 24)
      : replayHistory.slice(0, 12),
    clusterHistory: liveHistory.length >= 10
      ? liveHistory.slice(0, 90)
      : [
          ...liveHistory.slice(0, 24),
          ...replayHistory
            .slice(0, Math.max(0, 30 - liveHistory.length))
            .map((item) => ({
              ...item,
              learningWeight: 0.28,
            })),
        ],
  }
}

function seedV9HistoryFromConsensus(limit = 24) {
  const memory = readConsensusV16AIMemory()
  const checks = Array.isArray(memory.allTotalChecks)
    ? memory.allTotalChecks.slice(0, limit)
    : []
  return checks
    .map((item) => ({
      roundId: String(item?.id || ''),
      predictedTotals: Array.isArray(item?.predictedTotals)
        ? item.predictedTotals.map(Number).filter(Number.isFinite)
        : [],
      actualTotal: Number(item?.actualTotal),
      actualResult: String(
        item?.actualResult || classifyTotal(Number(item?.actualTotal)),
      ),
      hit: Boolean(item?.hit),
      strategyId: 'seed_consensus',
      strategyLabel: 'Seed Consensus',
      createdAt: null,
      resolvedAt: null,
    }))
    .filter((item) => item.roundId && item.predictedTotals.length)
}

function readV9Memory() {
  try {
    const raw = fs.readFileSync(V9_MEMORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const history = Array.isArray(parsed?.history) ? parsed.history : []
    return {
      updatedAt: parsed?.updatedAt ?? null,
      pendingPrediction: parsed?.pendingPrediction ?? null,
      history: history,
      latestRoundId:
        parsed?.latestRoundId != null
          ? String(parsed.latestRoundId)
          : history[0]?.roundId || null,
    }
  } catch {
    const seededHistory = seedV9HistoryFromConsensus()
    return {
      updatedAt: null,
      pendingPrediction: null,
      history: seededHistory,
      latestRoundId: seededHistory[0]?.roundId || null,
    }
  }
}

function writeV9Memory(data) {
  fs.writeFileSync(V9_MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8')
}

function ensureV9MemorySeeded() {
  if (fs.existsSync(V9_MEMORY_FILE)) return
  const seededHistory = seedV9HistoryFromConsensus()
  writeV9Memory({
    updatedAt: new Date().toISOString(),
    pendingPrediction: null,
    latestRoundId: seededHistory[0]?.roundId || null,
    history: seededHistory,
  })
}

function updateV9PendingPrediction(store = readData()) {
  if (!predictionCacheV9) return null
  const nextRoundId = nextRoundIdFromStore(store)
  if (!nextRoundId) return null
  const current = predictionCacheV9?.selectiveStrategy?.currentDecision || {}
  const topTotals = Array.isArray(current.recommendedTotals)
    ? current.recommendedTotals
    : Array.isArray(predictionCacheV9?.diagnosis?.topTotals)
      ? predictionCacheV9.diagnosis.topTotals
      : []
  const predictedTotals = topTotals
    .slice(0, 3)
    .map((item) => Number(item?.total))
    .filter(Number.isFinite)
  if (!predictedTotals.length) return null

  const memory = readV9Memory()
  memory.pendingPrediction = {
    roundId: nextRoundId,
    predictedTotals,
    predictedResult:
      current.recommendedResult ||
      predictionCacheV9?.diagnosis?.mostLikelyResult ||
      '--',
    strategyId:
      predictionCacheV9?.methodology?.adaptive?.selectedStrategy || null,
    strategyLabel:
      predictionCacheV9?.methodology?.adaptive?.selectedLabel || null,
    createdAt: new Date().toISOString(),
  }
  memory.updatedAt = new Date().toISOString()
  writeV9Memory(memory)
  return memory.pendingPrediction
}

function resolveV9MemoryForRound(round) {
  const memory = readV9Memory()
  const pending = memory.pendingPrediction
  if (!pending || String(pending.roundId) !== String(round?.id || ''))
    return null

  const actualTotal = Number(round.total)
  const actualResult = round.result || classifyTotal(actualTotal)
  const predictedTotals = Array.isArray(pending.predictedTotals)
    ? pending.predictedTotals.map(Number).filter(Number.isFinite)
    : []
  const record = {
    roundId: String(round.id),
    predictedTotals,
    predictedResult: pending.predictedResult || '--',
    actualTotal,
    actualResult,
    hit: predictedTotals.includes(actualTotal),
    strategyId: pending.strategyId || null,
    strategyLabel: pending.strategyLabel || null,
    createdAt: pending.createdAt || null,
    resolvedAt: new Date().toISOString(),
  }

  const history = [
    record,
    ...(Array.isArray(memory.history)
      ? memory.history.filter(
          (item) => String(item?.roundId || '') !== String(round.id),
        )
      : []),
  ].slice(0, 80)

  writeV9Memory({
    updatedAt: new Date().toISOString(),
    pendingPrediction: null,
    latestRoundId: String(round.id),
    history,
  })
  return record
}

function needsLocalAIBackfill() {
  const memory = readLocalAIMemory()
  const history = Array.isArray(memory.history) ? memory.history : []
  return history.length < LOCAL_AI_MEMORY_MIN_SAMPLES
}

function scheduleLocalAIBackfill(delayMs = 1500) {
  if (!needsLocalAIBackfill()) {
    localAIBackfillState = 'ready'
    return
  }
  if (localAIBackfillState === 'building' || localAIBackfillWorker) return

  localAIBackfillState = 'scheduled'
  setTimeout(() => {
    if (!needsLocalAIBackfill()) {
      localAIBackfillState = 'ready'
      return
    }
    if (localAIBackfillState === 'building' || localAIBackfillWorker) return

    const workerPath = path.join(
      __dirname,
      'local_ai_memory_backfill_worker.js',
    )
    localAIBackfillState = 'building'
    const worker = fork(workerPath, {
      cwd: __dirname,
      env: {
        ...process.env,
        DATA_FILE,
        LOCAL_AI_MEMORY_FILE,
        LOCAL_AI_MEMORY_MIN_TRAIN_ROUNDS: '180',
        LOCAL_AI_MEMORY_TRAIN_WINDOW: '320',
        LOCAL_AI_MEMORY_BACKFILL_TARGET: String(
          LOCAL_AI_MEMORY_BACKFILL_TARGET,
        ),
      },
      silent: true,
    })
    localAIBackfillWorker = worker
    let settled = false

    const finish = (nextState) => {
      if (settled) return
      settled = true
      localAIBackfillState = nextState
      localAIBackfillWorker = null
    }

    worker.stderr?.on('data', (chunk) => {
      const message = String(chunk || '').trim()
      if (message) console.error('[local-ai-backfill]', message)
    })

    worker.on('message', (message) => {
      if (!message?.ok) return
      finish('ready')
      console.log(
        `[local-ai-backfill] memory ready: ${Number(message.sampleSize || 0)} mau, backfill ${Number(message.generatedCount || 0)} ky`,
      )
    })

    worker.on('error', (error) => {
      finish('error')
      console.error('[local-ai-backfill] worker error:', error.message)
    })

    worker.on('exit', (code, signal) => {
      if (settled) return
      if (signal === 'SIGTERM' || signal === 'SIGINT' || code === 0) {
        finish('ready')
        return
      }
      finish('error')
      console.error(`[local-ai-backfill] exited with code ${code}`)
    })
  }, delayMs)
}

function buildCurrentCouncilTop3() {
  const consensus = buildConsensusSnapshotFromCaches()
  if (!consensus) return null

  return {
    result: consensus.resultConsensus || '--',
    topTotals: consensus.topTotals.slice(0, 3).map((item) => ({
      total: Number(item.total),
      probability: normalizeUnitProbability(item.normalized, 0),
    })),
  }
}

function updateLocalAIPendingPrediction(store = readData()) {
  const nextRoundId = nextRoundIdFromStore(store)
  if (!nextRoundId) return null

  const memory = readLocalAIMemory()
  const existingPendingRoundId = String(memory?.pendingPrediction?.roundId || '')
  const existingPending = memory?.pendingPrediction || null
  const nextRoundIdText = String(nextRoundId)
  if (existingPendingRoundId) {
    const pendingAlreadyInStore = Array.isArray(store?.rounds)
      ? store.rounds.some(
          (round) => String(round?.id || '') === existingPendingRoundId,
        )
      : false
    const pendingMatchesNextRound = existingPendingRoundId === nextRoundIdText
    if (
      !pendingAlreadyInStore &&
      pendingMatchesNextRound &&
      hasUsablePendingPrediction(existingPending)
    ) {
      return existingPending
    }

    if (!pendingAlreadyInStore && hasUsablePendingPrediction(existingPending)) {
      const pendingNumeric = numericRoundIdValue(existingPendingRoundId)
      const nextNumeric = numericRoundIdValue(nextRoundIdText)
      if (
        pendingNumeric != null &&
        nextNumeric != null &&
        pendingNumeric > nextNumeric
      ) {
        return existingPending
      }
    }
  }

  const localState = readLocalAIFreeState()
  const aiTopTotals = Array.isArray(localState?.aiOwnTopTotals)
    ? localState.aiOwnTopTotals
        .slice(0, 3)
        .map((item) => ({
          total: Number(item?.total),
          probability: Number(item?.probability || 0),
        }))
        .filter((item) => Number.isFinite(item.total))
    : []
  if (!aiTopTotals.length) return null

  memory.pendingPrediction = {
    roundId: nextRoundId,
    predictedResult: localState?.result || '--',
    predictedTotals: aiTopTotals.map((item) => Number(item.total)),
    predictedScores: aiTopTotals.map((item) => ({
      total: Number(item.total),
      probability: Number(item.probability || 0),
    })),
    predictionSource: 'live-pending',
    createdAt: new Date().toISOString(),
  }
  memory.updatedAt = new Date().toISOString()
  writeLocalAIMemory(memory)
  return memory.pendingPrediction
}

function resolveLocalAIMemoryForRound(round) {
  const memory = readLocalAIMemory()
  const pending = memory.pendingPrediction
  if (!pending || String(pending.roundId) !== String(round.id)) return null

  const actualTotal = Number(round.total)
  const actualResult = round.result || classifyTotal(actualTotal)
  const predictedTotals = Array.isArray(pending.predictedTotals)
    ? pending.predictedTotals
    : []
  const record = {
    roundId: String(round.id),
    predictedResult: pending.predictedResult || '--',
    predictedTotals,
    predictedScores: Array.isArray(pending.predictedScores)
      ? pending.predictedScores
      : [],
    actualTotal,
    actualResult,
    hit: predictedTotals.includes(actualTotal),
    resultHit: pending.predictedResult === actualResult,
    replayedPrediction: false,
    predictionSource: 'live-lock',
    createdAt: pending.createdAt || null,
    resolvedAt: new Date().toISOString(),
  }

  const history = [
    record,
    ...(Array.isArray(memory.history)
      ? memory.history.filter(
          (item) => String(item?.roundId || '') !== String(round.id),
        )
      : []),
  ].slice(0, 300)
  const nextMemory = {
    updatedAt: new Date().toISOString(),
    pendingPrediction: null,
    history,
  }
  writeLocalAIMemory(nextMemory)
  return record
}

function backfillLocalAIMemory(store = readData(), limit = 12) {
  const rounds = Array.isArray(store?.rounds) ? store.rounds : []
  if (!rounds.length) return null

  const memory = readLocalAIMemory()
  const history = Array.isArray(memory.history) ? memory.history : []
  const historyIds = new Set(
    history
      .map((item) => String(item?.roundId || item?.id || ''))
      .filter(Boolean),
  )
  const pendingId = String(memory?.pendingPrediction?.roundId || '')
  const graceIds = new Set(
    rounds
      .slice(0, Math.min(2, rounds.length))
      .map((round) => String(round?.id || ''))
      .filter(Boolean),
  )
  const missingRecords = []

  rounds.slice(0, limit).forEach((round) => {
    const roundId = String(round?.id || '')
    if (
      !roundId ||
      historyIds.has(roundId) ||
      roundId === pendingId ||
      graceIds.has(roundId)
    )
      return
    const actualTotal = Number(round?.total)
    const actualResult = round?.result || classifyTotal(actualTotal)
    missingRecords.push({
      roundId,
      predictedResult: '--',
      predictedTotals: [],
      predictedScores: [],
      actualTotal,
      actualResult,
      hit: false,
      resultHit: false,
      missingPrediction: true,
      replayedPrediction: true,
      predictionSource: 'missing-history',
      createdAt: null,
      resolvedAt: new Date().toISOString(),
    })
  })

  if (!missingRecords.length) return null

  const mergedHistory = [...history, ...missingRecords]
    .reduce((acc, item) => {
      const itemId = String(item?.roundId || item?.id || '')
      if (
        !itemId ||
        acc.some(
          (entry) => String(entry?.roundId || entry?.id || '') === itemId,
        )
      )
        return acc
      acc.push(item)
      return acc
    }, [])
    .sort(
      (a, b) =>
        Number(String(b?.roundId || b?.id || '').replace(/\D/g, '')) -
        Number(String(a?.roundId || a?.id || '').replace(/\D/g, '')),
    )
    .slice(0, 300)

  const nextMemory = {
    ...memory,
    updatedAt: new Date().toISOString(),
    history: mergedHistory,
  }
  writeLocalAIMemory(nextMemory)
  return missingRecords
}

function buildLocalAIFreeLearning(history) {
  const totalStats = new Map()
  const resultStats = new Map()

  for (const item of history) {
    const weight = clamp(Number(item?.learningWeight ?? 1), 0.05, 1)
    for (const total of Array.isArray(item.predictedTotals)
      ? item.predictedTotals
      : []) {
      const key = String(total)
      const stat = totalStats.get(key) || { seen: 0, hit: 0 }
      stat.seen += weight
      if (Number(total) === Number(item.actualTotal)) stat.hit += weight
      totalStats.set(key, stat)
    }

    const resultKey = String(item.predictedResult || '')
    if (resultKey) {
      const stat = resultStats.get(resultKey) || { seen: 0, hit: 0 }
      stat.seen += weight
      if (item.resultHit) stat.hit += weight
      resultStats.set(resultKey, stat)
    }
  }

  return { totalStats, resultStats }
}

function buildAdaptiveMemorySignals(history, currentTopTotals = []) {
  const recent = (Array.isArray(history) ? history : []).slice(0, 12)
  const normalizedCurrent = currentTopTotals
    .slice(0, 3)
    .map(Number)
    .filter(Number.isFinite)
  const currentKey = normalizedCurrent.join('|')

  let missStreak = 0
  for (const item of recent) {
    if (item?.hit) break
    missStreak += 1
  }

  let repeatedClusterMisses = 0
  for (const item of recent) {
    const itemKey = (
      Array.isArray(item?.predictedTotals) ? item.predictedTotals : []
    )
      .slice(0, 3)
      .map(Number)
      .join('|')
    if (itemKey !== currentKey || item?.hit) break
    repeatedClusterMisses += 1
  }

  const recentRepeatCount = recent.filter((item) => {
    const itemKey = (
      Array.isArray(item?.predictedTotals) ? item.predictedTotals : []
    )
      .slice(0, 3)
      .map(Number)
      .join('|')
    return itemKey === currentKey
  }).length

  const missTotalWeights = new Map()
  const missResultWeights = { Small: 0, Draw: 0, Big: 0 }
  const predictedExposureWeights = new Map()
  recent.forEach((item, index) => {
    const predictionWeight = 1 / (1 + index * 0.42)
    ;(Array.isArray(item?.predictedTotals) ? item.predictedTotals : [])
      .slice(0, 3)
      .map(Number)
      .filter(Number.isFinite)
      .forEach((total) => {
        predictedExposureWeights.set(
          total,
          (predictedExposureWeights.get(total) || 0) +
            predictionWeight * (item?.hit ? 0.45 : 1),
        )
      })

    if (!item || item.hit) return
    const actualTotal = Number(item.actualTotal)
    const actualResult = String(item.actualResult || classifyTotal(actualTotal))
    const weight = 1 / (1 + index * 0.35)
    if (Number.isFinite(actualTotal)) {
      missTotalWeights.set(
        actualTotal,
        (missTotalWeights.get(actualTotal) || 0) + weight,
      )
    }
    if (Object.prototype.hasOwnProperty.call(missResultWeights, actualResult)) {
      missResultWeights[actualResult] += weight
    }
  })

  const drawCenterMissWeight =
    (missTotalWeights.get(10) || 0) +
    (missTotalWeights.get(11) || 0) +
    ((missTotalWeights.get(9) || 0) + (missTotalWeights.get(12) || 0)) * 0.45

  return {
    missStreak,
    repeatedClusterMisses,
    recentRepeatCount,
    repeatPenalty: clamp(
      repeatedClusterMisses * 0.11 + Math.max(0, recentRepeatCount - 1) * 0.035,
      0,
      0.34,
    ),
    missTotalWeights,
    missResultWeights,
    predictedExposureWeights,
    drawCenterMissWeight,
    shouldConsiderDraw:
      drawCenterMissWeight >= 1.1 ||
      missResultWeights.Draw >= 1.2 ||
      (missStreak >= 2 && repeatedClusterMisses >= 2),
  }
}

function totalRegime(total) {
  const numeric = Number(total)
  if (!Number.isFinite(numeric)) return 'center'
  if (numeric >= 13) return 'upper'
  if (numeric <= 8) return 'lower'
  return 'center'
}

function regimeLabel(regime) {
  if (regime === 'upper') return 'Bien tren'
  if (regime === 'lower') return 'Bien duoi'
  return 'Trung tam'
}

function regimeBaseTotals(regime) {
  if (regime === 'upper') return [14, 13, 15, 16, 12, 17]
  if (regime === 'lower') return [8, 7, 9, 6, 10, 5]
  return [10, 11, 12, 9, 13, 8]
}

function buildClusterKey(totals = []) {
  return totals
    .slice(0, 3)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .join('|')
}

function deriveRegimeFromTotals(totals = []) {
  const counts = { center: 0, upper: 0, lower: 0 }
  totals
    .slice(0, 3)
    .map((item) => Number(item?.total ?? item))
    .filter(Number.isFinite)
    .forEach((total) => {
      counts[totalRegime(total)] += 1
    })

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return ranked[0]?.[1] ? ranked[0][0] : 'center'
}

function buildClusterHitRateMemory(history, candidateTotals = []) {
  const recent = (Array.isArray(history) ? history : []).slice(0, 180)
  const clusterStats = new Map()
  const regimeStats = new Map()

  for (const item of recent) {
    const weight = clamp(Number(item?.learningWeight ?? 1), 0.05, 1)
    const predictedTotals = Array.isArray(item?.predictedTotals)
      ? item.predictedTotals
      : []
    const clusterKey = buildClusterKey(predictedTotals)
    const regimeKey = deriveRegimeFromTotals(predictedTotals)
    if (clusterKey) {
      const clusterStat = clusterStats.get(clusterKey) || { seen: 0, hit: 0 }
      clusterStat.seen += weight
      if (item?.hit) clusterStat.hit += weight
      clusterStats.set(clusterKey, clusterStat)
    }

    const regimeStat = regimeStats.get(regimeKey) || { seen: 0, hit: 0 }
    regimeStat.seen += weight
    if (item?.hit) regimeStat.hit += weight
    regimeStats.set(regimeKey, regimeStat)
  }

  const currentClusterKey = buildClusterKey(candidateTotals)
  const currentRegime = deriveRegimeFromTotals(candidateTotals)
  const currentClusterStat = currentClusterKey
    ? clusterStats.get(currentClusterKey) || null
    : null
  const currentRegimeStat = regimeStats.get(currentRegime) || null
  const clusterPenalty =
    currentClusterStat && currentClusterStat.seen >= 2
      ? clamp(
          (1 - currentClusterStat.hit / currentClusterStat.seen) * 0.16,
          0,
          0.18,
        )
      : 0

  return {
    currentClusterKey,
    currentRegime,
    clusterPenalty,
    currentClusterHitRate:
      currentClusterStat && currentClusterStat.seen
        ? currentClusterStat.hit / currentClusterStat.seen
        : null,
    currentClusterSeen: currentClusterStat?.seen || 0,
    currentRegimeHitRate:
      currentRegimeStat && currentRegimeStat.seen
        ? currentRegimeStat.hit / currentRegimeStat.seen
        : null,
    currentRegimeSeen: currentRegimeStat?.seen || 0,
    bestRegimes: [...regimeStats.entries()]
      .map(([regime, stat]) => ({
        regime,
        label: regimeLabel(regime),
        seen: stat.seen,
        hitRate: stat.seen ? stat.hit / stat.seen : 0,
      }))
      .sort((a, b) => b.hitRate - a.hitRate || b.seen - a.seen)
      .slice(0, 3),
  }
}

function nextRoundIdFromStore(store = readData()) {
  const latestId = String(store?.rounds?.[0]?.id || '').trim()
  if (!latestId) return null
  const numeric = Number(latestId)
  if (!Number.isFinite(numeric)) return null
  return String(numeric + 1).padStart(latestId.length, '0')
}

function buildLiveV9Payload(payload, store = readData()) {
  if (!payload || typeof payload !== 'object') return payload
  const latestRound = normalizeStoredRound(store?.rounds?.[0])
  const memory = readConsensusV16AIMemory()
  const v9Memory = readV9Memory()
  return {
    ...payload,
    dataset: {
      ...(payload.dataset || {}),
      latestRound: latestRound
        ? {
            id: latestRound.id,
            total: latestRound.total,
            result: latestRound.result,
            time: latestRound.time,
          }
        : payload?.dataset?.latestRound || null,
      latestLedgerRound:
        memory.latestRoundId || payload?.dataset?.latestLedgerRound || null,
      nextRoundId:
        nextRoundIdFromStore(store) || payload?.dataset?.nextRoundId || null,
      v9MemorySamples: Array.isArray(v9Memory.history)
        ? v9Memory.history.length
        : 0,
    },
    selectiveStrategy: {
      ...(payload.selectiveStrategy || {}),
      backtest: {
        ...(payload.selectiveStrategy?.backtest || {}),
        sampleSize:
          Array.isArray(v9Memory.history) && v9Memory.history.length
            ? v9Memory.history.length
            : payload?.selectiveStrategy?.backtest?.sampleSize,
        totalHitRate:
          Array.isArray(v9Memory.history) && v9Memory.history.length
            ? Number(
                (
                  (v9Memory.history.filter((item) => item?.hit).length /
                    v9Memory.history.length || 0) * 100
                ).toFixed(4),
              )
            : payload?.selectiveStrategy?.backtest?.totalHitRate,
        recentTotalChecks:
          Array.isArray(v9Memory.history) && v9Memory.history.length
            ? v9Memory.history.slice(0, 7).map((item) => ({
                id: item.roundId,
                predictedTotals: item.predictedTotals,
                actualTotal: item.actualTotal,
                actualResult: item.actualResult,
                hit: item.hit,
                strategyId: item.strategyId,
                strategyLabel: item.strategyLabel,
              }))
            : payload?.selectiveStrategy?.backtest?.recentTotalChecks,
      },
    },
  }
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

function canonicalDiceKey(round) {
  const dice = Array.isArray(round?.dice)
    ? round.dice.map(Number).filter(Number.isFinite)
    : []
  if (dice.length !== 3) return null
  return [...dice].sort((a, b) => a - b).join('-')
}

function exactDiceKey(round) {
  const dice = Array.isArray(round?.dice)
    ? round.dice.map(Number).filter(Number.isFinite)
    : []
  if (dice.length !== 3) return null
  return dice.join('-')
}

function buildFollowUpComboInsights(roundsDesc) {
  const latest = roundsDesc?.[0]
  if (!latest) {
    return {
      totalRounds: 0,
      anchorRoundId: null,
      anchorDice: [],
      anchorTotal: null,
      support: 0,
      topCombos: [],
      topTotals: [],
    }
  }

  const anchorCanonical = canonicalDiceKey(latest)
  const anchorExact = exactDiceKey(latest)
  const comboCounts = new Map()
  const totalCounts = new Map()
  let support = 0

  for (let index = 1; index < roundsDesc.length; index += 1) {
    const round = roundsDesc[index]
    const newerRound = roundsDesc[index - 1]
    if (!round || !newerRound) continue
    if (canonicalDiceKey(round) !== anchorCanonical) continue
    support += 1

    const comboKey = canonicalDiceKey(newerRound)
    if (comboKey)
      comboCounts.set(comboKey, (comboCounts.get(comboKey) || 0) + 1)
    const total = Number(newerRound.total)
    if (Number.isFinite(total))
      totalCounts.set(total, (totalCounts.get(total) || 0) + 1)
  }

  const comboDenominator =
    [...comboCounts.values()].reduce((acc, value) => acc + value, 0) || 1
  const totalDenominator =
    [...totalCounts.values()].reduce((acc, value) => acc + value, 0) || 1

  return {
    totalRounds: roundsDesc.length,
    anchorRoundId: latest.id,
    anchorDice: Array.isArray(latest.dice) ? latest.dice : [],
    anchorExact,
    anchorCanonical,
    anchorTotal: Number(latest.total),
    support,
    topCombos: [...comboCounts.entries()]
      .map(([combo, count]) => ({
        combo,
        count,
        probability: count / comboDenominator,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    topTotals: [...totalCounts.entries()]
      .map(([total, count]) => ({
        total: Number(total),
        count,
        probability: count / totalDenominator,
        result: classifyTotal(Number(total)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
  }
}

function ensureConsensusFollowUpCombos(current, roundsDesc) {
  if (!current || typeof current !== 'object') return current
  if (current.followUpCombos && current.followUpCombos.support != null)
    return current
  return {
    ...current,
    followUpCombos: buildFollowUpComboInsights(roundsDesc),
  }
}

function buildFollowUpTotalInsights(roundsDesc) {
  const latest = roundsDesc?.[0]
  if (!latest || !Number.isFinite(Number(latest.total))) {
    return { support: 0, topTotals: [] }
  }

  const anchorTotal = Number(latest.total)
  const totalCounts = new Map()
  let support = 0

  for (let index = 1; index < roundsDesc.length; index += 1) {
    const round = roundsDesc[index]
    const newerRound = roundsDesc[index - 1]
    if (!round || !newerRound) continue
    if (Number(round.total) !== anchorTotal) continue
    support += 1
    const total = Number(newerRound.total)
    if (Number.isFinite(total)) {
      totalCounts.set(total, (totalCounts.get(total) || 0) + 1)
    }
  }

  const denominator =
    [...totalCounts.values()].reduce((acc, value) => acc + value, 0) || 1

  return {
    support,
    topTotals: [...totalCounts.entries()]
      .map(([total, count]) => ({
        total: Number(total),
        count,
        probability: count / denominator,
        result: classifyTotal(Number(total)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  }
}

function buildFollowUpResultInsights(roundsDesc) {
  const latest = roundsDesc?.[0]
  const latestResult = latest?.result || classifyTotal(Number(latest?.total))
  if (!latestResult) {
    return { support: 0, topTotals: [] }
  }

  const totalCounts = new Map()
  let support = 0

  for (let index = 1; index < roundsDesc.length; index += 1) {
    const round = roundsDesc[index]
    const newerRound = roundsDesc[index - 1]
    if (!round || !newerRound) continue
    const roundResult = round.result || classifyTotal(Number(round.total))
    if (roundResult !== latestResult) continue
    support += 1
    const total = Number(newerRound.total)
    if (Number.isFinite(total)) {
      totalCounts.set(total, (totalCounts.get(total) || 0) + 1)
    }
  }

  const denominator =
    [...totalCounts.values()].reduce((acc, value) => acc + value, 0) || 1

  return {
    support,
    topTotals: [...totalCounts.entries()]
      .map(([total, count]) => ({
        total: Number(total),
        count,
        probability: count / denominator,
        result: classifyTotal(Number(total)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  }
}

async function loadPredictorFns() {
  if (!predictorFnsPromise) {
    predictorFnsPromise = Promise.all([
      import('./predictor.js'),
      import('./predictor_v2.js'),
      import('./predictor_v3.js'),
      import('./predictor_v4.js'),
      import('./predictor_v5.js'),
      import('./predictor_v6.js'),
      import('./predictor_v7.js'),
      import('./predictor_v8.js'),
      import('./predictor_v9.js'),
    ]).then(
      ([
        predictorModule,
        predictorV2Module,
        predictorV3Module,
        predictorV4Module,
        predictorV5Module,
        predictorV6Module,
        predictorV7Module,
        predictorV8Module,
        predictorV9Module,
      ]) => ({
        buildPrediction: predictorModule.buildPrediction,
        buildPredictionFromBase: predictorV2Module.buildPredictionFromBase,
        buildPredictionV3: predictorV3Module.buildPrediction,
        buildPredictionV4: predictorV4Module.buildPrediction,
        buildPredictionV5: predictorV5Module.buildPrediction,
        buildPredictionV6: predictorV6Module.buildPrediction,
        buildPredictionV7: predictorV7Module.buildPrediction,
        buildPredictionV8: predictorV8Module.buildPrediction,
        buildPredictionV9: predictorV9Module.buildPrediction,
      }),
    )
  }

  return predictorFnsPromise
}

function buildAdaptedPredictorOutputs(predictorFns, roundsDesc) {
  const rawV1 = predictorFns.buildPrediction(roundsDesc)
  const rawV2 = predictorFns.buildPredictionFromBase(rawV1)
  const rawV3 = predictorFns.buildPredictionV3(roundsDesc)
  const rawV4 = predictorFns.buildPredictionV4(roundsDesc)
  const rawV5 = predictorFns.buildPredictionV5(roundsDesc)
  const rawV6 = predictorFns.buildPredictionV6(roundsDesc)
  const rawV7 = predictorFns.buildPredictionV7(roundsDesc)
  const rawV8 = predictorFns.buildPredictionV8(roundsDesc)
  const rawV9 = predictorFns.buildPredictionV9(roundsDesc)

  return {
    v1: adaptPredictionPayload(rawV1, roundsDesc, { modelId: 'v1' }),
    v2: adaptPredictionPayload(rawV2, roundsDesc, { modelId: 'v2' }),
    v3: adaptPredictionPayload(rawV3, roundsDesc, { modelId: 'v3' }),
    v4: adaptPredictionPayload(rawV4, roundsDesc, { modelId: 'v4' }),
    v5: adaptPredictionPayload(rawV5, roundsDesc, { modelId: 'v5' }),
    v6: adaptPredictionPayload(rawV6, roundsDesc, { modelId: 'v6' }),
    v7: adaptPredictionPayload(rawV7, roundsDesc, { modelId: 'v7' }),
    v8: adaptPredictionPayload(rawV8, roundsDesc, { modelId: 'v8' }),
    v9: adaptPredictionPayload(rawV9, roundsDesc, { modelId: 'v9' }),
  }
}

async function refreshPredictionCache(store = readData()) {
  void store
  return new Promise((resolve, reject) => {
    let settled = false
    const workerPath = path.join(__dirname, 'snapshot_builder.js')
    const worker = fork(workerPath, {
      cwd: __dirname,
      env: {
        ...process.env,
        DATA_FILE,
        PREDICTION_SNAPSHOTS_FILE,
      },
      silent: true,
    })
    snapshotBuildWorker = worker

    const cleanup = () => {
      snapshotBuildWorker = null
    }

    const settleResolve = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const settleReject = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    worker.stderr?.on('data', (chunk) => {
      const message = String(chunk || '').trim()
      if (message) console.error('[snapshot-builder]', message)
    })

    worker.on('message', (message) => {
      if (!message?.ok) return
      const snapshot = readPredictionSnapshots()
      if (!hydrateCachesFromSnapshots(snapshot)) {
        settleReject(
          new Error(
            'Snapshot bundle was created but could not hydrate caches.',
          ),
        )
        return
      }
      consensusV16AIBacktestState = 'idle'
      consensusV16AIBacktestPromise = null
      if (consensusV16AIReplayTimer) {
        clearTimeout(consensusV16AIReplayTimer)
        consensusV16AIReplayTimer = null
      }
      settleResolve(predictionCache)
    })

    worker.on('error', (error) => {
      cleanup()
      settleReject(error)
    })

    worker.on('exit', (code, signal) => {
      cleanup()
      if (settled) return
      if (signal === 'SIGTERM' || signal === 'SIGINT') {
        settleResolve(predictionCache)
        return
      }
      if (code === 0) {
        settleResolve(predictionCache)
        return
      }
      settleReject(new Error(`Snapshot builder exited with code ${code}`))
    })
  })
}

async function safeRefreshPredictionCache(store = readData()) {
  try {
    cacheBuildState = 'building'
    const cache = await refreshPredictionCache(store)
    startupError = null
    cacheBuildState = 'ready'
    cacheIsStale = false
    updateLocalAIPendingPrediction(store)
    backfillLocalAIMemory(store)
    updateV9PendingPrediction(store)
    scheduleLocalAIBackfill(400)
    scheduleConsensusV16AIBacktestBuild()
    broadcastReload()
    return cache
  } catch (err) {
    startupError = err
    cacheBuildState = 'error'
    console.error('[predict] refresh failed:', err.message)
    return null
  }
}

function scheduleCacheBuild(delayMs = 50, store = null) {
  if (cacheBuildState === 'building') return
  if (cacheBuildTimer) return
  if (snapshotBuildWorker) return

  cacheBuildState = 'scheduled'
  cacheBuildTimer = setTimeout(() => {
    cacheBuildTimer = null
    safeRefreshPredictionCache(store || readData()).catch((err) => {
      startupError = err
      cacheBuildState = 'error'
      console.error('[predict] scheduled build crashed:', err.message)
    })
  }, delayMs)
}

function invalidatePredictionCaches(options = {}) {
  const preserveConsensus = Boolean(options.preserveConsensus)
  const nextRoundId =
    options.nextRoundId != null ? String(options.nextRoundId) : null
  cacheIsStale = true
  if (!preserveConsensus) {
    consensusV16AICache = null
  } else if (consensusV16AICache?.current && nextRoundId) {
    consensusV16AICache = {
      ...consensusV16AICache,
      current: {
        ...consensusV16AICache.current,
        nextRoundId,
      },
    }
  }
  consensusV16AIBuildState = 'idle'
  consensusV16AIBuildPromise = null
  consensusV16AIBacktestState = 'idle'
  consensusV16AIBacktestPromise = null
  if (consensusV16AIReplayTimer) {
    clearTimeout(consensusV16AIReplayTimer)
    consensusV16AIReplayTimer = null
  }
  if (consensusV16AIWorker) {
    consensusV16AIWorker.kill()
    consensusV16AIWorker = null
  }
  if (snapshotBuildWorker) {
    snapshotBuildWorker.kill()
    snapshotBuildWorker = null
  }
}

function normalizeUnitProbability(value, fallback = 0) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return numeric > 1 ? numeric / 100 : numeric
}

function collectPredictionCandidates(payload, limit = 12) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  const list = [
    ...(Array.isArray(current.recommendedTotals) ? current.recommendedTotals : []),
    ...(Array.isArray(diagnosis.topTotals) ? diagnosis.topTotals : []),
    ...(Array.isArray(diagnosis.totalDistribution)
      ? diagnosis.totalDistribution
      : []),
  ]
  const seen = new Set()
  return list
    .map((item, index) => ({
      total: Number(item?.total),
      probability: normalizeUnitProbability(
        item?.probability ?? item?.normalized ?? item?.averageProbability ?? item?.score,
        Math.max(0.02, 0.16 - index * 0.012),
      ),
      result:
        item?.result ||
        item?.resultClass ||
        item?.classification ||
        classifyTotal(Number(item?.total)),
      sources: Array.isArray(item?.sources) ? item.sources : [],
    }))
    .filter((item) => {
      if (!Number.isFinite(item.total) || seen.has(item.total)) return false
      seen.add(item.total)
      return true
    })
    .slice(0, limit)
}

function readLocalAIFreeState() {
  const store = readData()
  const roundsDesc = normalizeStoredRounds(store).rounds
  const current = predictionCacheV6 || null
  const drawSpecialist = predictionCacheV7 || null
  const numberSpecialist = predictionCacheV8 || null
  const currentDecision = current?.selectiveStrategy?.currentDecision || {}
  const currentTopTotals = Array.isArray(currentDecision.recommendedTotals)
    ? currentDecision.recommendedTotals
        .map((item, index) => ({
          total: Number(item?.total),
          probability: normalizeUnitProbability(
            item?.probability ?? item?.score,
            Math.max(0.03, 0.16 - index * 0.018),
          ),
          result:
            item?.result ||
            item?.resultClass ||
            item?.classification ||
            classifyTotal(Number(item?.total)),
        }))
        .filter((item) => Number.isFinite(item.total))
    : []
  const topTotals = collectPredictionCandidates(current, 10)
  const primarySignalTotals = (currentTopTotals.length ? currentTopTotals : topTotals)
    .slice(0, 3)
    .map((item) => Number(item?.total))
    .filter(Number.isFinite)
  const consensus = consensusV16AICache?.current || null
  const memory = readLocalAIMemory()
  const history = Array.isArray(memory.history) ? memory.history : []
  const {
    allHistory,
    liveHistory,
    replayHistory,
    learningHistory,
    adaptiveHistory,
    clusterHistory,
  } = buildLocalAIHistoryBuckets(history)
  const { totalStats, resultStats } = buildLocalAIFreeLearning(learningHistory)
  const adaptive = buildAdaptiveMemorySignals(
    adaptiveHistory.length ? adaptiveHistory : learningHistory,
    primarySignalTotals,
  )
  const clusterMemory = buildClusterHitRateMemory(
    clusterHistory.length ? clusterHistory : learningHistory,
    primarySignalTotals,
  )
  const primarySignalSet = new Set(primarySignalTotals)
  const adjustedTopTotals = topTotals
    .slice(0, Math.max(6, topTotals.length))
    .map((item, index) => {
      const total = Number(item?.total)
      const baseProbability = normalizeUnitProbability(
        item?.probability ?? item?.score,
        0,
      )
      const stat = totalStats.get(String(total))
      const empirical =
        stat && stat.seen >= 2
          ? stat.hit / stat.seen
          : Math.max(0.18, baseProbability * 0.82)
      const predictedExposure = Number(
        adaptive.predictedExposureWeights.get(total) || 0,
      )
      let adjustedProbability = baseProbability * 0.58 + empirical * 0.24
      if (primarySignalSet.has(total) && adaptive.repeatPenalty > 0) {
        adjustedProbability *= 1 - adaptive.repeatPenalty * 0.58
      } else if (!primarySignalSet.has(total) && adaptive.repeatPenalty > 0) {
        adjustedProbability +=
          adaptive.repeatPenalty * Math.max(0.014, 0.032 - index * 0.003)
      }
      adjustedProbability -= Math.min(0.14, predictedExposure * 0.036)
      adjustedProbability += (adaptive.missTotalWeights.get(total) || 0) * 0.045
      if (total === 10 || total === 11) {
        adjustedProbability += adaptive.drawCenterMissWeight * 0.012
      } else if (total === 9 || total === 12) {
        adjustedProbability += adaptive.drawCenterMissWeight * 0.006
      }
      if (
        clusterMemory.currentRegime === totalRegime(total) &&
        clusterMemory.currentRegimeHitRate != null
      ) {
        adjustedProbability += clusterMemory.currentRegimeHitRate * 0.04
      }
      if (primarySignalSet.has(total) && clusterMemory.clusterPenalty > 0) {
        adjustedProbability *= 1 - clusterMemory.clusterPenalty * 0.9
      } else if (!primarySignalSet.has(total) && clusterMemory.clusterPenalty > 0) {
        adjustedProbability += clusterMemory.clusterPenalty * 0.05
      }
      return {
        total,
        probability: Math.max(0.0005, adjustedProbability),
        seen: stat?.seen || 0,
        hitRate: stat && stat.seen ? stat.hit / stat.seen : null,
        origin: primarySignalSet.has(total) ? 'v6-core' : 'adaptive-memory',
      }
    })
    .sort((a, b) => b.probability - a.probability)
  const currentResult =
    currentDecision.recommendedResult ||
    current?.diagnosis?.mostLikelyResult ||
    '--'
  const resultStat = resultStats.get(String(currentResult))
  const resultEmpirical =
    resultStat && resultStat.seen >= 3 ? resultStat.hit / resultStat.seen : null
  const drawProbability = normalizeUnitProbability(
    currentDecision.drawProbability ??
      current?.diagnosis?.resultProbabilities?.Draw,
    0,
  )
  const drawTopTotals = collectPredictionCandidates(drawSpecialist, 6)
  const numberTopTotals = collectPredictionCandidates(numberSpecialist, 6)
  const candidateOrigins = new Map()
  const mergedCandidatePool = [
    ...adjustedTopTotals.map((item) => ({
      ...item,
      origin: item.origin || 'adaptive-memory',
    })),
    ...drawTopTotals.map((item) => ({
      total: Number(item?.total),
      probability:
        normalizeUnitProbability(item?.probability ?? item?.score, 0) *
        (adaptive.shouldConsiderDraw ? 0.84 : 0.66),
      seen: totalStats.get(String(Number(item?.total)))?.seen || 0,
      hitRate: totalStats.get(String(Number(item?.total)))
        ? totalStats.get(String(Number(item?.total))).hit /
          totalStats.get(String(Number(item?.total))).seen
        : null,
      origin: 'draw-specialist',
    })),
    ...numberTopTotals.map((item) => ({
      total: Number(item?.total),
      probability:
        normalizeUnitProbability(item?.probability ?? item?.score, 0) * 0.82,
      seen: totalStats.get(String(Number(item?.total)))?.seen || 0,
      hitRate: totalStats.get(String(Number(item?.total)))
        ? totalStats.get(String(Number(item?.total))).hit /
          totalStats.get(String(Number(item?.total))).seen
        : null,
      origin: 'number-regime',
    })),
  ]
    .filter((item) => Number.isFinite(item.total))
    .reduce((acc, item) => {
      const total = Number(item.total)
      const existing = acc.get(total)
      if (!existing || Number(existing.probability || 0) < Number(item.probability || 0)) {
        acc.set(total, item)
        candidateOrigins.set(total, item.origin)
      }
      return acc
    }, new Map())
  const mergedTopTotals = [...mergedCandidatePool.values()]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 12)
  const localAdaptiveDistribution = adaptTopTotalRecords(
    mergedTopTotals,
    roundsDesc,
    {
      limit: 12,
      modelId: 'local',
      sourceLabel: 'local-adaptive',
    },
  )
  const localAdaptiveTopTotals = selectAdaptiveTopTotalRecords(
    localAdaptiveDistribution,
    roundsDesc,
    {
      limit: 3,
      modelId: 'local',
    },
  ).map((item) => ({
    total: Number(item.total),
    probability: Number(item.probability || 0),
    seen: Number(item?.seen || 0),
    hitRate: item?.hitRate != null ? Number(item.hitRate) : null,
  }))
  const localAdaptiveResultProbabilities = buildAdaptiveResultProbabilities(
    mergedTopTotals,
    roundsDesc,
    { modelId: 'local' },
  )
  const localAdaptiveResult = RESULT_ORDER.slice().sort(
    (left, right) =>
      localAdaptiveResultProbabilities[right] -
      localAdaptiveResultProbabilities[left],
  )[0]
  const aiOwnTopTotals = localAdaptiveTopTotals.slice(0, 3).map((item, index) => ({
    total: Number(item.total),
    probability: Number(item.probability || 0),
    rank: index + 1,
    origin: candidateOrigins.get(Number(item.total)) || 'adaptive-memory',
  }))
  const displayHistory = liveHistory.length ? liveHistory : learningHistory
  const recentTotalChecks = displayHistory.slice(0, 7).map((item) => ({
    id: String(item?.roundId || ''),
    predictedTotals: Array.isArray(item?.predictedTotals)
      ? item.predictedTotals.map(Number).filter(Number.isFinite).slice(0, 3)
      : [],
    actualTotal: Number(item?.actualTotal),
    actualResult: String(
      item?.actualResult || classifyTotal(Number(item?.actualTotal)),
    ),
    hit: Boolean(item?.hit),
  }))
  const pendingTotalCheck =
    memory.pendingPrediction && memory.pendingPrediction.roundId
      ? {
          id: String(memory.pendingPrediction.roundId),
          predictedTotals: Array.isArray(
            memory.pendingPrediction.predictedTotals,
          )
            ? memory.pendingPrediction.predictedTotals
                .map(Number)
                .filter(Number.isFinite)
                .slice(0, 3)
            : aiOwnTopTotals.slice(0, 3).map((item) => Number(item.total)),
          actualTotal: null,
          actualResult: null,
          hit: null,
          pending: true,
        }
      : null
  const finalDrawProbability = Number(
    (
      drawProbability * 0.58 +
      Number(localAdaptiveResultProbabilities.Draw || 0) * 0.42
    ).toFixed(6),
  )
  const liveHitRate = liveHistory.length
    ? liveHistory.filter((item) => item.hit).length / liveHistory.length
    : null
  const replayHitRate = replayHistory.length
    ? replayHistory.filter((item) => item.hit).length / replayHistory.length
    : null
  const learningWeightTotal = learningHistory.reduce(
    (acc, item) => acc + Number(item?.learningWeight ?? 1),
    0,
  )
  const learningHitRate = learningWeightTotal
    ? learningHistory.reduce(
        (acc, item) =>
          acc + (item?.hit ? Number(item?.learningWeight ?? 1) : 0),
        0,
      ) / learningWeightTotal
    : 0
  const drawConsideration = adaptive.shouldConsiderDraw
    ? 'Nên cân nhắc Hòa vì cụm 10/11 đang bị bỏ lỡ hoặc chuỗi đang trượt lặp.'
    : drawProbability >= 0.28
      ? 'Có thể theo dõi Hòa nếu cụm 10/11 tiếp tục sáng thêm vài kỳ.'
      : 'Hiện chưa nên ưu tiên Hòa, nhưng vẫn theo dõi cụm 10/11.'

  return {
    provider: 'local',
    version: 'v6-v7-adaptive',
    status: current
      ? 'ready'
      : cacheBuildState === 'building'
        ? 'warming_up'
        : 'idle',
    engine: 'V6 noi bo + V7 Draw Specialist + V8 Number Regime / local-free',
    result: localAdaptiveResult || currentResult,
    decision:
      currentDecision.decision || (currentDecision.shouldBet ? 'BET' : 'SKIP'),
    aiBetFlag:
      currentDecision.decision || (currentDecision.shouldBet ? 'BET' : 'SKIP'),
    confidence: normalizeUnitProbability(
      currentDecision.topProbability ??
        current?.diagnosis?.confidenceModel?.topProbability,
      0,
    ),
    spread: normalizeUnitProbability(
      currentDecision.topSpread ?? current?.diagnosis?.confidenceModel?.topGap,
      0,
    ),
    topTotals: localAdaptiveTopTotals,
    aiOwnTopTotals: localAdaptiveTopTotals.slice(0, 3).map((item, index) => ({
      total: Number(item.total),
      probability: Number(item.probability || 0),
      rank: index + 1,
      origin:
        aiOwnTopTotals.find(
          (entry) => Number(entry.total) === Number(item.total),
        )?.origin || 'adaptive-memory',
    })),
    aiOwnTopTotalsDisplay:
      Array.isArray(memory.pendingPrediction?.predictedTotals) &&
      memory.pendingPrediction.predictedTotals.length
        ? memory.pendingPrediction.predictedTotals
            .map((total, index) => ({
              total: Number(total),
              probability:
                memory.pendingPrediction?.predictedScores?.[index]
                  ?.probability ||
                aiOwnTopTotals[index]?.probability ||
                0,
              rank: index + 1,
              origin:
                aiOwnTopTotals.find(
                  (entry) => Number(entry.total) === Number(total),
                )?.origin || 'pending-lock',
            }))
            .filter((item) => Number.isFinite(item.total))
        : localAdaptiveTopTotals.slice(0, 3).map((item, index) => ({
            total: Number(item.total),
            probability: Number(item.probability || 0),
            rank: index + 1,
            origin:
              aiOwnTopTotals.find(
                (entry) => Number(entry.total) === Number(item.total),
              )?.origin || 'local-adaptive',
          })),
    drawProbability: finalDrawProbability,
    drawTopTotals: drawTopTotals.slice(0, 3),
    drawConsideration,
    consensusResult: consensus?.resultConsensus || '--',
    consensusTopTotal: consensus?.topTotal ?? null,
    totalRounds: Array.isArray(store.rounds) ? store.rounds.length : 0,
    updatedAt: store.updatedAt ?? null,
    memorySampleSize: learningHistory.length,
    memoryHistorySize: allHistory.length,
    liveMemorySampleSize: liveHistory.length,
    replayMemorySampleSize: replayHistory.length,
    memoryBackfillState: localAIBackfillState,
    memoryHitRate: learningHitRate,
    replayHitRate,
    aiHitRate: liveHitRate ?? learningHitRate,
    aiRecentTotalChecks: recentTotalChecks,
    aiPendingTotalCheck: pendingTotalCheck,
    resultEmpiricalHitRate: resultEmpirical,
    adaptiveSignals: {
      missStreak: adaptive.missStreak,
      repeatedClusterMisses: adaptive.repeatedClusterMisses,
      repeatPenalty: adaptive.repeatPenalty,
      shouldConsiderDraw: adaptive.shouldConsiderDraw,
      drawCenterMissWeight: adaptive.drawCenterMissWeight,
      adaptiveResultProbabilities: localAdaptiveResultProbabilities,
      clusterPenalty: clusterMemory.clusterPenalty,
      currentRegime: clusterMemory.currentRegime,
      currentRegimeHitRate: clusterMemory.currentRegimeHitRate,
    },
    pendingPrediction: memory.pendingPrediction || null,
    startupPhase,
    cacheBuildState,
    lastError: startupError ? startupError.message : null,
    notes: [
      'Khong can API key hoac billing.',
      'Khong fine-tune tra phi va khong goi model ngoai.',
      'Chi su dung du lieu local va predictor V6 hien co.',
      `AI local/free tu chot Top 3 rieng: ${localAdaptiveTopTotals.map((item) => item.total).join(', ') || '--'}.`,
      `Ty le trung AI chi tinh tren du doan live da khoa: ${liveHistory.length} mau.`,
      `Bo nho hoc dung ${learningHistory.length} mau huu hieu, trong do replay/backfill ${replayHistory.length} mau de warm-up.`,
      `Neu file nho duoi ${LOCAL_AI_MEMORY_MIN_SAMPLES} mau, he thong se backfill lich su den khoang ${LOCAL_AI_MEMORY_BACKFILL_TARGET} ky.`,
      'Co bo nho chong lap lai cum tong va tu tang trong so cho cac tong da bi bo lo.',
      `Regime local/free hien tai: ${clusterMemory.currentRegime || '--'}, hit-rate cum: ${clusterMemory.currentClusterHitRate != null ? `${Number((clusterMemory.currentClusterHitRate * 100).toFixed(2))}%` : '--'}.`,
    ],
  }
}

function topTotalsFromPayload(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const fromCurrent = Array.isArray(current.recommendedTotals)
    ? current.recommendedTotals
    : []
  const fromDiagnosis = Array.isArray(payload?.diagnosis?.topTotals)
    ? payload.diagnosis.topTotals
    : []
  const list = fromCurrent.length ? fromCurrent : fromDiagnosis
  return list
    .map((item, index) => ({
      total: Number(item?.total),
      probability: normalizeUnitProbability(
        item?.probability ?? item?.score,
        Math.max(0.06, 0.18 - index * 0.025),
      ),
    }))
    .filter((item) => Number.isFinite(item.total))
}

function resultFromPayload(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  return (
    current.recommendedResult ||
    diagnosis.mostLikelyResult ||
    diagnosis.recommendedResult ||
    'Draw'
  )
}

function decisionFromPayload(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  if (current.decision) return current.decision
  return current.shouldBet ? 'BET' : 'SKIP'
}

function summaryFromPayload(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  const recommendations = diagnosis?.recommendations
  if (typeof current.summary === 'string' && current.summary.trim())
    return current.summary
  if (
    recommendations &&
    typeof recommendations === 'object' &&
    typeof recommendations.recommendationText === 'string' &&
    recommendations.recommendationText.trim()
  ) {
    return recommendations.recommendationText
  }
  if (
    Array.isArray(recommendations) &&
    typeof recommendations[0] === 'string'
  ) {
    return recommendations[0]
  }
  if (
    typeof diagnosis.primaryMethod === 'string' &&
    diagnosis.primaryMethod.trim()
  ) {
    return diagnosis.primaryMethod
  }
  if (
    Array.isArray(diagnosis.methodNotes) &&
    typeof diagnosis.methodNotes[0] === 'string'
  ) {
    return diagnosis.methodNotes[0]
  }
  if (typeof current.rationale === 'string' && current.rationale.trim())
    return current.rationale
  return '--'
}

function regimeFromPayload(payload) {
  const methodologyRegime = payload?.methodology?.regime
  if (methodologyRegime && typeof methodologyRegime === 'object') {
    return methodologyRegime.key || methodologyRegime.label || 'center'
  }
  return deriveRegimeFromTotals(topTotalsFromPayload(payload))
}

function modelViewFromPayload(name, payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  return {
    name,
    result: resultFromPayload(payload),
    decision: decisionFromPayload(payload),
    summary: summaryFromPayload(payload),
    totals: topTotalsFromPayload(payload),
    regime: regimeFromPayload(payload),
    topProbability: normalizeUnitProbability(
      current.topProbability ?? diagnosis?.confidenceModel?.topProbability,
      0.01,
    ),
  }
}

function buildRestoredV6AIPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const cloned = JSON.parse(JSON.stringify(payload))
  cloned.methodology = {
    ...(cloned.methodology || {}),
    note: 'V6 AI dang duoc khoi phuc ve mode on dinh. Tam thoi su dung loi V6 de dam bao toc do va do on dinh cua he thong.',
    model: {
      id: 'predictor_v6_ai_restored',
      label: 'AI Doc Lap V6 (Restored Stable Mode)',
    },
  }
  if (cloned.dataset) {
    cloned.dataset.restoredFrom = 'V6'
  } else {
    cloned.dataset = { restoredFrom: 'V6' }
  }
  return cloned
}

function buildConsensusSnapshotFromCaches() {
  if (
    !predictionCache ||
    !predictionCacheV2 ||
    !predictionCacheV3 ||
    !predictionCacheV4 ||
    !predictionCacheV5 ||
    !predictionCacheV6 ||
    !predictionCacheV7 ||
    !predictionCacheV8
  ) {
    return null
  }

  return ensureConsensusFollowUpCombos(
    buildConsensusSnapshotFromPredictionsV2(
      {
        v1: predictionCache,
        v2: predictionCacheV2,
        v3: predictionCacheV3,
        v4: predictionCacheV4,
        v5: predictionCacheV5,
        v6: predictionCacheV6,
        v7: predictionCacheV7,
        v8: predictionCacheV8,
        v9: predictionCacheV9,
      },
      normalizeStoredRounds(readData()).rounds,
    ),
    normalizeStoredRounds(readData()).rounds,
  )
}

async function buildConsensusV16AIRecentMemory() {
  const predictorFns = await loadPredictorFns()
  const roundsDesc = normalizeStoredRounds(readData()).rounds
  const existingMemory = readConsensusV16AIMemory()
  const existingChecks = new Map(
    Array.isArray(existingMemory.allTotalChecks)
      ? existingMemory.allTotalChecks.map((item) => [
          String(item?.id || ''),
          item,
        ])
      : [],
  )
  const maxEval = Math.max(0, roundsDesc.length - 900)
  const evalRounds = Math.min(7, maxEval)
  const trainWindow = 1800
  const recentTotalChecks = []
  let totalHits = 0

  for (let offset = evalRounds; offset >= 1; offset -= 1) {
    const actualRound = roundsDesc[offset - 1]
    const existing = existingChecks.get(String(actualRound?.id || ''))
    if (existing) {
      recentTotalChecks.push(existing)
      if (existing.hit) totalHits += 1
      continue
    }
    const trainRounds = roundsDesc.slice(offset, offset + trainWindow)
    if (!actualRound || trainRounds.length < 900) continue

    const { v1, v2, v3, v4, v5, v6, v7, v8, v9 } =
      buildAdaptedPredictorOutputs(predictorFns, trainRounds)
    const snapshot = buildConsensusSnapshotFromPredictionsV2({
      v1,
      v2,
      v3,
      v4,
      v5,
      v6,
      v7,
      v8,
      v9,
    })
    const predictedTotals = snapshot.topTotals
      .slice(0, 3)
      .map((item) => Number(item.total))
    const hit = predictedTotals.includes(Number(actualRound.total))
    if (hit) totalHits += 1

    recentTotalChecks.push({
      id: actualRound.id,
      predictedTotals,
      actualTotal: Number(actualRound.total),
      actualResult: actualRound.result,
      hit,
      leadTotal: snapshot.topTotals[0]?.total ?? null,
      leadProbability: snapshot.topTotals[0]
        ? Number((snapshot.topTotals[0].normalized * 100).toFixed(2))
        : 0,
    })
  }

  const orderedChecks = recentTotalChecks.slice().reverse()
  const payload = {
    createdAt: new Date().toISOString(),
    sampleSize: orderedChecks.length,
    totalHitRate: orderedChecks.length ? totalHits / orderedChecks.length : 0,
    allTotalChecks: orderedChecks,
    recentTotalChecks: orderedChecks.slice(0, 7),
  }
  writeConsensusV16AIMemory(payload)
  return payload
}

function buildConsensusSnapshotFromPredictions(predictions) {
  const roles = {
    V1: { label: 'Chuyên số', cls: 'number' },
    V2: { label: 'Chuyên số', cls: 'number' },
    V3: { label: 'Chuyên số', cls: 'number' },
    V4: { label: 'Chuyên cửa', cls: 'result' },
    V5: { label: 'Chuyên cửa', cls: 'result' },
    V6: { label: 'AI meta', cls: 'ai' },
    V7: { label: 'Chuyên Hòa', cls: 'result' },
  }
  const models = [
    { name: 'V1', payload: predictions.v1 },
    { name: 'V2', payload: predictions.v2 },
    { name: 'V3', payload: predictions.v3 },
    { name: 'V4', payload: predictions.v4 },
    { name: 'V5', payload: predictions.v5 },
    { name: 'V6', payload: predictions.v6 },
    { name: 'V7', payload: predictions.v7 },
  ].map(({ name, payload }) => ({
    ...modelViewFromPayload(name, payload),
    role: roles[name],
  }))

  const resultScores = new Map([
    ['Big', 0],
    ['Small', 0],
    ['Draw', 0],
  ])
  const totalScores = new Map()
  const totalVotes = new Map()

  for (const model of models) {
    if (resultScores.has(model.result)) {
      const bonus = model.name === 'V6' ? 1.3 : model.name === 'V7' ? 1.18 : 1
      resultScores.set(
        model.result,
        (resultScores.get(model.result) || 0) +
          Math.max(0.01, model.topProbability) * bonus,
      )
    }
    model.totals.slice(0, 4).forEach((item, index) => {
      const total = Number(item.total)
      if (!Number.isFinite(total)) return
      const score =
        normalizeUnitProbability(item.probability, 0.08) *
        Math.max(0.3, 1 - index * 0.18) *
        (model.name === 'V6' ? 1.22 : model.name === 'V7' ? 1.12 : 1)
      totalScores.set(total, (totalScores.get(total) || 0) + score)
      const votes = totalVotes.get(total) || []
      votes.push(model.name)
      totalVotes.set(total, votes)
    })
  }

  const rawTopTotals = [...totalScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([total]) => Number(total))
  const adaptive = buildAdaptiveMemorySignals(
    readLocalAIMemory().history,
    rawTopTotals,
  )

  if (adaptive.repeatPenalty > 0) {
    rawTopTotals.forEach((total) => {
      totalScores.set(
        total,
        (totalScores.get(total) || 0) * (1 - adaptive.repeatPenalty),
      )
    })
  }

  for (const [total, weight] of adaptive.missTotalWeights.entries()) {
    totalScores.set(total, (totalScores.get(total) || 0) + weight * 0.12)
    if (total === 10 || total === 11) {
      totalScores.set(
        total,
        (totalScores.get(total) || 0) + adaptive.drawCenterMissWeight * 0.08,
      )
    } else if (total === 9 || total === 12) {
      totalScores.set(
        total,
        (totalScores.get(total) || 0) + adaptive.drawCenterMissWeight * 0.04,
      )
    }
  }

  resultScores.set(
    'Draw',
    (resultScores.get('Draw') || 0) + adaptive.drawCenterMissWeight * 0.22,
  )
  if (adaptive.shouldConsiderDraw) {
    resultScores.set('Draw', (resultScores.get('Draw') || 0) + 0.12)
  }

  const resultList = [...resultScores.entries()]
    .map(([result, score]) => ({ result, score }))
    .sort((a, b) => b.score - a.score)
  const resultSum = resultList.reduce((acc, item) => acc + item.score, 0) || 1
  resultList.forEach((item) => {
    item.probability = item.score / resultSum
  })

  const totalSum =
    [...totalScores.values()].reduce((acc, value) => acc + value, 0) || 1
  const totalList = [...totalScores.entries()]
    .map(([total, score]) => ({
      total,
      score,
      normalized: score / totalSum,
      votes: totalVotes.get(total) || [],
      result: classifyTotal(total),
    }))
    .sort((a, b) => b.score - a.score)

  const drawProbability =
    resultList.find((item) => item.result === 'Draw')?.probability || 0
  const drawCluster = totalList
    .filter(
      (item) =>
        item.total === 10 ||
        item.total === 11 ||
        item.total === 9 ||
        item.total === 12,
    )
    .slice(0, 4)
  const drawConsideration =
    adaptive.shouldConsiderDraw || drawProbability >= 0.3
      ? 'Nên cân nhắc Hòa khi cụm 10/11 sáng hoặc chuỗi đang bỏ lỡ vùng trung tâm.'
      : 'Hiện Big/Small vẫn mạnh hơn, nhưng cụm 10/11 cần được theo dõi riêng.'

  return {
    models,
    resultList,
    topTotals: totalList,
    resultConsensus: resultList[0]?.result || '--',
    topTotal: totalList[0]?.total ?? null,
    drawProbability,
    drawCluster,
    drawConsideration,
    adaptiveSignals: adaptive,
  }
}

function buildConsensusSnapshotFromPredictionsV2(
  predictions,
  roundsDesc = normalizeStoredRounds(readData()).rounds,
) {
  const roles = {
    V1: { label: 'Chuyen so', cls: 'number' },
    V2: { label: 'Chuyen so', cls: 'number' },
    V3: { label: 'Chuyen so', cls: 'number' },
    V4: { label: 'Chuyen cua', cls: 'result' },
    V5: { label: 'Chuyen cua', cls: 'result' },
    V6: { label: 'AI meta', cls: 'ai' },
    V7: { label: 'Chuyen Hoa', cls: 'result' },
    V8: { label: 'Chuyen regime so', cls: 'number' },
    V9: { label: 'Ledger theo ngay/50 ky', cls: 'ai' },
  }
  const models = [
    { name: 'V1', payload: predictions.v1 },
    { name: 'V2', payload: predictions.v2 },
    { name: 'V3', payload: predictions.v3 },
    { name: 'V4', payload: predictions.v4 },
    { name: 'V5', payload: predictions.v5 },
    { name: 'V6', payload: predictions.v6 },
    { name: 'V7', payload: predictions.v7 },
    { name: 'V8', payload: predictions.v8 },
    { name: 'V9', payload: predictions.v9 },
  ]
    .filter(({ payload }) => payload)
    .map(({ name, payload }) => ({
      ...modelViewFromPayload(name, payload),
      role: roles[name],
    }))

  const historyMemory = readConsensusV16AIMemory()
  const history = Array.isArray(historyMemory.allTotalChecks)
    ? historyMemory.allTotalChecks
    : []
  const comboInsights = buildFollowUpComboInsights(roundsDesc)
  const totalInsights = buildFollowUpTotalInsights(roundsDesc)
  const resultInsights = buildFollowUpResultInsights(roundsDesc)
  const temporalFlow = buildTemporalFlowBundle(roundsDesc)
  const resultScores = new Map([
    ['Big', 0],
    ['Small', 0],
    ['Draw', 0],
  ])
  const regimeScores = new Map([
    ['center', 0],
    ['upper', 0],
    ['lower', 0],
  ])
  const rawTotalScores = new Map()
  const totalVotes = new Map()

  const pushVote = (label, total, score) => {
    if (!Number.isFinite(Number(total)) || !Number.isFinite(Number(score)))
      return
    if (Number(score) <= 0) return
    rawTotalScores.set(
      Number(total),
      (rawTotalScores.get(Number(total)) || 0) + Number(score),
    )
    const votes = totalVotes.get(Number(total)) || []
    votes.push(label)
    totalVotes.set(Number(total), votes)
  }

  const addTemporalScoreObject = (
    label,
    scoreObject,
    multiplier,
    limit = 5,
  ) => {
    if (!scoreObject || !multiplier) return
    Object.entries(scoreObject)
      .map(([total, score]) => ({
        total: Number(total),
        score: Number(score),
      }))
      .filter(
        (item) => Number.isFinite(item.total) && Number.isFinite(item.score),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .forEach((item, index) => {
        pushVote(
          label,
          item.total,
          item.score * multiplier * Math.max(0.26, 1 - index * 0.1),
        )
      })
  }

  const modelBonus = (name) => {
    if (name === 'V6') return 1.08
    if (name === 'V7') return 1.06
    if (name === 'V8') return 1.1
    if (name === 'V9') return 1.14
    return 1
  }

  for (const model of models) {
    const bonus = modelBonus(model.name)
    if (resultScores.has(model.result)) {
      resultScores.set(
        model.result,
        (resultScores.get(model.result) || 0) +
          Math.max(0.01, model.topProbability) * bonus,
      )
    }
    regimeScores.set(
      model.regime,
      (regimeScores.get(model.regime) || 0) +
        Math.max(0.05, model.topProbability) * bonus,
    )

    model.totals.slice(0, 4).forEach((item, index) => {
      const total = Number(item.total)
      if (!Number.isFinite(total)) return
      const score =
        normalizeUnitProbability(item.probability, 0.08) *
        Math.max(0.3, 1 - index * 0.18) *
        bonus
      pushVote(model.name, total, score)
    })
  }

  ;['Small', 'Draw', 'Big'].forEach((result) => {
    resultScores.set(
      result,
      (resultScores.get(result) || 0) +
        Number(temporalFlow?.resultProbabilities?.[result] || 0) * 1.18,
    )
  })
  regimeScores.set(
    temporalFlow?.regime || 'center',
    (regimeScores.get(temporalFlow?.regime || 'center') || 0) + 0.18,
  )

  addTemporalScoreObject('T-BAL', temporalFlow?.scoreByTotal, 4.6, 6)
  addTemporalScoreObject(
    'T-DAY',
    temporalFlow?.components?.day?.scoreByTotal,
    2.1 *
      clamp(
        (Number(temporalFlow?.components?.day?.support || 0) || 0) / 18,
        0.3,
        1.35,
      ),
    4,
  )
  addTemporalScoreObject(
    'T-50',
    temporalFlow?.components?.recent50?.scoreByTotal,
    1.7,
    4,
  )
  addTemporalScoreObject(
    'T-RES',
    temporalFlow?.components?.afterResult?.scoreByTotal,
    2.4 *
      clamp(
        (Number(temporalFlow?.components?.afterResult?.support || 0) || 0) / 20,
        0.25,
        1.4,
      ),
    4,
  )
  addTemporalScoreObject(
    'T-TOTAL',
    temporalFlow?.components?.afterTotal?.scoreByTotal,
    1.35 *
      clamp(
        (Number(temporalFlow?.components?.afterTotal?.support || 0) || 0) / 14,
        0.2,
        1.1,
      ),
    3,
  )
  addTemporalScoreObject(
    'T-RSTREAK',
    temporalFlow?.components?.resultStreak?.scoreByTotal,
    1.9 *
      clamp(
        (Number(temporalFlow?.components?.resultStreak?.support || 0) || 0) / 16,
        0.2,
        1.25,
      ),
    4,
  )
  addTemporalScoreObject(
    'T-GSTREAK',
    temporalFlow?.components?.regimeStreak?.scoreByTotal,
    1.35 *
      clamp(
        (Number(temporalFlow?.components?.regimeStreak?.support || 0) || 0) / 16,
        0.18,
        1.15,
      ),
    4,
  )

  comboInsights.topTotals.forEach((item, index) => {
    const total = Number(item.total)
    if (!Number.isFinite(total)) return
    rawTotalScores.set(
      total,
      (rawTotalScores.get(total) || 0) +
        item.probability * Math.max(0.22, 0.46 - index * 0.06),
    )
    const votes = totalVotes.get(total) || []
    votes.push('H-COMBO')
    totalVotes.set(total, votes)
  })

  totalInsights.topTotals.forEach((item, index) => {
    const total = Number(item.total)
    if (!Number.isFinite(total)) return
    rawTotalScores.set(
      total,
      (rawTotalScores.get(total) || 0) +
        item.probability * Math.max(0.18, 0.38 - index * 0.05),
    )
    const votes = totalVotes.get(total) || []
    votes.push('H-TOTAL')
    totalVotes.set(total, votes)
  })

  resultInsights.topTotals.forEach((item, index) => {
    const total = Number(item.total)
    if (!Number.isFinite(total)) return
    rawTotalScores.set(
      total,
      (rawTotalScores.get(total) || 0) +
        item.probability * Math.max(0.14, 0.3 - index * 0.04),
    )
    const votes = totalVotes.get(total) || []
    votes.push('H-RESULT')
    totalVotes.set(total, votes)
  })

  const rawTopTotals = [...rawTotalScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([total]) => Number(total))
  const adaptive = buildAdaptiveMemorySignals(history, rawTopTotals)
  const clusterMemory = buildClusterHitRateMemory(history, rawTopTotals)

  if (adaptive.shouldConsiderDraw) {
    resultScores.set('Draw', (resultScores.get('Draw') || 0) + 0.12)
    regimeScores.set('center', (regimeScores.get('center') || 0) + 0.16)
  }
  resultScores.set(
    'Draw',
    (resultScores.get('Draw') || 0) + adaptive.drawCenterMissWeight * 0.22,
  )
  if (
    clusterMemory.currentRegimeSeen >= 3 &&
    clusterMemory.currentRegimeHitRate != null
  ) {
    regimeScores.set(
      clusterMemory.currentRegime,
      (regimeScores.get(clusterMemory.currentRegime) || 0) +
        clusterMemory.currentRegimeHitRate * 0.18,
    )
  }

  const regimeList = [...regimeScores.entries()]
    .map(([regime, score]) => ({
      regime,
      label: regimeLabel(regime),
      score,
    }))
    .sort((a, b) => b.score - a.score)
  const regimeConsensus = regimeList[0]?.regime || 'center'

  const totalScores = new Map()
  regimeBaseTotals(regimeConsensus).forEach((total, index) => {
    totalScores.set(total, 0.22 - index * 0.018)
  })

  for (const [total, score] of rawTotalScores.entries()) {
    const regime = totalRegime(total)
    const multiplier =
      regime === regimeConsensus
        ? 1.28
        : regimeConsensus === 'center' && (total === 9 || total === 12)
          ? 0.94
          : 0.42
    totalScores.set(total, (totalScores.get(total) || 0) + score * multiplier)
  }

  if (adaptive.repeatPenalty > 0) {
    rawTopTotals.forEach((total) => {
      totalScores.set(
        total,
        (totalScores.get(total) || 0) * (1 - adaptive.repeatPenalty),
      )
    })
  }
  if (clusterMemory.clusterPenalty > 0) {
    rawTopTotals.forEach((total) => {
      totalScores.set(
        total,
        (totalScores.get(total) || 0) * (1 - clusterMemory.clusterPenalty),
      )
    })
  }

  if (comboInsights.support >= 25) {
    comboInsights.topTotals.slice(0, 4).forEach((item, index) => {
      totalScores.set(
        item.total,
        (totalScores.get(item.total) || 0) +
          item.probability * Math.max(0.18, 0.34 - index * 0.04),
      )
    })
  }

  if (totalInsights.support >= 30) {
    totalInsights.topTotals.slice(0, 4).forEach((item, index) => {
      totalScores.set(
        item.total,
        (totalScores.get(item.total) || 0) +
          item.probability * Math.max(0.14, 0.28 - index * 0.035),
      )
    })
  }

  if (resultInsights.support >= 40) {
    resultInsights.topTotals.slice(0, 4).forEach((item, index) => {
      totalScores.set(
        item.total,
        (totalScores.get(item.total) || 0) +
          item.probability * Math.max(0.12, 0.24 - index * 0.03),
      )
    })
  }

  for (const [total, weight] of adaptive.missTotalWeights.entries()) {
    const regime = totalRegime(total)
    totalScores.set(
      total,
      (totalScores.get(total) || 0) +
        weight * (regime === regimeConsensus ? 0.11 : 0.03),
    )
  }

  const latestResultAnchor = temporalFlow?.summary?.anchors?.latestResult || null

  if (regimeConsensus === 'center') {
    if (latestResultAnchor === 'Draw') {
      totalScores.set(
        8,
        (totalScores.get(8) || 0) + adaptive.drawCenterMissWeight * 0.15,
      )
      totalScores.set(
        9,
        (totalScores.get(9) || 0) + adaptive.drawCenterMissWeight * 0.12,
      )
      totalScores.set(
        12,
        (totalScores.get(12) || 0) + adaptive.drawCenterMissWeight * 0.12,
      )
      totalScores.set(
        13,
        (totalScores.get(13) || 0) + adaptive.drawCenterMissWeight * 0.15,
      )
    } else {
      totalScores.set(
        10,
        (totalScores.get(10) || 0) + adaptive.drawCenterMissWeight * 0.18,
      )
      totalScores.set(
        11,
        (totalScores.get(11) || 0) + adaptive.drawCenterMissWeight * 0.18,
      )
      totalScores.set(
        9,
        (totalScores.get(9) || 0) + adaptive.drawCenterMissWeight * 0.08,
      )
      totalScores.set(
        12,
        (totalScores.get(12) || 0) + adaptive.drawCenterMissWeight * 0.08,
      )
    }
  }

  ;(temporalFlow?.components?.resultStreak?.topTotals || [])
    .slice(0, 4)
    .forEach((item, index) => {
      totalScores.set(
        Number(item.total),
        (totalScores.get(Number(item.total)) || 0) +
          Number(item.probability || 0) *
            Math.max(0.16, 0.34 - index * 0.04),
      )
    })

  ;(temporalFlow?.components?.regimeStreak?.topTotals || [])
    .slice(0, 4)
    .forEach((item, index) => {
      totalScores.set(
        Number(item.total),
        (totalScores.get(Number(item.total)) || 0) +
          Number(item.probability || 0) *
            Math.max(0.12, 0.24 - index * 0.03),
      )
    })

  const resultStreak = temporalFlow?.summary?.resultStreak || null
  if (
    resultStreak?.key === 'Draw' &&
    Number(resultStreak?.length || 0) >= 1
  ) {
    const streakPenalty =
      Number(resultStreak.length || 0) >= 2 ? 0.24 : 0.17
    const currentScore = Number(resultScores.get('Draw') || 0)
    resultScores.set('Draw', currentScore * (1 - streakPenalty))
    resultScores.set(
      'Small',
      (resultScores.get('Small') || 0) + currentScore * streakPenalty * 0.52,
    )
    resultScores.set(
      'Big',
      (resultScores.get('Big') || 0) + currentScore * streakPenalty * 0.48,
    )
  } else if (resultStreak?.key && Number(resultStreak?.length || 0) >= 2) {
    const streakPenalty =
      Number(resultStreak.length || 0) >= 3 ? 0.14 : 0.09
    const currentScore = Number(resultScores.get(resultStreak.key) || 0)
    resultScores.set(resultStreak.key, currentScore * (1 - streakPenalty))
    const alternatives = ['Small', 'Draw', 'Big'].filter(
      (result) => result !== resultStreak.key,
    )
    resultScores.set(
      alternatives[0],
      (resultScores.get(alternatives[0]) || 0) + currentScore * streakPenalty * 0.56,
    )
    resultScores.set(
      alternatives[1],
      (resultScores.get(alternatives[1]) || 0) + currentScore * streakPenalty * 0.44,
    )
  }

  ;(temporalFlow?.topTotals || []).slice(0, 4).forEach((item, index) => {
    const total = Number(item?.total)
    if (!Number.isFinite(total)) return
    totalScores.set(
      total,
      (totalScores.get(total) || 0) +
        Number(item?.probability || 0) * Math.max(0.22, 0.42 - index * 0.05),
    )
  })

  if (Number(temporalFlow?.components?.day?.support || 0) >= 10) {
    ;(temporalFlow?.components?.day?.topTotals || [])
      .slice(0, 3)
      .forEach((item, index) => {
        totalScores.set(
          Number(item.total),
          (totalScores.get(Number(item.total)) || 0) +
            Number(item.probability || 0) *
              Math.max(0.14, 0.26 - index * 0.035),
        )
      })
  }

  if (Number(temporalFlow?.components?.afterResult?.support || 0) >= 14) {
    ;(temporalFlow?.components?.afterResult?.topTotals || [])
      .slice(0, 3)
      .forEach((item, index) => {
        totalScores.set(
          Number(item.total),
          (totalScores.get(Number(item.total)) || 0) +
            Number(item.probability || 0) * Math.max(0.14, 0.28 - index * 0.04),
        )
      })
  }

  applyConsensusRecoveryBias(totalScores, roundsDesc, temporalFlow)

  const resultList = [...resultScores.entries()]
    .map(([result, score]) => ({ result, score }))
    .sort((a, b) => b.score - a.score)
  const resultSum = resultList.reduce((acc, item) => acc + item.score, 0) || 1
  resultList.forEach((item) => {
    item.probability = item.score / resultSum
  })

  const totalSum =
    [...totalScores.values()].reduce((acc, value) => acc + value, 0) || 1
  const totalList = [...totalScores.entries()]
    .map(([total, score]) => ({
      total,
      score,
      normalized: score / totalSum,
      votes: totalVotes.get(total) || [],
      result: classifyTotal(total),
      regime: totalRegime(total),
    }))
    .sort((a, b) => b.score - a.score)

  const drawProbability =
    resultList.find((item) => item.result === 'Draw')?.probability || 0
  const drawCluster = totalList
    .filter(
      (item) =>
        item.total === 10 ||
        item.total === 11 ||
        item.total === 9 ||
        item.total === 12,
    )
    .slice(0, 4)
  const drawConsideration =
    adaptive.shouldConsiderDraw || drawProbability >= 0.3
      ? 'Nen can nhac Hoa khi regime trung tam dang chiem uu the va cum 10/11 dang sang.'
      : 'Hien Big/Small van manh hon, nhung cum 10/11 can duoc theo doi rieng.'

  return {
    models,
    resultList,
    regimeList,
    regimeConsensus,
    topTotals: totalList,
    resultConsensus: resultList[0]?.result || '--',
    topTotal: totalList[0]?.total ?? null,
    drawProbability,
    drawCluster,
    drawConsideration,
    comboInsights,
    totalInsights,
    resultInsights,
    temporalFlow,
    clusterMemory,
    adaptiveSignals: adaptive,
  }
}

async function buildConsensusV16AIPayload(
  roundsDesc,
  predictorFns,
  options = {},
) {
  const {
    buildPrediction,
    buildPredictionFromBase,
    buildPredictionV3,
    buildPredictionV4,
    buildPredictionV5,
    buildPredictionV6,
    buildPredictionV7,
    buildPredictionV8,
    buildPredictionV9,
  } = predictorFns
  const includeBacktest = options.includeBacktest !== false

  const {
    v1: currentV1,
    v2: currentV2,
    v3: currentV3,
    v4: currentV4,
    v5: currentV5,
    v6: currentV6,
    v7: currentV7,
    v8: currentV8,
    v9: currentV9,
  } = buildAdaptedPredictorOutputs(predictorFns, roundsDesc)

  const current = ensureConsensusFollowUpCombos(
    buildConsensusSnapshotFromPredictionsV2(
      {
        v1: currentV1,
        v2: currentV2,
        v3: currentV3,
        v4: currentV4,
        v5: currentV5,
        v6: currentV6,
        v7: currentV7,
        v8: currentV8,
        v9: currentV9,
      },
      roundsDesc,
    ),
    roundsDesc,
  )
  current.followUpCombos = buildFollowUpComboInsights(roundsDesc)

  if (!includeBacktest) {
    return {
      current,
      backtest: {
        sampleSize: 0,
        totalHitRate: 0,
        recentTotalChecks: [],
        pending: true,
      },
    }
  }

  const maxEval = Math.max(0, roundsDesc.length - 900)
  const evalRounds = Math.min(50, maxEval)
  const trainWindow = 2200
  const recentTotalChecks = []
  let totalHits = 0

  for (let offset = evalRounds; offset >= 1; offset -= 1) {
    const actualRound = roundsDesc[offset - 1]
    const trainRounds = roundsDesc.slice(offset, offset + trainWindow)
    if (!actualRound || trainRounds.length < 900) continue

    const { v1, v2, v3, v4, v5, v6, v7, v8, v9 } =
      buildAdaptedPredictorOutputs(predictorFns, trainRounds)
    const snapshot = buildConsensusSnapshotFromPredictionsV2(
      {
        v1,
        v2,
        v3,
        v4,
        v5,
        v6,
        v7,
        v8,
        v9,
      },
      trainRounds,
    )
    const predictedTotals = snapshot.topTotals
      .slice(0, 3)
      .map((item) => Number(item.total))
    const hit = predictedTotals.includes(Number(actualRound.total))
    if (hit) totalHits += 1

    recentTotalChecks.push({
      id: actualRound.id,
      predictedTotals,
      actualTotal: Number(actualRound.total),
      actualResult: actualRound.result,
      hit,
      leadTotal: snapshot.topTotals[0]?.total ?? null,
      leadProbability: snapshot.topTotals[0]
        ? Number((snapshot.topTotals[0].normalized * 100).toFixed(2))
        : 0,
    })
  }

  return {
    current,
    backtest: {
      sampleSize: recentTotalChecks.length,
      totalHitRate: recentTotalChecks.length
        ? totalHits / recentTotalChecks.length
        : 0,
      recentTotalChecks: recentTotalChecks.reverse(),
    },
  }
}

async function ensureConsensusV16AICache(forceRefresh = false) {
  if (consensusV16AICache && !forceRefresh) return consensusV16AICache

  const current = buildConsensusSnapshotFromCaches()
  if (!current) {
    scheduleCacheBuild(50)
    throw new Error('Base prediction caches are not ready yet.')
  }

  consensusV16AIBuildState = 'ready'
  const nextRoundId = nextRoundIdFromStore()
  const latestRoundId = String(readData()?.rounds?.[0]?.id || '')
  const memory = readConsensusV16AIMemory()
  const memoryIsFresh =
    memory.sampleSize > 0 &&
    memory.latestRoundId &&
    latestRoundId &&
    String(memory.latestRoundId) === latestRoundId
  consensusV16AIBacktestState = memoryIsFresh ? 'ready' : 'idle'
  consensusV16AICache = {
    current: {
      ...current,
      nextRoundId,
    },
    backtest: {
      ...memory,
      pending: !memoryIsFresh || consensusV16AIBacktestState === 'building',
    },
  }
  scheduleConsensusV16AIBacktestBuild()
  return consensusV16AICache
}

function scheduleConsensusV16AIBacktestBuild() {
  if (
    consensusV16AIReplayTimer ||
    consensusV16AIBacktestState === 'building' ||
    consensusV16AIWorker
  ) {
    return
  }

  const runWhenReady = async () => {
    consensusV16AIReplayTimer = null

    if (cacheBuildState !== 'ready') {
      scheduleConsensusV16AIBacktestBuild()
      return
    }

    consensusV16AIBacktestState = 'building'
    consensusV16AIBacktestPromise = new Promise((resolve) => {
      const workerPath = path.join(__dirname, 'consensus_v16_ai_worker.js')
      const worker = fork(workerPath, {
        cwd: __dirname,
        env: {
          ...process.env,
          DATA_FILE,
          CONSENSUS_V16_AI_MEMORY_FILE,
        },
        silent: true,
      })
      consensusV16AIWorker = worker

      const cleanup = () => {
        consensusV16AIWorker = null
        consensusV16AIBacktestPromise = null
      }

      worker.on('message', (message) => {
        if (!message?.ok) return
        const backtest = readConsensusV16AIMemory()
        if (consensusV16AICache) {
          consensusV16AICache = {
            ...consensusV16AICache,
            backtest: {
              ...backtest,
              pending: false,
            },
          }
        }
        consensusV16AIBacktestState = 'ready'
        resolve(backtest)
      })

      worker.stderr?.on('data', (chunk) => {
        const message = String(chunk || '').trim()
        if (message) console.error('[consensus-v16-ai worker]', message)
      })

      worker.on('error', (error) => {
        startupError = error
        consensusV16AIBacktestState = 'error'
        console.error('[consensus-v16-ai] recent replay failed:', error.message)
        cleanup()
        resolve(null)
      })

      worker.on('exit', (code) => {
        if (code !== 0 && consensusV16AIBacktestState !== 'ready') {
          const error = new Error(`consensus worker exited with code ${code}`)
          startupError = error
          consensusV16AIBacktestState = 'error'
          console.error(
            '[consensus-v16-ai] recent replay failed:',
            error.message,
          )
          resolve(null)
        }
        cleanup()
      })
    })
  }

  consensusV16AIReplayTimer = setTimeout(runWhenReady, 12000)
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
  await safeRefreshPredictionCache({
    rounds: mapped,
    updatedAt: new Date().toISOString(),
  })

  console.log(`[sync] synced ${mapped.length} rounds`)
}

function scheduleFullSync(reason = 'manual', delayMs = 1500) {
  if (fullSyncState === 'building' || fullSyncPromise) return
  fullSyncState = 'scheduled'

  setTimeout(() => {
    if (fullSyncState === 'building' || fullSyncPromise) return
    fullSyncState = 'building'
    fullSyncPromise = syncAllRoundsFromSource()
      .then(() => {
        startupError = null
        fullSyncState = 'ready'
        broadcastReload()
        console.log(`[sync] background full sync complete (${reason})`)
      })
      .catch((error) => {
        startupError = error
        fullSyncState = 'error'
        console.error(
          `[sync] background full sync failed (${reason}):`,
          error.message,
        )
      })
      .finally(() => {
        fullSyncPromise = null
      })
  }, delayMs)
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
    const currentLatestId = String(store?.rounds?.[0]?.id || '')
    const latestNumeric = Number(latest?.id)
    const currentLatestNumeric = Number(currentLatestId)

    if (
      BACKFILL_ON_GAP &&
      Number.isFinite(latestNumeric) &&
      Number.isFinite(currentLatestNumeric) &&
      latestNumeric - currentLatestNumeric > 1
    ) {
      scheduleFullSync(`gap:${currentLatestId}->${latest.id}`, 400)
    }

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
        invalidatePredictionCaches({ preserveConsensus: true })
        scheduleCacheBuild(predictionCache ? 1200 : 250, store)
        console.log('[crawler] refreshed existing round:', latest.id)
      } else {
        console.log('[crawler] no new round')
      }
      return
    }

    appendConsensusRecentCheck(latest)
    resolveV9MemoryForRound(latest)
    resolveLocalAIMemoryForRound(latest)
    store.rounds.unshift(latest)
    store.updatedAt = new Date().toISOString()

    writeData(store)
    backfillLocalAIMemory(store)
    invalidatePredictionCaches({
      preserveConsensus: true,
      nextRoundId: nextRoundIdFromStore(store),
    })
    scheduleCacheBuild(predictionCache ? 1200 : 250, store)

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

app.get('/selective-v3', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selective-v3.html'))
})

app.get('/selective-v4', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selective-v4.html'))
})

app.get('/selective-v5', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selective-v5.html'))
})

app.get('/selective-v6', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selective-v6.html'))
})

app.get('/selective-v6-ai', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selective-v6-ai.html'))
})

app.get('/selective-v9', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'selective-v9.html'))
})

app.get('/consensus-v15', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'consensus-v15.html'))
})

app.get('/consensus-v16', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'consensus-v16.html'))
})

app.get('/consensus-v16-ai', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'consensus-v16-ai.html'))
})

app.get('/openai-judge', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'openai-judge.html'))
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
    cacheBuildState,
    startupError: startupError ? startupError.message : null,
    updatedAt: store.updatedAt,
    totalRounds: Array.isArray(store.rounds) ? store.rounds.length : 0,
  })
})

app.get('/predict', (req, res) => {
  if (!predictionCache) {
    scheduleCacheBuild(50)
  }
  if (!predictionCache) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(predictionCache)
})

app.get('/predict-v2', (req, res) => {
  if (!predictionCache || !predictionCacheV2) {
    scheduleCacheBuild(50)
  }
  if (!predictionCacheV2) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V2 cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(predictionCacheV2)
})

app.get('/predict-v3', (req, res) => {
  if (!predictionCacheV3) {
    scheduleCacheBuild(50)
  }
  if (!predictionCacheV3) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V3 cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(predictionCacheV3)
})

app.get('/predict-v4', (req, res) => {
  if (!predictionCacheV4) {
    scheduleCacheBuild(50)
  }
  if (!predictionCacheV4) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V4 cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(predictionCacheV4)
})

app.get('/predict-v5', (req, res) => {
  if (!predictionCacheV5) {
    scheduleCacheBuild(50)
  }
  if (!predictionCacheV5) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V5 cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(predictionCacheV5)
})

app.get('/predict-v6', (req, res) => {
  if (!predictionCacheV6) {
    scheduleCacheBuild(50)
  }
  if (!predictionCacheV6) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V6 cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(predictionCacheV6)
})

app.get('/predict-v7', (req, res) => {
  if (!predictionCacheV7) {
    scheduleCacheBuild(50)
  }
  if (!predictionCacheV7) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V7 cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(predictionCacheV7)
})

app.get('/predict-v8', (req, res) => {
  if (!predictionCacheV8) {
    scheduleCacheBuild(50)
  }
  if (!predictionCacheV8) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V8 cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(predictionCacheV8)
})

app.get('/predict-v9', (req, res) => {
  if (!predictionCacheV9) {
    scheduleCacheBuild(50)
  }
  if (!predictionCacheV9) {
    return res.status(503).json({
      ok: false,
      message: 'Prediction V9 cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }
  if (cacheIsStale) {
    scheduleCacheBuild(25)
  }
  res.json(buildLiveV9Payload(predictionCacheV9))
})

app.get('/predict-v6-ai', (req, res) => {
  if (!predictionCacheV6) {
    scheduleCacheBuild(50)
    return res.status(503).json({
      ok: false,
      message: 'Prediction V6 restored cache is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      error: startupError ? startupError.message : null,
    })
  }

  return res.json(buildRestoredV6AIPayload(predictionCacheV6))
})

app.get('/predict-consensus-v16-ai', async (req, res) => {
  try {
    const payload = await ensureConsensusV16AICache()
    return res.json(payload)
  } catch (error) {
    if (consensusV16AIBuildState !== 'building') {
      ensureConsensusV16AICache().catch((buildError) => {
        if (buildError?.message === 'Base prediction caches are not ready yet.')
          return
        startupError = buildError
        console.error('[consensus-v16-ai] build failed:', buildError.message)
      })
    }

    return res.status(503).json({
      ok: false,
      message: 'Consensus V1-V6 AI is warming up. Retry shortly.',
      phase: startupPhase,
      cacheBuildState,
      consensusBuildState: consensusV16AIBuildState,
      consensusBacktestState: consensusV16AIBacktestState,
      error: error?.message || (startupError ? startupError.message : null),
    })
  }
})

app.get('/predict-openai-judge', async (req, res) => {
  updateLocalAIPendingPrediction(readData())
  res.json(readLocalAIFreeState())
})

app.get('/api/openai-v7/state', (req, res) => {
  updateLocalAIPendingPrediction(readData())
  res.json(readLocalAIFreeState())
})

app.post('/api/openai-v7/start', (req, res) => {
  res.status(410).json({
    ok: false,
    message:
      'AI local/free khong can bat dau train tra phi. Trang nay chi doc predictor noi bo.',
  })
})

app.post('/api/openai-v7/sync', (req, res) => {
  res.status(410).json({
    ok: false,
    message: 'AI local/free khong co job OpenAI de dong bo.',
  })
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
    const existingSnapshots = readPredictionSnapshots()
    if (existingSnapshots) {
      hydrateCachesFromSnapshots(existingSnapshots)
      cacheBuildState = 'ready'
      cacheIsStale = false
    }

    const initialStore = readData()
    const normalizedStore = backfillMissingRoundFields(initialStore)
    if (JSON.stringify(normalizedStore) !== JSON.stringify(initialStore)) {
      writeData(normalizedStore)
    }

    if (FULL_SYNC_ON_STARTUP) {
      startupPhase = 'syncing_source'
      await syncAllRoundsFromSource()
      scheduleCacheBuild(250, readData())
    }
  } catch (err) {
    startupError = err
    console.error('[startup] bootstrap failed:', err.message)
  }

  startupPhase = 'ready'
  ensureV9MemorySeeded()
  scheduleLocalAIBackfill(600)
  scheduleCacheBuild(50, readData())
  scheduleConsensusV16AIBacktestBuild()

  if (ENABLE_POLLING && !pollTimer) {
    pollTimer = setInterval(pollLatestRound, POLL_INTERVAL_MS)
  }
  if (FULL_SYNC_INTERVAL_MS > 0 && !fullSyncTimer) {
    fullSyncTimer = setInterval(() => {
      scheduleFullSync('interval', 250)
    }, FULL_SYNC_INTERVAL_MS)
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`)
  console.log(
    `[startup] bootstrapDelay=${BOOTSTRAP_DELAY_MS}ms polling=${ENABLE_POLLING ? `on/${POLL_INTERVAL_MS}ms` : 'off'} fullSync=${FULL_SYNC_ON_STARTUP} gapBackfill=${BACKFILL_ON_GAP} intervalSync=${FULL_SYNC_INTERVAL_MS}`,
  )
  setTimeout(() => {
    bootstrapServer().catch((err) => {
      startupError = err
      startupPhase = 'ready'
      console.error('[startup] bootstrap crashed:', err.message)
    })
  }, BOOTSTRAP_DELAY_MS)
})
