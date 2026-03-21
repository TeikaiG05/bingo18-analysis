import express from 'express'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { fork } from 'child_process'
import { WebSocketServer } from 'ws'

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

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3000)
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : __dirname
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, 'data.json')
const PREDICTION_SNAPSHOTS_FILE = path.join(DATA_DIR, 'prediction-snapshots.json')
const CONSENSUS_V16_AI_MEMORY_FILE = path.join(DATA_DIR, 'consensus-v16-ai-memory.json')
const SOURCE_URL = 'https://18.xidnas.site/data/json'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 6000)
const BOOTSTRAP_DELAY_MS = Number(process.env.BOOTSTRAP_DELAY_MS || 50)
const FULL_SYNC_ON_STARTUP =
  String(process.env.FULL_SYNC_ON_STARTUP || 'false').toLowerCase() === 'true'
const ENABLE_POLLING =
  String(process.env.ENABLE_POLLING || 'true').toLowerCase() === 'true'
let predictionCache = null
let predictionCacheV2 = null
let predictionCacheV3 = null
let predictionCacheV4 = null
let predictionCacheV5 = null
let predictionCacheV6 = null
let consensusV16AICache = null
let consensusV16AIBuildState = 'idle'
let consensusV16AIBuildPromise = null
let consensusV16AIBacktestState = 'idle'
let consensusV16AIBacktestPromise = null
let consensusV16AIReplayTimer = null
let consensusV16AIWorker = null
let snapshotBuildWorker = null
let startupPhase = 'booting'
let startupError = null
let pollTimer = null
let cacheBuildState = 'idle'
let cacheBuildTimer = null
let predictorFnsPromise = null
let cacheIsStale = false

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
  consensusV16AICache = null
  consensusV16AIBuildState = 'idle'
  return Boolean(
    predictionCache &&
      predictionCacheV2 &&
      predictionCacheV3 &&
      predictionCacheV4 &&
      predictionCacheV5 &&
      predictionCacheV6,
  )
}

function readConsensusV16AIMemory() {
  try {
    const raw = fs.readFileSync(CONSENSUS_V16_AI_MEMORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      createdAt: parsed?.createdAt ?? null,
      latestRoundId: parsed?.latestRoundId != null ? String(parsed.latestRoundId) : null,
      sampleSize: Number(parsed?.sampleSize || 0),
      totalHitRate: Number(parsed?.totalHitRate || 0),
      recentTotalChecks: Array.isArray(parsed?.recentTotalChecks) ? parsed.recentTotalChecks : [],
    }
  } catch {
    return {
      createdAt: null,
      latestRoundId: null,
      sampleSize: 0,
      totalHitRate: 0,
      recentTotalChecks: [],
    }
  }
}

