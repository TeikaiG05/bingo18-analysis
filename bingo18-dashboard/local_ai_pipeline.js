import { classifyTotal } from './prediction_postprocessor.js'

function computeGaps(roundsDesc, limit = 100) {
  const gaps = new Map()
  for (let t = 3; t <= 18; t++) gaps.set(t, limit)
  for (let i = 0; i < Math.min(roundsDesc.length, limit); i++) {
    const total = Number(roundsDesc[i]?.total)
    if (gaps.get(total) === limit) gaps.set(total, i)
  }
  return gaps
}

function computeFrequencies(roundsDesc, window) {
  const freqs = new Map()
  for (let t = 3; t <= 18; t++) freqs.set(t, 0)
  for (let i = 0; i < Math.min(roundsDesc.length, window); i++) {
    const total = Number(roundsDesc[i]?.total)
    if (freqs.has(total)) freqs.set(total, freqs.get(total) + 1)
  }
  return freqs
}

// Fixed static profiles for completely different mathematical approaches
const STRATEGY_PROFILES = {
  'Transition Flow (Nhịp Nhảy)': { shortPulse: 0.0, midTrend: 0.0, gapReturn: 0.1, transitionFlow: 0.8, centerBias: 0.1, antiRepetition: true },
  'Trend Follower (Cầu Thuận)': { shortPulse: 0.5, midTrend: 0.4, gapReturn: 0.0, transitionFlow: 0.1, centerBias: 0.0, antiRepetition: false },
  'Gap Reversal (Bắt Gan)': { shortPulse: 0.0, midTrend: 0.0, gapReturn: 0.8, transitionFlow: 0.2, centerBias: 0.0, antiRepetition: true },
  'Anti-Repetition (Bẻ Cầu Lặp)': { shortPulse: 0.3, midTrend: 0.2, gapReturn: 0.2, transitionFlow: 0.3, centerBias: 0.0, antiRepetition: true },
  'Center Gravity (Bắt Hòa/Giữa)': { shortPulse: 0.1, midTrend: 0.1, gapReturn: 0.0, transitionFlow: 0.1, centerBias: 0.7, antiRepetition: true }
}

export function extractFeatureScores(roundsDesc, strategyParams) {
  const gaps = computeGaps(roundsDesc, 100)
  const freq6 = computeFrequencies(roundsDesc, 6)
  const freq12 = computeFrequencies(roundsDesc, 12)
  const freq24 = computeFrequencies(roundsDesc, 24)
  const lastTotal = Number(roundsDesc[0]?.total)

  const transitions = new Map()
  for (let t = 3; t <= 18; t++) transitions.set(t, 0)
  if (lastTotal > 0) {
    for (let i = 0; i < Math.min(roundsDesc.length - 1, 100); i++) {
        if (Number(roundsDesc[i + 1]?.total) === lastTotal) {
           const nextTotal = Number(roundsDesc[i]?.total)
           if (transitions.has(nextTotal)) transitions.set(nextTotal, transitions.get(nextTotal) + 1)
        }
    }
  }
  
  const featurePredictions = {
    shortPulse: new Map(),
    midTrend: new Map(),
    gapReturn: new Map(),
    transitionFlow: new Map(),
    centerBias: new Map(),
  }
  
  for (let t = 3; t <= 18; t++) {
    const isRepetition = (t === lastTotal)
    // Anti-repetition is optionally strict depending on strategy picked
    const multiplier = (isRepetition && strategyParams.antiRepetition) ? 0.02 : 1.0

    featurePredictions.shortPulse.set(t, (freq6.get(t) / 6) * multiplier)
    featurePredictions.midTrend.set(t, ((freq12.get(t) + freq24.get(t)*0.5) / 24) * multiplier)
    
    const g = gaps.get(t)
    let gapScore = 0
    if (g > 10) gapScore = Math.min(1, (g - 10) / 20)
    featurePredictions.gapReturn.set(t, gapScore)
    
    let tf = transitions.get(t) || 0
    featurePredictions.transitionFlow.set(t, tf * multiplier)
    
    let cb = 0
    if (t >= 9 && t <= 12) cb = 1
    else if (t === 8 || t === 13) cb = 0.5
    featurePredictions.centerBias.set(t, cb * multiplier)
  }

  // Normalize
  for (const feature of Object.keys(featurePredictions)) {
    let sum = 0
    const map = featurePredictions[feature]
    for (const val of map.values()) sum += val
    if (sum > 0) {
      for (const [k, v] of map.entries()) map.set(k, v / sum)
    } else {
      for (const k of map.keys()) map.set(k, 1/16)
    }
  }

  return featurePredictions
}

function evaluateStrategy(roundsDesc, strategyCode) {
  const strategyParams = STRATEGY_PROFILES[strategyCode]
  const currentFeatures = extractFeatureScores(roundsDesc, strategyParams)
  const finalScores = new Map()
  for (let t = 3; t <= 18; t++) {
    let score = 0
    score += strategyParams.shortPulse * (currentFeatures.shortPulse.get(t) || 0)
    score += strategyParams.midTrend * (currentFeatures.midTrend.get(t) || 0)
    score += strategyParams.gapReturn * (currentFeatures.gapReturn.get(t) || 0)
    score += strategyParams.transitionFlow * (currentFeatures.transitionFlow.get(t) || 0)
    score += strategyParams.centerBias * (currentFeatures.centerBias.get(t) || 0)
    finalScores.set(t, score)
  }

  const topTotals = [...finalScores.entries()]
    .map(([total, probability]) => ({ total: Number(total), probability, result: classifyTotal(total) }))
    .sort((a, b) => b.probability - a.probability)

  return topTotals.slice(0, 3)
}

