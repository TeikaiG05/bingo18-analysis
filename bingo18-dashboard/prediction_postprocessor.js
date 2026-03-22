const RESULT_ORDER = ['Small', 'Draw', 'Big']
const TOTAL_PRIOR = {
  3: 1,
  4: 3,
  5: 6,
  6: 10,
  7: 15,
  8: 21,
  9: 25,
  10: 27,
  11: 27,
  12: 25,
  13: 21,
  14: 15,
  15: 10,
  16: 6,
  17: 3,
  18: 1,
}
const TOTAL_RANGE = Array.from({ length: 16 }, (_, index) => index + 3)
const TOTAL_RECOVERY_PROFILE = {
  3: 0.08,
  4: 0.14,
  5: 0.28,
  6: 0.44,
  7: 0.6,
  8: 0.78,
  9: 0.92,
  10: 1,
  11: 1,
  12: 0.92,
  13: 0.78,
  14: 0.62,
  15: 0.46,
  16: 0.3,
  17: 0.16,
  18: 0.08,
}
const TOTAL_DRAW_ESCAPE_PROFILE = {
  3: 0.04,
  4: 0.08,
  5: 0.16,
  6: 0.28,
  7: 0.44,
  8: 0.58,
  9: 0.2,
  10: -0.92,
  11: -0.92,
  12: 0.2,
  13: 0.58,
  14: 0.44,
  15: 0.28,
  16: 0.16,
  17: 0.08,
  18: 0.04,
}

export function classifyTotal(total) {
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

function normalizeUnitProbability(value, fallback = 0) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return numeric > 1 ? numeric / 100 : numeric
}

function safeDateKey(round) {
  const value =
    round?.sourceDate ??
    round?.rawSourceTime ??
    round?.time ??
    round?.processTime ??
    ''
  if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    return value
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return `${String(parsed.getUTCDate()).padStart(2, '0')}/${String(
    parsed.getUTCMonth() + 1,
  ).padStart(2, '0')}/${parsed.getUTCFullYear()}`
}

function normalizeScoreMap(scoreMap) {
  const normalized = new Map()
  let sum = 0
  for (const total of TOTAL_RANGE) {
    const score = Math.max(0.000001, Number(scoreMap.get(total) || 0))
    normalized.set(total, score)
    sum += score
  }

  const divisor = sum || 1
  for (const total of TOTAL_RANGE) {
    normalized.set(total, normalized.get(total) / divisor)
  }
  return normalized
}

function mapToFrequency(roundsDesc, limit, sameDayKey = null) {
  const scores = new Map(TOTAL_RANGE.map((total) => [total, 0]))
  let seen = 0

  for (const round of roundsDesc || []) {
    if (sameDayKey && safeDateKey(round) !== sameDayKey) continue
    const total = Number(round?.total)
    if (!Number.isFinite(total) || !scores.has(total)) continue
    const weight = 1 / (1 + seen * 0.14)
    scores.set(total, scores.get(total) + weight)
    seen += 1
    if (!sameDayKey && seen >= limit) break
    if (sameDayKey && seen >= limit) break
  }

  return normalizeScoreMap(scores)
}

function buildRecentCountMap(roundsDesc = [], limit = 12) {
  const counts = new Map(TOTAL_RANGE.map((total) => [total, 0]))
  ;(roundsDesc || [])
    .slice(0, limit)
    .forEach((round) => {
      const total = Number(round?.total)
      if (!Number.isFinite(total) || !counts.has(total)) return
      counts.set(total, counts.get(total) + 1)
    })
  return counts
}

function currentResultStreak(roundsDesc) {
  const latestResult =
    roundsDesc?.[0]?.result || classifyTotal(Number(roundsDesc?.[0]?.total))
  if (!latestResult) return { key: null, length: 0 }

  let length = 0
  for (const round of roundsDesc || []) {
    const result = round?.result || classifyTotal(Number(round?.total))
    if (result !== latestResult) break
    length += 1
  }

  return { key: latestResult, length }
}

function buildGapByTotal(roundsDesc = [], limit = 36) {
  const gapByTotal = new Map(TOTAL_RANGE.map((total) => [total, limit]))
  const recent = (roundsDesc || []).slice(0, limit)

  recent.forEach((round, index) => {
    const total = Number(round?.total)
    if (!Number.isFinite(total) || !gapByTotal.has(total)) return
    if (gapByTotal.get(total) === limit) {
      gapByTotal.set(total, index)
    }
  })

  return gapByTotal
}

