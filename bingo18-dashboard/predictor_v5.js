const RESULT_ORDER = ['Small', 'Draw', 'Big']
const RESULT_LABEL = {
  Small: 'Nhỏ',
  Draw: 'Hòa',
  Big: 'Lớn',
}
const MAX_NGRAM = 3
const MIN_SUPPORT = {
  3: 18,
  2: 28,
  1: 42,
}
const RECENT_WINDOW = 480
const BACKTEST_ROUNDS = 10
const BACKTEST_TRAIN_WINDOW = 3200
const THEORY_TOTAL_ORDER = [10, 11, 9, 12, 8, 13, 7, 14, 6, 15, 5, 16, 4, 17, 3, 18]

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

function buildCenterPressure(roundsDesc, window = 10) {
  const recent = roundsDesc.slice(0, window)
  let weightSum = 0
  let centerScore = 0

  recent.forEach((round, index) => {
    const total = Number(round?.total)
    const weight = 1 / (1 + index * 0.22)
    weightSum += weight
    if (total === 10 || total === 11) centerScore += weight * 1
    else if (total === 9 || total === 12) centerScore += weight * 0.55
  })

  return weightSum > 0 ? centerScore / weightSum : 0
}

function incrementNestedMap(outer, key, valueKey) {
  if (!outer.has(key)) outer.set(key, new Map())
  const inner = outer.get(key)
  inner.set(valueKey, (inner.get(valueKey) || 0) + 1)
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

  const count = [...totals.values()].reduce((sum, value) => sum + value, 0) || 1
  const normalized = new Map()
  for (const [total, hits] of totals.entries()) {
    normalized.set(total, hits / count)
  }
  return normalized
}

function mapToResultProbabilities(countMap, priorMap, alpha = 18) {
  const support = RESULT_ORDER.reduce((sum, result) => sum + (countMap?.get?.(result) || 0), 0)
  const denominator = support + alpha
  const probabilities = {}
  for (const result of RESULT_ORDER) {
    const count = countMap?.get?.(result) || 0
    const prior = priorMap[result] || 0
    probabilities[result] = denominator > 0 ? (count + alpha * prior) / denominator : prior
  }

  const total = RESULT_ORDER.reduce((sum, result) => sum + probabilities[result], 0) || 1
  for (const result of RESULT_ORDER) {
    probabilities[result] = roundNumber(probabilities[result] / total)
  }

  return {
    support,
    map: probabilities,
  }
}

function countsToTotalPosterior(countMap, priorMap, alpha = 18) {
  const support = [...(countMap?.values?.() || [])].reduce((sum, value) => sum + (Number(value) || 0), 0)
  const denominator = support + alpha
  const posterior = new Map()
  for (const [total, prior] of priorMap.entries()) {
    const count = countMap?.get?.(total) || 0
    posterior.set(total, denominator > 0 ? (count + alpha * prior) / denominator : prior)
  }

  const totalWeight = [...posterior.values()].reduce((sum, value) => sum + value, 0) || 1
  for (const [total, value] of posterior.entries()) {
    posterior.set(total, value / totalWeight)
  }

  return {
    support,
    map: posterior,
  }
}

function buildEmpiricalResultPrior(roundsDesc) {
  const longRunCounts = new Map()
  const recentCounts = new Map()

  for (const round of roundsDesc) {
    const result = round.result || classifyTotal(Number(round.total))
    longRunCounts.set(result, (longRunCounts.get(result) || 0) + 1)
  }

  for (const round of roundsDesc.slice(0, RECENT_WINDOW)) {
    const result = round.result || classifyTotal(Number(round.total))
    recentCounts.set(result, (recentCounts.get(result) || 0) + 1)
  }

  const theory = {
    Small: 81 / 216,
    Draw: 54 / 216,
    Big: 81 / 216,
  }

  const longRunSupport = RESULT_ORDER.reduce((sum, result) => sum + (longRunCounts.get(result) || 0), 0) || 1
  const recentSupport = RESULT_ORDER.reduce((sum, result) => sum + (recentCounts.get(result) || 0), 0) || 1

  const longRun = {}
  const recent = {}
  for (const result of RESULT_ORDER) {
    longRun[result] = (longRunCounts.get(result) || 0) / longRunSupport
    recent[result] = (recentCounts.get(result) || 0) / recentSupport
  }

  const weights = {
    theory: 0.05,
    longRun: 0.6 * clamp(longRunSupport / 5000, 0.7, 1),
    recent: 0.35 * clamp(recentSupport / RECENT_WINDOW, 0.3, 1),
  }
  const totalWeight = weights.theory + weights.longRun + weights.recent
  const prior = {}
  for (const result of RESULT_ORDER) {
    prior[result] =
      (theory[result] * weights.theory +
        longRun[result] * weights.longRun +
        recent[result] * weights.recent) /
      totalWeight
    prior[result] = roundNumber(prior[result])
  }

  return {
    prior,
    components: { theory, longRun, recent },
    weights: {
      theory: roundNumber(weights.theory / totalWeight),
      longRun: roundNumber(weights.longRun / totalWeight),
      recent: roundNumber(weights.recent / totalWeight),
    },
  }
}