function runBacktestForStrategy(roundsDesc, strategyCode, backtestWindow) {
  let score = 0
  let recentMisses = 0
  let countingStreak = true
  
  // Simulate from i=1 up to window (walking backwards in time)
  for (let i = 1; i <= backtestWindow; i++) {
    const slice = roundsDesc.slice(i)
    if (slice.length < 10) break
    const top3 = evaluateStrategy(slice, strategyCode)
    const actual = Number(roundsDesc[i - 1].total)
    
    // Time-decay: recent rounds are worth much more than old rounds (1.0 down to 0.4)
    const decayWeight = 1 - (i / backtestWindow) * 0.6
    
    if (top3.some(t => t.total === actual)) {
       score += decayWeight
       countingStreak = false // Stop counting misses once we hit
    } else {
       if (countingStreak) recentMisses++
    }
  }

  // Force rotation: if a strategy missed the last 2 rounds, cut its score
  if (recentMisses >= 2) {
    score *= 0.4 // 60% penalty
  }
  if (recentMisses >= 3) {
    score *= 0.1 // 90% penalty
  }

  return score
}

export function predictNextRound(roundsDesc, config = {}, recentMemoryHistory = []) {
  if (!roundsDesc || roundsDesc.length < 10) return buildFallbackPrediction()

  // Dynamic Ensemble Selector: evaluate all logics on the last 40 rounds
  const backtestWindow = config.backtestWindow || 40
  let bestStrategy = Object.keys(STRATEGY_PROFILES)[0]
  let maxScore = -1
  const results = {}

  for (const strat of Object.keys(STRATEGY_PROFILES)) {
    const score = runBacktestForStrategy(roundsDesc, strat, backtestWindow)
    results[strat] = score
    if (score > maxScore) {
      maxScore = score
      bestStrategy = strat
    }
  }

  // Generate final prediction using the winning logic
  const targetParams = STRATEGY_PROFILES[bestStrategy]
  const currentFeatures = extractFeatureScores(roundsDesc, targetParams)
  const finalScores = new Map()
  for (let t = 3; t <= 18; t++) {
    let score = 0
    score += targetParams.shortPulse * (currentFeatures.shortPulse.get(t) || 0)
    score += targetParams.midTrend * (currentFeatures.midTrend.get(t) || 0)
    score += targetParams.gapReturn * (currentFeatures.gapReturn.get(t) || 0)
    score += targetParams.transitionFlow * (currentFeatures.transitionFlow.get(t) || 0)
    score += targetParams.centerBias * (currentFeatures.centerBias.get(t) || 0)
    finalScores.set(t, score)
  }

  const topTotals = [...finalScores.entries()]
    .map(([total, probability]) => ({
      total: Number(total),
      probability,
      score: probability,
      result: classifyTotal(total)
    }))
    .sort((a, b) => b.probability - a.probability)

  const resultScores = { Big: 0, Small: 0, Draw: 0 }
  for (const t of topTotals) {
    if (resultScores[t.result] !== undefined) resultScores[t.result] += t.probability
  }
  let topResult = Object.keys(resultScores).reduce((a, b) => resultScores[a] > resultScores[b] ? a : b)

  const scoreStr = maxScore.toFixed(2)
  let explanation = `Tự động bắt nhịp thuật toán tốt nhất: [${bestStrategy}] có hệ số điểm cao nhất (${scoreStr} pts) trong vòng 40 kỳ qua sau khi đã phạt các thuật toán bị trượt chuỗi.`

  return {
    modelId: 'smart-ensemble',
    sourceLabel: 'AI LOCAL (Dynamic Selector)',
    trainedWeights: targetParams,
    evaluatedSamples: backtestWindow,
    result: topResult,
    resultConsensus: topResult,
    topTotals,
    confidence: topTotals[0].probability,
    explanation,
    resultProbabilities: resultScores,
    missStreak: 0,
    bestStrategy,
    backtestWinRate: maxScore / backtestWindow // Rough normalized score
  }
}

function buildFallbackPrediction() {
  return {
    modelId: 'smart-ensemble',
    sourceLabel: 'AI LOCAL (Fallback)',
    trainedWeights: { shortPulse: 0.2, midTrend: 0.2, gapReturn: 0.2, transitionFlow: 0.2, centerBias: 0.2 },
    evaluatedSamples: 0,
    result: 'Draw',
    resultConsensus: 'Draw',
    topTotals: [10, 11, 9].map(t => ({ total: t, probability: 0.1, score: 0.1, result: classifyTotal(t) })),
    confidence: 0,
    explanation: 'Fallback do thiếu dữ liệu.',
    resultProbabilities: { Big: 0.33, Small: 0.33, Draw: 0.34 },
    missStreak: 0
  }
}