function buildContext(roundsDesc = []) {
  const latestRound = roundsDesc?.[0] || null
  const latestTotal = Number(latestRound?.total)
  const latestResult =
    latestRound?.result ||
    (Number.isFinite(latestTotal) ? classifyTotal(latestTotal) : null)
  const latestDayKey = latestRound ? safeDateKey(latestRound) : null
  const recent12Totals = new Set(
    (roundsDesc || [])
      .slice(0, 12)
      .map((round) => Number(round?.total))
      .filter(Number.isFinite),
  )
  const recent24Totals = new Set(
    (roundsDesc || [])
      .slice(0, 24)
      .map((round) => Number(round?.total))
      .filter(Number.isFinite),
  )
  const recent6Totals = (roundsDesc || [])
    .slice(0, 6)
    .map((round) => Number(round?.total))
    .filter(Number.isFinite)
  const recent12CountMap = buildRecentCountMap(roundsDesc, 12)
  const centerCount6 = recent6Totals.filter((total) => total >= 9 && total <= 12).length
  const edgeCount6 = recent6Totals.filter((total) => total <= 5 || total >= 15).length

  return {
    latestTotal,
    latestResult,
    streak: currentResultStreak(roundsDesc),
    recent18: mapToFrequency(roundsDesc, 18),
    recent50: mapToFrequency(roundsDesc, 50),
    day: latestDayKey ? mapToFrequency(roundsDesc, 96, latestDayKey) : null,
    gapByTotal: buildGapByTotal(roundsDesc, 36),
    recent12Totals,
    recent24Totals,
    recent6Totals,
    recent12CountMap,
    centerShare6: recent6Totals.length ? centerCount6 / recent6Totals.length : 0,
    edgeShare6: recent6Totals.length ? edgeCount6 / recent6Totals.length : 0,
  }
}

function strengthForModel(modelId) {
  switch (String(modelId || '').toLowerCase()) {
    case 'v9':
    case 'predictor_v9':
      return 0.38
    case 'v8':
    case 'predictor_v8':
    case 'v7':
    case 'predictor_v7':
      return 0.74
    case 'local':
    case 'local-free':
      return 1
    default:
      return 0.92
  }
}

function uniqueRecords(records = []) {
  const seen = new Set()
  return records.filter((item) => {
    const total = Number(item?.total)
    if (!Number.isFinite(total) || seen.has(total)) return false
    seen.add(total)
    return true
  })
}

function buildScoreMapFromRecords(records = []) {
  const scoreMap = new Map(
    TOTAL_RANGE.map((total) => [total, ((TOTAL_PRIOR[total] || 1) / 216) * 0.035]),
  )

  uniqueRecords(records)
    .map((item) => ({
      ...item,
      normalizedProbability: normalizeUnitProbability(
        item?.probability ??
          item?.normalized ??
          item?.averageProbability ??
          item?.score,
        0,
      ),
    }))
    .sort(
      (left, right) =>
        Number(right?.normalizedProbability || 0) -
        Number(left?.normalizedProbability || 0),
    )
    .slice(0, 16)
    .forEach((item, index) => {
      const total = Number(item?.total)
      const probability = normalizeUnitProbability(
        item?.probability ??
          item?.normalized ??
          item?.averageProbability ??
          item?.score,
        Math.max(0.05, 0.18 - index * 0.015),
      )
      const rankWeight =
        index === 0 ? 1 : index === 1 ? 0.82 : index === 2 ? 0.68 : 0.52
      scoreMap.set(total, (scoreMap.get(total) || 0) + probability * rankWeight)
    })

  return scoreMap
}