function buildMarkovState(roundsDesc) {
  const asc = [...(Array.isArray(roundsDesc) ? roundsDesc : [])]
    .filter((round) => round && Number.isFinite(Number(round.total)))
    .reverse()
    .map((round) => ({
      ...round,
      total: Number(round.total),
      result: round.result || classifyTotal(Number(round.total)),
    }))

  const transitions = {
    1: new Map(),
    2: new Map(),
    3: new Map(),
  }
  const totalTransitions = {
    1: new Map(),
    2: new Map(),
    3: new Map(),
  }
  const resultTotals = new Map()
  for (const result of RESULT_ORDER) {
    resultTotals.set(result, new Map())
  }

  for (let index = 0; index < asc.length; index += 1) {
    const current = asc[index]
    const resultTotalMap = resultTotals.get(current.result)
    resultTotalMap.set(current.total, (resultTotalMap.get(current.total) || 0) + 1)

    for (let n = 1; n <= MAX_NGRAM; n += 1) {
      if (index < n) continue
      const chain = asc.slice(index - n, index).map((item) => item.result).join('|')
      incrementNestedMap(transitions[n], chain, current.result)
      incrementNestedMap(totalTransitions[n], chain, current.total)
    }
  }

  return {
    asc,
    latestChain: asc.slice(-MAX_NGRAM).map((item) => item.result),
    transitions,
    totalTransitions,
    resultTotals,
  }
}

function pickBestNgram(latestChain, transitions, prior) {
  for (let n = MAX_NGRAM; n >= 1; n -= 1) {
    if (latestChain.length < n) continue
    const chain = latestChain.slice(-n).join('|')
    const posterior = mapToResultProbabilities(
      transitions[n].get(chain),
      prior,
      10 + (MAX_NGRAM - n) * 8,
    )
    if (posterior.support >= MIN_SUPPORT[n]) {
      return {
        n,
        chain,
        posterior,
      }
    }
  }

  const fallbackChain = latestChain.slice(-1).join('|')
  return {
    n: 0,
    chain: fallbackChain || 'none',
    posterior: {
      support: 0,
      map: prior,
    },
  }
}

function buildChainInsights(latestChain, transitions, prior) {
  const insights = []
  for (let n = 1; n <= MAX_NGRAM; n += 1) {
    if (latestChain.length < n) continue
    const chain = latestChain.slice(-n).join('|')
    const posterior = mapToResultProbabilities(
      transitions[n].get(chain),
      prior,
      10 + (MAX_NGRAM - n) * 8,
    )
    const ranked = [...RESULT_ORDER]
      .map((result) => ({
        result,
        probability: posterior.map[result],
      }))
      .sort((a, b) => b.probability - a.probability)

    insights.push({
      order: n,
      chain,
      support: posterior.support,
      topResult: ranked[0]?.result || 'Draw',
      probabilities: posterior.map,
      spread: roundNumber((ranked[0]?.probability || 0) - (ranked[1]?.probability || 0)),
    })
  }
  return insights.reverse()
}

function formatChainLabel(chain) {
  if (!chain || chain === 'none') return '--'
  return chain
    .split('|')
    .map((result) => RESULT_LABEL[result] || result)
    .join(' -> ')
}

