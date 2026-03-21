import data from './data.json' with { type: 'json' }
import { buildPrediction } from './predictor_v6_ai.js'

const prediction = buildPrediction(data.rounds || [])
const current = prediction?.selectiveStrategy?.currentDecision || {}
const backtest = prediction?.selectiveStrategy?.backtest || {}

console.log(JSON.stringify({
  result: current.recommendedResult,
  totals: (current.recommendedTotals || []).map((item) => item.total),
  topProbability: current.topProbability,
  spread: current.spread,
  decision: current.decision,
  backtest,
}, null, 2))
