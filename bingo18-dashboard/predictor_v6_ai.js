const RESULT_ORDER = ['Small', 'Draw', 'Big']
const RESULT_LABEL = {
  Small: 'Nho',
  Draw: 'Hoa',
  Big: 'Lon',
}

const MIN_HISTORY = 240
const MAX_MODEL_ROUNDS = 2500
const RECENT_WINDOWS = [12, 48, 240]
const LEARNING_RATE = 0.055
const L2 = 0.0008
const THEORY_PRIOR = {
  Small: 81 / 216,
  Draw: 54 / 216,
  Big: 81 / 216,
}

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function roundNumber(value, digits = 6) {
  return Number(value.toFixed(digits))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function softmax(logits) {
  const maxLogit = Math.max(...logits)
  const exp = logits.map((value) => Math.exp(value - maxLogit))
  const sum = exp.reduce((acc, value) => acc + value, 0) || 1
  return exp.map((value) => value / sum)
}

function createNestedCounts() {
  const map = new Map()
  return {
    map,
    increment(key, result) {
      if (!map.has(key)) map.set(key, new Map())
      const inner = map.get(key)
      inner.set(result, (inner.get(result) || 0) + 1)
    },
    get(key) {
      return map.get(key) || new Map()
    },
  }
}

function countsToPosterior(countsMap, alpha = 14) {
  const support = RESULT_ORDER.reduce((acc, result) => acc + (countsMap.get(result) || 0), 0)
  const denominator = support + alpha
  const output = {}
  for (const result of RESULT_ORDER) {
    const count = countsMap.get(result) || 0
    output[result] = denominator > 0 ? (count + alpha * THEORY_PRIOR[result]) / denominator : THEORY_PRIOR[result]
  }
  const sum = RESULT_ORDER.reduce((acc, result) => acc + output[result], 0) || 1
  for (const result of RESULT_ORDER) output[result] /= sum
  return {
    support,
    map: output,
  }
}

function normalizeRows(weights) {
  return weights.map((row) => row.map((value) => roundNumber(value)))
}

function buildTheoryTotalMap() {
  const totals = new Map()
  for (let d1 = 1; d1 <= 6; d1 += 1) {
    for (let d2 = 1; d2 <= 6; d2 += 1) {
      for (let d3 = 1; d3 <= 6; d3 += 1) {
        const total = d1 + d2 + d3
        totals.set(total, (totals.get(total) || 0) + 1)
      }
    }
  }
  const sum = [...totals.values()].reduce((acc, value) => acc + value, 0) || 1
  const normalized = new Map()
  for (const [total, count] of totals.entries()) {
    normalized.set(total, count / sum)
  }
  return normalized
}

function createState() {
  const globalCounts = new Map()
  RESULT_ORDER.forEach((result) => globalCounts.set(result, 0))

  const recentQueues = new Map()
  const recentCounts = new Map()
  for (const window of RECENT_WINDOWS) {
    recentQueues.set(window, [])
    recentCounts.set(window, new Map(RESULT_ORDER.map((result) => [result, 0])))
  }

  const transition1 = createNestedCounts()
  const transition2 = createNestedCounts()
  const transition3 = createNestedCounts()
  const totalsByResult = new Map(RESULT_ORDER.map((result) => [result, new Map()]))
  const recentTotalsByResult = new Map(RESULT_ORDER.map((result) => [result, new Map()]))
  const recentTotalQueue = []

  const history = []

  function incrementRecentTotal(result, total) {
    const map = recentTotalsByResult.get(result)
    map.set(total, (map.get(total) || 0) + 1)
    recentTotalQueue.push({ result, total })
    if (recentTotalQueue.length > 480) {
      const dropped = recentTotalQueue.shift()
      const dropMap = recentTotalsByResult.get(dropped.result)
      dropMap.set(dropped.total, Math.max(0, (dropMap.get(dropped.total) || 0) - 1))
    }
  }

  return {
    globalCounts,
    recentQueues,
    recentCounts,
    transition1,
    transition2,
    transition3,
    totalsByResult,
    recentTotalsByResult,
    history,
    add(round) {
      const result = round.result
      const total = round.total
      globalCounts.set(result, (globalCounts.get(result) || 0) + 1)

      for (const window of RECENT_WINDOWS) {
        const queue = recentQueues.get(window)
        const counts = recentCounts.get(window)
        queue.push(result)
        counts.set(result, (counts.get(result) || 0) + 1)
        if (queue.length > window) {
          const dropped = queue.shift()
          counts.set(dropped, Math.max(0, (counts.get(dropped) || 0) - 1))
        }
      }

      const resultTotals = totalsByResult.get(result)
      resultTotals.set(total, (resultTotals.get(total) || 0) + 1)
      incrementRecentTotal(result, total)

      history.push(round)
      const h = history
      const len = h.length
      if (len >= 2) {
        transition1.increment(h[len - 2].result, result)
      }
      if (len >= 3) {
        transition2.increment(`${h[len - 3].result}|${h[len - 2].result}`, result)
      }
      if (len >= 4) {
        transition3.increment(`${h[len - 4].result}|${h[len - 3].result}|${h[len - 2].result}`, result)
      }
    },
  }
}

function freqFromCounts(countsMap, window) {
  const result = {}
  const denominator = window || 1
  for (const key of RESULT_ORDER) {
    result[key] = (countsMap.get(key) || 0) / denominator
  }
  return result
}

function buildFeatureContext(state) {
  const history = state.history
  const last = history[history.length - 1] || null
  const prev = history[history.length - 2] || null
  const lastResult = last?.result || 'Draw'
  const prevResult = prev?.result || 'Draw'

  let streak = 1
  for (let index = history.length - 2; index >= 0; index -= 1) {
    if (history[index].result === lastResult) streak += 1
    else break
  }

  let flips = 0
  const recentFive = history.slice(-5)
  for (let index = 1; index < recentFive.length; index += 1) {
    if (recentFive[index].result !== recentFive[index - 1].result) flips += 1
  }

  const recentTwelveTotals = history.slice(-12).map((item) => Number(item.total))
  const avgRecentTotal =
    recentTwelveTotals.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0) /
    (recentTwelveTotals.length || 1)

  const result12 = freqFromCounts(state.recentCounts.get(12), Math.min(12, history.length))
  const result48 = freqFromCounts(state.recentCounts.get(48), Math.min(48, history.length))
  const result240 = freqFromCounts(state.recentCounts.get(240), Math.min(240, history.length))
  const global = freqFromCounts(state.globalCounts, history.length)

  const trans1 = countsToPosterior(state.transition1.get(lastResult))
  const trans2 = countsToPosterior(state.transition2.get(`${prevResult}|${lastResult}`))
  const trans3 = countsToPosterior(
    history.length >= 3
      ? state.transition3.get(
          `${history[history.length - 3].result}|${prevResult}|${lastResult}`,
        )
      : new Map(),
  )

  const drawCount10 = history.slice(-10).filter((item) => item.result === 'Draw').length

  return {
    lastResult,
    prevResult,
    streak,
    flips,
    avgRecentTotal,
    drawCount10,
    result12,
    result48,
    result240,
    global,
    trans1,
    trans2,
    trans3,
  }
}