function buildTopTotals(predictedResult, ngramPick, totalTransitions, resultTotals, theoryTotals) {
  const resultPosterior = countsToTotalPosterior(
    resultTotals.get(predictedResult),
    theoryTotals,
    24,
  )

  const totalPosterior = ngramPick.n > 0
    ? countsToTotalPosterior(
        totalTransitions[ngramPick.n].get(ngramPick.chain),
        resultPosterior.map,
        14,
      )
    : resultPosterior

  const ranked = [...theoryTotals.entries()]
    .map(([total, theoryProbability]) => {
      const conditioned = totalPosterior.map.get(total) || 0
      const resultBoost = total % 1 === 0 && classifyTotal(total) === predictedResult ? 1.08 : 0.35
      const score = conditioned * 0.75 + theoryProbability * 0.25 * resultBoost
      return {
        total,
        result: classifyTotal(total),
        probability: roundNumber(score),
        theoryProbability: roundNumber(theoryProbability),
      }
    })
    .filter((item) => item.result === predictedResult)
    .sort((a, b) => b.probability - a.probability)

  if (ranked.length >= 3) {
    return ranked.slice(0, 6).map((item) => ({
      ...item,
      score: roundNumber(item.probability * 100),
      sources: [
        {
          source: ngramPick.n > 0 ? `markov-${ngramPick.n}` : 'result-prior',
          probability: item.probability,
          support: totalPosterior.support,
        },
        {
          source: 'theory-bell',
          probability: item.theoryProbability,
          support: 216,
        },
      ],
    }))
  }

  return THEORY_TOTAL_ORDER
    .filter((total) => classifyTotal(total) === predictedResult)
    .slice(0, 6)
    .map((total) => ({
      total,
      result: predictedResult,
      probability: roundNumber(theoryTotals.get(total) || 0),
      score: roundNumber((theoryTotals.get(total) || 0) * 100),
      sources: [
        {
          source: 'theory-bell',
          probability: roundNumber(theoryTotals.get(total) || 0),
          support: 216,
        },
      ],
    }))
}

function selectRecommendedTotals(topTotals, predictedResult, theoryTotals) {
  if (predictedResult !== 'Draw') return topTotals.slice(0, 3)

  const drawTotals = topTotals.filter((item) => item.result === 'Draw').slice(0, 2)
  const centerSpillover = THEORY_TOTAL_ORDER
    .filter((total) => total === 9 || total === 12)
    .filter((total) => !drawTotals.some((item) => item.total === total))
    .slice(0, 1)
    .map((total) => ({
      total,
      result: classifyTotal(total),
      probability: roundNumber(theoryTotals.get(total) || 0),
      score: roundNumber((theoryTotals.get(total) || 0) * 100),
      sources: [
        {
          source: 'center-spillover',
          probability: roundNumber(theoryTotals.get(total) || 0),
          support: 216,
        },
      ],
    }))

  return [...drawTotals, ...centerSpillover].slice(0, 3)
}

function buildRecentBacktest(roundsDesc, evalRounds = BACKTEST_ROUNDS) {
  const windows = Math.min(evalRounds, Math.max(roundsDesc.length - 320, 0))
  let continuousHits = 0
  let selectiveBets = 0
  let selectiveHits = 0
  const recentQualified = []

  for (let offset = windows; offset >= 1; offset -= 1) {
    const trainRounds = roundsDesc.slice(offset, offset + BACKTEST_TRAIN_WINDOW)
    const actual = roundsDesc[offset - 1]
    if (!actual || trainRounds.length < 320) continue
    const prediction = buildPrediction(trainRounds, { disableBacktest: true })
    const predicted = prediction.diagnosis?.mostLikelyResult
    const shouldBet = prediction.selectiveStrategy?.currentDecision?.shouldBet
    const hit = predicted === actual.result

    if (hit) continuousHits += 1
    if (shouldBet) {
      selectiveBets += 1
      if (hit) selectiveHits += 1
      recentQualified.push({
        id: actual.id,
        predicted,
        actual: actual.result,
        outcome: hit ? 'Trúng' : 'Trượt',
      })
    }
  }

  return {
    evaluatedRounds: windows,
    continuousHitRate: windows ? roundNumber(continuousHits / windows) : 0,
    selectiveHitRate: selectiveBets ? roundNumber(selectiveHits / selectiveBets) : 0,
    selectiveBets,
    recentQualified: recentQualified.slice(-8).reverse(),
  }
}

