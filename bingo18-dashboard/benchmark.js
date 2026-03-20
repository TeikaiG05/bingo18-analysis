import fs from 'fs'
import { buildPrediction, buildTheoryMaps, enumerateExactCombos } from './predictor.js'

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function loadRounds() {
  const raw = fs.readFileSync(new URL('./data.json', import.meta.url), 'utf8')
  const data = JSON.parse(raw)
  return Array.isArray(data.rounds) ? data.rounds : []
}

function percentage(value) {
  return Number((value * 100).toFixed(2))
}

function summarizeRows(rows, threshold) {
  const selected = rows.filter((row) => row.confidenceScore >= threshold)
  const samples = selected.length

  if (!samples) {
    return {
      threshold,
      samples: 0,
      coverage: 0,
      resultAccuracy: 0,
      totalAccuracy: 0,
      top2Accuracy: 0,
    }
  }

  const resultHits = selected.filter((row) => row.resultHit).length
  const totalHits = selected.filter((row) => row.totalHit).length
  const top2Hits = selected.filter((row) => row.top2Hit).length

  return {
    threshold,
    samples,
    coverage: percentage(samples / rows.length),
    resultAccuracy: percentage(resultHits / samples),
    totalAccuracy: percentage(totalHits / samples),
    top2Accuracy: percentage(top2Hits / samples),
  }
}

function utilityScore(summary) {
  if (summary.samples < 10) return -999

  const coverage = summary.coverage / 100
  const resultAccuracy = summary.resultAccuracy / 100
  const totalAccuracy = summary.totalAccuracy / 100
  const top2Accuracy = summary.top2Accuracy / 100
  const coveragePenalty = coverage < 0.08 ? (0.08 - coverage) * 1.5 : 0

  return resultAccuracy * 0.55 + totalAccuracy * 0.3 + top2Accuracy * 0.15 - coveragePenalty
}

function findBestThreshold(summaries) {
  return summaries
    .map((summary) => ({ ...summary, utility: Number(utilityScore(summary).toFixed(6)) }))
    .sort((a, b) => b.utility - a.utility || b.resultAccuracy - a.resultAccuracy)[0]
}

async function main() {
  const roundsDesc = loadRounds()
  const asc = roundsDesc.slice().reverse()
  const exactCombos = enumerateExactCombos()
  const theory = buildTheoryMaps(exactCombos)
  const evalRounds = Number(process.env.BENCH_EVAL_ROUNDS || 180)
  const minTrainRounds = Number(process.env.BENCH_MIN_TRAIN_ROUNDS || 3000)
  const maxTrainRounds = Number(process.env.BENCH_MAX_TRAIN_ROUNDS || 12000)

  const startIndex = Math.max(minTrainRounds, asc.length - evalRounds)
  const rows = []

  for (let i = startIndex; i < asc.length; i += 1) {
    const trainAsc = asc.slice(Math.max(0, i - maxTrainRounds), i)
    if (trainAsc.length < minTrainRounds) continue

    const trainDesc = trainAsc.slice().reverse()
    const actual = asc[i]
    const prediction = buildPrediction(trainDesc, {
      includeAnalytics: false,
      includeDistributions: false,
      exactCombos,
      theory,
    })

    const predictedResult = prediction.diagnosis.mostLikelyResult
    const predictedTotal = prediction.diagnosis.topTotals[0]?.total ?? null
    const predictedTop2 = prediction.diagnosis.topTotals.slice(0, 2).map((item) => item.total)
    const confidenceScore = prediction.diagnosis.confidenceModel?.confidenceScore ?? 0

    rows.push({
      index: i,
      actualTotal: actual.total,
      actualResult: classifyTotal(actual.total),
      predictedResult,
      predictedTotal,
      predictedTop2,
      confidenceScore,
      resultHit: predictedResult === classifyTotal(actual.total),
      totalHit: predictedTotal === actual.total,
      top2Hit: predictedTop2.includes(actual.total),
      abstain: prediction.diagnosis.confidenceModel?.shouldAbstain ?? false,
    })
  }

  const overall = summarizeRows(rows, 0)
  const suggestedNoBet = {
    samples: rows.filter((row) => row.abstain).length,
    rate: percentage(rows.filter((row) => row.abstain).length / Math.max(rows.length, 1)),
  }

  const thresholdSummaries = Array.from({ length: 19 }, (_, index) => summarizeRows(rows, index * 5))
  const bestThreshold = findBestThreshold(thresholdSummaries.filter((item) => item.threshold >= 10))

  const aggressive = thresholdSummaries.find((item) => item.threshold === 20)
  const balanced = thresholdSummaries.find((item) => item.threshold === 35)
  const conservative = thresholdSummaries.find((item) => item.threshold === 50)

  const report = {
    dataset: {
      totalRounds: roundsDesc.length,
      benchmarkSamples: rows.length,
      evalRoundsRequested: evalRounds,
      minTrainRounds,
      maxTrainRounds,
    },
    baselineAllRounds: overall,
    currentNoBetSignal: suggestedNoBet,
    presets: {
      aggressive,
      balanced,
      conservative,
    },
    recommendedThreshold: bestThreshold,
    thresholdTable: thresholdSummaries,
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