function applyAdaptiveScoreMap(scoreMap, roundsDesc = [], options = {}) {
  const context = buildContext(roundsDesc)
  const strength = clamp(
    Number(options.strength ?? strengthForModel(options.modelId)),
    0.2,
    1.2,
  )
  const adjusted = new Map()
  const ordered = TOTAL_RANGE.map((total) =>
    Math.max(0.000001, Number(scoreMap.get(total) || 0)),
  ).sort((a, b) => a - b)
  const median = ordered[Math.floor(ordered.length / 2)] || 0.000001
  const lowerQuartile = ordered[Math.floor(ordered.length * 0.25)] || 0.000001

  for (const total of TOTAL_RANGE) {
    const currentScore = Math.max(0.000001, Number(scoreMap.get(total) || 0))
    const recent18 = Number(context.recent18.get(total) || 0)
    const recent50 = Number(context.recent50.get(total) || 0)
    const day = Number(context.day?.get(total) || 0)
    const recentGap = Number(context.gapByTotal.get(total) || 0)
    const recent12Count = Number(context.recent12CountMap.get(total) || 0)
    const recoveryWeight = Number(TOTAL_RECOVERY_PROFILE[total] || 0.24)
    const drawEscapeWeight = Number(TOTAL_DRAW_ESCAPE_PROFILE[total] || 0)
    const priorShare = (TOTAL_PRIOR[total] || 1) / 216
    const recentBlend = recent18 * 0.62 + recent50 * 0.38
    const scarcity =
      currentScore < median
        ? clamp((median - currentScore) / Math.max(median, 0.000001), 0, 1.45)
        : 0
    const dominance =
      currentScore > median
        ? clamp((currentScore - median) / Math.max(median, 0.000001), 0, 1.25)
        : 0
    const gapPressure = clamp(recentGap / 18, 0, 1.45)
    const seenPressure = recent18 * 1.08 + recent50 * 0.48 + day * 0.76
    const deficitPressure = clamp(
      (priorShare * 0.95 - recentBlend) / Math.max(priorShare * 0.95, 0.0045),
      0,
      1.45,
    )
    const excessPressure = clamp(
      (recentBlend - priorShare * 1.32) / Math.max(priorShare * 1.32, 0.006),
      0,
      1.85,
    )
    const underExposed =
      currentScore <= lowerQuartile || (recent18 <= 0.018 && day <= 0.015)

    let factor = 1
    factor += scarcity * (0.026 + recoveryWeight * 0.026) * strength
    factor += gapPressure * recoveryWeight * 0.034 * strength
    factor += deficitPressure * (0.018 + recoveryWeight * 0.026) * strength
    if (underExposed) factor += recoveryWeight * 0.015 * strength
    if (!context.recent12Totals.has(total)) factor += recoveryWeight * 0.008 * strength
    if (!context.recent24Totals.has(total)) factor += recoveryWeight * 0.006 * strength
    if (seenPressure <= 0.055) factor += recoveryWeight * 0.022 * strength
    else if (seenPressure <= 0.085) factor += recoveryWeight * 0.01 * strength
    if (recent12Count >= 2) {
      factor *= 1 - Math.min(0.15, recent12Count * 0.028 * strength)
    }
    if (context.recent6Totals.includes(total)) {
      factor *= 1 - 0.024 * strength
    }
    if (context.centerShare6 >= 0.52 && total >= 9 && total <= 12) {
      factor *= 1 - 0.028 * strength
    }
    if (context.edgeShare6 >= 0.34 && (total <= 5 || total >= 15)) {
      factor *= 1 - 0.016 * strength
    }
    if (excessPressure > 0) {
      factor *= 1 - excessPressure * (0.026 + (1 - recoveryWeight) * 0.012) * strength
    }

    if (dominance > 0 && recoveryWeight <= 0.16) {
      factor *= 1 - dominance * 0.065 * strength
    } else if (dominance > 0 && recoveryWeight <= 0.3) {
      factor *= 1 - dominance * 0.04 * strength
    }

    if (context.latestResult === 'Draw') {
      const heavyDrawPenalty = context.streak.length >= 2 ? 0.52 : 0.38
      if (total === 10 || total === 11) {
        factor *= 1 - heavyDrawPenalty * strength
      } else if (total === 9 || total === 12) {
        factor *= 1 - heavyDrawPenalty * 0.52 * strength
      } else {
        factor *= 1 + drawEscapeWeight * 0.12 * strength
      }
    } else if (
      context.streak.key &&
      context.streak.length >= 2 &&
      classifyTotal(total) === context.streak.key
    ) {
      factor *= 1 - 0.06 * strength
    }

    if (Number.isFinite(context.latestTotal) && total === context.latestTotal) {
      factor *= context.latestResult === 'Draw' ? 0.88 : 0.93
    }

    const maxLift =
      1 + (0.058 + recoveryWeight * 0.16 + deficitPressure * 0.03) * strength
    factor = clamp(factor, 0.3, maxLift)

    adjusted.set(total, currentScore * factor)
  }

  return normalizeScoreMap(adjusted)
}

