import fs from 'fs'
import { buildPrediction } from './core-predictor.js'

function loadRounds() {
  const raw = fs.readFileSync(new URL('./data.json', import.meta.url), 'utf8')
  const data = JSON.parse(raw)
  return Array.isArray(data.rounds) ? data.rounds : []
}

function percentage(value) {
  return Number((value * 100).toFixed(2))
}

function evaluateMode(roundsAsc, config) {
  const evalRounds = Number(process.env.BENCH_EVAL_ROUNDS || 240)
  const minTrainRounds = Number(process.env.BENCH_MIN_TRAIN_ROUNDS || 3000)
  const maxTrainRounds = Number(process.env.BENCH_MAX_TRAIN_ROUNDS || 12000)
  const startIndex = Math.max(minTrainRounds, roundsAsc.length - evalRounds)

  let samples = 0
  let hits = 0
  let abstained = 0

  for (let index = startIndex; index < roundsAsc.length; index += 1) {
    const trainAsc = roundsAsc.slice(Math.max(0, index - maxTrainRounds), index)
    if (trainAsc.length < minTrainRounds) continue

    const trainDesc = trainAsc.slice().reverse()
    const actual = roundsAsc[index]
    const prediction = buildPrediction(trainDesc, {
      includeHourFeatures: config.includeHourFeatures,
      selective: config.selective,
    })

    const decision = prediction.selectiveStrategy?.currentDecision
    const shouldBet = config.selective ? Boolean(decision?.shouldBet) : true
    if (!shouldBet) {
      abstained += 1
      continue
    }

    samples += 1
    const predicted = config.selective ? decision?.predictedResult : prediction.diagnosis?.mostLikelyResult
    if (predicted === actual.result) hits += 1
  }

  const totalWindows = Math.max(0, roundsAsc.length - startIndex)
  return {
    mode: config.name,
    evaluatedWindows: totalWindows,
    placedBets: samples,
    abstained,
    coverage: percentage(samples / Math.max(totalWindows, 1)),
    hitRate: percentage(hits / Math.max(samples, 1)),
  }
}

function main() {
  const roundsDesc = loadRounds()
  const roundsAsc = roundsDesc.slice().reverse()

  const configs = [
    { name: 'continuous_no_hour', selective: false, includeHourFeatures: false },
    { name: 'continuous_with_hour', selective: false, includeHourFeatures: true },
    { name: 'selective_no_hour', selective: true, includeHourFeatures: false },
    { name: 'selective_with_hour', selective: true, includeHourFeatures: true },
  ]

  const results = configs.map((config) => evaluateMode(roundsAsc, config))
  const bestContinuous = results
    .filter((item) => item.mode.startsWith('continuous'))
    .sort((a, b) => b.hitRate - a.hitRate)[0]
  const bestSelective = results
    .filter((item) => item.mode.startsWith('selective'))
    .sort((a, b) => b.hitRate - a.hitRate || b.coverage - a.coverage)[0]

  console.log(
    JSON.stringify(
      {
        dataset: {
          totalRounds: roundsDesc.length,
        },
        results,
        recommendation: {
          continuous: bestContinuous,
          selective: bestSelective,
        },
      },
      null,
      2
    )
  )
}

main()
