const RESULT_ORDER = ['Small', 'Draw', 'Big']
const RESULT_LABEL = {
  Small: 'Nhỏ',
  Draw: 'Hòa',
  Big: 'Lớn',
}
const THEORY_RESULT_PRIOR = {
  Small: 81 / 216,
  Draw: 54 / 216,
  Big: 81 / 216,
}
const RECENT_RESULT_PRIOR_WINDOW = 360

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function roundNumber(value, digits = 6) {
  return Number(value.toFixed(digits))
}

function parseTimeMs(value) {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function determineJumpStyle(prev2, prev1) {
  if (!prev2 || !prev1) return 'unknown'
  if (prev2 === prev1) return `streak:${prev1}`
  if ((prev2 === 'Big' && prev1 === 'Small') || (prev2 === 'Small' && prev1 === 'Big')) {
    return 'flip:edge'
  }
  if (prev2 === 'Draw' || prev1 === 'Draw') {
    return 'draw:bridge'
  }
  return `mixed:${prev2}->${prev1}`
}

function incrementNestedMap(outer, key, valueKey) {
  if (!outer.has(key)) outer.set(key, new Map())
  const inner = outer.get(key)
  inner.set(valueKey, (inner.get(valueKey) || 0) + 1)
}

function countsMapToResultPrior(countsMap) {
  const support =
    RESULT_ORDER.reduce((sum, result) => sum + (countsMap?.get?.(result) || 0), 0) || 1
  const prior = {}
  for (const result of RESULT_ORDER) {
    prior[result] = (countsMap?.get?.(result) || 0) / support
  }
  return {
    support,
    prior,
  }
}

function buildHybridResultPrior(longRunCounts, recentCounts) {
  const longRun = countsMapToResultPrior(longRunCounts)
  const recent = countsMapToResultPrior(recentCounts)
  const theoryWeight = 0.06
  const longRunWeight = 0.58 * clamp(longRun.support / 4000, 0.65, 1)
  const recentWeight = 0.36 * clamp(recent.support / RECENT_RESULT_PRIOR_WINDOW, 0.25, 1)
  const totalWeight = theoryWeight + longRunWeight + recentWeight

  const blended = {}
  for (const result of RESULT_ORDER) {
    blended[result] =
      (THEORY_RESULT_PRIOR[result] * theoryWeight +
        longRun.prior[result] * longRunWeight +
        recent.prior[result] * recentWeight) /
      totalWeight
  }

  const sum = RESULT_ORDER.reduce((acc, result) => acc + blended[result], 0) || 1
  for (const result of RESULT_ORDER) {
    blended[result] = roundNumber(blended[result] / sum)
  }

  return {
    map: blended,
    components: {
      theory: THEORY_RESULT_PRIOR,
      longRun: longRun.prior,
      recent: recent.prior,
    },
    supports: {
      longRun: longRun.support,
      recent: recent.support,
    },
    weights: {
      theory: roundNumber(theoryWeight / totalWeight),
      longRun: roundNumber(longRunWeight / totalWeight),
      recent: roundNumber(recentWeight / totalWeight),
    },
  }
}

function mapToPosterior(countMap, priorMap, alpha = 12) {
  const posterior = {}
  let support = 0
  for (const value of countMap?.values?.() || []) {
    support += Number(value) || 0
  }

  const denominator = support + alpha
  for (const result of RESULT_ORDER) {
    const count = countMap?.get?.(result) || 0
    const prior = priorMap[result] || 0
    posterior[result] = denominator > 0 ? (count + alpha * prior) / denominator : prior
  }

  const total = RESULT_ORDER.reduce((sum, result) => sum + posterior[result], 0) || 1
  for (const result of RESULT_ORDER) {
    posterior[result] /= total
  }

  return {
    support,
    map: posterior,
  }
}

function buildGlobalTotalsPrior() {
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

function countsToTotalPosterior(counts, priorMap, alpha = 20) {
  const support = [...(counts?.values?.() || [])].reduce((acc, value) => acc + (Number(value) || 0), 0)
  const result = new Map()
  const denominator = support + alpha
  for (const [total, prior] of priorMap.entries()) {
    const count = counts?.get?.(total) || 0
    result.set(total, denominator > 0 ? (count + alpha * prior) / denominator : prior)
  }
  const sum = [...result.values()].reduce((acc, value) => acc + value, 0) || 1
  for (const [total, value] of result.entries()) {
    result.set(total, value / sum)
  }
  return {
    support,
    map: result,
  }
}

function blendResultMaps(parts) {
  const scores = { Small: 0, Draw: 0, Big: 0 }
  let totalWeight = 0
  for (const part of parts) {
    const weight = Number(part.weight || 0)
    if (weight <= 0) continue
    totalWeight += weight
    for (const result of RESULT_ORDER) {
      scores[result] += (part.map?.[result] || 0) * weight
    }
  }

  if (totalWeight <= 0) {
    return { ...THEORY_RESULT_PRIOR }
  }

  for (const result of RESULT_ORDER) {
    scores[result] /= totalWeight
  }

  const sum = RESULT_ORDER.reduce((acc, result) => acc + scores[result], 0) || 1
  for (const result of RESULT_ORDER) {
    scores[result] = roundNumber(scores[result] / sum)
  }
  return scores
}

function blendTotalMaps(parts, priorMap) {
  const scores = new Map()
  let totalWeight = 0
  for (const total of priorMap.keys()) {
    scores.set(total, 0)
  }

  for (const part of parts) {
    const weight = Number(part.weight || 0)
    if (weight <= 0 || !(part.map instanceof Map)) continue
    totalWeight += weight
    for (const total of priorMap.keys()) {
      scores.set(total, scores.get(total) + (part.map.get(total) || 0) * weight)
    }
  }

  if (totalWeight <= 0) {
    return new Map(priorMap)
  }

  const blended = new Map()
  let sum = 0
  for (const [total, value] of scores.entries()) {
    const normalized = value / totalWeight
    blended.set(total, normalized)
    sum += normalized
  }
  sum ||= 1
  for (const [total, value] of blended.entries()) {
    blended.set(total, value / sum)
  }
  return blended
}

function topTotalsFromMap(totalMap, sourcesByTotal) {
  return [...totalMap.entries()]
    .map(([total, probability]) => ({
      total,
      result: classifyTotal(total),
      probability: roundNumber(probability),
      score: roundNumber(probability * 100),
      sources: (sourcesByTotal.get(total) || []).slice(0, 4),
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 6)
}

function selectRecommendedTotals(topTotals, mostLikelyResult) {
  if (mostLikelyResult !== 'Draw') {
    return topTotals.filter((item) => item.result === mostLikelyResult).slice(0, 3)
  }

  const drawTotals = topTotals.filter((item) => item.result === 'Draw').slice(0, 2)
  const centerSpillover = topTotals
    .filter((item) => item.result !== 'Draw' && (item.total === 9 || item.total === 12))
    .slice(0, 1)

  return [...drawTotals, ...centerSpillover].slice(0, 3)
}

function buildTraining(roundsDesc) {
  const asc = [...(Array.isArray(roundsDesc) ? roundsDesc : [])]
    .filter((round) => round && Number.isFinite(Number(round.total)))
    .reverse()
    .map((round) => ({
      ...round,
      total: Number(round.total),
      result: round.result || classifyTotal(Number(round.total)),
      timeMs: parseTimeMs(round.time),
    }))

  const transitionCounts = new Map()
  const pairCounts = new Map()
  const styleCounts = new Map()
  const pairTotalCounts = new Map()
  const afterResultTotalCounts = new Map()
  const resultTotals = new Map()
  const globalResults = new Map()
  const recentResults = new Map()

  for (const result of RESULT_ORDER) {
    resultTotals.set(result, new Map())
  }

  for (let index = 0; index < asc.length; index += 1) {
    const current = asc[index]
    globalResults.set(current.result, (globalResults.get(current.result) || 0) + 1)
    if (index >= Math.max(0, asc.length - RECENT_RESULT_PRIOR_WINDOW)) {
      recentResults.set(current.result, (recentResults.get(current.result) || 0) + 1)
    }
    const resultTotalMap = resultTotals.get(current.result)
    resultTotalMap.set(current.total, (resultTotalMap.get(current.total) || 0) + 1)

    if (index < 1) continue
    const prev1 = asc[index - 1]
    incrementNestedMap(transitionCounts, prev1.result, current.result)
    incrementNestedMap(afterResultTotalCounts, prev1.result, current.total)

    if (index < 2) continue
    const prev2 = asc[index - 2]
    const pairKey = `${prev2.result}|${prev1.result}`
    const styleKey = determineJumpStyle(prev2.result, prev1.result)
    incrementNestedMap(pairCounts, pairKey, current.result)
    incrementNestedMap(styleCounts, styleKey, current.result)
    incrementNestedMap(pairTotalCounts, pairKey, current.total)
  }

  const globalSupport = RESULT_ORDER.reduce((sum, result) => sum + (globalResults.get(result) || 0), 0) || 1
  const globalPrior = {}
  for (const result of RESULT_ORDER) {
    globalPrior[result] = (globalResults.get(result) || 0) / globalSupport
  }

  return {
    asc,
    latest: asc[asc.length - 1] || null,
    previous: asc[asc.length - 2] || null,
    transitionCounts,
    pairCounts,
    styleCounts,
    pairTotalCounts,
    afterResultTotalCounts,
    resultTotals,
    globalPrior,
    globalResults,
    recentResults,
  }
}

function buildRecentBacktest(roundsDesc, evalRounds = 8, trainWindow = 2200) {
  let continuousHits = 0
  let selectiveHits = 0
  let selectiveBets = 0
  const recentQualified = []

  const windows = Math.min(evalRounds, Math.max(roundsDesc.length - 280, 0))
  for (let offset = windows; offset >= 1; offset -= 1) {
    const trainRounds = roundsDesc.slice(offset, offset + trainWindow)
    const actual = roundsDesc[offset - 1]
    if (!actual || trainRounds.length < 280) continue
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
  const training = buildTraining(roundsDesc)
  const theoryTotals = buildGlobalTotalsPrior()
  const latest = training.latest
  const previous = training.previous

  if (!latest || !previous) {
    return {
      methodology: {
        model: { id: 'predictor_v4', label: 'Jump Analysis V4' },
      },
      dataset: {
        totalRounds: roundsDesc.length,
        latestRound: latest || null,
      },
      diagnosis: {
        mostLikelyResult: 'Draw',
        resultProbabilities: { ...THEORY_RESULT_PRIOR },
        topTotals: [],
      },
      selectiveStrategy: {
        currentDecision: {
          decision: 'SKIP',
          shouldBet: false,
          recommendedResult: 'Draw',
          recommendedTotals: [],
          gateChecks: [],
          jumpInsights: [],
        },
        recentQualified: [],
      },
      betPortfolio: {
        decision: 'SKIP',
        highHit: { totals: [] },
        highPayout: { exactTriples: [] },
      },
    }
  }

  const pairKey = `${previous.result}|${latest.result}`
  const styleKey = determineJumpStyle(previous.result, latest.result)
  const recentRounds = roundsDesc.slice(0, RECENT_RESULT_PRIOR_WINDOW)
  const resultHybridPrior = buildHybridResultPrior(
    training.globalResults,
    training.recentResults,
  )

  const transitionPosterior = mapToPosterior(
    training.transitionCounts.get(latest.result),
    resultHybridPrior.map,
    18,
  )
  const pairPosterior = mapToPosterior(
    training.pairCounts.get(pairKey),
    transitionPosterior.map,
    14,
  )
  const stylePosterior = mapToPosterior(
    training.styleCounts.get(styleKey),
    transitionPosterior.map,
    16,
  )
  const recentPosterior = {
    support: recentRounds.length,
    map: resultHybridPrior.components.recent,
  }

  const resultProbabilities = blendResultMaps([
    { label: 'hybrid-prior', map: resultHybridPrior.map, weight: 0.14 },
    {
      label: `after:${latest.result}`,
      map: transitionPosterior.map,
      weight: 0.28 * clamp(transitionPosterior.support / (transitionPosterior.support + 20), 0.25, 1),
    },
    {
      label: `pair:${pairKey}`,
      map: pairPosterior.map,
      weight: 0.34 * clamp(pairPosterior.support / (pairPosterior.support + 12), 0.15, 1),
    },
    {
      label: `style:${styleKey}`,
      map: stylePosterior.map,
      weight: 0.12 * clamp(stylePosterior.support / (stylePosterior.support + 12), 0.15, 1),
    },
    { label: 'recent-prior', map: recentPosterior.map, weight: 0.08 },
  ])

  const rankedResults = [...RESULT_ORDER]
    .map((result) => ({
      result,
      probability: resultProbabilities[result],
    }))
    .sort((a, b) => b.probability - a.probability)
  const mostLikelyResult = rankedResults[0]?.result || 'Draw'
  const topProbability = rankedResults[0]?.probability || 0
  const spread = topProbability - (rankedResults[1]?.probability || 0)
  const drawProbability = resultProbabilities.Draw || 0

  const resultPriorTotals = countsToTotalPosterior(
    training.resultTotals.get(mostLikelyResult),
    theoryTotals,
    28,
  )
  const afterResultTotals = countsToTotalPosterior(
    training.afterResultTotalCounts.get(latest.result),
    resultPriorTotals.map,
    18,
  )
  const pairTotals = countsToTotalPosterior(
    training.pairTotalCounts.get(pairKey),
    afterResultTotals.map,
    14,
  )

  const totalParts = [
    { label: `result:${mostLikelyResult}`, map: resultPriorTotals.map, weight: 0.34 },
    {
      label: `after:${latest.result}`,
      map: afterResultTotals.map,
      weight: 0.28 * clamp(afterResultTotals.support / (afterResultTotals.support + 20), 0.2, 1),
    },
    {
      label: `pair:${pairKey}`,
      map: pairTotals.map,
      weight: 0.38 * clamp(pairTotals.support / (pairTotals.support + 14), 0.18, 1),
    },
  ]

  const sourcesByTotal = new Map()
  for (const [total] of theoryTotals.entries()) {
    sourcesByTotal.set(total, [])
  }
  for (const part of totalParts) {
    for (const [total, probability] of part.map.entries()) {
      sourcesByTotal.get(total).push({
        source: part.label,
        probability: roundNumber(probability),
        weight: roundNumber(part.weight),
      })
    }
  }

  const topTotals = topTotalsFromMap(
    blendTotalMaps(totalParts, theoryTotals),
    sourcesByTotal,
  )

  const jumpInsights = [
    {
      label: `Sau ${RESULT_LABEL[latest.result]}`,
      support: transitionPosterior.support,
      summary: `Cầu 1 bước hiện nghiêng về ${RESULT_LABEL[rankedResults[0]?.result || 'Draw']}.`,
    },
    {
      label: `${RESULT_LABEL[previous.result]} -> ${RESULT_LABEL[latest.result]}`,
      support: pairPosterior.support,
      summary: `Cầu 2 bước ${RESULT_LABEL[previous.result]} -> ${RESULT_LABEL[latest.result]} đang cho xác suất cao nhất ở ${RESULT_LABEL[mostLikelyResult]}.`,
    },
    {
      label: `Style ${styleKey}`,
      support: stylePosterior.support,
      summary: `Nhóm nhảy cầu ${styleKey} đang phản hồi mạnh nhất về ${RESULT_LABEL[rankedResults[0]?.result || 'Draw']}.`,
    },
  ]

  const gateChecks = [
    {
      label: 'Pair support',
      pass: pairPosterior.support >= 24,
      value: pairPosterior.support,
      threshold: 24,
      detail: 'Mẫu nhảy cầu 2 bước phải đủ dày.',
    },
    {
      label: 'Top probability',
      pass: topProbability >= 0.42,
      value: roundNumber(topProbability * 100, 4),
      threshold: 42,
      detail: 'Xác suất hướng kế tiếp phải đủ rõ.',
    },
    {
      label: 'Spread',
      pass: spread >= 0.06,
      value: roundNumber(spread * 100, 4),
      threshold: 6,
      detail: 'Top 1 phải tách Top 2 đủ xa để tránh cầu giả.',
    },
    {
      label: mostLikelyResult === 'Draw' ? 'Draw conviction' : 'Draw pressure',
      pass: mostLikelyResult === 'Draw' ? drawProbability >= 0.24 : drawProbability <= 0.3,
      value: roundNumber(drawProbability * 100, 4),
      threshold: mostLikelyResult === 'Draw' ? 24 : 30,
      detail:
        mostLikelyResult === 'Draw'
          ? 'Khi chọn Hòa, xác suất Hòa phải tự đứng đủ rõ.'
          : 'Áp lực Hòa quá cao sẽ làm nhảy cầu kém sạch.',
    },
  ]

  const shouldBet = gateChecks.filter((item) => item.pass).length >= 3
  const validation = options.disableBacktest ? {
    evaluatedRounds: 0,
    continuousHitRate: 0,
    selectiveHitRate: 0,
    selectiveBets: 0,
    recentQualified: [],
  } : buildRecentBacktest(roundsDesc)

  const recommendedTotals = selectRecommendedTotals(topTotals, mostLikelyResult)
  const confidenceScore = roundNumber(
    topProbability * 54 +
      spread * 230 +
      clamp(pairPosterior.support / 40, 0, 1) * 20 -
      (mostLikelyResult === 'Draw' ? -drawProbability * -6 : drawProbability * 10),
    4,
  )

  return {
    methodology: {
      note: 'Jump-analysis engine focused on result transitions: after-result, 2-step jump pair, jump style family, and total distributions conditioned by jump pattern.',
      caution:
        'V4 không đánh theo nhịp giờ. Nó tập trung vào việc cầu hiện tại có đang đảo, hồi, hay nối tiếp sang lớp nào tiếp theo.',
      model: {
        id: 'predictor_v4',
        label: 'Jump Analysis V4',
      },
      jumpContext: {
        latestPair: pairKey,
        latestStyle: styleKey,
      },
      priors: {
        weights: resultHybridPrior.weights,
        longRun: resultHybridPrior.components.longRun,
        recent: resultHybridPrior.components.recent,
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
      recentRounds: recentRounds.length,
      latestDayKey: latest.sourceDate || null,
      latestDayRounds: null,
      latestRound: {
        id: latest.id,
        total: latest.total,
        dice: latest.dice,
        result: latest.result,
        time: latest.time,
        pattern: pairKey,
      },
    },
    diagnosis: {
      mostLikelyResult,
      resultProbabilities: Object.fromEntries(
        RESULT_ORDER.map((result) => [result, roundNumber(resultProbabilities[result])]),
      ),
      topTotals,
      topExactDice: [],
      topFaces: [],
      confidenceModel: {
        confidenceScore,
        topProbability: roundNumber(topProbability * 100, 4),
        spread: roundNumber(spread * 100, 4),
        pairSupport: pairPosterior.support,
        styleSupport: stylePosterior.support,
      },
      confidenceSpread: roundNumber(spread),
      recommendations: jumpInsights.map((item) => item.summary),
    },
    selectiveStrategy: {
      currentDecision: {
        decision: shouldBet ? 'BET' : 'SKIP',
        shouldBet,
        recommendedResult: mostLikelyResult,
        recommendedTotals,
        topProbability: roundNumber(topProbability * 100, 4),
        spread: roundNumber(spread * 100, 4),
        drawProbability: roundNumber(drawProbability * 100, 4),
        confidenceBand:
          shouldBet && topProbability >= 0.46 ? 'Nhảy cầu sáng' :
          shouldBet ? 'Có thể vào' : 'Quan sát thêm',
        confidenceScore,
        gateChecks,
        resultBreakdown: rankedResults.map((item) => ({
          result: item.result,
          probability: roundNumber(item.probability * 100, 4),
        })),
        consensusTotals: topTotals.slice(0, 4).map((item) => ({
          total: item.total,
          result: item.result,
          averageProbability: roundNumber(item.probability * 100, 4),
          sources: item.sources,
        })),
        summary: shouldBet
          ? `V4 cho rằng cầu ${RESULT_LABEL[previous.result]} -> ${RESULT_LABEL[latest.result]} đang sáng cho ${RESULT_LABEL[mostLikelyResult]}.`
          : `V4 thấy cầu hiện tại chưa đủ sạch để vào, nên tiếp tục quan sát nhịp ${RESULT_LABEL[previous.result]} -> ${RESULT_LABEL[latest.result]}.`,
        rationale: jumpInsights.map((item) => `${item.label}: ${item.summary}`),
        jumpInsights,
      },
      recentQualified: validation.recentQualified || [],
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
          ? `Ưu tiên các tổng ${recommendedTotals.map((item) => item.total).join(', ')} cùng hướng ${RESULT_LABEL[mostLikelyResult]}.`
          : 'Nhảy cầu chưa đồng thuận đủ mạnh để dồn lệnh.',
        resultRange: RESULT_LABEL[mostLikelyResult],
        totals: recommendedTotals,
        singleFaces: [],
        exactDoubles: [],
      },
      highPayout: {
        summary: 'V4 ưu tiên đọc cầu và lớp kết quả, không lấy exact dice làm lõi.',
        anyTriple: { status: 'SKIP', score: 0 },
        exactTriples: [],
        tripleHotHours: [],
      },
    },
    analytics: {
      v4: {
        pairSupport: pairPosterior.support,
        styleSupport: stylePosterior.support,
        jumpStyle: styleKey,
        latestPair: pairKey,
      },
    },
    distributions: {
      totals: Object.fromEntries(topTotals.map((item) => [item.total, item.probability])),
    },
  }
}
