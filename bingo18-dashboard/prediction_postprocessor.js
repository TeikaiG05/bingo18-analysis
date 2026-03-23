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
  const recent6CountMap = buildRecentCountMap(roundsDesc, 6)
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
    recent6CountMap,
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

function isHardEdgeTotal(total) {
  const numeric = Number(total)
  return Number.isFinite(numeric) && (numeric <= 4 || numeric >= 17)
}

function isEdgeTotal(total) {
  const numeric = Number(total)
  return Number.isFinite(numeric) && (numeric <= 5 || numeric >= 16)
}

function drawHangoverMultiplier(total, streakLength = 1) {
  const numeric = Number(total)
  if (!Number.isFinite(numeric)) return 1
  if (numeric === 10 || numeric === 11) {
    return streakLength >= 2 ? 0.34 : 0.5
  }
  if (numeric === 9 || numeric === 12) {
    return streakLength >= 2 ? 0.56 : 0.72
  }
  return 1
}

function edgeGapLift(total, gap, recent12Count = 0, recent6Count = 0) {
  const numeric = Number(total)
  if (!Number.isFinite(numeric) || !isEdgeTotal(numeric)) return 0
  const hardEdge = isHardEdgeTotal(numeric)
  const pressure = clamp(
    (Number(gap || 0) - (hardEdge ? 7 : 9)) / (hardEdge ? 18 : 20),
    0,
    hardEdge ? 1.45 : 1.18,
  )
  // Bug #5 FIX: Giảm magnitude xuống để tránh double-boost số biên
  // local_ai_pipeline.js đã boost biên lần 1 (max=0.045), postprocessor này là lần 2
  // Giảm base từ 0.085/0.058 xuống 0.052/0.038, max từ 0.12/0.085 xuống 0.065/0.045
  let lift = pressure * (hardEdge ? 0.052 : 0.038)
  if (Number(recent12Count || 0) === 0) {
    lift += hardEdge ? 0.012 : 0.008
  }
  if (Number(recent6Count || 0) > 0) {
    lift *= hardEdge ? 0.68 : 0.76
  }
  if (Number(gap || 0) <= (hardEdge ? 3 : 4)) {
    lift *= 0.35
  }
  return clamp(lift, 0, hardEdge ? 0.065 : 0.045)
}