function buildFeatureVector(state) {
  const ctx = buildFeatureContext(state)
  const vector = []
  vector.push(1)
  vector.push(ctx.result12.Small, ctx.result12.Draw, ctx.result12.Big)
  vector.push(ctx.result48.Small, ctx.result48.Draw, ctx.result48.Big)
  vector.push(ctx.result240.Small, ctx.result240.Draw, ctx.result240.Big)
  vector.push(ctx.global.Small, ctx.global.Draw, ctx.global.Big)
  vector.push(ctx.trans1.map.Small, ctx.trans1.map.Draw, ctx.trans1.map.Big)
  vector.push(ctx.trans2.map.Small, ctx.trans2.map.Draw, ctx.trans2.map.Big)
  vector.push(ctx.trans3.map.Small, ctx.trans3.map.Draw, ctx.trans3.map.Big)
  vector.push(ctx.lastResult === 'Small' ? 1 : 0, ctx.lastResult === 'Draw' ? 1 : 0, ctx.lastResult === 'Big' ? 1 : 0)
  vector.push(ctx.prevResult === 'Small' ? 1 : 0, ctx.prevResult === 'Draw' ? 1 : 0, ctx.prevResult === 'Big' ? 1 : 0)
  vector.push(clamp(ctx.streak / 6, 0, 1))
  vector.push(clamp(ctx.flips / 4, 0, 1))
  vector.push(clamp(ctx.drawCount10 / 4, 0, 1))
  vector.push(clamp((ctx.avgRecentTotal - 3) / 15, 0, 1))
  return {
    vector,
    context: ctx,
  }
}

function resultIndex(result) {
  return RESULT_ORDER.indexOf(result)
}