function scoreMapToRecords(
  scoreMap,
  existingByTotal = new Map(),
  limit = 4,
  sourceLabel = 'adaptive-post',
) {
  return [...scoreMap.entries()]
    .map(([total, probability]) => {
      const base = existingByTotal.get(total) || {}
      const nextSources = Array.isArray(base?.sources) ? [...base.sources] : []
      nextSources.push({
        source: sourceLabel,
        probability: roundNumber(probability),
        support: 0,
      })
      return {
        ...base,
        total,
        result:
          base?.result ||
          base?.resultClass ||
          base?.classification ||
          classifyTotal(total),
        probability: roundNumber(probability),
        score: roundNumber(probability * 100, 4),
        normalized: roundNumber(probability),
        sources: nextSources,
      }
    })
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit)
}

function selectStrategicTopTotalRecords(
  records,
  roundsDesc = [],
  options = {},
) {
  const limit = Math.max(1, Number(options.limit || 3))
  const context = buildContext(roundsDesc)
  const candidatePool = (Array.isArray(records) ? records : [])
    .filter((item) => Number.isFinite(Number(item?.total)))
    .slice(0, Math.max(6, limit + 6))

  if (candidatePool.length <= limit) {
    return candidatePool.slice(0, limit)
  }

  const baseScoreByTotal = new Map(
    candidatePool.map((item, index) => [
      Number(item.total),
      normalizeUnitProbability(
        item?.probability ?? item?.normalized ?? item?.score,
        Math.max(0.02, 0.15 - index * 0.012),
      ),
    ]),
  )
  const carryBoostByTotal = new Map(
    candidatePool.map((item) => {
      const total = Number(item.total)
      const gap = Number(context.gapByTotal.get(total) || 0)
      const recentCount = Number(context.recent12CountMap.get(total) || 0)
      const recoveryWeight = Number(TOTAL_RECOVERY_PROFILE[total] || 0.24)
      const carryBoost =
        clamp(gap / 16, 0, 1.6) * (0.012 + recoveryWeight * 0.02) -
        recentCount * 0.008
      return [total, carryBoost]
    }),
  )

  let best = candidatePool.slice(0, limit)
  let bestScore = -Infinity
  for (let i = 0; i < candidatePool.length; i += 1) {
    for (let j = i + 1; j < candidatePool.length; j += 1) {
      for (
        let k = j + 1;
        k < candidatePool.length && limit >= 3;
        k += 1
      ) {
        const trio = [candidatePool[i], candidatePool[j], candidatePool[k]]
        const totals = trio.map((item) => Number(item.total))
        const sortedTotals = [...totals].sort((left, right) => left - right)
        const results = new Set(totals.map((total) => classifyTotal(total)))
        const regimes = new Set(
          totals.map((total) =>
            total >= 13 ? 'upper' : total <= 8 ? 'lower' : 'center',
          ),
        )
        const baseScore = totals.reduce(
          (acc, total) => acc + Number(baseScoreByTotal.get(total) || 0),
          0,
        )
        const carryBoost = totals.reduce(
          (acc, total) => acc + Number(carryBoostByTotal.get(total) || 0),
          0,
        )
        const spread = sortedTotals[2] - sortedTotals[0]
        const adjacencyPenalty =
          (sortedTotals[1] - sortedTotals[0] <= 1 ? 0.085 : 0) +
          (sortedTotals[2] - sortedTotals[1] <= 1 ? 0.085 : 0) +
          (sortedTotals[1] - sortedTotals[0] === 2 ? 0.028 : 0) +
          (sortedTotals[2] - sortedTotals[1] === 2 ? 0.028 : 0)
        const sameResultPenalty =
          results.size === 1
            ? context.latestResult === classifyTotal(sortedTotals[1])
              ? 0.072
              : 0.038
            : 0
        const latestOverlapPenalty = Number.isFinite(context.latestTotal)
          ? totals.filter((total) => Math.abs(total - context.latestTotal) <= 1).length *
            0.024
          : 0
        const centerSpamPenalty =
          context.centerShare6 >= 0.5
            ? totals.filter((total) => total >= 9 && total <= 12).length * 0.018
            : 0
        const diversityBonus =
          (results.size >= 2 ? 0.04 : 0) +
          (regimes.size >= 2 ? 0.05 : 0) +
          (spread >= 5 ? 0.045 : spread >= 3 ? 0.02 : 0)
        const score =
          baseScore +
          carryBoost +
          diversityBonus -
          adjacencyPenalty -
          sameResultPenalty -
          latestOverlapPenalty -
          centerSpamPenalty

        if (score > bestScore) {
          bestScore = score
          best = trio
        }
      }
    }
  }

  const selectedTotals = new Set(best.map((item) => Number(item.total)))
  const orderedBest = best
    .slice()
    .sort(
      (left, right) =>
        Number(baseScoreByTotal.get(Number(right.total)) || 0) -
        Number(baseScoreByTotal.get(Number(left.total)) || 0),
    )
  if (limit <= 3) return orderedBest.slice(0, limit)

  const remainder = candidatePool
    .filter((item) => !selectedTotals.has(Number(item.total)))
    .sort(
      (left, right) =>
        Number(baseScoreByTotal.get(Number(right.total)) || 0) -
        Number(baseScoreByTotal.get(Number(left.total)) || 0),
    )

  return [...orderedBest, ...remainder].slice(0, limit)
}

