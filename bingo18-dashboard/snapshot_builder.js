import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { buildPrediction as buildPredictionV1 } from './predictor.js'
import { buildPredictionFromBase } from './predictor_v2.js'
import { buildPrediction as buildPredictionV3 } from './predictor_v3.js'
import { buildPrediction as buildPredictionV4 } from './predictor_v4.js'
import { buildPrediction as buildPredictionV5 } from './predictor_v5.js'
import { buildPrediction as buildPredictionV6 } from './predictor_v6.js'
import { buildPrediction as buildPredictionV7 } from './predictor_v7.js'
import { buildPrediction as buildPredictionV8 } from './predictor_v8.js'
import { buildPrediction as buildPredictionV9 } from './predictor_v9.js'
import { adaptPredictionPayload } from './prediction_postprocessor.js'

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
  const rawV1 = buildPredictionV1(rounds)
  const rawV2 = buildPredictionFromBase(rawV1)
  const rawV3 = buildPredictionV3(rounds)
  const rawV4 = buildPredictionV4(rounds)
  const rawV5 = buildPredictionV5(rounds)
  const rawV6 = buildPredictionV6(rounds)
  const rawV7 = buildPredictionV7(rounds)
  const rawV8 = buildPredictionV8(rounds)
  const rawV9 = buildPredictionV9(rounds)
  const v1 = adaptPredictionPayload(rawV1, rounds, { modelId: 'v1' })
  const v2 = adaptPredictionPayload(rawV2, rounds, { modelId: 'v2' })
  const v3 = adaptPredictionPayload(rawV3, rounds, { modelId: 'v3' })
  const v4 = adaptPredictionPayload(rawV4, rounds, { modelId: 'v4' })
  const v5 = adaptPredictionPayload(rawV5, rounds, { modelId: 'v5' })
  const v6 = adaptPredictionPayload(rawV6, rounds, { modelId: 'v6' })
  const v7 = adaptPredictionPayload(rawV7, rounds, { modelId: 'v7' })
  const v8 = adaptPredictionPayload(rawV8, rounds, { modelId: 'v8' })
  const v9 = adaptPredictionPayload(rawV9, rounds, { modelId: 'v9' })

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
    v7,
    v8,
    v9,
  }

  fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(payload), 'utf8')
  if (process.send) process.send({ ok: true, generatedAt: payload.generatedAt })
  process.exit(0)
} catch (error) {
  if (process.send) process.send({ ok: false, error: error.message })
  process.exit(1)
}