export function buildPrediction(rounds, options = {}) {
  const roundsDesc = Array.isArray(rounds) ? rounds : []
  const theoryTotals = buildTheoryTotalMap()
  const empiricalPrior = buildEmpiricalResultPrior(roundsDesc)
  const markov = buildMarkovState(roundsDesc)
  const latestRound = roundsDesc[0] || null

  if (!latestRound || markov.asc.length < 4) {
    return {
      methodology: {
        note: 'Markov result predictor with theory total fallback.',
        model: { id: 'predictor_v5', label: 'Markov Transition V5' },
      },
      dataset: {
        totalRounds: roundsDesc.length,
        latestRound,
      },
      diagnosis: {
        mostLikelyResult: 'Draw',
        resultProbabilities: empiricalPrior.prior,
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
      betPortfolio: {
        decision: 'SKIP',
        highHit: { totals: [] },
      },
    }
  }

  const ngramPick = pickBestNgram(markov.latestChain, markov.transitions, empiricalPrior.prior)
  const chainInsights = buildChainInsights(
    markov.latestChain,
    markov.transitions,
    empiricalPrior.prior,
  )
  const centerPressure = buildCenterPressure(roundsDesc)
  const resultProbabilitiesRaw = { ...ngramPick.posterior.map }
  if (centerPressure >= 0.5) {
    resultProbabilitiesRaw.Draw += centerPressure * 0.08
    resultProbabilitiesRaw.Small *= 1 - centerPressure * 0.06
    resultProbabilitiesRaw.Big *= 1 - centerPressure * 0.06
  }
  const resultProbabilities = mapToResultProbabilities(new Map(), resultProbabilitiesRaw, 0).map
  const rankedResults = [...RESULT_ORDER]
    .map((result) => ({
      result,
      probability: resultProbabilities[result],
    }))
    .sort((a, b) => b.probability - a.probability)

  const mostLikelyResult = rankedResults[0]?.result || 'Draw'
  const topProbability = rankedResults[0]?.probability || 0
  const spread = topProbability - (rankedResults[1]?.probability || 0)
  const topTotals = buildTopTotals(
    mostLikelyResult,
    ngramPick,
    markov.totalTransitions,
    markov.resultTotals,
    theoryTotals,
  )

  const gateChecks = [
    {
      label: 'N-gram support',
      pass: ngramPick.posterior.support >= (MIN_SUPPORT[ngramPick.n] || 0),
      value: ngramPick.posterior.support,
      threshold: MIN_SUPPORT[ngramPick.n] || 0,
      detail: 'Chuỗi Markov phải có đủ support để đáng tin.',
    },
    {
      label: 'Top probability',
      pass: topProbability >= 0.44,
      value: roundNumber(topProbability * 100, 4),
      threshold: 44,
      detail: 'Xác suất lớp kết quả theo Markov phải đủ rõ.',
    },
    {
      label: 'Spread',
      pass: spread >= 0.05,
      value: roundNumber(spread * 100, 4),
      threshold: 5,
      detail: 'Top 1 phải tách Top 2 để tránh over-read pattern.',
    },
  ]

  const shouldBet = gateChecks.every((item) => item.pass)
  const validation = options.disableBacktest
    ? {
        evaluatedRounds: 0,
        continuousHitRate: 0,
        selectiveHitRate: 0,
        selectiveBets: 0,
        recentQualified: [],
      }
    : buildRecentBacktest(roundsDesc)

  const resultBreakdown = rankedResults.map((item) => ({
    result: item.result,
    probability: roundNumber(item.probability * 100, 4),
  }))

  return {
    methodology: {
      note: 'V5 uses Markov transition analysis on result sequences (1-gram to 3-gram) with support-aware backoff. Theory totals are used only as a secondary bell-curve anchor.',
      caution:
        'V5 does not assume >80% long-run accuracy is possible on a fair system. It looks for temporary imbalance in short-term result transitions only.',
      model: {
        id: 'predictor_v5',
        label: 'Markov Transition V5',
      },
      priors: empiricalPrior,
      markov: {
        selectedOrder: ngramPick.n,
        selectedChain: ngramPick.chain,
        selectedChainLabel: formatChainLabel(ngramPick.chain),
        support: ngramPick.posterior.support,
        chainInsights,
      },
      validation: {
        continuousHitRate: validation.continuousHitRate,
        selectiveHitRate: validation.selectiveHitRate,
        selectiveBets: validation.selectiveBets,
        evaluatedRounds: validation.evaluatedRounds,
      },
    },
    dataset: {
      totalRounds: roundsDesc.length,
      recentRounds: Math.min(RECENT_WINDOW, roundsDesc.length),
      latestDayKey: latestRound.sourceDate || null,
      latestDayRounds: null,
      latestRound: {
        id: latestRound.id,
        total: latestRound.total,
        dice: latestRound.dice,
        result: latestRound.result || classifyTotal(Number(latestRound.total)),
        time: latestRound.time,
        pattern: markov.latestChain.join(' -> '),
      },
    },
    diagnosis: {
      mostLikelyResult,
      resultProbabilities,
      topTotals,
      topExactDice: [],
      topFaces: [],
      confidenceModel: {
        confidenceScore: roundNumber(topProbability * 55 + spread * 260 + clamp(ngramPick.posterior.support / 50, 0, 1) * 15, 4),
        topProbability: roundNumber(topProbability * 100, 4),
        spread: roundNumber(spread * 100, 4),
        ngramOrder: ngramPick.n,
        support: ngramPick.posterior.support,
        selectedChainLabel: formatChainLabel(ngramPick.chain),
        chainInsights,
      },
      confidenceSpread: roundNumber(spread),
      recommendations: [
        `Chuỗi hiện tại: ${ngramPick.chain || 'none'}`,
        `Markov bậc ${ngramPick.n} đang nghiêng về ${RESULT_LABEL[mostLikelyResult]}.`,
        `Top totals bám phân phối chuông, ưu tiên cụm gần 10-11-9-12 trong lớp kết quả đã chọn.`,
      ],
    },
    selectiveStrategy: {
      currentDecision: {
        decision: shouldBet ? 'BET' : 'SKIP',
        shouldBet,
        recommendedResult: mostLikelyResult,
        recommendedTotals: selectRecommendedTotals(topTotals, mostLikelyResult, theoryTotals),
        topProbability: roundNumber(topProbability * 100, 4),
        spread: roundNumber(spread * 100, 4),
        drawProbability: roundNumber((resultProbabilities.Draw || 0) * 100, 4),
        confidenceBand:
          shouldBet && topProbability >= 0.48 ? 'Markov sáng' :
          shouldBet ? 'Có thể vào' : 'Quan sát',
        confidenceScore: roundNumber(topProbability * 55 + spread * 260, 4),
        gateChecks,
        resultBreakdown,
        consensusTotals: topTotals.slice(0, 4).map((item) => ({
          total: item.total,
          result: item.result,
          averageProbability: roundNumber(item.probability * 100, 4),
          sources: item.sources,
        })),
        summary: shouldBet
          ? `V5 chọn ${RESULT_LABEL[mostLikelyResult]} từ chuỗi Markov ${ngramPick.chain}.`
          : `V5 thấy chuỗi ${ngramPick.chain} chưa đủ tách biệt để vào lệnh.`,
        rationale: [
          `Order: ${ngramPick.n}`,
          `Support: ${ngramPick.posterior.support}`,
          `Top result: ${RESULT_LABEL[mostLikelyResult]} ${roundNumber(topProbability * 100, 2)}%`,
          `Center pressure: ${roundNumber(centerPressure * 100, 2)}%`,
        ],
        chainInsights,
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
      recommendedResult: mostLikelyResult,
      highHit: {
        summary: shouldBet
          ? `Ưu tiên ${RESULT_LABEL[mostLikelyResult]}, tập trung các tổng ${selectRecommendedTotals(topTotals, mostLikelyResult, theoryTotals).map((item) => item.total).join(', ')}.`
          : 'Markov chưa có lợi thế đủ lớn để dồn lệnh.',
        resultRange: RESULT_LABEL[mostLikelyResult],
        totals: selectRecommendedTotals(topTotals, mostLikelyResult, theoryTotals),
        singleFaces: [],
        exactDoubles: [],
      },
      highPayout: {
        summary: 'V5 không lấy exact dice làm lõi. Nó chỉ dùng Markov cho Lớn/Nhỏ/Hòa và chuông xác suất cho tổng.',
        anyTriple: { status: 'SKIP', score: 0 },
        exactTriples: [],
        tripleHotHours: [],
      },
    },
    analytics: {
      v5: {
        selectedOrder: ngramPick.n,
        selectedChain: ngramPick.chain,
        support: ngramPick.posterior.support,
      },
    },
    distributions: {
      totals: Object.fromEntries(topTotals.map((item) => [item.total, item.probability])),
    },
  }
}