function trainWalkForward(roundsAsc) {
  const state = createState()
  const featureLength = buildFeatureVector({
    ...state,
    history: [
      { result: 'Small', total: 8 },
      { result: 'Big', total: 12 },
      { result: 'Draw', total: 10 },
    ],
    recentCounts: new Map([
      [12, new Map([['Small', 1], ['Draw', 1], ['Big', 1]])],
      [48, new Map([['Small', 1], ['Draw', 1], ['Big', 1]])],
      [240, new Map([['Small', 1], ['Draw', 1], ['Big', 1]])],
    ]),
    globalCounts: new Map([['Small', 1], ['Draw', 1], ['Big', 1]]),
  }).vector.length

  const weights = RESULT_ORDER.map(() => Array(featureLength).fill(0))
  const recentQualified = []
  let evaluated = 0
  let hits = 0
  let selectiveBets = 0
  let selectiveHits = 0

  for (let index = 0; index < roundsAsc.length; index += 1) {
    const round = roundsAsc[index]
    if (index >= MIN_HISTORY) {
      const { vector } = buildFeatureVector(state)
      const logits = RESULT_ORDER.map((_, rowIndex) =>
        vector.reduce((acc, value, featureIndex) => acc + weights[rowIndex][featureIndex] * value, 0),
      )
      const probs = softmax(logits)
      const ranked = RESULT_ORDER.map((result, rowIndex) => ({
        result,
        probability: probs[rowIndex],
      })).sort((a, b) => b.probability - a.probability)

      const predicted = ranked[0].result
      const actual = round.result
      const spread = ranked[0].probability - ranked[1].probability
      const shouldBet = ranked[0].probability >= 0.42 && spread >= 0.045
      evaluated += 1
      if (predicted === actual) hits += 1
      if (shouldBet) {
        selectiveBets += 1
        if (predicted === actual) selectiveHits += 1
        if (recentQualified.length < 12 || index > roundsAsc.length - 18) {
          recentQualified.push({
            id: round.id,
            prediction: predicted,
            actualResult: actual,
            hit: predicted === actual,
          })
        }
      }

      const actualIndex = resultIndex(actual)
      for (let rowIndex = 0; rowIndex < RESULT_ORDER.length; rowIndex += 1) {
        const target = rowIndex === actualIndex ? 1 : 0
        const error = probs[rowIndex] - target
        for (let featureIndex = 0; featureIndex < featureLength; featureIndex += 1) {
          weights[rowIndex][featureIndex] -=
            LEARNING_RATE * (error * vector[featureIndex] + L2 * weights[rowIndex][featureIndex])
        }
      }
    }

    state.add(round)
  }

  return {
    weights,
    validation: {
      evaluatedRounds: evaluated,
      continuousHitRate: evaluated ? hits / evaluated : 0,
      selectiveHitRate: selectiveBets ? selectiveHits / selectiveBets : 0,
      selectiveBets,
      recentQualified: recentQualified.slice(-10),
    },
    state,
  }
}

function blendTotalCandidates(result, context, state) {
  const theoryTotals = buildTheoryTotalMap()
  const globalMap = state.totalsByResult.get(result) || new Map()
  const recentMap = state.recentTotalsByResult.get(result) || new Map()

  const totals = []
  let sum = 0
  for (let total = 3; total <= 18; total += 1) {
    if (classifyTotal(total) !== result) continue
    const theory = theoryTotals.get(total) || 0
    const globalSupport = [...globalMap.values()].reduce((acc, value) => acc + value, 0) || 1
    const recentSupport = [...recentMap.values()].reduce((acc, value) => acc + value, 0) || 1
    const global = (globalMap.get(total) || 0) / globalSupport
    const recent = (recentMap.get(total) || 0) / recentSupport

    const posterior1 = context.trans1.map[result] || THEORY_PRIOR[result]
    const posterior2 = context.trans2.map[result] || THEORY_PRIOR[result]
    const posterior3 = context.trans3.map[result] || THEORY_PRIOR[result]
    const transitionStrength = (posterior1 + posterior2 + posterior3) / 3
    const score =
      theory * 0.18 +
      global * 0.36 +
      recent * 0.34 +
      theory * transitionStrength * 0.12
    totals.push({ total, result, probability: score })
    sum += score
  }

  sum ||= 1
  return totals
    .map((item) => ({
      ...item,
      probability: roundNumber(item.probability / sum),
      score: roundNumber((item.probability / sum) * 100, 4),
      sources: ['ai-meta', 'global', 'recent', 'theory'],
    }))
    .sort((a, b) => b.probability - a.probability)
}