export function buildAdaptiveResultProbabilities(
  records,
  roundsDesc = [],
  options = {},
) {
  const normalizedMap = applyAdaptiveScoreMap(
    buildScoreMapFromRecords(records),
    roundsDesc,
    options,
  )
  const scores = { Small: 0, Draw: 0, Big: 0 }
  for (const [total, probability] of normalizedMap.entries()) {
    scores[classifyTotal(total)] += probability
  }

  if (buildContext(roundsDesc).latestResult === 'Draw') {
    const streak = buildContext(roundsDesc).streak
    const drawPenalty = streak.length >= 2 ? 0.22 : 0.15
    scores.Draw *= 1 - drawPenalty
    scores.Small += drawPenalty * 0.52
    scores.Big += drawPenalty * 0.48
  }

  const sum =
    RESULT_ORDER.reduce(
      (acc, result) => acc + Math.max(0, Number(scores[result] || 0)),
      0,
    ) || 1
  return Object.fromEntries(
    RESULT_ORDER.map((result) => [
      result,
      roundNumber(Math.max(0, Number(scores[result] || 0)) / sum),
    ]),
  )
}

export function adaptTopTotalRecords(records, roundsDesc = [], options = {}) {
  const unique = uniqueRecords(records)
  const existingByTotal = new Map(
    unique.map((item) => [Number(item.total), item]),
  )
  const scoreMap = applyAdaptiveScoreMap(
    buildScoreMapFromRecords(unique),
    roundsDesc,
    options,
  )
  return scoreMapToRecords(
    scoreMap,
    existingByTotal,
    options.limit || 4,
    options.sourceLabel || 'adaptive-post',
  )
}

export function selectAdaptiveTopTotalRecords(records, roundsDesc = [], options = {}) {
  return selectStrategicTopTotalRecords(records, roundsDesc, options)
}

function extractPayloadRecords(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  const sources = [
    ...(Array.isArray(current.recommendedTotals) ? current.recommendedTotals : []),
    ...(Array.isArray(diagnosis.topTotals) ? diagnosis.topTotals : []),
    ...(Array.isArray(diagnosis.totalDistribution)
      ? diagnosis.totalDistribution
      : []),
  ]

  return uniqueRecords(
    sources.map((item) => ({
      ...item,
      total: Number(item?.total),
      probability:
        item?.probability ??
        item?.normalized ??
        item?.averageProbability ??
        item?.score,
    })),
  )
}

function extractPayloadResultProbabilities(payload) {
  const diagnosis = payload?.diagnosis || {}
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const direct = diagnosis?.resultProbabilities
  if (direct && typeof direct === 'object') {
    const normalized = {}
    for (const result of RESULT_ORDER) {
      normalized[result] = normalizeUnitProbability(direct[result], 0)
    }
    return normalized
  }

  if (Array.isArray(current.resultBreakdown)) {
    const normalized = { Small: 0, Draw: 0, Big: 0 }
    current.resultBreakdown.forEach((item) => {
      if (!RESULT_ORDER.includes(item?.result)) return
      normalized[item.result] = normalizeUnitProbability(item?.probability, 0)
    })
    return normalized
  }

  return null
}

