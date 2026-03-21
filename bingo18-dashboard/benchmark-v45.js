import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { buildPrediction as buildPredictionV4 } from './predictor_v4.js'
import { buildPrediction as buildPredictionV5 } from './predictor_v5.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_FILE = path.join(__dirname, 'data.json')
const evalRounds = Number(process.env.BENCH_EVAL_ROUNDS || 24)

function readRounds() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed.rounds) ? parsed.rounds : []
}

function evaluateModel(label, buildPrediction, rounds, windows) {
  let continuousHits = 0
  let selectiveHits = 0
  let selectiveBets = 0

  for (let offset = windows; offset >= 1; offset -= 1) {
    const trainRounds = rounds.slice(offset)
    const actual = rounds[offset - 1]
    const prediction = buildPrediction(trainRounds)
    const predicted = prediction?.diagnosis?.mostLikelyResult
    const current = prediction?.selectiveStrategy?.currentDecision || {}
    const shouldBet = Boolean(current.shouldBet)
    const recommended = current.recommendedResult || predicted

    if (predicted === actual.result) continuousHits += 1
    if (shouldBet) {
      selectiveBets += 1
      if (recommended === actual.result) selectiveHits += 1
    }
  }

  return {
    label,
    windows,
    continuousHitRate: windows ? (continuousHits / windows) * 100 : 0,
    selectiveBets,
    selectiveHitRate: selectiveBets ? (selectiveHits / selectiveBets) * 100 : 0,
    coverage: windows ? (selectiveBets / windows) * 100 : 0,
  }
}

const rounds = readRounds()
const windows = Math.min(evalRounds, Math.max(rounds.length - 400, 1))

const results = [
  evaluateModel('V4', buildPredictionV4, rounds, windows),
  evaluateModel('V5', buildPredictionV5, rounds, windows),
]

console.table(
  results.map((item) => ({
    Model: item.label,
    Windows: item.windows,
    Continuous: item.continuousHitRate.toFixed(2) + '%',
    SelectiveBets: item.selectiveBets,
    SelectiveHit: item.selectiveHitRate.toFixed(2) + '%',
    Coverage: item.coverage.toFixed(2) + '%',
  })),
)