function writeConsensusV16AIMemory(data) {
  fs.writeFileSync(CONSENSUS_V16_AI_MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8')
}

function nextRoundIdFromStore(store = readData()) {
  const latestId = String(store?.rounds?.[0]?.id || '').trim()
  if (!latestId) return null
  const numeric = Number(latestId)
  if (!Number.isFinite(numeric)) return null
  return String(numeric + 1).padStart(latestId.length, '0')
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

async function loadPredictorFns() {
  if (!predictorFnsPromise) {
    predictorFnsPromise = Promise.all([
      import('./predictor.js'),
      import('./predictor_v2.js'),
      import('./predictor_v3.js'),
      import('./predictor_v4.js'),
      import('./predictor_v5.js'),
      import('./predictor_v6.js'),
    ]).then(([predictorModule, predictorV2Module, predictorV3Module, predictorV4Module, predictorV5Module, predictorV6Module]) => ({
      buildPrediction: predictorModule.buildPrediction,
      buildPredictionFromBase: predictorV2Module.buildPredictionFromBase,
      buildPredictionV3: predictorV3Module.buildPrediction,
      buildPredictionV4: predictorV4Module.buildPrediction,
      buildPredictionV5: predictorV5Module.buildPrediction,
      buildPredictionV6: predictorV6Module.buildPrediction,
    }))
  }

  return predictorFnsPromise
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
        settleReject(new Error('Snapshot bundle was created but could not hydrate caches.'))
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
    scheduleConsensusV16AIBacktestBuild()
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

function invalidatePredictionCaches() {
  cacheIsStale = true
  consensusV16AICache = null
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
  if (typeof current.summary === 'string' && current.summary.trim()) return current.summary
  if (
    recommendations &&
    typeof recommendations === 'object' &&
    typeof recommendations.recommendationText === 'string' &&
    recommendations.recommendationText.trim()
  ) {
    return recommendations.recommendationText
  }
  if (Array.isArray(recommendations) && typeof recommendations[0] === 'string') {
    return recommendations[0]
  }
  if (typeof diagnosis.primaryMethod === 'string' && diagnosis.primaryMethod.trim()) {
    return diagnosis.primaryMethod
  }
  if (Array.isArray(diagnosis.methodNotes) && typeof diagnosis.methodNotes[0] === 'string') {
    return diagnosis.methodNotes[0]
  }
  if (typeof current.rationale === 'string' && current.rationale.trim()) return current.rationale
  return '--'
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
    note:
      'V6 AI dang duoc khoi phuc ve mode on dinh. Tam thoi su dung loi V6 de dam bao toc do va do on dinh cua he thong.',
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
    !predictionCacheV6
  ) {
    return null
  }

  return buildConsensusSnapshotFromPredictions({
    v1: predictionCache,
    v2: predictionCacheV2,
    v3: predictionCacheV3,
    v4: predictionCacheV4,
    v5: predictionCacheV5,
    v6: predictionCacheV6,
  })
}

async function buildConsensusV16AIRecentMemory() {
  const predictorFns = await loadPredictorFns()
  const roundsDesc = normalizeStoredRounds(readData()).rounds
  const maxEval = Math.max(0, roundsDesc.length - 900)
  const evalRounds = Math.min(7, maxEval)
  const trainWindow = 1800
  const recentTotalChecks = []
  let totalHits = 0

  for (let offset = evalRounds; offset >= 1; offset -= 1) {
    const actualRound = roundsDesc[offset - 1]
    const trainRounds = roundsDesc.slice(offset, offset + trainWindow)
    if (!actualRound || trainRounds.length < 900) continue

    const v1 = predictorFns.buildPrediction(trainRounds)
    const v2 = predictorFns.buildPredictionFromBase(v1)
    const v3 = predictorFns.buildPredictionV3(trainRounds)
    const v4 = predictorFns.buildPredictionV4(trainRounds)
    const v5 = predictorFns.buildPredictionV5(trainRounds)
    const v6 = predictorFns.buildPredictionV6(trainRounds)
    const snapshot = buildConsensusSnapshotFromPredictions({ v1, v2, v3, v4, v5, v6 })
    const predictedTotals = snapshot.topTotals.slice(0, 3).map((item) => Number(item.total))
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

  const payload = {
    createdAt: new Date().toISOString(),
    sampleSize: recentTotalChecks.length,
    totalHitRate: recentTotalChecks.length ? totalHits / recentTotalChecks.length : 0,
    recentTotalChecks: recentTotalChecks.reverse(),
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
  }
  const models = [
    { name: 'V1', payload: predictions.v1 },
    { name: 'V2', payload: predictions.v2 },
    { name: 'V3', payload: predictions.v3 },
    { name: 'V4', payload: predictions.v4 },
    { name: 'V5', payload: predictions.v5 },
    { name: 'V6', payload: predictions.v6 },
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
      const bonus = model.name === 'V6' ? 1.3 : 1
      resultScores.set(
        model.result,
        (resultScores.get(model.result) || 0) + Math.max(0.01, model.topProbability) * bonus,
      )
    }
    model.totals.slice(0, 4).forEach((item, index) => {
      const total = Number(item.total)
      if (!Number.isFinite(total)) return
      const score =
        normalizeUnitProbability(item.probability, 0.08) *
        Math.max(0.3, 1 - index * 0.18) *
        (model.name === 'V6' ? 1.22 : 1)
      totalScores.set(total, (totalScores.get(total) || 0) + score)
      const votes = totalVotes.get(total) || []
      votes.push(model.name)
      totalVotes.set(total, votes)
    })
  }

  const resultList = [...resultScores.entries()]
    .map(([result, score]) => ({ result, score }))
    .sort((a, b) => b.score - a.score)
  const resultSum = resultList.reduce((acc, item) => acc + item.score, 0) || 1
  resultList.forEach((item) => {
    item.probability = item.score / resultSum
  })

  const totalSum = [...totalScores.values()].reduce((acc, value) => acc + value, 0) || 1
  const totalList = [...totalScores.entries()]
    .map(([total, score]) => ({
      total,
      score,
      normalized: score / totalSum,
      votes: totalVotes.get(total) || [],
    }))
    .sort((a, b) => b.score - a.score)

  return {
    models,
    resultList,
    topTotals: totalList,
    resultConsensus: resultList[0]?.result || '--',
    topTotal: totalList[0]?.total ?? null,
  }
}

async function buildConsensusV16AIPayload(roundsDesc, predictorFns, options = {}) {
  const {
    buildPrediction,
    buildPredictionFromBase,
    buildPredictionV3,
    buildPredictionV4,
    buildPredictionV5,
    buildPredictionV6,
  } = predictorFns
  const includeBacktest = options.includeBacktest !== false

  const currentV1 = buildPrediction(roundsDesc)
  const currentV2 = buildPredictionFromBase(currentV1)
  const currentV3 = buildPredictionV3(roundsDesc)
  const currentV4 = buildPredictionV4(roundsDesc)
  const currentV5 = buildPredictionV5(roundsDesc)
  const currentV6 = buildPredictionV6(roundsDesc)

  const current = buildConsensusSnapshotFromPredictions({
    v1: currentV1,
    v2: currentV2,
    v3: currentV3,
    v4: currentV4,
    v5: currentV5,
    v6: currentV6,
  })

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

    const v1 = buildPrediction(trainRounds)
    const v2 = buildPredictionFromBase(v1)
    const v3 = buildPredictionV3(trainRounds)
    const v4 = buildPredictionV4(trainRounds)
    const v5 = buildPredictionV5(trainRounds)
    const v6 = buildPredictionV6(trainRounds)
    const snapshot = buildConsensusSnapshotFromPredictions({ v1, v2, v3, v4, v5, v6 })
    const predictedTotals = snapshot.topTotals.slice(0, 3).map((item) => Number(item.total))
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
      totalHitRate: recentTotalChecks.length ? totalHits / recentTotalChecks.length : 0,
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
          console.error('[consensus-v16-ai] recent replay failed:', error.message)
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
        invalidatePredictionCaches()
        scheduleCacheBuild(predictionCache ? 1200 : 250, store)
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
    invalidatePredictionCaches()
    scheduleCacheBuild(predictionCache ? 1200 : 250, store)
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
  res.status(410).json({
    ok: false,
    message: 'OpenAI judge has been disabled for local stability testing.',
  })
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
        if (buildError?.message === 'Base prediction caches are not ready yet.') return
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
  res.status(410).json({
    ok: false,
    message: 'OpenAI judge has been disabled for local stability testing.',
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
  scheduleCacheBuild(50, readData())
  scheduleConsensusV16AIBacktestBuild()

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