function blendedResultProbabilities(payload, adaptedFromTotals, roundsDesc, options) {
  const direct = extractPayloadResultProbabilities(payload)
  if (!direct) return adaptedFromTotals

  const context = buildContext(roundsDesc)
  const blended = {}
  for (const result of RESULT_ORDER) {
    blended[result] =
      direct[result] * 0.58 + Number(adaptedFromTotals[result] || 0) * 0.42
  }

  if (context.latestResult === 'Draw') {
    const drawPenalty = context.streak.length >= 2 ? 0.18 : 0.12
    blended.Draw *= 1 - drawPenalty
    blended.Small += drawPenalty * 0.52
    blended.Big += drawPenalty * 0.48
  }

  const sum =
    RESULT_ORDER.reduce(
      (acc, result) => acc + Math.max(0, Number(blended[result] || 0)),
      0,
    ) || 1
  return Object.fromEntries(
    RESULT_ORDER.map((result) => [
      result,
      roundNumber(Math.max(0, Number(blended[result] || 0)) / sum),
    ]),
  )
}

function topResultFromProbabilities(resultProbabilities) {
  return RESULT_ORDER.slice().sort(
    (left, right) => resultProbabilities[right] - resultProbabilities[left],
  )[0]
}

export function adaptPredictionPayload(payload, roundsDesc = [], options = {}) {
  if (!payload || typeof payload !== 'object') return payload

  const records = extractPayloadRecords(payload)
  if (!records.length) return payload

  const modelId = options.modelId || payload?.methodology?.model?.id || null
  const adaptedDistribution = adaptTopTotalRecords(records, roundsDesc, {
    limit: 16,
    modelId,
    sourceLabel: `${modelId || 'prediction'}-adaptive`,
  })
  const adaptedTopTotals = selectStrategicTopTotalRecords(
    adaptedDistribution,
    roundsDesc,
    { limit: 4, modelId },
  )
  const adaptedResults = blendedResultProbabilities(
    payload,
    buildAdaptiveResultProbabilities(records, roundsDesc, { modelId }),
    roundsDesc,
    { modelId },
  )
  const recommendedResult = topResultFromProbabilities(adaptedResults)
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  const topProbability = Number(adaptedTopTotals?.[0]?.probability || 0)
  const spread = Math.max(
    0,
    topProbability - Number(adaptedTopTotals?.[1]?.probability || 0),
  )
  const existingTopProbability = normalizeUnitProbability(
    current.topProbability ?? diagnosis?.confidenceModel?.topProbability,
    topProbability,
  )
  const existingSpread = normalizeUnitProbability(
    current.topSpread ??
      current.spread ??
      diagnosis?.confidenceModel?.topGap ??
      diagnosis?.confidenceModel?.spread,
    spread,
  )

  return {
    ...payload,
    methodology: {
      ...(payload.methodology || {}),
      adaptivePostprocess: {
        enabled: true,
        modelId,
        latestResult: buildContext(roundsDesc).latestResult,
        resultStreakLength: buildContext(roundsDesc).streak.length,
      },
    },
    diagnosis: {
      ...diagnosis,
      topTotals: adaptedTopTotals,
      totalDistribution: adaptedDistribution,
      resultProbabilities: adaptedResults,
      mostLikelyResult: recommendedResult,
      recommendedResult,
      confidenceModel: diagnosis?.confidenceModel
        ? {
            ...diagnosis.confidenceModel,
            topProbability: roundNumber(existingTopProbability * 0.56 + topProbability * 0.44),
            topGap: roundNumber(existingSpread * 0.56 + spread * 0.44),
            spread: roundNumber(existingSpread * 0.56 + spread * 0.44),
            confidenceScore: roundNumber(
              (existingTopProbability * 0.56 + topProbability * 0.44) * 100,
              4,
            ),
          }
        : diagnosis?.confidenceModel,
    },
    selectiveStrategy: payload?.selectiveStrategy
      ? {
          ...payload.selectiveStrategy,
          currentDecision: {
            ...current,
            recommendedTotals: adaptedTopTotals.slice(0, 3),
            recommendedResult,
            topProbability: roundNumber(
              existingTopProbability * 0.56 + topProbability * 0.44,
            ),
            topSpread: roundNumber(existingSpread * 0.56 + spread * 0.44),
            resultBreakdown: RESULT_ORDER.map((result) => ({
              result,
              probability: roundNumber(adaptedResults[result] * 100, 4),
            })),
          },
        }
      : payload?.selectiveStrategy,
  }
}