function normalizeNumericMapOption(value) {
  if (value instanceof Map) return value
  if (Array.isArray(value)) {
    return new Map(
      value
        .map((entry) => [Number(entry?.[0]), Number(entry?.[1])])
        .filter(([key, numeric]) => Number.isFinite(key) && Number.isFinite(numeric)),
    )
  }
  if (value && typeof value === 'object') {
    return new Map(
      Object.entries(value)
        .map(([key, numeric]) => [Number(key), Number(numeric)])
        .filter(([key, numeric]) => Number.isFinite(key) && Number.isFinite(numeric)),
    )
  }
  return new Map()
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
    const recent6Count = Number(context.recent6CountMap.get(total) || 0)
    const recoveryWeight = Number(TOTAL_RECOVERY_PROFILE[total] || 0.24)
    const drawEscapeWeight = Number(TOTAL_DRAW_ESCAPE_PROFILE[total] || 0)
    const edgeLift = edgeGapLift(total, recentGap, recent12Count, recent6Count)
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
    if (edgeLift > 0) factor += edgeLift * Math.max(0.7, strength)
    if (underExposed) factor += recoveryWeight * 0.015 * strength
    if (!context.recent12Totals.has(total)) factor += recoveryWeight * 0.008 * strength
    if (!context.recent24Totals.has(total)) factor += recoveryWeight * 0.006 * strength
    if (seenPressure <= 0.055) factor += recoveryWeight * 0.022 * strength
    else if (seenPressure <= 0.085) factor += recoveryWeight * 0.01 * strength
    if (recent12Count >= 2) {
      factor *= 1 - Math.min(0.15, recent12Count * 0.028 * strength)
    }
    if (recent6Count >= 2) {
      factor *=
        1 -
        Math.min(
          total >= 9 && total <= 13 ? 0.2 : 0.16,
          (0.045 + recent6Count * 0.028) * strength,
        )
    } else if (
      recent6Count === 1 &&
      context.centerShare6 >= 0.5 &&
      total >= 9 &&
      total <= 12
    ) {
      factor *= 1 - 0.022 * strength
    }
    if (context.recent6Totals.includes(total)) {
      factor *= 1 - 0.024 * strength
    }
    if (context.centerShare6 >= 0.52 && total >= 9 && total <= 12) {
      factor *= 1 - 0.028 * strength
    }
    if (recent12Count >= 3 && total >= 9 && total <= 12) {
      factor *= 1 - Math.min(0.14, recent12Count * 0.026 * strength)
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
      factor *= drawHangoverMultiplier(total, context.streak.length)
      if (total !== 10 && total !== 11 && total !== 9 && total !== 12) {
        factor *= 1 + drawEscapeWeight * 0.12 * Math.max(0.7, strength)
        if (edgeLift > 0) {
          factor *= 1 + edgeLift * 0.6
        }
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
  const preferredResult = RESULT_ORDER.includes(options.preferredResult)
    ? options.preferredResult
    : null
  const drawdownLevel = ['normal', 'soft', 'hard'].includes(options.drawdownLevel)
    ? options.drawdownLevel
    : 'normal'
  const blacklistedClusterKeys = options.blacklistedClusterKeys instanceof Set
    ? options.blacklistedClusterKeys
    : new Set(Array.isArray(options.blacklistedClusterKeys) ? options.blacklistedClusterKeys : [])
  const cooldownByTotal = options.cooldownByTotal instanceof Map
    ? options.cooldownByTotal
    : new Map(
        Array.isArray(options.cooldownByTotal)
          ? options.cooldownByTotal
          : Object.entries(options.cooldownByTotal || {}).map(([key, value]) => [
              Number(key),
              Number(value),
            ]),
      )
  const penaltyByTotal = normalizeNumericMapOption(options.penaltyByTotal)
  const bonusByTotal = normalizeNumericMapOption(options.bonusByTotal)
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
        const trioKey = sortedTotals.join('|')
        const results = new Set(totals.map((total) => classifyTotal(total)))
        const regimes = new Set(
          totals.map((total) =>
            total >= 13 ? 'upper' : total <= 8 ? 'lower' : 'center',
          ),
        )
        const streakKey = context.streak?.key || null
        const streakLength = Number(context.streak?.length || 0)
        const streakMatchCount = streakKey
          ? totals.filter((total) => classifyTotal(total) === streakKey).length
          : 0
        const preferredMatchCount = preferredResult
          ? totals.filter((total) => classifyTotal(total) === preferredResult).length
          : 0
        const centerCount = totals.filter((total) => total >= 9 && total <= 12).length
        const hardDrawCount = totals.filter((total) => total === 10 || total === 11).length
        const baseScore = totals.reduce(
          (acc, total) => acc + Number(baseScoreByTotal.get(total) || 0),
          0,
        )
        const carryBoost = totals.reduce(
          (acc, total) => acc + Number(carryBoostByTotal.get(total) || 0),
          0,
        )
        const edgeGapBonus = totals.reduce((acc, total) => {
          const recentGap = Number(context.gapByTotal.get(total) || 0)
          const recent12Count = Number(context.recent12CountMap.get(total) || 0)
          const recent6Count = Number(context.recent6CountMap.get(total) || 0)
          return (
            acc +
            edgeGapLift(total, recentGap, recent12Count, recent6Count) * 0.72
          )
        }, 0)
        const cooldownPenalty = totals.reduce(
          (acc, total) => acc + Number(cooldownByTotal.get(total) || 0),
          0,
        )
        const extraPenalty = totals.reduce(
          (acc, total) => acc + Number(penaltyByTotal.get(total) || 0),
          0,
        )
        const extraBonus = totals.reduce(
          (acc, total) => acc + Number(bonusByTotal.get(total) || 0),
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
        const repeatLoadPenalty = totals.reduce((acc, total) => {
          const recent12Count = Number(context.recent12CountMap.get(total) || 0)
          const recent6Count = Number(context.recent6CountMap.get(total) || 0)
          let penalty =
            recent12Count * (total >= 9 && total <= 12 ? 0.014 : 0.01) +
            recent6Count * (total >= 9 && total <= 12 ? 0.022 : 0.015)
          if (recent6Count >= 2) {
            penalty += total >= 9 && total <= 12 ? 0.04 : 0.026
          }
          return acc + penalty
        }, 0)
        const centerLockPenalty =
          preferredResult !== 'Draw' && centerCount >= 2
            ? context.centerShare6 >= 0.5
              ? 0.085
              : 0.05
            : 0
        const postDrawPenalty =
          context.latestResult === 'Draw'
            ? totals.reduce((acc, total) => {
                if (total === 10 || total === 11) {
                  return (
                    acc + (context.streak.length >= 2 ? 0.24 : 0.17)
                  )
                }
                if (total === 9 || total === 12) {
                  return acc + (context.streak.length >= 2 ? 0.11 : 0.07)
                }
                return acc
              }, 0)
            : 0
        const balancedMixPenalty =
          streakLength >= 2 && streakKey && streakKey !== 'Draw' && results.size === 3
            ? 0.045
            : 0
        const resultConstraintPenalty =
          preferredResult === 'Small' || preferredResult === 'Big'
            ? preferredMatchCount >= 2
              ? 0
              : preferredMatchCount === 1
                ? 0.16
                : 0.28
            : preferredResult === 'Draw'
              ? hardDrawCount >= 1
                ? 0
                : 0.14
              : 0
        const blacklistPenalty = blacklistedClusterKeys.has(trioKey)
          ? drawdownLevel === 'hard'
            ? 0.52
            : drawdownLevel === 'soft'
              ? 0.34
              : 0.22
          : 0
        const drawdownPenalty =
          drawdownLevel === 'hard'
            ? cooldownPenalty * 1.2
            : drawdownLevel === 'soft'
              ? cooldownPenalty
              : cooldownPenalty * 0.7
        let streakShapeBonus = 0
        let preferredResultBonus = 0
        if (preferredResult === 'Small' || preferredResult === 'Big') {
          if (preferredMatchCount >= 2) preferredResultBonus += 0.082
          else if (preferredMatchCount === 1) preferredResultBonus -= 0.038
          else preferredResultBonus -= 0.11
        } else if (preferredResult === 'Draw') {
          if (hardDrawCount === 1 || hardDrawCount === 2) preferredResultBonus += 0.04
          else if (hardDrawCount === 0) preferredResultBonus -= 0.05
          if (centerCount >= 3) preferredResultBonus -= 0.03
        }
        if (streakKey === 'Small' && streakLength >= 2) {
          if (streakMatchCount >= 2) streakShapeBonus += 0.062
          else if (streakMatchCount === 0) streakShapeBonus -= 0.078
          if (centerCount >= 2) streakShapeBonus -= 0.03
          if (hardDrawCount >= 1) streakShapeBonus -= 0.022 * hardDrawCount
        } else if (streakKey === 'Big' && streakLength >= 2) {
          if (streakMatchCount >= 2) streakShapeBonus += 0.062
          else if (streakMatchCount === 0) streakShapeBonus -= 0.078
          if (centerCount >= 2) streakShapeBonus -= 0.028
          if (totals.filter((total) => total <= 8).length >= 1) {
            streakShapeBonus -= 0.018
          }
        } else if (streakKey === 'Draw' && streakLength >= 1) {
          if (hardDrawCount >= 2) streakShapeBonus -= streakLength >= 2 ? 0.06 : 0.035
          else if (centerCount === 1) streakShapeBonus += 0.02
        }
        const diversityBonus =
          (results.size >= 2 ? 0.04 : 0) +
          (regimes.size >= 2 ? 0.05 : 0) +
          (spread >= 5 ? 0.045 : spread >= 3 ? 0.02 : 0)
        const score =
          baseScore +
          carryBoost +
          edgeGapBonus +
          streakShapeBonus +
          preferredResultBonus +
          extraBonus +
          diversityBonus -
          adjacencyPenalty -
          sameResultPenalty -
          latestOverlapPenalty -
          centerSpamPenalty -
          repeatLoadPenalty -
          centerLockPenalty -
          postDrawPenalty -
          balancedMixPenalty -
          resultConstraintPenalty -
          blacklistPenalty -
          extraPenalty -
          drawdownPenalty

        if (score > bestScore) {
          bestScore = score
          best = trio
        }
      }
    }
  }

  const selectedTotals = new Set(best.map((item) => Number(item.total)))
  const rankingScoreForTotal = (total) =>
    Number(baseScoreByTotal.get(Number(total)) || 0) +
    Number(bonusByTotal.get(Number(total)) || 0) -
    Number(penaltyByTotal.get(Number(total)) || 0)
  const orderedBest = best
    .slice()
    .sort(
      (left, right) =>
        rankingScoreForTotal(Number(right.total)) -
        rankingScoreForTotal(Number(left.total)),
    )
  if (limit <= 3) return orderedBest.slice(0, limit)

  const remainder = candidatePool
    .filter((item) => !selectedTotals.has(Number(item.total)))
    .sort(
      (left, right) =>
        rankingScoreForTotal(Number(right.total)) -
        rankingScoreForTotal(Number(left.total)),
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

  // Bug #6 FIX: Reuse context thay vì gọi buildContext 2 lần riêng biệt
  const ctx = buildContext(roundsDesc)
  if (ctx.latestResult === 'Draw') {
    const streak = ctx.streak
    const drawPenalty = streak.length >= 2 ? 0.38 : 0.28
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
    const drawPenalty = context.streak.length >= 2 ? 0.34 : 0.24
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
  const adaptedResults = blendedResultProbabilities(
    payload,
    buildAdaptiveResultProbabilities(records, roundsDesc, { modelId }),
    roundsDesc,
    { modelId },
  )
  const recommendedResult = topResultFromProbabilities(adaptedResults)
  const adaptedTopTotals = selectStrategicTopTotalRecords(
    adaptedDistribution,
    roundsDesc,
    { limit: 4, modelId, preferredResult: recommendedResult },
  )
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