export function buildPrediction(rounds) {
  const allRoundsAsc = [...(Array.isArray(rounds) ? rounds : [])]
    .filter((round) => round && Number.isFinite(Number(round.total)))
    .map((round) => ({
      ...round,
      total: Number(round.total),
      result: round.result || classifyTotal(Number(round.total)),
    }))
    .reverse()

  const roundsAsc =
    allRoundsAsc.length > MAX_MODEL_ROUNDS
      ? allRoundsAsc.slice(-MAX_MODEL_ROUNDS)
      : allRoundsAsc

  if (roundsAsc.length <= MIN_HISTORY + 1) {
    return {
      methodology: {
        note: 'V6 AI needs more history to train the walk-forward learner.',
        model: { id: 'predictor_v6_ai', label: 'AI Meta Learner V6' },
      },
      diagnosis: {
        mostLikelyResult: 'Draw',
        resultProbabilities: { Small: 0.375, Draw: 0.25, Big: 0.375 },
        topTotals: [],
      },
      selectiveStrategy: {
        currentDecision: {
          decision: 'SKIP',
          shouldBet: false,
          recommendedResult: 'Draw',
          recommendedTotals: [],
          gateChecks: [],
        },
        recentQualified: [],
      },
    }
  }

  const { weights, validation, state } = trainWalkForward(roundsAsc)
  const { vector, context } = buildFeatureVector(state)
  const logits = RESULT_ORDER.map((_, rowIndex) =>
    vector.reduce((acc, value, featureIndex) => acc + weights[rowIndex][featureIndex] * value, 0),
  )
  const probabilities = softmax(logits)
  const rankedResults = RESULT_ORDER.map((result, rowIndex) => ({
    result,
    probability: probabilities[rowIndex],
  })).sort((a, b) => b.probability - a.probability)

  const topResult = rankedResults[0].result
  const topProbability = rankedResults[0].probability
  const spread = topProbability - rankedResults[1].probability
  const topTotals = blendTotalCandidates(topResult, context, state)
  const recommendedTotals = topTotals.slice(0, 3)
  const agreementProxy =
    (context.trans1.support >= 30 ? 1 : 0) +
    (context.trans2.support >= 24 ? 1 : 0) +
    (context.trans3.support >= 18 ? 1 : 0)

  const gateChecks = [
    {
      label: 'Xac suat top',
      pass: topProbability >= 0.43,
      value: roundNumber(topProbability * 100, 4),
      threshold: 43,
      detail: 'Cua top phai qua 43 phan tram.',
    },
    {
      label: 'Do chenh',
      pass: spread >= 0.05,
      value: roundNumber(spread * 100, 4),
      threshold: 5,
      detail: 'Top 1 phai tach Top 2 de tranh quyet dinh mo ho.',
    },
    {
      label: 'Ho tro Markov',
      pass: agreementProxy >= 2,
      value: agreementProxy,
      threshold: 2,
      detail: 'It nhat 2 trong 3 tang chuyen trang thai phai co support tot.',
    },
  ]

  const shouldBet = gateChecks.every((item) => item.pass)
  const resultProbabilities = {
    Small: roundNumber(probabilities[resultIndex('Small')]),
    Draw: roundNumber(probabilities[resultIndex('Draw')]),
    Big: roundNumber(probabilities[resultIndex('Big')]),
  }

  return {
    methodology: {
      note: 'V6 AI is a true online meta learner: it trains with walk-forward updates over the full history and predicts using a multiclass softmax model on sequential features.',
      caution:
        'The learner is adaptive, not magical. It updates after each historical round and then predicts the next one using only past information.',
      model: {
        id: 'predictor_v6_ai',
        label: 'AI Meta Learner V6',
      },
      training: {
        type: 'walk-forward online softmax',
        learningRate: LEARNING_RATE,
        l2: L2,
        minHistory: MIN_HISTORY,
        maxModelRounds: MAX_MODEL_ROUNDS,
        featureCount: vector.length,
        weights: normalizeRows(weights),
      },
      validation: {
        continuousHitRate: roundNumber(validation.continuousHitRate * 100, 4),
        selectiveHitRate: roundNumber(validation.selectiveHitRate * 100, 4),
        selectiveBets: validation.selectiveBets,
        evaluatedRounds: validation.evaluatedRounds,
      },
      context: {
        latestResult: state.history[state.history.length - 1]?.result || null,
        streak: context.streak,
        flips: context.flips,
        drawCount10: context.drawCount10,
        avgRecentTotal: roundNumber(context.avgRecentTotal, 4),
        support1: context.trans1.support,
        support2: context.trans2.support,
        support3: context.trans3.support,
      },
    },
    dataset: {
      totalRounds: allRoundsAsc.length,
      trainingRoundsUsed: roundsAsc.length,
      latestRound: state.history[state.history.length - 1] || null,
    },
    diagnosis: {
      mostLikelyResult: topResult,
      resultProbabilities,
      topTotals,
      topExactDice: [],
      topFaces: [],
      confidenceModel: {
        confidenceScore: roundNumber(clamp(topProbability * 55 + spread * 240 + agreementProxy * 8, 0, 99), 4),
        topProbability: roundNumber(topProbability * 100, 4),
        spread: roundNumber(spread * 100, 4),
        support: context.trans3.support,
        agreementProxy,
      },
      confidenceSpread: roundNumber(spread),
      recommendations: {
        recommendationText: `AI V6 nghieng ve ${RESULT_LABEL[topResult]} va uu tien tong ${recommendedTotals.map((item) => item.total).join(', ')}.`,
        primaryMethod: 'Walk-forward online meta learner',
        methodNotes: [
          `Top result: ${RESULT_LABEL[topResult]} ${roundNumber(topProbability * 100, 2)}%`,
          `Spread: ${roundNumber(spread * 100, 2)}%`,
          `Supports: ${context.trans1.support}/${context.trans2.support}/${context.trans3.support}`,
        ],
      },
    },
    selectiveStrategy: {
      currentDecision: {
        decision: shouldBet ? 'BET' : 'SKIP',
        shouldBet,
        recommendedResult: topResult,
        recommendedTotals,
        topProbability: roundNumber(topProbability * 100, 4),
        spread: roundNumber(spread * 100, 4),
        drawProbability: roundNumber((resultProbabilities.Draw || 0) * 100, 4),
        confidenceBand: shouldBet ? 'AI sang' : 'Quan sat',
        confidenceScore: roundNumber(clamp(topProbability * 55 + spread * 240 + agreementProxy * 8, 0, 99), 4),
        gateChecks,
        resultBreakdown: rankedResults.map((item) => ({
          result: item.result,
          probability: roundNumber(item.probability * 100, 4),
        })),
        consensusTotals: topTotals.slice(0, 5).map((item) => ({
          total: item.total,
          result: item.result,
          averageProbability: roundNumber(item.probability * 100, 4),
          sources: item.sources,
        })),
        summary: shouldBet
          ? `AI V6 chon ${RESULT_LABEL[topResult]} vi xac suat va do chenh da hoi tu.`
          : 'AI V6 thay nhan dinh hien tai chua du tach biet de vao lenh.',
        rationale: [
          `Walk-forward rounds: ${validation.evaluatedRounds}`,
          `Continuous hit: ${roundNumber(validation.continuousHitRate * 100, 2)}%`,
          `Selective hit: ${roundNumber(validation.selectiveHitRate * 100, 2)}%`,
        ],
      },
      recentQualified: validation.recentQualified,
      review: {
        missedBets: [],
      },
      backtest: {
        continuousHitRate: roundNumber(validation.continuousHitRate * 100, 4),
        selectiveHitRate: roundNumber(validation.selectiveHitRate * 100, 4),
        selectiveBets: validation.selectiveBets,
        evaluatedRounds: validation.evaluatedRounds,
      },
    },
    betPortfolio: {
      decision: shouldBet ? 'BET' : 'SKIP',
      recommendedResult: topResult,
      highHit: {
        summary: shouldBet
          ? `AI V6 uu tien ${RESULT_LABEL[topResult]}, tap trung tong ${recommendedTotals.map((item) => item.total).join(', ')}.`
          : 'AI V6 chua thay loi the du lon de don lenh.',
        resultRange: RESULT_LABEL[topResult],
        totals: recommendedTotals,
        singleFaces: [],
        exactDoubles: [],
      },
      highPayout: {
        summary: 'V6 AI uu tien learning tren cua va tong, khong lay exact dice lam loi.',
        anyTriple: { status: 'SKIP', score: 0 },
        exactTriples: [],
        tripleHotHours: [],
      },
    },
    analytics: {
      v6ai: {
        agreementProxy,
        recentWindows: RECENT_WINDOWS,
      },
    },
    distributions: {
      totals: Object.fromEntries(topTotals.map((item) => [item.total, item.probability])),
    },
  }
}
