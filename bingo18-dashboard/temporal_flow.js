const TOTAL_MIN = 3
const TOTAL_MAX = 18
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
const TOTAL_RANGE = Array.from(
  { length: TOTAL_MAX - TOTAL_MIN + 1 },
  (_, index) => TOTAL_MIN + index,
)
const RESULT_ORDER = ['Small', 'Draw', 'Big']

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function totalRegime(total) {
  if (total >= 13) return 'upper'
  if (total <= 8) return 'lower'
  return 'center'
}

function roundNumber(value, digits = 6) {
  return Number(value.toFixed(digits))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
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

function normalizeScores(rawScores = {}) {
  const sum =
    TOTAL_RANGE.reduce(
      (acc, total) => acc + Math.max(0, Number(rawScores[String(total)] || 0)),
      0,
    ) || 1

  const entries = TOTAL_RANGE.map((total) => [
    String(total),
    roundNumber(Math.max(0, Number(rawScores[String(total)] || 0)) / sum, 8),
  ])

  return Object.fromEntries(
    entries.sort((a, b) => Number(b[1]) - Number(a[1])),
  )
}

function topTotalsFromScoreObject(scoreByTotal, limit = 4) {
  return Object.entries(scoreByTotal || {})
    .map(([total, probability]) => ({
      total: Number(total),
      probability: Number(probability),
      result: classifyTotal(Number(total)),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.total) && Number.isFinite(item.probability),
    )
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit)
}

function resultProbabilitiesFromScoreObject(scoreByTotal) {
  const scores = {
    Small: 0,
    Draw: 0,
    Big: 0,
  }

  TOTAL_RANGE.forEach((total) => {
    const score = Number(scoreByTotal?.[String(total)] || 0)
    scores[classifyTotal(total)] += score
  })

  const sum =
    RESULT_ORDER.reduce(
      (acc, result) => acc + Math.max(0, Number(scores[result] || 0)),
      0,
    ) || 1

  return {
    Small: roundNumber(Math.max(0, Number(scores.Small || 0)) / sum, 8),
    Draw: roundNumber(Math.max(0, Number(scores.Draw || 0)) / sum, 8),
    Big: roundNumber(Math.max(0, Number(scores.Big || 0)) / sum, 8),
  }
}

function dominantResultFromScores(scoreByTotal) {
  const resultProbabilities = resultProbabilitiesFromScoreObject(scoreByTotal)
  return RESULT_ORDER.slice().sort(
    (left, right) => resultProbabilities[right] - resultProbabilities[left],
  )[0]
}

function buildPriorComponent() {
  return {
    support: 216,
    scoreByTotal: normalizeScores(
      Object.fromEntries(
        TOTAL_RANGE.map((total) => [String(total), TOTAL_PRIOR[total] || 0]),
      ),
    ),
  }
}

function buildRecentWindowComponent(roundsDesc, limit, decay) {
  const scores = {}
  let support = 0

  roundsDesc.slice(0, limit).forEach((round, index) => {
    const total = Number(round?.total)
    if (!Number.isFinite(total)) return
    const weight = 1 / (1 + index * decay)
    scores[String(total)] = Number(scores[String(total)] || 0) + weight
    support += 1
  })

  return {
    support,
    scoreByTotal: normalizeScores(scores),
  }
}

function buildDayComponent(roundsDesc, latestDayKey) {
  const scores = {}
  let support = 0

  for (const round of roundsDesc) {
    if (safeDateKey(round) !== latestDayKey) continue
    const total = Number(round?.total)
    if (!Number.isFinite(total)) continue
    const weight = 1.08 / (1 + support * 0.08)
    scores[String(total)] = Number(scores[String(total)] || 0) + weight
    support += 1
    if (support >= 96) break
  }

  return {
    support,
    scoreByTotal: normalizeScores(scores),
  }
}

function buildTransitionComponent(roundsDesc, matcher, limit, decay) {
  const scores = {}
  let support = 0

  for (let index = 1; index < roundsDesc.length && support < limit; index += 1) {
    const older = roundsDesc[index]
    const newer = roundsDesc[index - 1]
    if (!matcher(older)) continue

    const newerTotal = Number(newer?.total)
    if (!Number.isFinite(newerTotal)) continue

    const weight = 1 / (1 + support * decay)
    scores[String(newerTotal)] = Number(scores[String(newerTotal)] || 0) + weight
    support += 1
  }

  return {
    support,
    scoreByTotal: normalizeScores(scores),
  }
}

function buildDayGroupsAsc(roundsDesc) {
  const asc = [...roundsDesc].reverse()
  const groups = []

  asc.forEach((round) => {
    const key = safeDateKey(round)
    const lastGroup = groups[groups.length - 1]
    if (!lastGroup || lastGroup.key !== key) {
      groups.push({
        key,
        rounds: [round],
      })
      return
    }
    lastGroup.rounds.push(round)
  })

  return groups
}

function buildCurrentStreak(roundsDesc, selector) {
  const latest = roundsDesc?.[0]
  const latestKey = latest ? selector(latest) : null
  if (!latestKey) {
    return {
      key: null,
      length: 0,
    }
  }

  let length = 0
  for (const round of roundsDesc) {
    if (selector(round) !== latestKey) break
    length += 1
  }

  return {
    key: latestKey,
    length,
  }
}

function buildStreakTransitionComponent(roundsDesc, selector, latestStreak, limit) {
  const scores = {}
  const asc = [...roundsDesc].reverse()
  const targetKey = latestStreak?.key ?? null
  const targetLength = Math.min(Number(latestStreak?.length || 0), 4)
  let support = 0

  if (!targetKey || !targetLength) {
    return {
      support: 0,
      key: targetKey,
      streakLength: targetLength,
      scoreByTotal: normalizeScores(scores),
    }
  }

  for (let index = 0; index < asc.length - 1 && support < limit; index += 1) {
    const currentKey = selector(asc[index])
    if (currentKey !== targetKey) continue

    let streakLength = 1
    for (let prev = index - 1; prev >= 0; prev -= 1) {
      if (selector(asc[prev]) !== currentKey) break
      streakLength += 1
    }

    if (Math.min(streakLength, 4) !== targetLength) continue

    const nextTotal = Number(asc[index + 1]?.total)
    if (!Number.isFinite(nextTotal)) continue

    const weight = 1 / (1 + support * 0.08)
    scores[String(nextTotal)] = Number(scores[String(nextTotal)] || 0) + weight
    support += 1
  }

  return {
    support,
    key: targetKey,
    streakLength: Number(latestStreak?.length || 0),
    scoreByTotal: normalizeScores(scores),
  }
}

function buildSlotComponent(dayGroups) {
  const scores = {}
  const currentDay = dayGroups[dayGroups.length - 1]

  if (!currentDay) {
    return {
      support: 0,
      slotIndex: 0,
      scoreByTotal: normalizeScores(scores),
    }
  }

  const slotIndex = currentDay.rounds.length
  let support = 0

  for (let index = dayGroups.length - 2; index >= 0; index -= 1) {
    const dayRounds = dayGroups[index]?.rounds || []
    if (dayRounds.length <= slotIndex) continue
    const slotRound = dayRounds[slotIndex]
    const total = Number(slotRound?.total)
    if (!Number.isFinite(total)) continue

    const weight = 1 / (1 + support * 0.12)
    scores[String(total)] = Number(scores[String(total)] || 0) + weight
    support += 1
    if (support >= 28) break
  }

  return {
    support,
    slotIndex,
    scoreByTotal: normalizeScores(scores),
  }
}

function buildRegimeComponent(dayComponent, recent50Component) {
  const regimeScores = {
    center: 0,
    upper: 0,
    lower: 0,
  }

  TOTAL_RANGE.forEach((total) => {
    const regime = totalRegime(total)
    const dayScore = Number(dayComponent?.scoreByTotal?.[String(total)] || 0)
    const recent50Score = Number(
      recent50Component?.scoreByTotal?.[String(total)] || 0,
    )
    regimeScores[regime] += dayScore * 0.56 + recent50Score * 0.44
  })

  const regimeSum =
    regimeScores.center + regimeScores.upper + regimeScores.lower || 1
  const bias = {
    center: roundNumber(regimeScores.center / regimeSum, 8),
    upper: roundNumber(regimeScores.upper / regimeSum, 8),
    lower: roundNumber(regimeScores.lower / regimeSum, 8),
  }

  const totalScores = {}
  TOTAL_RANGE.forEach((total) => {
    const regime = totalRegime(total)
    let score = 0

    if (regime === 'center') {
      score =
        (total === 10 || total === 11
          ? 1.18
          : total === 9 || total === 12
            ? 0.96
            : 0.54) * bias.center
    } else if (regime === 'upper') {
      score =
        (total === 13 || total === 14
          ? 1.14
          : total === 12 || total === 15
            ? 0.88
            : 0.52) * bias.upper
    } else {
      score =
        (total === 7 || total === 8
          ? 1.14
          : total === 6 || total === 9
            ? 0.88
            : 0.52) * bias.lower
    }

    totalScores[String(total)] = score
  })

  return {
    support:
      Number(dayComponent?.support || 0) + Number(recent50Component?.support || 0),
    bias,
    scoreByTotal: normalizeScores(totalScores),
  }
}

function composeProfileScoreObject(components, weights, availability) {
  const rawScores = Object.fromEntries(
    TOTAL_RANGE.map((total) => [String(total), 0]),
  )

  Object.entries(weights || {}).forEach(([name, weight]) => {
    if (!weight) return
    const component = components?.[name]
    if (!component?.scoreByTotal) return

    const effectiveWeight = Number(weight) * Number(availability?.[name] || 0)
    if (!effectiveWeight) return

    TOTAL_RANGE.forEach((total) => {
      rawScores[String(total)] +=
        Number(component.scoreByTotal[String(total)] || 0) * effectiveWeight
    })
  })

  return normalizeScores(rawScores)
}

function applyAdaptiveFlowAdjustments(scoreByTotal, components, context = {}) {
  const adjusted = { ...(scoreByTotal || {}) }
  const latestResult = context?.latestResult || null
  const resultStreak = context?.resultStreak || { key: null, length: 0 }
  const streakLength = Number(resultStreak?.length || 0)

  if (latestResult === 'Draw') {
    const drawPenalty = streakLength >= 2 ? 0.58 : 0.46

    ;[10, 11].forEach((total) => {
      adjusted[String(total)] = roundNumber(
        Number(adjusted[String(total)] || 0) * (1 - drawPenalty),
        8,
      )
    })
    ;[9, 12].forEach((total) => {
      adjusted[String(total)] = roundNumber(
        Number(adjusted[String(total)] || 0) * (1 - drawPenalty * 0.64),
        8,
      )
    })
    TOTAL_RANGE.forEach((total) => {
      if (total >= 9 && total <= 12) return
      adjusted[String(total)] = roundNumber(
        Number(adjusted[String(total)] || 0) * (1 + drawPenalty * 0.34),
        8,
      )
    })
    ;[3, 4, 5, 6, 13, 14, 15, 16, 17, 18].forEach((total) => {
      adjusted[String(total)] = roundNumber(
        Number(adjusted[String(total)] || 0) * (1 + drawPenalty * 0.24),
        8,
      )
    })
  }

  const ordered = TOTAL_RANGE.map((total) =>
    Number(adjusted[String(total)] || 0),
  ).sort((a, b) => a - b)
  const median = ordered[Math.floor(ordered.length / 2)] || 0.000001
  const lowerQuartile = ordered[Math.floor(ordered.length * 0.25)] || 0

  TOTAL_RANGE.forEach((total) => {
    const key = String(total)
    const currentScore = Number(adjusted[key] || 0)
    const recent18Score = Number(
      components?.recent18?.scoreByTotal?.[key] || 0,
    )
    const recent50Score = Number(
      components?.recent50?.scoreByTotal?.[key] || 0,
    )
    const dayScore = Number(components?.day?.scoreByTotal?.[key] || 0)

    const scarcity =
      currentScore < median
        ? clamp((median - currentScore) / Math.max(median, 0.000001), 0, 1.35)
        : 0
    const seenPressure = recent18Score * 1.1 + recent50Score * 0.42 + dayScore * 0.76
    const underExposed =
      currentScore <= lowerQuartile || (recent18Score <= 0.018 && dayScore <= 0.015)

    let factor = 1
    factor += scarcity * 0.11
    if (underExposed) factor += 0.032
    if (seenPressure <= 0.055) factor += 0.082
    else if (seenPressure <= 0.085) factor += 0.042

    if (latestResult === 'Draw') {
      if (total === 10 || total === 11) factor *= streakLength >= 2 ? 0.64 : 0.72
      else if (total === 9 || total === 12) factor *= streakLength >= 2 ? 0.82 : 0.9
      else if (total <= 8 || total >= 13) factor *= streakLength >= 2 ? 1.13 : 1.09
      else factor *= 1.04
    }

    adjusted[key] = roundNumber(currentScore * factor, 8)
  })

  return normalizeScores(adjusted)
}

function buildProfile(id, label, components, weights, availability, context = {}) {
  const baseScoreByTotal = composeProfileScoreObject(
    components,
    weights,
    availability,
  )
  const scoreByTotal = applyAdaptiveFlowAdjustments(
    baseScoreByTotal,
    components,
    context,
  )
  const topTotals = topTotalsFromScoreObject(scoreByTotal, 4)

  return {
    id,
    label,
    support: roundNumber(
      Object.entries(weights || {}).reduce((acc, [name, weight]) => {
        if (!weight) return acc
        return (
          acc +
          Number(components?.[name]?.support || 0) *
            Math.max(0.15, Number(availability?.[name] || 0))
        )
      }, 0),
      4,
    ),
    scoreByTotal,
    topTotals,
    resultProbabilities: resultProbabilitiesFromScoreObject(scoreByTotal),
    result: dominantResultFromScores(scoreByTotal),
    regime: totalRegime(topTotals[0]?.total ?? 10),
  }
}

export function buildTemporalFlowBundle(roundsDesc = []) {
  const cleanRounds = [...(Array.isArray(roundsDesc) ? roundsDesc : [])]
    .filter((round) => round && Number.isFinite(Number(round.total)))
    .map((round) => ({
      ...round,
      total: Number(round.total),
      result: round.result || classifyTotal(Number(round.total)),
    }))

  if (!cleanRounds.length) {
    const prior = buildPriorComponent()
    const emptyProfile = buildProfile(
      'temporal_balanced',
      'Temporal Balanced Flow',
      {
        prior,
      },
      { prior: 1 },
      { prior: 1 },
    )

    return {
      latestDayKey: null,
      latestTotal: null,
      latestResult: null,
      components: {
        prior,
      },
      availability: {
        prior: 1,
      },
      profile: emptyProfile,
      profiles: [emptyProfile],
      scoreByTotal: emptyProfile.scoreByTotal,
      topTotals: emptyProfile.topTotals,
      resultProbabilities: emptyProfile.resultProbabilities,
      primaryResult: emptyProfile.result,
      regime: emptyProfile.regime,
      summary: {
        dayRounds: 0,
        recentWindow: 0,
        slotIndex: 0,
        regimeBias: {
          center: 0,
          upper: 0,
          lower: 0,
        },
      },
    }
  }

  const latestRound = cleanRounds[0]
  const latestDayKey = safeDateKey(latestRound)
  const latestTotal = Number(latestRound.total)
  const latestResult = latestRound.result || classifyTotal(latestTotal)
  const resultStreak = buildCurrentStreak(
    cleanRounds,
    (round) => round?.result || classifyTotal(Number(round?.total)),
  )
  const regimeStreak = buildCurrentStreak(
    cleanRounds,
    (round) => totalRegime(Number(round?.total)),
  )

  const prior = buildPriorComponent()
  const recent50 = buildRecentWindowComponent(cleanRounds, 50, 0.06)
  const recent18 = buildRecentWindowComponent(cleanRounds, 18, 0.12)
  const day = buildDayComponent(cleanRounds, latestDayKey)
  const afterResult = buildTransitionComponent(
    cleanRounds,
    (round) =>
      (round?.result || classifyTotal(Number(round?.total))) === latestResult,
    70,
    0.06,
  )
  const afterTotal = buildTransitionComponent(
    cleanRounds,
    (round) => Number(round?.total) === latestTotal,
    50,
    0.08,
  )
  const resultStreakFlow = buildStreakTransitionComponent(
    cleanRounds,
    (round) => round?.result || classifyTotal(Number(round?.total)),
    resultStreak,
    80,
  )
  const regimeStreakFlow = buildStreakTransitionComponent(
    cleanRounds,
    (round) => totalRegime(Number(round?.total)),
    regimeStreak,
    80,
  )
  const slot = buildSlotComponent(buildDayGroupsAsc(cleanRounds))
  const regime = buildRegimeComponent(day, recent50)

  const components = {
    prior,
    day,
    recent50,
    recent18,
    afterResult,
    afterTotal,
    resultStreak: resultStreakFlow,
    regimeStreak: regimeStreakFlow,
    slot,
    regime,
  }

  const availability = {
    prior: 1,
    day: day.support ? clamp(day.support / 22, 0.3, 1.45) : 0,
    recent50: recent50.support ? clamp(recent50.support / 50, 0.55, 1.05) : 0,
    recent18: recent18.support ? clamp(recent18.support / 18, 0.4, 1.05) : 0,
    afterResult: afterResult.support
      ? clamp(afterResult.support / 24, 0.18, 1.45)
      : 0,
    afterTotal: afterTotal.support
      ? clamp(afterTotal.support / 16, 0.12, 1.05)
      : 0,
    resultStreak: resultStreakFlow.support
      ? clamp(resultStreakFlow.support / 18, 0.18, 1.25)
      : 0,
    regimeStreak: regimeStreakFlow.support
      ? clamp(regimeStreakFlow.support / 18, 0.18, 1.2)
      : 0,
    slot: slot.support ? clamp(slot.support / 10, 0.08, 0.8) : 0,
    regime: 1,
  }

  const profiles = [
    buildProfile(
      'temporal_balanced',
      'Temporal Balanced Flow',
      components,
      {
        prior: 0.26,
        day: 1.18,
        recent50: 0.86,
        recent18: 0.34,
        afterResult: 1.3,
        afterTotal: 0.74,
        resultStreak: 0.92,
        regimeStreak: 0.66,
        slot: 0.22,
        regime: 0.42,
      },
      availability,
      { latestResult, resultStreak },
    ),
    buildProfile(
      'temporal_daypulse',
      'Temporal Day Pulse',
      components,
      {
        prior: 0.12,
        day: 1.48,
        recent50: 0.38,
        recent18: 0.2,
        afterResult: 0.96,
        afterTotal: 0.28,
        resultStreak: 0.62,
        regimeStreak: 0.4,
        slot: 0.46,
        regime: 0.3,
      },
      availability,
      { latestResult, resultStreak },
    ),
    buildProfile(
      'temporal_recent50',
      'Temporal Recent50 Mesh',
      components,
      {
        prior: 0.18,
        day: 0.42,
        recent50: 1.24,
        recent18: 0.82,
        afterResult: 0.82,
        afterTotal: 0.32,
        resultStreak: 0.32,
        regimeStreak: 0.36,
        slot: 0.1,
        regime: 0.26,
      },
      availability,
      { latestResult, resultStreak },
    ),
    buildProfile(
      'temporal_transition',
      'Temporal Transition Relay',
      components,
      {
        prior: 0.12,
        day: 0.56,
        recent50: 0.46,
        recent18: 0.24,
        afterResult: 1.42,
        afterTotal: 1.04,
        resultStreak: 1.12,
        regimeStreak: 0.78,
        slot: 0.24,
        regime: 0.22,
      },
      availability,
      { latestResult, resultStreak },
    ),
  ]

  const primaryProfile = profiles[0]

  return {
    latestDayKey,
    latestTotal,
    latestResult,
    components: {
      prior: {
        ...prior,
        topTotals: topTotalsFromScoreObject(prior.scoreByTotal),
      },
      day: {
        ...day,
        topTotals: topTotalsFromScoreObject(day.scoreByTotal),
      },
      recent50: {
        ...recent50,
        topTotals: topTotalsFromScoreObject(recent50.scoreByTotal),
      },
      recent18: {
        ...recent18,
        topTotals: topTotalsFromScoreObject(recent18.scoreByTotal),
      },
      afterResult: {
        ...afterResult,
        anchor: latestResult,
        topTotals: topTotalsFromScoreObject(afterResult.scoreByTotal),
      },
      afterTotal: {
        ...afterTotal,
        anchor: latestTotal,
        topTotals: topTotalsFromScoreObject(afterTotal.scoreByTotal),
      },
      resultStreak: {
        ...resultStreakFlow,
        topTotals: topTotalsFromScoreObject(resultStreakFlow.scoreByTotal),
      },
      regimeStreak: {
        ...regimeStreakFlow,
        topTotals: topTotalsFromScoreObject(regimeStreakFlow.scoreByTotal),
      },
      slot: {
        ...slot,
        topTotals: topTotalsFromScoreObject(slot.scoreByTotal),
      },
      regime: {
        ...regime,
        topTotals: topTotalsFromScoreObject(regime.scoreByTotal),
      },
    },
    availability: Object.fromEntries(
      Object.entries(availability).map(([key, value]) => [key, roundNumber(value)]),
    ),
    profile: primaryProfile,
    profiles,
    scoreByTotal: primaryProfile.scoreByTotal,
    topTotals: primaryProfile.topTotals,
    resultProbabilities: primaryProfile.resultProbabilities,
    primaryResult: primaryProfile.result,
    regime: primaryProfile.regime,
    summary: {
      dayRounds: day.support,
      recentWindow: recent50.support,
      slotIndex: slot.slotIndex,
      regimeBias: regime.bias,
      resultStreak,
      regimeStreak,
      anchors: {
        latestTotal,
        latestResult,
      },
    },
  }
}
