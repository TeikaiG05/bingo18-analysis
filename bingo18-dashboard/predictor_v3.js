const RESULT_ORDER = ['Small', 'Draw', 'Big']
const SESSION_BREAK_MS = 12 * 60 * 1000
const RECENT_WINDOW = 240
const SESSION_WINDOW = 120
const BACKTEST_ROUNDS = 8
const BACKTEST_MIN_TRAIN = 300
const BACKTEST_TRAIN_WINDOW = 2400

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function parseTimeMs(value) {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function stateKey(round) {
  return `${round.result}:${round.total}`
}

function roundProbability(value) {
  return Number(value.toFixed(6))
}

function normalizeTotalsMap(totalsMap) {
  let sum = 0
  for (const value of totalsMap.values()) {
    sum += Math.max(0, value)
  }

  const normalized = new Map()
  const divisor = sum || 1
  for (const [total, value] of totalsMap.entries()) {
    normalized.set(total, Math.max(0, value) / divisor)
  }
  return normalized
}

function mapFromObject(source) {
  const map = new Map()
  for (const [key, value] of Object.entries(source || {})) {
    map.set(Number(key), Number(value) || 0)
  }
  return map
}

function incrementNestedMap(outer, key, valueKey) {
  if (!outer.has(key)) outer.set(key, new Map())
  const inner = outer.get(key)
  inner.set(valueKey, (inner.get(valueKey) || 0) + 1)
}

function buildTheoryTotalMap() {
  const counts = new Map()
  let totalCombos = 0

  for (let d1 = 1; d1 <= 6; d1 += 1) {
    for (let d2 = 1; d2 <= 6; d2 += 1) {
      for (let d3 = 1; d3 <= 6; d3 += 1) {
        const total = d1 + d2 + d3
        counts.set(total, (counts.get(total) || 0) + 1)
        totalCombos += 1
      }
    }
  }

  const probabilities = new Map()
  for (const [total, count] of counts.entries()) {
    probabilities.set(total, count / totalCombos)
  }
  return probabilities
}

function countsToPosterior(counts, priorMap, alpha = 18) {
  const totals = [...priorMap.keys()]
  const countMap = counts instanceof Map ? counts : mapFromObject(counts || {})
  let support = 0
  for (const value of countMap.values()) {
    support += Number(value) || 0
  }

  const posterior = new Map()
  const denominator = support + alpha
  for (const total of totals) {
    const count = countMap.get(total) || 0
    const prior = priorMap.get(total) || 0
    posterior.set(total, denominator > 0 ? (count + alpha * prior) / denominator : prior)
  }

  return {
    map: normalizeTotalsMap(posterior),
    support,
  }
}

function aggregateResultProbabilities(totalMap) {
  const resultMap = { Small: 0, Draw: 0, Big: 0 }
  for (const [total, probability] of totalMap.entries()) {
    resultMap[classifyTotal(total)] += probability
  }
  return {
    Small: roundProbability(resultMap.Small || 0),
    Draw: roundProbability(resultMap.Draw || 0),
    Big: roundProbability(resultMap.Big || 0),
  }
}

function blendComponentMaps(components, priorMap) {
  const scoreMap = new Map()
  const contributions = new Map()

  for (const total of priorMap.keys()) {
    scoreMap.set(total, 0)
    contributions.set(total, [])
  }

  let totalWeight = 0
  for (const component of components) {
    const weight = Number(component.weight || 0)
    if (weight <= 0 || !(component.map instanceof Map)) continue
    totalWeight += weight
    for (const total of priorMap.keys()) {
      const probability = component.map.get(total) || 0
      scoreMap.set(total, scoreMap.get(total) + probability * weight)
      contributions.get(total).push({
        source: component.label,
        probability: roundProbability(probability),
        support: component.support || 0,
        weight: roundProbability(weight),
      })
    }
  }

  if (totalWeight <= 0) {
    return {
      totals: new Map(priorMap),
      contributions,
    }
  }

  const blended = new Map()
  for (const total of priorMap.keys()) {
    blended.set(total, (scoreMap.get(total) || 0) / totalWeight)
  }

  return {
    totals: normalizeTotalsMap(blended),
    contributions,
  }
}

function confidenceBand(topProbability, spread, shouldBet) {
  if (shouldBet && topProbability >= 0.48 && spread >= 0.1) return 'Kỷ luật cao'
  if (topProbability >= 0.43 && spread >= 0.07) return 'Có thể vào'
  if (topProbability >= 0.4) return 'Quan sát'
  return 'Rất thận trọng'
}

function toAscWithSessions(roundsDesc) {
  const asc = [...(Array.isArray(roundsDesc) ? roundsDesc : [])]
    .filter((round) => round && Number.isFinite(Number(round.total)))
    .reverse()
    .map((round) => ({
      ...round,
      result: round.result || classifyTotal(Number(round.total)),
      total: Number(round.total),
      timeMs: parseTimeMs(round.time),
    }))

  let sessionId = 0
  let previous = null
  for (const round of asc) {
    if (!previous) {
      round.sessionId = sessionId
      previous = round
      continue
    }

    const gapMs =
      Number.isFinite(round.timeMs) && Number.isFinite(previous.timeMs)
        ? Math.max(0, round.timeMs - previous.timeMs)
        : 0

    if (gapMs > SESSION_BREAK_MS) {
      sessionId += 1
    }

    round.sessionId = sessionId
    previous = round
  }

  return asc
}

function buildTrainingState(roundsDesc) {
  const asc = toAscWithSessions(roundsDesc)
  const theoryTotals = buildTheoryTotalMap()
  const globalPosterior = countsToPosterior(
    asc.reduce((map, round) => {
      map.set(round.total, (map.get(round.total) || 0) + 1)
      return map
    }, new Map()),
    theoryTotals,
    96,
  )

  const recentRounds = asc.slice(-RECENT_WINDOW)
  const recentPosterior = countsToPosterior(
    recentRounds.reduce((map, round) => {
      map.set(round.total, (map.get(round.total) || 0) + 1)
      return map
    }, new Map()),
    globalPosterior.map,
    42,
  )

  const latestRound = asc[asc.length - 1] || null
  const latestSessionId = latestRound?.sessionId ?? null
  const latestSessionRounds = latestRound
    ? asc.filter((round) => round.sessionId === latestSessionId)
    : []
  const sessionPosterior = countsToPosterior(
    latestSessionRounds.slice(-SESSION_WINDOW).reduce((map, round) => {
      map.set(round.total, (map.get(round.total) || 0) + 1)
      return map
    }, new Map()),
    recentPosterior.map,
    24,
  )

  const afterResultCounts = new Map()
  const afterTotalCounts = new Map()
  const contextCounts = {
    1: new Map(),
    2: new Map(),
    3: new Map(),
  }

  for (let index = 1; index < asc.length; index += 1) {
    const previous = asc[index - 1]
    const current = asc[index]
    if (previous.sessionId !== current.sessionId) continue

    incrementNestedMap(afterResultCounts, previous.result, current.total)
    incrementNestedMap(afterTotalCounts, previous.total, current.total)

    const sessionPrefix = asc
      .slice(0, index)
      .filter((round) => round.sessionId === current.sessionId)
    const states = sessionPrefix.map(stateKey)

    for (let length = 1; length <= 3; length += 1) {
      if (states.length < length) continue
      const key = states.slice(-length).join('|')
      incrementNestedMap(contextCounts[length], key, current.total)
    }
  }

  return {
    asc,
    latestRound,
    latestSessionRounds,
    theoryTotals,
    globalPosterior,
    recentPosterior,
    sessionPosterior,
    afterResultCounts,
    afterTotalCounts,
    contextCounts,
  }
}

function buildCorePrediction(roundsDesc) {
  const training = buildTrainingState(roundsDesc)
  const {
    asc,
    latestRound,
    latestSessionRounds,
    theoryTotals,
    globalPosterior,
    recentPosterior,
    sessionPosterior,
    afterResultCounts,
    afterTotalCounts,
    contextCounts,
  } = training

  if (!latestRound) {
    return {
      topTotals: [],
      resultProbabilities: { Small: 0, Draw: 0, Big: 0 },
      mostLikelyResult: 'Draw',
      confidenceScore: 0,
      topProbability: 0,
      spread: 0,
      drawProbability: 0,
      gateChecks: [],
      components: [],
      contextSupport: 0,
      sessionContinuity: 0,
      latestRound: null,
    }
  }

  const latestStates = latestSessionRounds.map(stateKey)
  const contextParts = []
  for (const length of [3, 2, 1]) {
    if (latestStates.length < length) continue
    const key = latestStates.slice(-length).join('|')
    const posterior = countsToPosterior(
      contextCounts[length].get(key) || new Map(),
      sessionPosterior.map,
      12 + length * 4,
    )
    contextParts.push({
      label: `context-${length}`,
      map: posterior.map,
      support: posterior.support,
      weight: [0, 0.12, 0.18, 0.24][length] * clamp(posterior.support / (posterior.support + 12), 0.15, 1),
    })
  }

  const afterResultPosterior = countsToPosterior(
    afterResultCounts.get(latestRound.result) || new Map(),
    recentPosterior.map,
    18,
  )
  const afterTotalPosterior = countsToPosterior(
    afterTotalCounts.get(latestRound.total) || new Map(),
    recentPosterior.map,
    18,
  )

  const components = [
    { label: 'theory', map: theoryTotals, support: asc.length, weight: 0.08 },
    {
      label: 'global',
      map: globalPosterior.map,
      support: globalPosterior.support,
      weight: 0.16,
    },
    {
      label: 'recent-240',
      map: recentPosterior.map,
      support: recentPosterior.support,
      weight: 0.15,
    },
    {
      label: 'session',
      map: sessionPosterior.map,
      support: sessionPosterior.support,
      weight: 0.12 * clamp(sessionPosterior.support / 40, 0.35, 1),
    },
    {
      label: `after-result:${latestRound.result}`,
      map: afterResultPosterior.map,
      support: afterResultPosterior.support,
      weight: 0.13 * clamp(afterResultPosterior.support / (afterResultPosterior.support + 16), 0.2, 1),
    },
    {
      label: `after-total:${latestRound.total}`,
      map: afterTotalPosterior.map,
      support: afterTotalPosterior.support,
      weight: 0.12 * clamp(afterTotalPosterior.support / (afterTotalPosterior.support + 16), 0.2, 1),
    },
    ...contextParts,
  ]

  const blended = blendComponentMaps(components, theoryTotals)
  const topTotals = [...blended.totals.entries()]
    .map(([total, probability]) => ({
      total,
      result: classifyTotal(total),
      probability: roundProbability(probability),
      score: roundProbability(probability * 100),
      support: Math.max(
        0,
        ...blended.contributions.get(total).map((item) => Number(item.support || 0)),
      ),
      sources: blended.contributions
        .get(total)
        .filter((item) => item.weight >= 0.05)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 4),
    }))
    .sort((a, b) => b.probability - a.probability)

  const resultProbabilities = aggregateResultProbabilities(blended.totals)
  const rankedResults = [...RESULT_ORDER]
    .map((result) => ({
      result,
      probability: resultProbabilities[result],
    }))
    .sort((a, b) => b.probability - a.probability)

  const mostLikelyResult = rankedResults[0]?.result || 'Draw'
  const topProbability = rankedResults[0]?.probability || 0
  const spread = (rankedResults[0]?.probability || 0) - (rankedResults[1]?.probability || 0)
  const drawProbability = resultProbabilities.Draw || 0
  const contextSupport = Math.max(0, ...contextParts.map((item) => item.support || 0))
  const sessionContinuity = clamp(latestSessionRounds.length / 18, 0, 1)
  const confidenceScore =
    topProbability * 55 +
    spread * 240 +
    clamp(contextSupport / 14, 0, 1) * 18 +
    sessionContinuity * 10 -
    drawProbability * 12

  const gateChecks = [
    {
      label: 'Top probability',
      pass: topProbability >= 0.43,
      value: roundProbability(topProbability * 100),
      threshold: 43,
      detail: 'Xác suất lớp kết quả đứng đầu cần vượt ngưỡng hành động.',
    },
    {
      label: 'Top spread',
      pass: spread >= 0.07,
      value: roundProbability(spread * 100),
      threshold: 7,
      detail: 'Chênh lệch Top 1 và Top 2 phải đủ rộng để tránh nhiễu.',
    },
    {
      label: 'Context support',
      pass: contextSupport >= 10,
      value: contextSupport,
      threshold: 10,
      detail: 'Mẫu ngữ cảnh phải đủ dày để cho phép tin vào backoff context.',
    },
    {
      label: 'Draw pressure',
      pass: drawProbability <= 0.29,
      value: roundProbability(drawProbability * 100),
      threshold: 29,
      detail: 'Áp lực Hòa cao sẽ chặn lệnh để giảm đảo pha.',
    },
    {
      label: 'Session continuity',
      pass: sessionContinuity >= 0.42,
      value: roundProbability(sessionContinuity * 100),
      threshold: 42,
      detail: 'Không nối chuỗi mạnh qua phiên đứt quãng.',
    },
  ]

  const shouldBet = gateChecks.every((item) => item.pass)

  return {
    topTotals,
    resultProbabilities,
    mostLikelyResult,
    confidenceScore: roundProbability(confidenceScore),
    topProbability: roundProbability(topProbability),
    spread: roundProbability(spread),
    drawProbability: roundProbability(drawProbability),
    gateChecks,
    shouldBet,
    decision: shouldBet ? 'BET' : 'SKIP',
    components: components
      .filter((item) => item.weight > 0.03)
      .map((item) => ({
        label: item.label,
        support: item.support,
        weight: roundProbability(item.weight),
      })),
    contextSupport,
    sessionContinuity: roundProbability(sessionContinuity),
    latestRound,
    latestSessionLength: latestSessionRounds.length,
  }
}

