import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  adaptTopTotalRecords,
  buildAdaptiveResultProbabilities,
} from './prediction_postprocessor.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data.json')
const LOCAL_AI_MEMORY_FILE = process.env.LOCAL_AI_MEMORY_FILE
  ? path.resolve(process.env.LOCAL_AI_MEMORY_FILE)
  : path.join(__dirname, 'local-ai-memory.json')
const BACKFILL_SIZE = Math.max(50, Number(process.env.LOCAL_AI_MEMORY_BACKFILL_TARGET || 220))
const MIN_TRAIN_ROUNDS = Math.max(120, Number(process.env.LOCAL_AI_MEMORY_MIN_TRAIN_ROUNDS || 180))
const TRAIN_WINDOW = Math.max(MIN_TRAIN_ROUNDS, Number(process.env.LOCAL_AI_MEMORY_TRAIN_WINDOW || 320))
const THEORY_TOTAL_WEIGHTS = {
  3: 1,
  4: 3,
  5: 6,
  6: 10,
  7: 15,
  8: 21,
  9: 25,
  10: 27,
  11: 27,
  12: 25,
  13: 21,
  14: 15,
  15: 10,
  16: 6,
  17: 3,
  18: 1,
}

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function isDateOnlyValue(value) {
  return typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value)
}

function extractId(round, time, dice) {
  return `${time}-${dice.join('')}-${Math.random().toString(36).slice(2, 8)}`
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

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.rounds) ? parsed.rounds : []
  } catch {
    return []
  }
}

function readLocalAIMemory() {
  try {
    const raw = fs.readFileSync(LOCAL_AI_MEMORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      updatedAt: parsed?.updatedAt ?? null,
      pendingPrediction: parsed?.pendingPrediction ?? null,
      history: Array.isArray(parsed?.history) ? parsed.history : [],
    }
  } catch {
    return {
      updatedAt: null,
      pendingPrediction: null,
      history: [],
    }
  }
}

function buildRollingPrediction(trainRounds) {
  const resultScores = new Map([
    ['Small', 0],
    ['Draw', 0],
    ['Big', 0],
  ])
  const totalScores = new Map()

  for (let total = 3; total <= 18; total += 1) {
    totalScores.set(total, (THEORY_TOTAL_WEIGHTS[total] || 1) * 0.08)
  }

  const limitedRounds = trainRounds.slice(0, TRAIN_WINDOW)
  limitedRounds.forEach((round, index) => {
    const recencyWeight = 1.8 / (1 + index * 0.09)
    resultScores.set(round.result, (resultScores.get(round.result) || 0) + recencyWeight)
    totalScores.set(round.total, (totalScores.get(round.total) || 0) + recencyWeight)
  })

  const totalRecords = Array.from(totalScores.entries()).map(([total, score]) => ({
    total: Number(total),
    probability: Number(score || 0),
  }))
  const adaptiveResultProbabilities = buildAdaptiveResultProbabilities(
    totalRecords,
    trainRounds,
    { modelId: 'local' },
  )
  const resultConsensus =
    Object.entries(adaptiveResultProbabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    Array.from(resultScores.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ||
    'Draw'
  const rankedTotals = adaptTopTotalRecords(totalRecords, trainRounds, {
    limit: 16,
    modelId: 'local',
    sourceLabel: 'local-backfill',
  })
  const topTotals = [
    ...rankedTotals.filter((item) => classifyTotal(Number(item.total)) === resultConsensus),
    ...rankedTotals.filter((item) => classifyTotal(Number(item.total)) !== resultConsensus),
  ].slice(0, 6)

  return {
    resultConsensus,
    topTotals,
  }
}

function buildRecord(trainRounds, actualRound) {
  const consensus = buildRollingPrediction(trainRounds)
  const predictedScores = consensus.topTotals.slice(0, 3).map((item) => ({
    total: Number(item.total),
    probability: Number(item.probability || item.normalized || 0),
  }))
  const predictedTotals = predictedScores.map((item) => item.total)

  return {
    roundId: String(actualRound.id),
    predictedResult: consensus.resultConsensus,
    predictedTotals,
    predictedScores,
    actualTotal: Number(actualRound.total),
    actualResult: actualRound.result,
    hit: predictedTotals.includes(Number(actualRound.total)),
    resultHit: consensus.resultConsensus === actualRound.result,
    replayedPrediction: true,
    predictionSource: 'backfill-replay',
    createdAt: actualRound.processTime ?? actualRound.time ?? null,
    resolvedAt: actualRound.processTime ?? actualRound.time ?? null,
  }
}

function buildBackfillHistory() {
  const roundsDesc = readData().map(normalizeStoredRound).filter(Boolean)
  const history = []
  const maxOffset = Math.max(0, roundsDesc.length - MIN_TRAIN_ROUNDS - 1)

  for (let offset = 1; offset <= maxOffset && history.length < BACKFILL_SIZE; offset += 1) {
    const actualRound = roundsDesc[offset - 1]
    const trainRounds = roundsDesc.slice(offset, offset + TRAIN_WINDOW)
    if (!actualRound || trainRounds.length < MIN_TRAIN_ROUNDS) continue
    history.push(buildRecord(trainRounds, actualRound))
  }

  return history
}

try {
  const currentMemory = readLocalAIMemory()
  const currentHistory = Array.isArray(currentMemory.history) ? currentMemory.history : []
  const generated = buildBackfillHistory()
  const seenRoundIds = new Set()
  const merged = [
    ...currentHistory,
    ...generated.filter((item) => {
      const roundId = String(item?.roundId || '')
      const existing = currentHistory.find(
        (entry) => String(entry?.roundId || '') === roundId,
      )
      return !existing || existing?.missingPrediction === true
    }),
  ]
    .filter((item) => item && item.roundId && !seenRoundIds.has(String(item.roundId)) && seenRoundIds.add(String(item.roundId)))
    .slice(0, BACKFILL_SIZE)

  const payload = {
    updatedAt: new Date().toISOString(),
    pendingPrediction: currentMemory.pendingPrediction ?? null,
    history: merged,
  }

  fs.writeFileSync(LOCAL_AI_MEMORY_FILE, JSON.stringify(payload, null, 2), 'utf8')
  if (process.send) {
    process.send({
      ok: true,
      sampleSize: merged.length,
      generatedCount: generated.length,
    })
  }
  process.exit(0)
} catch (error) {
  if (process.send) process.send({ ok: false, error: error.message })
  process.exit(1)
}
