import fs from 'fs'
import { buildPrediction as buildPredictionV1 } from './predictor.js'
import { buildPredictionFromBase as buildPredictionV2FromBase } from './predictor_v2.js'

function loadRounds() {
  const raw = fs.readFileSync(new URL('./data.json', import.meta.url), 'utf8')
  const data = JSON.parse(raw)
  return Array.isArray(data.rounds) ? data.rounds : []
}

function percentage(value) {
  return Number((value * 100).toFixed(2))
}

function summarize(rows, mode) {
  const placed = rows.filter((row) => row[mode].placed)
  return {
    samples: rows.length,
    placedBets: placed.length,
    coverage: percentage(placed.length / Math.max(rows.length, 1)),
    hitRate: placed.length
      ? percentage(placed.filter((row) => row[mode].hit).length / placed.length)
      : 0,
    continuousAccuracy: percentage(
      rows.filter((row) => row[mode].continuousHit).length / Math.max(rows.length, 1)
    ),
  }
}

function main() {
  const roundsDesc = loadRounds()
  const asc = roundsDesc.slice().reverse()
  const evalRounds = Number(process.env.BENCH_EVAL_ROUNDS || 6)
  const minTrain = Number(process.env.BENCH_MIN_TRAIN_ROUNDS || 3000)
  const maxTrain = Number(process.env.BENCH_MAX_TRAIN_ROUNDS || 12000)
  const start = Math.max(minTrain, asc.length - evalRounds)
  const rows = []

  for (let index = start; index < asc.length; index += 1) {
    const trainAsc = asc.slice(Math.max(0, index - maxTrain), index)
    if (trainAsc.length < minTrain) continue

    const base = buildPredictionV1(trainAsc.slice().reverse(), { includeDistributions: false })
    const v2 = buildPredictionV2FromBase(base)
    const actual = asc[index]

    const v1Decision = base.selectiveStrategy?.currentDecision || {}
    const v2Decision = v2.selectiveStrategy?.currentDecision || {}

    rows.push({
      roundId: actual.id,
      actual: actual.result,
      v1: {
        placed: v1Decision.decision === 'BET',
        hit: v1Decision.recommendedResult === actual.result,
        continuousHit: base.diagnosis?.mostLikelyResult === actual.result,
      },
      v2: {
        placed: v2.selectiveStrategy?.v2?.currentDecision?.decision === 'BET',
        hit: v2.selectiveStrategy?.v2?.currentDecision?.recommendedResult === actual.result,
        continuousHit: v2.diagnosis?.mostLikelyResult === actual.result,
      },
    })
  }

  console.log(
    JSON.stringify(
      {
        dataset: {
          totalRounds: roundsDesc.length,
          benchmarkSamples: rows.length,
          evalRoundsRequested: evalRounds,
        },
        v1: summarize(rows, 'v1'),
        v2: summarize(rows, 'v2'),
      },
      null,
      2
    )
  )
}

main()