function buildRecentBacktest(roundsDesc, evalRounds = BACKTEST_ROUNDS) {
  const samples = []
  let selectiveBets = 0
  let selectiveHits = 0

  const maxRounds = Math.min(evalRounds, Math.max(roundsDesc.length - BACKTEST_MIN_TRAIN, 0))
  for (let offset = maxRounds; offset >= 1; offset -= 1) {
    const trainRounds = roundsDesc.slice(offset, offset + BACKTEST_TRAIN_WINDOW)
    const actual = roundsDesc[offset - 1]
    if (!actual || trainRounds.length < BACKTEST_MIN_TRAIN) continue

    const prediction = buildCorePrediction(trainRounds)
    const hit = prediction.mostLikelyResult === actual.result

    if (prediction.shouldBet) {
      selectiveBets += 1
      if (prediction.mostLikelyResult === actual.result) selectiveHits += 1
    }

    samples.push({
      id: actual.id,
      predicted: prediction.mostLikelyResult,
      actual: actual.result,
      topProbability: prediction.topProbability,
      spread: prediction.spread,
      decision: prediction.decision,
      hit,
    })
  }

  return {
    evaluatedRounds: samples.length,
    continuousHitRate: samples.length
      ? roundProbability(
          samples.filter((item) => item.hit).length / samples.length,
        )
      : 0,
    selectiveBets,
    selectiveHitRate: selectiveBets
      ? roundProbability(selectiveHits / selectiveBets)
      : 0,
    recentQualified: samples
      .filter((item) => item.decision === 'BET')
      .slice(-8)
      .reverse()
      .map((item) => ({
        id: item.id,
        predicted: item.predicted,
        actual: item.actual,
        outcome: item.hit ? 'Trúng' : 'Trượt',
        topProbability: roundProbability(item.topProbability * 100),
        spread: roundProbability(item.spread * 100),
      })),
    missedBets: samples
      .filter((item) => item.decision === 'BET' && !item.hit)
      .slice(-5)
      .reverse()
      .map((item) => ({
        id: item.id,
        predicted: item.predicted,
        actual: item.actual,
        reason: 'Ngữ cảnh cùng pha nhưng thực tế đảo khỏi cụm ưu tiên.',
      })),
  }
}

