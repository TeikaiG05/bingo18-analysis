import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { buildPrediction as buildPredictionV1 } from './predictor.js'
import { buildPredictionFromBase } from './predictor_v2.js'
import { buildPrediction as buildPredictionV3 } from './predictor_v3.js'
import { buildPrediction as buildPredictionV4 } from './predictor_v4.js'
import { buildPrediction as buildPredictionV5 } from './predictor_v5.js'
import { buildPrediction as buildPredictionV6 } from './predictor_v6.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data.json')
const SNAPSHOTS_FILE = process.env.PREDICTION_SNAPSHOTS_FILE
  ? path.resolve(process.env.PREDICTION_SNAPSHOTS_FILE)
  : path.join(__dirname, 'prediction-snapshots.json')

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
    return {
      rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [],
      updatedAt: parsed.updatedAt ?? null,
    }
  } catch {
    return { rounds: [], updatedAt: null }
  }
}

function normalizeStoredRounds(store) {
  const rounds = Array.isArray(store?.rounds) ? store.rounds : []
  return rounds.map(normalizeStoredRound).filter(Boolean)
}

try {
  const store = readData()
  const rounds = normalizeStoredRounds(store)
  const v1 = buildPredictionV1(rounds)
  const v2 = buildPredictionFromBase(v1)
  const v3 = buildPredictionV3(rounds)
  const v4 = buildPredictionV4(rounds)
  const v5 = buildPredictionV5(rounds)
  const v6 = buildPredictionV6(rounds)

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt: store.updatedAt ?? null,
    totalRounds: rounds.length,
    v1,
    v2,
    v3,
    v4,
    v5,
    v6,
  }

  fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(payload), 'utf8')
  if (process.send) process.send({ ok: true, generatedAt: payload.generatedAt })
  process.exit(0)
} catch (error) {
  if (process.send) process.send({ ok: false, error: error.message })
  process.exit(1)
}