function buildBetPortfolio(core) {
  const resultLabel = { Small: 'Nhỏ', Draw: 'Hòa', Big: 'Lớn' }[core.mostLikelyResult] || '--'
  return {
    decision: core.decision,
    recommendedResult: core.mostLikelyResult,
    highHit: {
      summary:
        core.shouldBet
          ? `V3 ưu tiên ${resultLabel}, rồi mới siết 2 tổng có xác suất hội tụ cao nhất.`
          : 'V3 đang chặn lệnh vì ngữ cảnh hoặc độ phân tách chưa đủ đẹp.',
      resultRange: resultLabel,
      totals: core.topTotals.slice(0, 3),
      singleFaces: [],
      exactDoubles: [],
    },
    highPayout: {
      summary: 'V3 không lấy exact dice làm lõi quyết định. Các kèo nhân lớn chỉ để tham khảo.',
      anyTriple: {
        status: 'SKIP',
        score: 0,
        overallRate: 0,
        recentRate: 0,
        todayRate: 0,
        hotHour: null,
        hotHourScore: null,
      },
      exactTriples: [],
      tripleHotHours: [],
    },
  }
}

export function buildPrediction(rounds, options = {}) {
  const roundsDesc = Array.isArray(rounds) ? rounds : []
  const core = buildCorePrediction(roundsDesc)
  const backtest = buildRecentBacktest(
    roundsDesc,
    options.backtestRounds ?? BACKTEST_ROUNDS,
  )

  const resultBreakdown = RESULT_ORDER.map((result) => ({
    result,
    probability: roundProbability((core.resultProbabilities[result] || 0) * 100),
  })).sort((a, b) => b.probability - a.probability)

  const recommendedTotals = core.topTotals
    .filter((item) => item.result === core.mostLikelyResult)
    .slice(0, 3)

  return {
    methodology: {
      note: 'Session-aware context backoff engine using theory prior, recent drift, last-result transition, last-total transition, and 1-3 step context with empirical shrinkage.',
      caution:
        'V3 giảm mạnh feature giờ/ngày để tránh overfit. Nó ưu tiên ngữ cảnh trong cùng phiên và sẽ bỏ lệnh khi draw pressure hoặc session break quá lớn.',
      model: {
        id: 'predictor_v3',
        label: 'Session-Aware Context Backoff V3',
      },
      config: {
        sessionBreakMinutes: SESSION_BREAK_MS / 60000,
        recentWindow: RECENT_WINDOW,
        sessionWindow: SESSION_WINDOW,
        backtestRounds: options.backtestRounds ?? BACKTEST_ROUNDS,
      },
      components: core.components,
      validation: {
        continuousHitRate: backtest.continuousHitRate,
        selectiveHitRate: backtest.selectiveHitRate,
        selectiveBets: backtest.selectiveBets,
        evaluatedRounds: backtest.evaluatedRounds,
      },
    },
    dataset: {
      totalRounds: roundsDesc.length,
      recentRounds: Math.min(RECENT_WINDOW, roundsDesc.length),
      latestDayKey: core.latestRound?.sourceDate || null,
      latestDayRounds: core.latestSessionLength,
      latestRound: core.latestRound
        ? {
            id: core.latestRound.id,
            total: core.latestRound.total,
            dice: core.latestRound.dice,
            result: core.latestRound.result,
            time: core.latestRound.time,
            pattern: stateKey(core.latestRound),
          }
        : null,
    },
    diagnosis: {
      mostLikelyResult: core.mostLikelyResult,
      resultProbabilities: core.resultProbabilities,
      topTotals: core.topTotals.slice(0, 6),
      topExactDice: [],
      topFaces: [],
      confidenceModel: {
        confidenceScore: core.confidenceScore,
        topProbability: roundProbability(core.topProbability * 100),
        spread: roundProbability(core.spread * 100),
        contextSupport: core.contextSupport,
        sessionContinuity: roundProbability(core.sessionContinuity * 100),
      },
      confidenceSpread: core.spread,
      recommendations: core.gateChecks
        .filter((item) => !item.pass)
        .map((item) => `${item.label}: ${item.detail}`),
    },
    selectiveStrategy: {
      currentDecision: {
        decision: core.decision,
        shouldBet: core.shouldBet,
        recommendedResult: core.mostLikelyResult,
        recommendedTotals,
        topProbability: roundProbability(core.topProbability * 100),
        spread: roundProbability(core.spread * 100),
        drawProbability: roundProbability(core.drawProbability * 100),
        confidenceBand: confidenceBand(core.topProbability, core.spread, core.shouldBet),
        confidenceScore: core.confidenceScore,
        gateChecks: core.gateChecks,
        resultBreakdown,
        consensusTotals: core.topTotals.slice(0, 4).map((item) => ({
          total: item.total,
          result: item.result,
          averageProbability: roundProbability(item.probability * 100),
          sources: item.sources,
        })),
        summary: core.shouldBet
          ? `V3 cho phép vào ${core.mostLikelyResult} vì top probability, spread và context support cùng vượt ngưỡng.`
          : 'V3 đang giữ an toàn vì ít nhất một chốt kiểm định chưa đạt.',
        rationale: core.gateChecks.map((item) =>
          `${item.pass ? 'PASS' : 'FAIL'} | ${item.label}: ${item.value}/${item.threshold}`,
        ),
        score: core.confidenceScore,
        contextSupport: core.contextSupport,
        sessionContinuity: roundProbability(core.sessionContinuity * 100),
      },
      backtest: {
        evaluatedRounds: backtest.evaluatedRounds,
        selectiveBets: backtest.selectiveBets,
        selectiveHitRate: roundProbability(backtest.selectiveHitRate * 100),
        continuousHitRate: roundProbability(backtest.continuousHitRate * 100),
      },
      recentQualified: backtest.recentQualified,
      review: {
        missedBets: backtest.missedBets,
      },
    },
    betPortfolio: buildBetPortfolio(core),
    analytics: {
      v3: {
        topProbability: roundProbability(core.topProbability * 100),
        spread: roundProbability(core.spread * 100),
        contextSupport: core.contextSupport,
        sessionContinuity: roundProbability(core.sessionContinuity * 100),
      },
    },
    distributions: {
      totals: Object.fromEntries(
        core.topTotals.map((item) => [item.total, item.probability]),
      ),
    },
  }
}
