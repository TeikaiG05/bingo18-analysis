function sumDice(dice) {
  return dice[0] + dice[1] + dice[2]
}

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function dateKeyFromValue(value) {
  if (!value) return 'unknown'

  if (typeof value === 'string') {
    const slashMatch = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (slashMatch) return `${slashMatch[3]}-${slashMatch[2]}-${slashMatch[1]}`
  }

  const d = new Date(value)
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)

  return String(value)
}

function roundDateValue(round) {
  return round?.sourceDate ?? round?.rawSourceTime ?? round?.time ?? null
}

function localHourFromValue(value, utcOffsetHours = 7) {
  if (!value) return null

  const d = new Date(value)
  if (!Number.isNaN(d.getTime())) return (d.getUTCHours() + utcOffsetHours + 24) % 24

  return null
}

function roundHourBucket(round) {
  return localHourFromValue(round?.processTime ?? round?.time)
}

function normalizeMap(map) {
  const total = [...map.values()].reduce((acc, value) => acc + value, 0)
  const result = new Map()

  if (!total) {
    for (const [key] of map.entries()) result.set(key, 0)
    return result
  }

  for (const [key, value] of map.entries()) {
    result.set(key, value / total)
  }

  return result
}

function scoreTo100(value, maxValue) {
  if (!maxValue) return 0
  return Number(((value / maxValue) * 100).toFixed(2))
}

function roundPattern(round) {
  const counts = new Map()
  for (const face of round.dice) counts.set(face, (counts.get(face) || 0) + 1)

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  if (sorted[0]?.[1] === 3) return `${sorted[0][0]}${sorted[0][0]}${sorted[0][0]}`
  if (sorted[0]?.[1] === 2) return `${sorted[0][0]}${sorted[0][0]}x`
  return 'mixed'
}

function canonicalComboKey(dice) {
  return [...dice].sort((a, b) => a - b).join('-')
}

function isExactTriplePattern(pattern) {
  return typeof pattern === 'string' && /^(\d)\1\1$/.test(pattern)
}

export function enumerateExactCombos() {
  const combos = []
  for (let d1 = 1; d1 <= 6; d1 += 1) {
    for (let d2 = 1; d2 <= 6; d2 += 1) {
      for (let d3 = 1; d3 <= 6; d3 += 1) {
        combos.push([d1, d2, d3])
      }
    }
  }
  return combos
}

export function buildTheoryMaps(exactCombos) {
  const totalTheoryRaw = new Map()
  const exactTheory = new Map()
  const canonicalTheoryRaw = new Map()

  for (const combo of exactCombos) {
    const key = combo.join('-')
    const canonicalKey = canonicalComboKey(combo)
    const total = sumDice(combo)
    exactTheory.set(key, 1 / exactCombos.length)
    totalTheoryRaw.set(total, (totalTheoryRaw.get(total) || 0) + 1)
    canonicalTheoryRaw.set(canonicalKey, (canonicalTheoryRaw.get(canonicalKey) || 0) + 1)
  }

  const totalTheory = new Map()
  for (const [total, count] of totalTheoryRaw.entries()) {
    totalTheory.set(total, count / exactCombos.length)
  }

  const canonicalTheory = new Map()
  for (const [key, count] of canonicalTheoryRaw.entries()) {
    canonicalTheory.set(key, count / exactCombos.length)
  }

  return { totalTheory, exactTheory, canonicalTheory }
}

function mapRoundsByDay(rounds) {
  const days = new Map()
  for (const round of rounds) {
    const key = dateKeyFromValue(roundDateValue(round))
    if (!days.has(key)) days.set(key, [])
    days.get(key).push(round)
  }
  return days
}

function countByTotal(rounds) {
  const counts = new Map()
  for (let total = 3; total <= 18; total += 1) counts.set(total, 0)
  for (const round of rounds) counts.set(round.total, (counts.get(round.total) || 0) + 1)
  return counts
}

function countByExact(rounds, exactCombos) {
  const counts = new Map(exactCombos.map((combo) => [combo.join('-'), 0]))
  for (const round of rounds) {
    const key = round.dice.join('-')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function countByCanonical(rounds, exactCombos) {
  const uniqueCanonical = new Set(exactCombos.map((combo) => canonicalComboKey(combo)))
  const counts = new Map([...uniqueCanonical].map((key) => [key, 0]))
  for (const round of rounds) {
    const key = canonicalComboKey(round.dice)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function countByClass(rounds) {
  const counts = new Map([
    ['Small', 0],
    ['Draw', 0],
    ['Big', 0],
  ])
  for (const round of rounds) {
    const label = classifyTotal(round.total)
    counts.set(label, counts.get(label) + 1)
  }
  return counts
}

function buildDecayedTotalProb(rounds, decay = 0.992) {
  const counts = new Map()
  for (let total = 3; total <= 18; total += 1) counts.set(total, 0)

  rounds.forEach((round, index) => {
    counts.set(round.total, counts.get(round.total) + decay ** index)
  })

  return normalizeMap(counts)
}

function buildDecayedExactProb(rounds, exactCombos, decay = 0.992) {
  const counts = new Map(exactCombos.map((combo) => [combo.join('-'), 1]))

  rounds.forEach((round, index) => {
    const key = round.dice.join('-')
    counts.set(key, (counts.get(key) || 0) + decay ** index)
  })

  return normalizeMap(counts)
}

function buildDecayedCanonicalProb(rounds, exactCombos, decay = 0.992) {
  const uniqueCanonical = new Set(exactCombos.map((combo) => canonicalComboKey(combo)))
  const counts = new Map([...uniqueCanonical].map((key) => [key, 1]))

  rounds.forEach((round, index) => {
    const key = canonicalComboKey(round.dice)
    counts.set(key, (counts.get(key) || 0) + decay ** index)
  })

  return normalizeMap(counts)
}

function buildFaceMomentum(rounds, decay = 0.992) {
  const counts = new Map()
  for (let face = 1; face <= 6; face += 1) counts.set(face, 1)

  rounds.forEach((round, index) => {
    const weight = decay ** index
    for (const face of round.dice) {
      counts.set(face, counts.get(face) + weight)
    }
  })

  return normalizeMap(counts)
}

function windowSlice(rounds, size) {
  return rounds.slice(0, Math.min(size, rounds.length))
}

function buildTheoryGapBias(empiricalMap, theoryMap) {
  const gaps = new Map()

  for (const [key, theoryValue] of theoryMap.entries()) {
    const empirical = empiricalMap.get(key) || 0
    gaps.set(key, Math.max(theoryValue - empirical, 0))
  }

  return normalizeMap(gaps)
}

function klDivergence(pMap, qMap) {
  let sum = 0
  for (const [key, pRaw] of pMap.entries()) {
    const p = pRaw || 0
    const q = qMap.get(key) || 1e-12
    if (p > 0) sum += p * Math.log(p / q)
  }
  return sum
}

function jensenShannonDivergence(aMap, bMap) {
  const keys = new Set([...aMap.keys(), ...bMap.keys()])
  const mMap = new Map()
  for (const key of keys) {
    mMap.set(key, ((aMap.get(key) || 0) + (bMap.get(key) || 0)) / 2)
  }
  return (klDivergence(aMap, mMap) + klDivergence(bMap, mMap)) / 2
}

function countPatternBiasByTotal(rounds) {
  const counts = new Map()
  for (let total = 3; total <= 18; total += 1) counts.set(total, 0)

  for (const round of rounds) {
    const boost = roundPattern(round) === 'mixed' ? 1 : 1.35
    counts.set(round.total, counts.get(round.total) + boost)
  }

  return normalizeMap(counts)
}

function buildTotalTransitionMatrix(rounds) {
  const matrix = new Map()
  for (let current = 3; current <= 18; current += 1) {
    const row = new Map()
    for (let next = 3; next <= 18; next += 1) row.set(next, 1)
    matrix.set(current, row)
  }

  for (let i = 0; i < rounds.length - 1; i += 1) {
    const current = rounds[i].total
    const next = rounds[i + 1].total
    matrix.get(current).set(next, matrix.get(current).get(next) + 1)
  }

  return matrix
}

function buildClassTransitionMatrix(rounds) {
  const labels = ['Small', 'Draw', 'Big']
  const matrix = new Map()

  for (const current of labels) {
    const row = new Map()
    for (const next of labels) row.set(next, 1)
    matrix.set(current, row)
  }

  for (let i = 0; i < rounds.length - 1; i += 1) {
    const current = classifyTotal(rounds[i].total)
    const next = classifyTotal(rounds[i + 1].total)
    matrix.get(current).set(next, matrix.get(current).get(next) + 1)
  }

  return matrix
}

function buildPatternTransitionMatrix(rounds) {
  const matrix = new Map()

  for (let i = 0; i < rounds.length - 1; i += 1) {
    const current = roundPattern(rounds[i])
    if (!matrix.has(current)) {
      const row = new Map()
      for (let total = 3; total <= 18; total += 1) row.set(total, 1)
      matrix.set(current, row)
    }
    matrix.get(current).set(rounds[i + 1].total, matrix.get(current).get(rounds[i + 1].total) + 1)
  }

  return matrix
}

function topEntries(probMap, limit, mapper) {
  return [...probMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, probability]) => mapper(key, probability))
}

function buildFaceStats(rounds) {
  const counts = new Map()
  for (let face = 1; face <= 6; face += 1) counts.set(face, 0)

  for (const round of rounds) {
    for (const face of round.dice) {
      counts.set(face, counts.get(face) + 1)
    }
  }

  const totalDice = rounds.length * 3 || 1
  return [...counts.entries()]
    .map(([face, count]) => ({
      face,
      appearances: count,
      rate: Number((count / totalDice).toFixed(6)),
    }))
    .sort((a, b) => b.appearances - a.appearances)
}

function buildCoOccurrenceStats(rounds) {
  const counts = new Map()

  for (const round of rounds) {
    const unique = [...new Set(round.dice)].sort((a, b) => a - b)
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const key = `${unique[i]}-${unique[j]}`
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([pair, count]) => ({
      pair,
      count,
      rate: Number((count / Math.max(rounds.length, 1)).toFixed(6)),
    }))
}

function buildPatternStats(rounds) {
  const counts = new Map()
  for (const round of rounds) {
    const pattern = roundPattern(round)
    counts.set(pattern, (counts.get(pattern) || 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => ({
      pattern,
      count,
      rate: Number((count / Math.max(rounds.length, 1)).toFixed(6)),
    }))
}

function buildRunLength(rounds) {
  if (!rounds.length) return 0
  const latestClass = classifyTotal(rounds[0].total)
  let run = 0
  for (const round of rounds) {
    if (classifyTotal(round.total) !== latestClass) break
    run += 1
  }
  return run
}

const PROFILE_LIBRARY = [
  {
    id: 'balanced',
    label: 'Balanced',
    total: {
      theoretical: 0.08,
      historical: 0.12,
      recent: 0.18,
      daily: 0.26,
      afterLatestTotal: 0.12,
      afterLatestClass: 0.18,
      afterLatestPattern: 0.04,
      dailyPatternBias: 0.02,
    },
    exact: {
      theoretical: 0.06,
      historical: 0.16,
      recent: 0.18,
      daily: 0.28,
      inheritedFromTotal: 0.2,
      todayDoublePatternBoost: 0.12,
    },
  },
  {
    id: 'daily_momentum',
    label: 'Daily Momentum',
    total: {
      theoretical: 0.04,
      historical: 0.08,
      recent: 0.18,
      daily: 0.34,
      afterLatestTotal: 0.12,
      afterLatestClass: 0.18,
      afterLatestPattern: 0.04,
      dailyPatternBias: 0.02,
    },
    exact: {
      theoretical: 0.04,
      historical: 0.12,
      recent: 0.18,
      daily: 0.34,
      inheritedFromTotal: 0.16,
      todayDoublePatternBoost: 0.16,
    },
  },
  {
    id: 'transition_heavy',
    label: 'Transition Heavy',
    total: {
      theoretical: 0.04,
      historical: 0.09,
      recent: 0.16,
      daily: 0.22,
      afterLatestTotal: 0.18,
      afterLatestClass: 0.23,
      afterLatestPattern: 0.06,
      dailyPatternBias: 0.02,
    },
    exact: {
      theoretical: 0.04,
      historical: 0.14,
      recent: 0.18,
      daily: 0.24,
      inheritedFromTotal: 0.2,
      todayDoublePatternBoost: 0.2,
    },
  },
  {
    id: 'pattern_pressure',
    label: 'Pattern Pressure',
    total: {
      theoretical: 0.03,
      historical: 0.08,
      recent: 0.16,
      daily: 0.28,
      afterLatestTotal: 0.11,
      afterLatestClass: 0.17,
      afterLatestPattern: 0.1,
      dailyPatternBias: 0.07,
    },
    exact: {
      theoretical: 0.03,
      historical: 0.12,
      recent: 0.16,
      daily: 0.28,
      inheritedFromTotal: 0.18,
      todayDoublePatternBoost: 0.23,
    },
  },
]

const CONTEXT_LIBRARY = [
  {
    id: 'context_strict',
    label: 'Context Strict',
    lookback: 4,
    minSimilarity: 5.4,
    recencyDecay: 0.9994,
  },
  {
    id: 'context_balanced',
    label: 'Context Balanced',
    lookback: 3,
    minSimilarity: 4.1,
    recencyDecay: 0.99965,
  },
  {
    id: 'context_loose',
    label: 'Context Loose',
    lookback: 2,
    minSimilarity: 2.9,
    recencyDecay: 0.9998,
  },
]

function detectRegime(rounds, latestDayRounds) {
  const latestRound = rounds[0] ?? null
  const latestClass = latestRound ? classifyTotal(latestRound.total) : null
  const latestPattern = latestRound ? roundPattern(latestRound) : null
  const dayClassProb = normalizeMap(countByClass(latestDayRounds))
  const dayPatternStats = buildPatternStats(latestDayRounds).filter((item) => item.pattern !== 'mixed')
  const topDayPattern = dayPatternStats[0] ?? null
  const classRun = buildRunLength(rounds)

  const strongDailyPattern = topDayPattern && topDayPattern.rate >= 0.08
  const strongClassBias = latestClass && (dayClassProb.get(latestClass) || 0) >= 0.38

  let preferredProfileId = 'balanced'
  if (strongDailyPattern) preferredProfileId = 'pattern_pressure'
  else if (strongClassBias || classRun >= 3) preferredProfileId = 'transition_heavy'
  else if (latestDayRounds.length >= 30) preferredProfileId = 'daily_momentum'

  return {
    latestClass,
    latestPattern,
    classRun,
    strongDailyPattern: Boolean(strongDailyPattern),
    strongClassBias: Boolean(strongClassBias),
    preferredProfileId,
    topDayPattern: topDayPattern
      ? {
          pattern: topDayPattern.pattern,
          rate: Number((topDayPattern.rate * 100).toFixed(2)),
        }
      : null,
  }
}

function detectRegimeBreak(features) {
  const shortVsLongTotal = jensenShannonDivergence(
    features.shortRecentTotalProb,
    features.longRecentTotalProb,
  )
  const dayVsRecentTotal = jensenShannonDivergence(features.dayTotalProb, features.recentTotalProb)
  const shortVsLongFace = jensenShannonDivergence(
    buildFaceMomentum(features.shortRecentRounds, 0.985),
    buildFaceMomentum(features.longRecentRounds, 0.999),
  )

  const pressure =
    shortVsLongTotal * 0.45 +
    dayVsRecentTotal * 0.35 +
    shortVsLongFace * 0.2

  return {
    shortVsLongTotal: Number(shortVsLongTotal.toFixed(6)),
    dayVsRecentTotal: Number(dayVsRecentTotal.toFixed(6)),
    shortVsLongFace: Number(shortVsLongFace.toFixed(6)),
    pressure: Number(pressure.toFixed(6)),
    isBreaking: pressure >= 0.035,
  }
}

function buildContextSnapshotFromAsc(roundsAsc, index, lookback) {
  if (index < lookback) return null

  const previous = []
  const faceCounts = new Map()
  for (let face = 1; face <= 6; face += 1) faceCounts.set(face, 0)

  for (let offset = 1; offset <= lookback; offset += 1) {
    const round = roundsAsc[index - offset]
    const pattern = roundPattern(round)
    const label = classifyTotal(round.total)
    previous.push({
      total: round.total,
      label,
      pattern,
      dice: round.dice,
    })
    for (const face of round.dice) {
      faceCounts.set(face, faceCounts.get(face) + 1)
    }
  }

  let classRun = 0
  const latestLabel = previous[0]?.label ?? null
  for (const item of previous) {
    if (item.label !== latestLabel) break
    classRun += 1
  }

  return {
    previous,
    latestTotal: previous[0]?.total ?? null,
    latestLabel,
    latestPattern: previous[0]?.pattern ?? null,
    latestDice: previous[0]?.dice ?? [],
    classRun,
    faceCounts,
  }
}

function scoreContextSimilarity(current, historical) {
  if (!current || !historical) return 0

  const weights = [2.2, 1.35, 0.9, 0.55]
  let score = 0

  for (let i = 0; i < Math.min(current.previous.length, historical.previous.length); i += 1) {
    const currentItem = current.previous[i]
    const historicalItem = historical.previous[i]
    const weight = weights[i] || 0.35
    const totalDiff = Math.abs(currentItem.total - historicalItem.total)

    if (currentItem.total === historicalItem.total) score += weight * 1.45
    else score += Math.max(0, weight * (1 - totalDiff / 7))

    if (currentItem.label === historicalItem.label) score += weight * 0.9
    if (currentItem.pattern === historicalItem.pattern) score += weight * 0.75

    const exactDiceMatch =
      currentItem.dice.length === historicalItem.dice.length &&
      currentItem.dice.every((value, index) => value === historicalItem.dice[index])
    if (exactDiceMatch) score += weight * 0.85
  }

  for (let face = 1; face <= 6; face += 1) {
    score += Math.min(current.faceCounts.get(face) || 0, historical.faceCounts.get(face) || 0) * 0.08
  }

  score += Math.max(0, 0.65 - Math.abs(current.classRun - historical.classRun) * 0.18)

  return score
}

function buildContextExpertPredictionFromAsc(roundsAsc, expert, options = {}) {
  const exactCombos = options.exactCombos ?? enumerateExactCombos()
  const theory = options.theory ?? buildTheoryMaps(exactCombos)
  const current = buildContextSnapshotFromAsc(roundsAsc, roundsAsc.length, expert.lookback)

  const totalCounts = new Map()
  const exactCounts = new Map(exactCombos.map((combo) => [combo.join('-'), theory.exactTheory.get(combo.join('-')) || 1e-6]))
  const classCounts = new Map([
    ['Small', 1 / 3],
    ['Draw', 1 / 3],
    ['Big', 1 / 3],
  ])
  const faceCounts = new Map()
  for (let total = 3; total <= 18; total += 1) totalCounts.set(total, theory.totalTheory.get(total) || 0)
  for (let face = 1; face <= 6; face += 1) faceCounts.set(face, 1 / 6)

  let matchCount = 0
  let totalWeight = 0

  for (let index = expert.lookback; index < roundsAsc.length; index += 1) {
    const historical = buildContextSnapshotFromAsc(roundsAsc, index, expert.lookback)
    const similarity = scoreContextSimilarity(current, historical)
    if (similarity < expert.minSimilarity) continue

    const target = roundsAsc[index]
    const age = roundsAsc.length - index
    const recencyWeight = expert.recencyDecay ** age
    const weight = similarity * recencyWeight

    totalCounts.set(target.total, totalCounts.get(target.total) + weight)
    exactCounts.set(target.dice.join('-'), exactCounts.get(target.dice.join('-')) + weight)
    classCounts.set(classifyTotal(target.total), classCounts.get(classifyTotal(target.total)) + weight)
    for (const face of target.dice) {
      faceCounts.set(face, faceCounts.get(face) + weight / 3)
    }

    matchCount += 1
    totalWeight += weight
  }

  return {
    totalProbabilities: normalizeMap(totalCounts),
    exactProbabilities: normalizeMap(exactCounts),
    classProbabilities: normalizeMap(classCounts),
    faceProbabilities: normalizeMap(faceCounts),
    diagnostics: {
      expertId: expert.id,
      matchCount,
      totalWeight: Number(totalWeight.toFixed(6)),
      lookback: expert.lookback,
      minSimilarity: expert.minSimilarity,
    },
  }
}

function evaluateContextExpert(expert, roundsDesc, options = {}) {
  const evalRounds = options.evalRounds ?? 120
  const trainWindow = options.trainWindow ?? 4000
  const exactCombos = options.exactCombos ?? enumerateExactCombos()
  const theory = options.theory ?? buildTheoryMaps(exactCombos)
  const regime = options.regime ?? {}

  const asc = roundsDesc.slice().reverse()
  const startIndex = Math.max(180, asc.length - evalRounds)
  let score = 0
  let samples = 0
  let weightedSamples = 0

  for (let i = startIndex; i < asc.length; i += 1) {
    const trainAsc = asc.slice(Math.max(0, i - trainWindow), i)
    if (trainAsc.length < expert.lookback + 50) continue

    const model = buildContextExpertPredictionFromAsc(trainAsc, expert, { exactCombos, theory })
    const actual = asc[i]
    const context = buildContextSnapshotFromAsc(trainAsc, trainAsc.length, expert.lookback)

    let sampleWeight = 1
    if (regime.latestClass && context?.latestLabel === regime.latestClass) sampleWeight += 0.35
    if (regime.latestPattern && context?.latestPattern === regime.latestPattern) sampleWeight += 0.25

    score += Math.log((model.totalProbabilities.get(actual.total) || 1e-9) + 1e-12) * sampleWeight
    samples += 1
    weightedSamples += sampleWeight
  }

  return {
    expertId: expert.id,
    label: expert.label,
    avgLogScore: weightedSamples ? Number((score / weightedSamples).toFixed(6)) : -999,
    samples,
    weightedSamples: Number(weightedSamples.toFixed(2)),
  }
}

function pickBestContextExperts(roundsDesc, regime, options = {}) {
  const evaluations = CONTEXT_LIBRARY.map((expert) =>
    evaluateContextExpert(expert, roundsDesc, { ...options, regime }),
  ).sort((a, b) => b.avgLogScore - a.avgLogScore)

  return {
    evaluations,
    bestExpertId: evaluations[0]?.expertId || CONTEXT_LIBRARY[0].id,
  }
}

function buildExpertBlendWeights(evaluations, key = 'profileId') {
  if (!evaluations.length) return []

  const bestScore = evaluations[0].avgLogScore
  const raw = evaluations.slice(0, 3).map((item) => ({
    id: item[key],
    rawWeight: Math.exp((item.avgLogScore - bestScore) * 12),
  }))
  const total = raw.reduce((sum, item) => sum + item.rawWeight, 0) || 1

  return raw.map((item) => ({
    id: item.id,
    weight: Number((item.rawWeight / total).toFixed(6)),
  }))
}

function scoreTotalsForProfile(features, profile, latestClass) {
  const scored = new Map()
  const componentMap = new Map()

  for (let total = 3; total <= 18; total += 1) {
    const label = classifyTotal(total)
    const components = {
      theoretical: features.totalTheory.get(total) || 0,
      historical: features.globalTotalProb.get(total) || 0,
      shortRecent: features.shortRecentTotalProb.get(total) || 0,
      recent: features.recentTotalProb.get(total) || 0,
      longRecent: features.longRecentTotalProb.get(total) || 0,
      decayed: features.decayedTotalProb.get(total) || 0,
      daily: features.dayTotalProb.get(total) || 0,
      afterLatestTotal: features.afterLatestTotalProb.get(total) || 0,
      afterLatestClass: features.afterLatestClassProb.get(label) || 0,
      afterLatestPattern: features.afterLatestPatternProb.get(total) || 0,
      dailyPatternBias: features.dailyPatternBias.get(total) || 0,
      theoryGap: features.totalTheoryGap.get(total) || 0,
    }

    let score = 0
    for (const [name, value] of Object.entries(components)) {
      score += value * (profile.total[name] || 0)
    }

    if (latestClass && latestClass === label) {
      score += 0.01
      components.sameClassAsLatest = 1
    } else {
      components.sameClassAsLatest = 0
    }

    score += components.decayed * 0.08
    score += components.theoryGap * 0.05
    score += components.shortRecent * 0.11
    score += components.longRecent * 0.05
    score += ((components.shortRecent + components.recent + components.longRecent) / 3) * 0.06

    scored.set(total, score)
    componentMap.set(total, components)
  }

  const probabilities = normalizeMap(scored)
  const maxScore = Math.max(...scored.values(), 1)
  const ranked = [...probabilities.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([total, probability]) => ({
      total: Number(total),
      result: classifyTotal(Number(total)),
      probability: Number(probability.toFixed(6)),
      score: scoreTo100(scored.get(total), maxScore),
      components: Object.fromEntries(
        Object.entries(componentMap.get(total)).map(([key, value]) => [key, Number(value.toFixed(6))]),
      ),
    }))

  return { probabilities, ranked, componentMap }
}

function scoreExactDiceForProfile(features, profile, totalProbabilities) {
  const scores = new Map()
  const details = new Map()
  const patternBoostMap = new Map(features.dayPatternStats.map((item) => [item.pattern, item.rate / 100]))

  for (const combo of features.exactCombos) {
    const key = combo.join('-')
    const canonicalKey = canonicalComboKey(combo)
    const total = sumDice(combo)
    const pattern = roundPattern({ dice: combo })

    const components = {
      theoretical: features.exactTheory.get(key) || 0,
      historical: features.globalExactProb.get(key) || 0,
      canonicalHistorical: features.globalCanonicalProb.get(canonicalKey) || 0,
      shortRecent: features.shortRecentExactProb.get(key) || 0,
      canonicalShortRecent: features.shortRecentCanonicalProb.get(canonicalKey) || 0,
      recent: features.recentExactProb.get(key) || 0,
      canonicalRecent: features.recentCanonicalProb.get(canonicalKey) || 0,
      longRecent: features.longRecentExactProb.get(key) || 0,
      canonicalLongRecent: features.longRecentCanonicalProb.get(canonicalKey) || 0,
      decayed: features.decayedExactProb.get(key) || 0,
      canonicalDecayed: features.decayedCanonicalProb.get(canonicalKey) || 0,
      daily: features.dayExactProb.get(key) || 0,
      canonicalDaily: features.dayCanonicalProb.get(canonicalKey) || 0,
      inheritedFromTotal: totalProbabilities.get(total) || 0,
      todayDoublePatternBoost: patternBoostMap.get(pattern) || 0,
      theoryGap: features.exactTheoryGap.get(key) || 0,
      canonicalTheoryGap: features.canonicalTheoryGap.get(canonicalKey) || 0,
    }

    let score = 0
    for (const [name, value] of Object.entries(components)) {
      score += value * (profile.exact[name] || 0)
    }

    const facePressure = combo.reduce((acc, face) => acc + (features.faceMomentum.get(face) || 0), 0) / 3
    const diversityBoost = pattern === 'mixed' ? 0.004 : 0
    score += components.decayed * 0.08
    score += components.theoryGap * 0.04
    score += components.canonicalHistorical * 0.08
    score += components.canonicalShortRecent * 0.08
    score += components.canonicalRecent * 0.07
    score += components.canonicalLongRecent * 0.04
    score += components.canonicalDecayed * 0.08
    score += components.canonicalDaily * 0.05
    score += components.canonicalTheoryGap * 0.03
    score += facePressure * 0.16
    score += components.shortRecent * 0.12
    score += components.longRecent * 0.05
    score += ((components.shortRecent + components.recent + components.longRecent) / 3) * 0.05
    score += diversityBoost

    scores.set(key, score)
    details.set(key, { pattern, components, facePressure: Number(facePressure.toFixed(6)) })
  }

  const probabilities = normalizeMap(scores)
  const maxScore = Math.max(...scores.values(), 1)

  const ranked = [...probabilities.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, probability]) => {
      const info = details.get(key)
      const dice = key.split('-').map(Number)
      return {
        dice,
        total: sumDice(dice),
        probability: Number(probability.toFixed(6)),
        score: scoreTo100(scores.get(key), maxScore),
        pattern: info.pattern,
        facePressure: Number((info.facePressure * 100).toFixed(2)),
      }
    })

  return { probabilities, ranked }
}

function buildFeatureSet(roundsDesc, options = {}) {
  const recentWindow = options.recentWindow ?? 300
  const shortWindow = options.shortWindow ?? 90
  const longWindow = options.longWindow ?? 900
  const exactCombos = options.exactCombos ?? enumerateExactCombos()
  const theory = options.theory ?? buildTheoryMaps(exactCombos)
  const latestRound = roundsDesc[0] ?? null
  const recentRounds = roundsDesc.slice(0, Math.min(recentWindow, roundsDesc.length))
  const shortRecentRounds = windowSlice(roundsDesc, shortWindow)
  const longRecentRounds = windowSlice(roundsDesc, longWindow)
  const dayMap = mapRoundsByDay(roundsDesc)
  const latestDayKey = latestRound ? dateKeyFromValue(roundDateValue(latestRound)) : null
  const latestDayRounds = latestDayKey ? dayMap.get(latestDayKey) || [] : []
  const latestClass = latestRound ? classifyTotal(latestRound.total) : null
  const latestPattern = latestRound ? roundPattern(latestRound) : null

  const totalTransitionMatrix = buildTotalTransitionMatrix(roundsDesc)
  const classTransitionMatrix = buildClassTransitionMatrix(roundsDesc)
  const patternTransitionMatrix = buildPatternTransitionMatrix(roundsDesc)

  const globalTotalProb = normalizeMap(countByTotal(roundsDesc))
  const shortRecentTotalProb = normalizeMap(countByTotal(shortRecentRounds))
  const recentTotalProb = normalizeMap(countByTotal(recentRounds))
  const longRecentTotalProb = normalizeMap(countByTotal(longRecentRounds))
  const dayTotalProb = normalizeMap(countByTotal(latestDayRounds))
  const decayedTotalProb = buildDecayedTotalProb(roundsDesc)
  const afterLatestTotalProb = latestRound
    ? normalizeMap(totalTransitionMatrix.get(latestRound.total))
    : new Map([...theory.totalTheory.entries()])
  const afterLatestClassProb = latestClass
    ? normalizeMap(classTransitionMatrix.get(latestClass))
    : new Map([
        ['Small', 1 / 3],
        ['Draw', 1 / 3],
        ['Big', 1 / 3],
      ])
  const afterLatestPatternProb =
    latestPattern && patternTransitionMatrix.has(latestPattern)
      ? normalizeMap(patternTransitionMatrix.get(latestPattern))
      : new Map([...theory.totalTheory.entries()])

  const globalExactCounts = countByExact(roundsDesc, exactCombos)
  const globalCanonicalCounts = countByCanonical(roundsDesc, exactCombos)
  const shortRecentExactCounts = countByExact(shortRecentRounds, exactCombos)
  const shortRecentCanonicalCounts = countByCanonical(shortRecentRounds, exactCombos)
  const recentExactCounts = countByExact(recentRounds, exactCombos)
  const recentCanonicalCounts = countByCanonical(recentRounds, exactCombos)
  const longRecentExactCounts = countByExact(longRecentRounds, exactCombos)
  const longRecentCanonicalCounts = countByCanonical(longRecentRounds, exactCombos)
  const dayExactCounts = countByExact(latestDayRounds, exactCombos)
  const dayCanonicalCounts = countByCanonical(latestDayRounds, exactCombos)

  const globalExactDenominator = roundsDesc.length + exactCombos.length
  const globalCanonicalDenominator = roundsDesc.length + theory.canonicalTheory.size
  const shortRecentExactDenominator = shortRecentRounds.length + exactCombos.length
  const shortRecentCanonicalDenominator = shortRecentRounds.length + theory.canonicalTheory.size
  const recentExactDenominator = recentRounds.length + exactCombos.length
  const recentCanonicalDenominator = recentRounds.length + theory.canonicalTheory.size
  const longRecentExactDenominator = longRecentRounds.length + exactCombos.length
  const longRecentCanonicalDenominator = longRecentRounds.length + theory.canonicalTheory.size
  const dayExactDenominator = latestDayRounds.length + exactCombos.length
  const dayCanonicalDenominator = latestDayRounds.length + theory.canonicalTheory.size

  const globalExactProb = new Map()
  const globalCanonicalProb = new Map()
  const shortRecentExactProb = new Map()
  const shortRecentCanonicalProb = new Map()
  const recentExactProb = new Map()
  const recentCanonicalProb = new Map()
  const longRecentExactProb = new Map()
  const longRecentCanonicalProb = new Map()
  const dayExactProb = new Map()
  const dayCanonicalProb = new Map()
  const canonicalKeys = new Set()
  for (const combo of exactCombos) {
    const key = combo.join('-')
    const canonicalKey = canonicalComboKey(combo)
    canonicalKeys.add(canonicalKey)
    globalExactProb.set(key, (globalExactCounts.get(key) + 1) / globalExactDenominator)
    shortRecentExactProb.set(key, (shortRecentExactCounts.get(key) + 1) / shortRecentExactDenominator)
    recentExactProb.set(key, (recentExactCounts.get(key) + 1) / recentExactDenominator)
    longRecentExactProb.set(key, (longRecentExactCounts.get(key) + 1) / longRecentExactDenominator)
    dayExactProb.set(key, (dayExactCounts.get(key) + 1) / dayExactDenominator)
  }
  for (const canonicalKey of canonicalKeys) {
    globalCanonicalProb.set(canonicalKey, (globalCanonicalCounts.get(canonicalKey) + 1) / globalCanonicalDenominator)
    shortRecentCanonicalProb.set(canonicalKey, (shortRecentCanonicalCounts.get(canonicalKey) + 1) / shortRecentCanonicalDenominator)
    recentCanonicalProb.set(canonicalKey, (recentCanonicalCounts.get(canonicalKey) + 1) / recentCanonicalDenominator)
    longRecentCanonicalProb.set(canonicalKey, (longRecentCanonicalCounts.get(canonicalKey) + 1) / longRecentCanonicalDenominator)
    dayCanonicalProb.set(canonicalKey, (dayCanonicalCounts.get(canonicalKey) + 1) / dayCanonicalDenominator)
  }

  const decayedExactProb = buildDecayedExactProb(roundsDesc, exactCombos)
  const decayedCanonicalProb = buildDecayedCanonicalProb(roundsDesc, exactCombos)
  const faceMomentum = buildFaceMomentum(roundsDesc)
  const totalTheoryGap = buildTheoryGapBias(decayedTotalProb, theory.totalTheory)
  const exactTheoryGap = buildTheoryGapBias(decayedExactProb, theory.exactTheory)
  const canonicalTheoryGap = buildTheoryGapBias(decayedCanonicalProb, theory.canonicalTheory)

  return {
    exactCombos,
    exactTheory: theory.exactTheory,
    canonicalTheory: theory.canonicalTheory,
    totalTheory: theory.totalTheory,
    latestRound,
    latestClass,
    latestPattern,
    latestDayKey,
    latestDayRounds,
    shortRecentRounds,
    recentRounds,
    longRecentRounds,
    globalTotalProb,
    shortRecentTotalProb,
    recentTotalProb,
    longRecentTotalProb,
    decayedTotalProb,
    dayTotalProb,
    afterLatestTotalProb,
    afterLatestClassProb,
    afterLatestPatternProb,
    dailyPatternBias: countPatternBiasByTotal(latestDayRounds),
    dayPatternStats: buildPatternStats(latestDayRounds).filter((item) => item.pattern !== 'mixed'),
    globalExactProb,
    globalCanonicalProb,
    shortRecentExactProb,
    shortRecentCanonicalProb,
    recentExactProb,
    recentCanonicalProb,
    longRecentExactProb,
    longRecentCanonicalProb,
    dayExactProb,
    dayCanonicalProb,
    decayedExactProb,
    decayedCanonicalProb,
    faceMomentum,
    totalTheoryGap,
    exactTheoryGap,
    canonicalTheoryGap,
  }
}

function evaluateProfile(profile, roundsDesc, options = {}) {
  const recentWindow = options.recentWindow ?? 300
  const shortWindow = options.shortWindow ?? 90
  const longWindow = options.longWindow ?? 900
  const evalRounds = options.evalRounds ?? 120
  const trainWindow = options.trainWindow ?? 1800
  const exactCombos = options.exactCombos ?? enumerateExactCombos()
  const theory = options.theory ?? buildTheoryMaps(exactCombos)
  const regime = options.regime ?? {}

  const asc = roundsDesc.slice().reverse()
  const startIndex = Math.max(180, asc.length - evalRounds)
  let score = 0
  let samples = 0
  let weightedSamples = 0

  for (let i = startIndex; i < asc.length; i += 1) {
    const trainAsc = asc.slice(Math.max(0, i - trainWindow), i)
    if (trainAsc.length < 120) continue

    const trainDesc = trainAsc.slice().reverse()
    const features = buildFeatureSet(trainDesc, {
      recentWindow,
      shortWindow,
      longWindow,
      exactCombos,
      theory,
    })
    const latestClass = features.latestClass
    const model = scoreTotalsForProfile(features, profile, latestClass)
    const actualTotal = asc[i].total
    const actualProb = model.probabilities.get(actualTotal) || 1e-9
    let sampleWeight = 1
    if (regime.latestClass && features.latestClass === regime.latestClass) sampleWeight += 0.35
    if (regime.latestPattern && features.latestPattern === regime.latestPattern) sampleWeight += 0.25
    if (
      regime.topDayPattern?.pattern &&
      features.dayPatternStats[0]?.pattern === regime.topDayPattern.pattern
    ) {
      sampleWeight += 0.2
    }

    score += Math.log(actualProb + 1e-12) * sampleWeight
    samples += 1
    weightedSamples += sampleWeight
  }

  return {
    profileId: profile.id,
    label: profile.label,
    avgLogScore: weightedSamples ? Number((score / weightedSamples).toFixed(6)) : -999,
    samples,
    weightedSamples: Number(weightedSamples.toFixed(2)),
  }
}

function pickBestProfile(roundsDesc, regime, options = {}) {
  const evaluations = PROFILE_LIBRARY.map((profile) =>
    evaluateProfile(profile, roundsDesc, { ...options, regime }),
  ).sort((a, b) => b.avgLogScore - a.avgLogScore)

  const backtestBest = evaluations[0]?.profileId || 'balanced'
  const preferred = regime.preferredProfileId
  const chosenProfileId = preferred === backtestBest ? preferred : evaluations[0]?.profileId || preferred
  const chosenProfile = PROFILE_LIBRARY.find((profile) => profile.id === chosenProfileId) || PROFILE_LIBRARY[0]

  return {
    chosenProfile,
    preferredProfileId: preferred,
    backtestBestProfileId: backtestBest,
    evaluations,
  }
}

function buildProfileBlendWeights(evaluations) {
  return buildExpertBlendWeights(evaluations, 'profileId').map((item) => ({
    profileId: item.id,
    weight: item.weight,
  }))
}

function blendProbabilityMaps(weightedMaps) {
  const combined = new Map()

  for (const { map, weight } of weightedMaps) {
    for (const [key, probability] of map.entries()) {
      combined.set(key, (combined.get(key) || 0) + probability * weight)
    }
  }

  return normalizeMap(combined)
}

function rankTotalsFromProbabilityMap(probabilities, componentMaps = []) {
  const maxProbability = Math.max(...probabilities.values(), 1)

  return [...probabilities.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([total, probability]) => {
      const mergedComponents = {}
      componentMaps.forEach(({ components, weight }) => {
        const source = components.get(total) || {}
        for (const [name, value] of Object.entries(source)) {
          mergedComponents[name] = (mergedComponents[name] || 0) + value * weight
        }
      })

      return {
        total: Number(total),
        result: classifyTotal(Number(total)),
        probability: Number(probability.toFixed(6)),
        score: scoreTo100(probability, maxProbability),
        components: Object.fromEntries(
          Object.entries(mergedComponents).map(([key, value]) => [key, Number(value.toFixed(6))]),
        ),
      }
    })
}

function buildSurpriseTotals(features) {
  const rows = []

  for (let total = 3; total <= 18; total += 1) {
    const historical = features.globalTotalProb.get(total) || 0
    const shortRecent = features.shortRecentTotalProb.get(total) || 0
    const recent = features.recentTotalProb.get(total) || 0
    const daily = features.dayTotalProb.get(total) || 0
    const theoryGap = features.totalTheoryGap.get(total) || 0
    const tailBoost = total <= 7 || total >= 14 ? 1.2 : 1
    const scoreRaw =
      (Math.max(0, shortRecent - historical) * 0.38 +
        Math.max(0, recent - historical) * 0.27 +
        Math.max(0, daily - historical) * 0.2 +
        theoryGap * 0.15) *
      tailBoost

    rows.push({
      total,
      result: classifyTotal(total),
      historicalRate: Number((historical * 100).toFixed(2)),
      shortRecentRate: Number((shortRecent * 100).toFixed(2)),
      recentRate: Number((recent * 100).toFixed(2)),
      todayRate: Number((daily * 100).toFixed(2)),
      scoreRaw,
    })
  }

  const maxScore = Math.max(...rows.map((item) => item.scoreRaw), 1)
  return rows
    .sort((a, b) => b.scoreRaw - a.scoreRaw)
    .map((item) => ({
      total: item.total,
      result: item.result,
      historicalRate: item.historicalRate,
      shortRecentRate: item.shortRecentRate,
      recentRate: item.recentRate,
      todayRate: item.todayRate,
      score: scoreTo100(item.scoreRaw, maxScore),
    }))
}

function rankExactDiceFromProbabilityMap(probabilities, exactCombos) {
  const maxProbability = Math.max(...probabilities.values(), 1)

  return [...probabilities.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, probability]) => {
      const dice = key.split('-').map(Number)
      return {
        dice,
        total: sumDice(dice),
        probability: Number(probability.toFixed(6)),
        score: scoreTo100(probability, maxProbability),
        pattern: roundPattern({ dice }),
      }
    })
}

function analyticsLikeFaceRate(roundsDesc, features, face) {
  const overall = roundsDesc.filter((round) => round.dice.includes(face)).length / Math.max(roundsDesc.length, 1)
  const recent =
    features.recentRounds.filter((round) => round.dice.includes(face)).length /
    Math.max(features.recentRounds.length, 1)
  const today =
    features.latestDayRounds.filter((round) => round.dice.includes(face)).length /
    Math.max(features.latestDayRounds.length, 1)

  return overall * 0.2 + recent * 0.3 + today * 0.5
}

function computeEntropy(probabilities) {
  let entropy = 0
  for (const value of probabilities.values()) {
    if (value > 0) entropy += -value * Math.log(value)
  }
  return entropy
}

function computeNormalizedEntropy(probabilities) {
  const size = Math.max(probabilities.size, 1)
  return computeEntropy(probabilities) / Math.log(size)
}

function calibrateConfidence({ totalProbabilities, topTotals, regimeBreak, familyBlend, contextTuning }) {
  const top1 = topTotals[0]?.probability || 0
  const top2 = topTotals[1]?.probability || 0
  const spread = Math.max(0, top1 - top2)
  const entropyPenalty = computeNormalizedEntropy(totalProbabilities)
  const contextEdge = Math.max(
    0,
    (contextTuning.evaluations[0]?.avgLogScore || -999) - (contextTuning.evaluations[1]?.avgLogScore || -999),
  )

  const raw =
    spread * 10 +
    (familyBlend.context || 0) * 0.22 +
    contextEdge * 3.5 +
    (top1 * 2.2) -
    entropyPenalty * 0.55 -
    regimeBreak.pressure * 3.2

  const confidence = 1 / (1 + Math.exp(-(raw - 0.35) * 3.4))
  const confidenceScore = Number((confidence * 100).toFixed(2))

  let action = 'observe'
  if (confidenceScore >= 20) action = 'high_conviction'
  else if (confidenceScore >= 12) action = 'medium_conviction'

  return {
    confidence: Number(confidence.toFixed(6)),
    confidenceScore,
    entropy: Number(entropyPenalty.toFixed(6)),
    action,
    shouldAbstain: confidenceScore < 10 || regimeBreak.isBreaking,
  }
}

function buildRecommendations({ diagnosis, methodology, analytics }) {
  const confidenceModel = diagnosis.confidenceModel || {}
  const regimeBreak = methodology.regimeBreak || {}
  const confidenceScore = confidenceModel.confidenceScore || 0
  const recommendedResult = diagnosis.mostLikelyResult || 'Draw'
  const followTotals = [...(diagnosis.topTotals || []).slice(0, 2), ...((analytics?.surpriseTotals || [])
    .filter((item) => item.total <= 7 || item.total >= 14)
    .slice(0, 2))]
    .filter((item, index, array) => array.findIndex((candidate) => candidate.total === item.total) === index)
    .slice(0, 4)
    .map((item) => ({
      total: item.total,
      result: item.result,
      probability:
        item.probability != null
          ? Number((item.probability * 100).toFixed(2))
          : Number((item.score || 0).toFixed(2)),
    }))
  const followFaces = (diagnosis.topFaces || []).slice(0, 4).map((item) => ({
    face: item.face,
    score: item.score,
    probabilityHint: item.probabilityHint,
  }))
  const avoidTotals = (diagnosis.topTotals || [])
    .slice()
    .sort((a, b) => a.probability - b.probability)
    .slice(0, 3)
    .map((item) => ({
      total: item.total,
      result: item.result,
      probability: Number((item.probability * 100).toFixed(2)),
    }))
  const hotBetFaces = ((analytics?.betTypes?.singleFaces || []).slice(0, 3)).map((item) => ({
    face: item.face,
    score: item.score,
    recentRate: item.recentRate,
    todayRate: item.todayRate,
  }))
  const watchExactDice = (diagnosis.topExactDice || []).slice(0, 3).map((item) => ({
    dice: item.dice,
    total: item.total,
    probability: Number((item.probability * 100).toFixed(2)),
  }))

  let recommendationCode = 'NO_BET'
  let recommendationText = 'Đứng ngoài, chỉ quan sát thêm dữ liệu.'
  let stakePlan = '0%'

  let primaryMethod = 'Quan sat'
  let confidenceBand = 'Thap'
  let riskLevel = 'Cao'

  if (!confidenceModel.shouldAbstain && !regimeBreak.isBreaking) {
    if ((confidenceModel.confidenceScore || 0) >= 18) {
      recommendationCode = 'FOLLOW_PRIMARY'
      recommendationText = `Ưu tiên theo ${diagnosis.mostLikelyResult} và bám các tổng ${followTotals.map((item) => item.total).join(', ')}.`
      stakePlan = '0.75u'
    } else {
      recommendationCode = 'LIGHT_FOLLOW'
      recommendationText = `Chỉ vào nhẹ theo ${diagnosis.mostLikelyResult}, ưu tiên tổng ${followTotals[0]?.total ?? 'n/a'} và mặt ${followFaces.slice(0, 2).map((item) => item.face).join(', ')}.`
      stakePlan = '0.25u'
    }
  } else if (regimeBreak.isBreaking) {
    recommendationText = 'Cầu đang có dấu hiệu gãy pha, không nên theo mạnh.'
  }

  if (!confidenceModel.shouldAbstain && !regimeBreak.isBreaking) {
    if (confidenceScore >= 18) {
      primaryMethod = 'Theo ket qua chinh + tong uu tien'
      confidenceBand = 'Cao'
      riskLevel = 'Trung binh'
      recommendationText = `Theo ${recommendedResult} va bam cac tong ${followTotals.map((item) => item.total).join(', ')}.`
    } else {
      primaryMethod = 'Theo nhe ket qua chinh + 1 tong'
      confidenceBand = 'Vua'
      riskLevel = 'Trung binh cao'
      recommendationText = `Vao nhe theo ${recommendedResult}, uu tien tong ${followTotals[0]?.total ?? 'n/a'} va mat ${followFaces.slice(0, 2).map((item) => item.face).join(', ')}.`
    }
  } else if (regimeBreak.isBreaking) {
    primaryMethod = 'Dung lai, chi quan sat'
    confidenceBand = 'Rat thap'
    recommendationText = 'Cau dang co dau hieu gay pha, khong nen theo manh.'
  } else {
    primaryMethod = 'Dung lai, cho them edge'
  }

  const methodNotes = [
    'Không vào lệnh khi confidence thấp hoặc cầu có dấu hiệu gãy.',
    `Ưu tiên lớp kết quả ${diagnosis.mostLikelyResult}, sau đó mới xét tổng và mặt số.`,
    `Mặt nên theo: ${followFaces.slice(0, 3).map((item) => item.face).join(', ') || 'n/a'}.`,
    `Tổng nên tránh: ${avoidTotals.map((item) => item.total).join(', ') || 'n/a'}.`,
  ]

  return {
    recommendationCode,
    recommendationText,
    stakePlan,
    confidenceBand,
    riskLevel,
    primaryMethod,
    recommendedResult,
    followTotals,
    followFaces,
    hotBetFaces,
    watchExactDice,
    avoidTotals,
    methodNotes,
  }
}

function buildAnalytics(roundsDesc, features, diagnosis) {
  const faceOverall = buildFaceStats(roundsDesc)
  const faceRecent = buildFaceStats(features.recentRounds)
  const faceToday = buildFaceStats(features.latestDayRounds)

  const faceScores = faceOverall.map((item) => {
    const recent = faceRecent.find((face) => face.face === item.face)?.rate || 0
    const today = faceToday.find((face) => face.face === item.face)?.rate || 0
    const score = item.rate * 0.25 + recent * 0.3 + today * 0.45
    return {
      face: item.face,
      overallRate: Number((item.rate * 100).toFixed(2)),
      recentRate: Number((recent * 100).toFixed(2)),
      todayRate: Number((today * 100).toFixed(2)),
      score,
    }
  })
  const maxFaceScore = Math.max(...faceScores.map((item) => item.score), 1)

  const hotFaces = faceScores
    .sort((a, b) => b.score - a.score)
    .map((item) => ({
      face: item.face,
      overallRate: item.overallRate,
      recentRate: item.recentRate,
      todayRate: item.todayRate,
      score: scoreTo100(item.score, maxFaceScore),
    }))
    .slice(0, 6)

  const pairPatterns = buildPatternStats(roundsDesc)
    .filter((item) => item.pattern !== 'mixed')
    .slice(0, 6)
    .map((item) => ({
      pattern: item.pattern,
      count: item.count,
      rate: Number((item.rate * 100).toFixed(2)),
    }))

  const pairPatternsToday = features.dayPatternStats.slice(0, 6).map((item) => ({
    pattern: item.pattern,
    count: item.count,
    rate: Number((item.rate * 100).toFixed(2)),
  }))

  function weightedRate(overall, recent, today) {
    return overall * 0.2 + recent * 0.3 + today * 0.5
  }

  const exactTripleStats = Array.from({ length: 6 }, (_, index) => {
    const face = index + 1
    const overall = roundsDesc.filter((round) => roundPattern(round) === `${face}${face}${face}`).length
    const recent = features.recentRounds.filter(
      (round) => roundPattern(round) === `${face}${face}${face}`,
    ).length
    const today = features.latestDayRounds.filter(
      (round) => roundPattern(round) === `${face}${face}${face}`,
    ).length
    const overallRate = overall / Math.max(roundsDesc.length, 1)
    const recentRate = recent / Math.max(features.recentRounds.length, 1)
    const todayRate = today / Math.max(features.latestDayRounds.length, 1)
    return {
      face,
      count: overall,
      overallRate: Number((overallRate * 100).toFixed(2)),
      recentRate: Number((recentRate * 100).toFixed(2)),
      todayRate: Number((todayRate * 100).toFixed(2)),
      scoreRaw: weightedRate(overallRate, recentRate, todayRate),
    }
  })
  const tripleMax = Math.max(...exactTripleStats.map((item) => item.scoreRaw), 1)

  const exactDoubleStats = Array.from({ length: 6 }, (_, index) => {
    const face = index + 1
    const pattern = `${face}${face}x`
    const overall = roundsDesc.filter((round) => roundPattern(round) === pattern).length
    const recent = features.recentRounds.filter((round) => roundPattern(round) === pattern).length
    const today = features.latestDayRounds.filter((round) => roundPattern(round) === pattern).length
    const overallRate = overall / Math.max(roundsDesc.length, 1)
    const recentRate = recent / Math.max(features.recentRounds.length, 1)
    const todayRate = today / Math.max(features.latestDayRounds.length, 1)
    return {
      face,
      pattern,
      count: overall,
      overallRate: Number((overallRate * 100).toFixed(2)),
      recentRate: Number((recentRate * 100).toFixed(2)),
      todayRate: Number((todayRate * 100).toFixed(2)),
      scoreRaw: weightedRate(overallRate, recentRate, todayRate),
    }
  })
  const doubleMax = Math.max(...exactDoubleStats.map((item) => item.scoreRaw), 1)

  const singleFaceStats = Array.from({ length: 6 }, (_, index) => {
    const face = index + 1
    const overall = roundsDesc.filter((round) => round.dice.includes(face)).length
    const recent = features.recentRounds.filter((round) => round.dice.includes(face)).length
    const today = features.latestDayRounds.filter((round) => round.dice.includes(face)).length
    const overallRate = overall / Math.max(roundsDesc.length, 1)
    const recentRate = recent / Math.max(features.recentRounds.length, 1)
    const todayRate = today / Math.max(features.latestDayRounds.length, 1)
    return {
      face,
      count: overall,
      overallRate: Number((overallRate * 100).toFixed(2)),
      recentRate: Number((recentRate * 100).toFixed(2)),
      todayRate: Number((todayRate * 100).toFixed(2)),
      scoreRaw: weightedRate(overallRate, recentRate, todayRate),
    }
  })
  const singleMax = Math.max(...singleFaceStats.map((item) => item.scoreRaw), 1)

  const anyTripleOverall = roundsDesc.filter((round) => isExactTriplePattern(roundPattern(round))).length
  const anyTripleRecent = features.recentRounds.filter((round) => isExactTriplePattern(roundPattern(round))).length
  const anyTripleToday = features.latestDayRounds.filter((round) => isExactTriplePattern(roundPattern(round))).length
  const anyTripleScoreRaw = weightedRate(
    anyTripleOverall / Math.max(roundsDesc.length, 1),
    anyTripleRecent / Math.max(features.recentRounds.length, 1),
    anyTripleToday / Math.max(features.latestDayRounds.length, 1),
  )

  const coOccurrencePairs = buildCoOccurrenceStats(roundsDesc).map((item, _, all) => ({
    pair: item.pair,
    count: item.count,
    rate: Number((item.rate * 100).toFixed(2)),
    score: scoreTo100(item.count, all[0]?.count || 1),
  }))

  const todayTopTotals = topEntries(features.dayTotalProb, 5, (total, probability) => ({
    total: Number(total),
    result: classifyTotal(Number(total)),
    rate: Number((probability * 100).toFixed(2)),
  }))

  const afterLatestTotal = topEntries(features.afterLatestTotalProb, 4, (total, probability) => ({
    total: Number(total),
    result: classifyTotal(Number(total)),
    probability: Number((probability * 100).toFixed(2)),
  }))

  const afterLatestPattern = topEntries(features.afterLatestPatternProb, 4, (total, probability) => ({
    total: Number(total),
    result: classifyTotal(Number(total)),
    probability: Number((probability * 100).toFixed(2)),
  }))

  const tripleHourCounts = new Map()
  for (let hour = 0; hour < 24; hour += 1) tripleHourCounts.set(hour, 0)

  const exactTripleHourCounts = new Map()
  for (let face = 1; face <= 6; face += 1) {
    const counts = new Map()
    for (let hour = 0; hour < 24; hour += 1) counts.set(hour, 0)
    exactTripleHourCounts.set(face, counts)
  }

  for (const round of roundsDesc) {
    const pattern = roundPattern(round)
    if (!isExactTriplePattern(pattern)) continue

    const hour = roundHourBucket(round)
    if (hour == null) continue

    tripleHourCounts.set(hour, (tripleHourCounts.get(hour) || 0) + 1)

    const face = Number(pattern[0])
    if (exactTripleHourCounts.has(face)) {
      const counts = exactTripleHourCounts.get(face)
      counts.set(hour, (counts.get(hour) || 0) + 1)
    }
  }

  const tripleHourMax = Math.max(...tripleHourCounts.values(), 1)
  const tripleHotHours = [...tripleHourCounts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hour, count]) => ({
      hour,
      label: `${String(hour).padStart(2, '0')}:00-${String(hour).padStart(2, '0')}:59`,
      count,
      rate: Number((count / Math.max(anyTripleOverall, 1) * 100).toFixed(2)),
      score: scoreTo100(count, tripleHourMax),
    }))

  const exactTripleHotHours = Array.from({ length: 6 }, (_, index) => {
    const face = index + 1
    const counts = exactTripleHourCounts.get(face)
    const faceTotal = exactTripleStats.find((item) => item.face === face)?.count || 0
    const faceMax = Math.max(...counts.values(), 1)

    return {
      face,
      totalCount: faceTotal,
      hours: [...counts.entries()]
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([hour, count]) => ({
          hour,
          label: `${String(hour).padStart(2, '0')}:00-${String(hour).padStart(2, '0')}:59`,
          count,
          rate: Number((count / Math.max(faceTotal, 1) * 100).toFixed(2)),
          score: scoreTo100(count, faceMax),
        })),
    }
  })
    .filter((item) => item.totalCount > 0)
    .sort((a, b) => b.totalCount - a.totalCount)

  return {
    hotFaces,
    pairPatterns,
    pairPatternsToday,
    coOccurrencePairs,
    todayTopTotals,
    surpriseTotals: buildSurpriseTotals(features).slice(0, 6),
    afterLatestRound: {
      latestTotal: features.latestRound?.total ?? null,
      latestClass: features.latestClass,
      latestPattern: features.latestPattern,
      topTotalsAfterLatestTotal: afterLatestTotal,
      topTotalsAfterLatestPattern: {
        pattern: features.latestPattern,
        topTotals: afterLatestPattern,
      },
      classFlow: {
        Small: Number(((features.afterLatestClassProb.get('Small') || 0) * 100).toFixed(2)),
        Draw: Number(((features.afterLatestClassProb.get('Draw') || 0) * 100).toFixed(2)),
        Big: Number(((features.afterLatestClassProb.get('Big') || 0) * 100).toFixed(2)),
      },
    },
    finalPicks: {
      totals: diagnosis.topTotals.slice(0, 5).map((item, index) => ({
        rank: index + 1,
        total: item.total,
        result: item.result,
        probability: Number((item.probability * 100).toFixed(2)),
        score: item.score,
      })),
      exactDice: diagnosis.topExactDice.slice(0, 5).map((item, index) => ({
        rank: index + 1,
        dice: item.dice,
        total: item.total,
        pattern: item.pattern,
        probability: Number((item.probability * 100).toFixed(2)),
        score: item.score,
      })),
    },
    betTypes: {
      exactTriples: exactTripleStats
        .sort((a, b) => b.scoreRaw - a.scoreRaw)
        .map((item) => ({
          face: item.face,
          overallRate: item.overallRate,
          recentRate: item.recentRate,
          todayRate: item.todayRate,
          score: scoreTo100(item.scoreRaw, tripleMax),
        })),
      anyTriple: {
        overallRate: Number(((anyTripleOverall / Math.max(roundsDesc.length, 1)) * 100).toFixed(2)),
        recentRate: Number(
          ((anyTripleRecent / Math.max(features.recentRounds.length, 1)) * 100).toFixed(2),
        ),
        todayRate: Number(
          ((anyTripleToday / Math.max(features.latestDayRounds.length, 1)) * 100).toFixed(2),
        ),
        score: Number((anyTripleScoreRaw * 100).toFixed(2)),
      },
      tripleHotHours,
      exactTripleHotHours,
      exactDoubles: exactDoubleStats
        .sort((a, b) => b.scoreRaw - a.scoreRaw)
        .map((item) => ({
          face: item.face,
          pattern: item.pattern,
          overallRate: item.overallRate,
          recentRate: item.recentRate,
          todayRate: item.todayRate,
          score: scoreTo100(item.scoreRaw, doubleMax),
        })),
      singleFaces: singleFaceStats
        .sort((a, b) => b.scoreRaw - a.scoreRaw)
        .map((item) => ({
          face: item.face,
          overallRate: item.overallRate,
          recentRate: item.recentRate,
          todayRate: item.todayRate,
          score: scoreTo100(item.scoreRaw, singleMax),
        })),
    },
  }
}

function aggregateResultProbabilitiesFromTotalMap(totalMap) {
  const resultMap = new Map([
    ['Small', 0],
    ['Draw', 0],
    ['Big', 0],
  ])

  for (const [total, probability] of totalMap.entries()) {
    const label = classifyTotal(total)
    resultMap.set(label, (resultMap.get(label) || 0) + probability)
  }

  return resultMap
}

function topEntriesFromMap(map, limit, mapper) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => mapper(key, value))
}

function computeSelectiveSnapshot(roundsDesc, options = {}) {
  const recentWindow = options.recentWindow ?? 240
  const shortWindow = options.shortWindow ?? 72
  const recentRounds = roundsDesc.slice(0, recentWindow)
  const shortRounds = roundsDesc.slice(0, shortWindow)

  if (recentRounds.length < 40) return null

  const latestRound = recentRounds[0]
  const latestClass = classifyTotal(latestRound.total)
  const latestPattern = roundPattern(latestRound)
  const overallClass = normalizeMap(countByClass(recentRounds))
  const shortClass = normalizeMap(countByClass(shortRounds))
  const classFlowCounts = new Map([
    ['Small', 0],
    ['Draw', 0],
    ['Big', 0],
  ])
  const totalFlowCounts = new Map()
  const patternFlowCounts = new Map()
  for (let total = 3; total <= 18; total += 1) {
    totalFlowCounts.set(total, 0)
    patternFlowCounts.set(total, 0)
  }

  let classSupport = 0
  let totalSupport = 0
  let patternSupport = 0
  const ascRecent = recentRounds.slice().reverse()

  for (let index = 0; index < ascRecent.length - 1; index += 1) {
    const current = ascRecent[index]
    const next = ascRecent[index + 1]
    const currentClass = classifyTotal(current.total)
    const nextClass = classifyTotal(next.total)

    if (currentClass === latestClass) {
      classSupport += 1
      classFlowCounts.set(nextClass, (classFlowCounts.get(nextClass) || 0) + 1)
    }

    if (current.total === latestRound.total) {
      totalSupport += 1
      totalFlowCounts.set(next.total, (totalFlowCounts.get(next.total) || 0) + 1)
    }

    if (roundPattern(current) === latestPattern) {
      patternSupport += 1
      patternFlowCounts.set(next.total, (patternFlowCounts.get(next.total) || 0) + 1)
    }
  }

  const classFlow = normalizeMap(classFlowCounts)
  const totalFlow = normalizeMap(totalFlowCounts)
  const patternFlow = normalizeMap(patternFlowCounts)
  const totalFlowByClass = aggregateResultProbabilitiesFromTotalMap(totalFlow)
  const patternFlowByClass = aggregateResultProbabilitiesFromTotalMap(patternFlow)
  const results = ['Small', 'Draw', 'Big']
  const rawScores = new Map()

  for (const result of results) {
    const score =
      (overallClass.get(result) || 0) * 0.22 +
      (shortClass.get(result) || 0) * 0.18 +
      (classFlow.get(result) || 0) * 0.34 +
      (totalFlowByClass.get(result) || 0) * 0.16 +
      (patternFlowByClass.get(result) || 0) * 0.1

    rawScores.set(result, score)
  }

  const scoreTotal = [...rawScores.values()].reduce((sum, value) => sum + value, 0) || 1
  const resultProbabilities = new Map(
    [...rawScores.entries()].map(([result, score]) => [result, score / scoreTotal]),
  )
  const rankedResults = [...resultProbabilities.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([result, probability]) => ({
      result,
      probability: Number((probability * 100).toFixed(2)),
    }))

  const totalTop = topEntriesFromMap(totalFlow, 4, (total, probability) => ({
    total: Number(total),
    result: classifyTotal(Number(total)),
    probability: Number((probability * 100).toFixed(2)),
  }))
  const patternTop = topEntriesFromMap(patternFlow, 4, (total, probability) => ({
    total: Number(total),
    result: classifyTotal(Number(total)),
    probability: Number((probability * 100).toFixed(2)),
  }))
  const totalTopMap = new Map(totalTop.map((item) => [item.total, item]))
  const consensusTotals = patternTop
    .filter((item) => totalTopMap.has(item.total))
    .map((item) => ({
      total: item.total,
      result: item.result,
      fromTotal: totalTopMap.get(item.total).probability,
      fromPattern: item.probability,
      averageProbability: Number(
        (((totalTopMap.get(item.total).probability + item.probability) / 2)).toFixed(2),
      ),
    }))
    .sort((a, b) => b.averageProbability - a.averageProbability)
  const topTotalClass = totalTop[0]?.result || null
  const topPatternClass = patternTop[0]?.result || null
  const topConsensus = consensusTotals[0] || null
  const secondaryConsensus = consensusTotals[1] || null
  const leadClass = rankedResults[0]?.result || null
  const drawProbability = rankedResults.find((item) => item.result === 'Draw')?.probability || 0
  const runnerUpResult = rankedResults[1]?.result || null
  const agreementSignals = [leadClass, topTotalClass, topPatternClass, topConsensus?.result].filter(Boolean)
  const agreementCount = agreementSignals.filter((value) => value === leadClass).length
  const consensusStrength = Number((topConsensus?.averageProbability || 0).toFixed(2))
  const totalPatternGap =
    totalTop[0] && patternTop[0]
      ? Number(Math.abs((totalTop[0].probability || 0) - (patternTop[0].probability || 0)).toFixed(2))
      : 0
  const consensusLeadMatch = !topConsensus || topConsensus.result === leadClass
  const alternativeResultPressure =
    !!(
      topConsensus &&
      secondaryConsensus &&
      topConsensus.result !== secondaryConsensus.result &&
      Math.abs((topConsensus.averageProbability || 0) - (secondaryConsensus.averageProbability || 0)) <= 3
    )
  const drawPressure =
    leadClass !== 'Draw' &&
    (
      drawProbability >= 26 ||
      Number(((rankedResults[0]?.probability || 0) - drawProbability).toFixed(2)) <= 8
    )

  return {
    latestRound: {
      id: latestRound.id,
      total: latestRound.total,
      result: latestClass,
      pattern: latestPattern,
      time: latestRound.time,
    },
    rankedResults,
    topResult: rankedResults[0]?.result || 'Draw',
    topProbability: rankedResults[0]?.probability || 0,
    drawProbability: Number(drawProbability.toFixed(2)),
    runnerUpProbability: rankedResults[1]?.probability || 0,
    runnerUpResult,
    spread: Number(((rankedResults[0]?.probability || 0) - (rankedResults[1]?.probability || 0)).toFixed(2)),
    classSupport,
    totalSupport,
    patternSupport,
    topTotalClass,
    topPatternClass,
    agreementCount,
    consensusStrength,
    totalPatternGap,
    consensusLeadMatch,
    alternativeResultPressure,
    drawPressure,
    classFlow: Object.fromEntries(results.map((result) => [result, Number(((classFlow.get(result) || 0) * 100).toFixed(2))])),
    totalSignals: totalTop,
    patternSignals: patternTop,
    consensusTotals,
  }
}

function selectiveShouldBet(snapshot, thresholds) {
  if (!snapshot) return false

  return (
    snapshot.topProbability >= thresholds.minTopProbability &&
    snapshot.spread >= thresholds.minSpread &&
    snapshot.classSupport >= thresholds.minClassSupport &&
    snapshot.totalSupport >= thresholds.minTotalSupport &&
    snapshot.patternSupport >= thresholds.minPatternSupport &&
    snapshot.consensusTotals.length >= thresholds.minConsensusCount &&
    snapshot.agreementCount >= thresholds.minAgreementCount &&
    snapshot.consensusStrength >= thresholds.minConsensusStrength &&
    snapshot.totalPatternGap <= thresholds.maxTotalPatternGap &&
    !snapshot.drawPressure
  )
}

function buildSelectiveStrategy(roundsDesc) {
  const evalSamples = Math.min(120, Math.max(roundsDesc.length - 241, 0))
  const lookbackWindow = 360
  const asc = roundsDesc.slice().reverse()
  const snapshots = []
  const strategyMode = 'precision_first'

  for (let index = Math.max(lookbackWindow, asc.length - evalSamples); index < asc.length; index += 1) {
    const historyAsc = asc.slice(Math.max(0, index - lookbackWindow), index)
    const historyDesc = historyAsc.slice().reverse()
    const nextRound = asc[index]
    const snapshot = computeSelectiveSnapshot(historyDesc)
    if (!snapshot || !nextRound) continue

    snapshots.push({
      ...snapshot,
      actualResult: classifyTotal(nextRound.total),
      actualTotal: nextRound.total,
      actualId: nextRound.id,
    })
  }

  const thresholdGrid = []
  for (const minTopProbability of [42, 44, 46, 48, 50, 52]) {
    for (const minSpread of [4, 5, 6, 8, 10, 12]) {
      for (const minClassSupport of [12, 16, 20, 24, 28]) {
        for (const minTotalSupport of [4, 6, 8, 10]) {
          for (const minPatternSupport of [18, 24, 30, 36]) {
            for (const minConsensusCount of [1]) {
              for (const minAgreementCount of [2, 3, 4]) {
                for (const minConsensusStrength of [10, 12, 14, 16]) {
                  for (const maxTotalPatternGap of [10, 8, 6]) {
                    thresholdGrid.push({
                      minTopProbability,
                      minSpread,
                      minClassSupport,
                      minTotalSupport,
                      minPatternSupport,
                      minConsensusCount,
                      minAgreementCount,
                      minConsensusStrength,
                      maxTotalPatternGap,
                    })
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  let best = null
  for (const thresholds of thresholdGrid) {
    const bets = snapshots.filter((snapshot) => selectiveShouldBet(snapshot, thresholds))
    if (bets.length < 6) continue

    const hitCount = bets.filter((bet) => bet.topResult === bet.actualResult).length
    const top2HitCount = bets.filter((bet) => {
      const top2 = bet.rankedResults.slice(0, 2).map((item) => item.result)
      return top2.includes(bet.actualResult)
    }).length
    const hitRate = Number(((hitCount / bets.length) * 100).toFixed(2))
    const top2HitRate = Number(((top2HitCount / bets.length) * 100).toFixed(2))
    const coverage = Number(((bets.length / Math.max(snapshots.length, 1)) * 100).toFixed(2))

    const candidate = {
      thresholds,
      qualifyingBets: bets.length,
      sampleSize: snapshots.length,
      hitRate,
      top2HitRate,
      coverage,
      skipRate: Number((100 - coverage).toFixed(2)),
      utility:
        strategyMode === 'precision_first'
          ? Number(
            (
              hitRate * 1.8 +
              top2HitRate * 0.2 -
              Math.max(0, 10 - bets.length) * 1.5 -
              Math.max(0, 8 - coverage) * 0.75
            ).toFixed(2),
          )
          : Number((hitRate - Math.max(0, 18 - bets.length) * 0.8 - Math.max(0, 12 - coverage) * 0.5).toFixed(2)),
    }

    if (
      !best ||
      candidate.utility > best.utility ||
      (candidate.utility === best.utility && candidate.hitRate > best.hitRate) ||
      (candidate.utility === best.utility && candidate.hitRate === best.hitRate && candidate.qualifyingBets > best.qualifyingBets) ||
      (candidate.utility === best.utility && candidate.hitRate === best.hitRate && candidate.qualifyingBets === best.qualifyingBets &&
        candidate.top2HitRate > best.top2HitRate)
    ) {
      best = candidate
    }
  }

  const fallbackThresholds = {
    minTopProbability: 46,
    minSpread: 6,
    minClassSupport: 16,
    minTotalSupport: 6,
    minPatternSupport: 24,
    minConsensusCount: 1,
    minAgreementCount: 3,
    minConsensusStrength: 12,
    maxTotalPatternGap: 8,
  }
  const selectedThresholds = best?.thresholds || fallbackThresholds
  const currentSnapshot = computeSelectiveSnapshot(roundsDesc)
  const recentQualified = snapshots
    .filter((snapshot) => selectiveShouldBet(snapshot, selectedThresholds))
    .slice(-12)
    .reverse()
    .map((snapshot) => ({
      roundId: snapshot.actualId,
      expected: snapshot.topResult,
      actual: snapshot.actualResult,
      hit: snapshot.topResult === snapshot.actualResult,
      topProbability: snapshot.topProbability,
      spread: snapshot.spread,
      support: snapshot.classSupport,
      consensusTotal: snapshot.consensusTotals[0]?.total ?? null,
    }))

  const currentDecision = currentSnapshot
    ? {
        decision: selectiveShouldBet(currentSnapshot, selectedThresholds) ? 'BET' : 'SKIP',
        shouldBet: selectiveShouldBet(currentSnapshot, selectedThresholds),
        recommendedResult: currentSnapshot.topResult,
        topProbability: currentSnapshot.topProbability,
        spread: currentSnapshot.spread,
        latestRound: currentSnapshot.latestRound,
        resultBreakdown: currentSnapshot.rankedResults,
        totalSignals: currentSnapshot.totalSignals,
        patternSignals: currentSnapshot.patternSignals,
        consensusTotals: currentSnapshot.consensusTotals.slice(0, 4),
        gateChecks: [
          {
            label: 'Top probability',
            value: currentSnapshot.topProbability,
            threshold: selectedThresholds.minTopProbability,
            pass: currentSnapshot.topProbability >= selectedThresholds.minTopProbability,
          },
          {
            label: 'Spread',
            value: currentSnapshot.spread,
            threshold: selectedThresholds.minSpread,
            pass: currentSnapshot.spread >= selectedThresholds.minSpread,
          },
          {
            label: 'Class support',
            value: currentSnapshot.classSupport,
            threshold: selectedThresholds.minClassSupport,
            pass: currentSnapshot.classSupport >= selectedThresholds.minClassSupport,
          },
          {
            label: 'Total support',
            value: currentSnapshot.totalSupport,
            threshold: selectedThresholds.minTotalSupport,
            pass: currentSnapshot.totalSupport >= selectedThresholds.minTotalSupport,
          },
          {
            label: 'Pattern support',
            value: currentSnapshot.patternSupport,
            threshold: selectedThresholds.minPatternSupport,
            pass: currentSnapshot.patternSupport >= selectedThresholds.minPatternSupport,
          },
          {
            label: 'Consensus count',
            value: currentSnapshot.consensusTotals.length,
            threshold: selectedThresholds.minConsensusCount,
            pass: currentSnapshot.consensusTotals.length >= selectedThresholds.minConsensusCount,
          },
          {
            label: 'Agreement count',
            value: currentSnapshot.agreementCount,
            threshold: selectedThresholds.minAgreementCount,
            pass: currentSnapshot.agreementCount >= selectedThresholds.minAgreementCount,
          },
          {
            label: 'Consensus strength',
            value: currentSnapshot.consensusStrength,
            threshold: selectedThresholds.minConsensusStrength,
            pass: currentSnapshot.consensusStrength >= selectedThresholds.minConsensusStrength,
          },
          {
            label: 'Total-pattern gap',
            value: currentSnapshot.totalPatternGap,
            threshold: selectedThresholds.maxTotalPatternGap,
            pass: currentSnapshot.totalPatternGap <= selectedThresholds.maxTotalPatternGap,
          },
          {
            label: 'Consensus lead match',
            value: currentSnapshot.consensusLeadMatch ? 1 : 0,
            threshold: 1,
            pass: currentSnapshot.consensusLeadMatch,
          },
          {
            label: 'Alternative result pressure',
            value: currentSnapshot.alternativeResultPressure ? 1 : 0,
            threshold: 0,
            pass: !currentSnapshot.alternativeResultPressure,
          },
          {
            label: 'Draw pressure',
            value: currentSnapshot.drawProbability,
            threshold: 26,
            pass: !currentSnapshot.drawPressure,
          },
        ],
      }
    : null

  return {
    currentDecision,
    backtest: {
      sampleSize: best?.sampleSize || snapshots.length,
      qualifyingBets: best?.qualifyingBets || 0,
      hitRate: best?.hitRate || 0,
      top2HitRate: best?.top2HitRate || 0,
      coverage: best?.coverage || 0,
      skipRate: best?.skipRate || 0,
      utility: best?.utility || 0,
      mode: strategyMode,
      thresholds: selectedThresholds,
      note:
        strategyMode === 'precision_first'
          ? 'Selective mode đang ưu tiên top1 hit rate, chấp nhận bỏ qua nhiều kỳ hơn để lọc sạch tín hiệu.'
          : 'Selective mode chỉ ra kèo khi tín hiệu đạt ngưỡng xác suất, độ chênh và độ dày mẫu chuyển trạng thái.',
    },
    recentQualified,
  }
}

function buildSelectiveSnapshots(roundsDesc, config) {
  const evalSamples = Math.min(config.evalSamples ?? 120, Math.max(roundsDesc.length - (config.recentWindow ?? 240) - 1, 0))
  const lookbackWindow = config.lookbackWindow ?? 360
  const asc = roundsDesc.slice().reverse()
  const snapshots = []

  for (let index = Math.max(lookbackWindow, asc.length - evalSamples); index < asc.length; index += 1) {
    const historyAsc = asc.slice(Math.max(0, index - lookbackWindow), index)
    const historyDesc = historyAsc.slice().reverse()
    const nextRound = asc[index]
    const snapshot = computeSelectiveSnapshot(historyDesc, config)
    if (!snapshot || !nextRound) continue

    snapshots.push({
      ...snapshot,
      actualResult: classifyTotal(nextRound.total),
      actualTotal: nextRound.total,
      actualId: nextRound.id,
    })
  }

  return snapshots
}

function evaluateSelectiveThresholds(snapshots, thresholds, strategyMode) {
  const bets = snapshots.filter((snapshot) => selectiveShouldBet(snapshot, thresholds))
  if (bets.length < 6) return null

  const hitCount = bets.filter((bet) => bet.topResult === bet.actualResult).length
  const top2HitCount = bets.filter((bet) => {
    const top2 = bet.rankedResults.slice(0, 2).map((item) => item.result)
    return top2.includes(bet.actualResult)
  }).length
  const hitRate = Number(((hitCount / bets.length) * 100).toFixed(2))
  const top2HitRate = Number(((top2HitCount / bets.length) * 100).toFixed(2))
  const coverage = Number(((bets.length / Math.max(snapshots.length, 1)) * 100).toFixed(2))

  return {
    thresholds,
    qualifyingBets: bets.length,
    sampleSize: snapshots.length,
    hitRate,
    top2HitRate,
    coverage,
    skipRate: Number((100 - coverage).toFixed(2)),
    utility:
      strategyMode === 'precision_first'
        ? Number(
          (
            hitRate * 1.8 +
            top2HitRate * 0.2 -
            Math.max(0, 10 - bets.length) * 1.5 -
            Math.max(0, 8 - coverage) * 0.75
          ).toFixed(2),
        )
        : Number((hitRate - Math.max(0, 18 - bets.length) * 0.8 - Math.max(0, 12 - coverage) * 0.5).toFixed(2)),
  }
}

function buildRecentQualifiedThresholds(thresholds) {
  if (!thresholds) return null

  return {
    minTopProbability: Math.max(40, Number((thresholds.minTopProbability - 3).toFixed(2))),
    minSpread: Math.max(3, Number((thresholds.minSpread - 1.5).toFixed(2))),
    minClassSupport: Math.max(12, Number((thresholds.minClassSupport - 4).toFixed(2))),
    minTotalSupport: Math.max(4, Number((thresholds.minTotalSupport - 2).toFixed(2))),
    minPatternSupport: Math.max(18, Number((thresholds.minPatternSupport - 6).toFixed(2))),
    minConsensusCount: Math.max(0, Math.floor((thresholds.minConsensusCount ?? 0) - 1)),
    minAgreementCount: Math.max(2, Math.floor((thresholds.minAgreementCount ?? 0) - 1)),
    minConsensusStrength: Math.max(8, Number((thresholds.minConsensusStrength - 4).toFixed(2))),
    maxTotalPatternGap: Number(((thresholds.maxTotalPatternGap ?? 8) + 2).toFixed(2)),
  }
}

function detectSelectiveDrift(roundsDesc, config, recentQualified) {
  const shortWindow = config.shortWindow ?? 72
  const recentWindow = config.recentWindow ?? 240
  const compareWindow = Math.max(recentWindow - shortWindow, shortWindow)
  const shortRounds = roundsDesc.slice(0, shortWindow)
  const compareRounds = roundsDesc.slice(shortWindow, shortWindow + compareWindow)

  if (
    shortRounds.length < Math.max(24, Math.floor(shortWindow * 0.7)) ||
    compareRounds.length < Math.max(24, Math.floor(compareWindow * 0.7))
  ) {
    return {
      totalShift: 0,
      classShift: 0,
      faceShift: 0,
      recentHitRate: null,
      pressure: 0,
      level: 'stable',
      safeMode: false,
      note: 'Chưa đủ dữ liệu để đánh giá drift.',
    }
  }

  const totalShift = jensenShannonDivergence(
    normalizeMap(countByTotal(shortRounds)),
    normalizeMap(countByTotal(compareRounds)),
  )
  const classShift = jensenShannonDivergence(
    normalizeMap(countByClass(shortRounds)),
    normalizeMap(countByClass(compareRounds)),
  )
  const faceShift = jensenShannonDivergence(
    buildFaceMomentum(shortRounds, 0.992),
    buildFaceMomentum(compareRounds, 0.999),
  )

  const recentQualifiedSample = (recentQualified || []).slice(0, 8)
  const recentHitRate = recentQualifiedSample.length
    ? Number(((recentQualifiedSample.filter((item) => item.hit).length / recentQualifiedSample.length) * 100).toFixed(2))
    : null
  const missPenalty = recentHitRate == null ? 0 : Math.max(0, (55 - recentHitRate) / 100)
  const pressure = totalShift * 0.45 + classShift * 0.3 + faceShift * 0.15 + missPenalty * 0.1

  let level = 'stable'
  if (pressure >= 0.12) level = 'severe'
  else if (pressure >= 0.08) level = 'elevated'

  return {
    totalShift: Number(totalShift.toFixed(6)),
    classShift: Number(classShift.toFixed(6)),
    faceShift: Number(faceShift.toFixed(6)),
    recentHitRate,
    pressure: Number(pressure.toFixed(6)),
    level,
    safeMode: pressure >= 0.12,
    note:
      level === 'severe'
        ? 'Dữ liệu gần đây đang lệch pha mạnh so với giai đoạn trước, nên chế độ an toàn cần chặn lệnh.'
        : level === 'elevated'
          ? 'Dữ liệu gần đây đang có dấu hiệu drift, nên cần siết ngưỡng thận trọng hơn.'
          : 'Dữ liệu gần đây vẫn đang tương đối ổn định.',
  }
}

function summarizeSelectiveMiss(snapshot, thresholds) {
  const reasons = []
  const top2 = snapshot.rankedResults.slice(0, 2).map((item) => item.result)
  const signalTotals = new Set([
    ...(snapshot.totalSignals || []).map((item) => item.total),
    ...(snapshot.patternSignals || []).map((item) => item.total),
    ...(snapshot.consensusTotals || []).map((item) => item.total),
  ])

  if (top2.includes(snapshot.actualResult)) reasons.push('runner_up_reversal')
  else reasons.push('class_break')
  if (!signalTotals.has(snapshot.actualTotal)) reasons.push('total_outside_priority_cluster')
  if ((snapshot.consensusTotals || []).length < thresholds.minConsensusCount) reasons.push('weak_consensus')
  if (snapshot.agreementCount < thresholds.minAgreementCount) reasons.push('weak_agreement')
  if (snapshot.totalPatternGap > thresholds.maxTotalPatternGap) reasons.push('pattern_total_gap')
  if (!snapshot.consensusLeadMatch) reasons.push('consensus_lead_mismatch')
  if (snapshot.alternativeResultPressure) reasons.push('alternative_result_pressure')
  if (snapshot.drawPressure) reasons.push('draw_pressure')

  return reasons
}

function buildSelectiveStrategyV2(roundsDesc) {
  const strategyMode = 'precision_first'
  const rollingConfigs = [
    { id: 'fast', label: 'Fast 180', recentWindow: 180, shortWindow: 54, lookbackWindow: 240, evalSamples: 120 },
    { id: 'core', label: 'Core 240', recentWindow: 240, shortWindow: 72, lookbackWindow: 360, evalSamples: 120 },
    { id: 'wide', label: 'Wide 300', recentWindow: 300, shortWindow: 90, lookbackWindow: 420, evalSamples: 120 },
  ]

  const thresholdGrid = []
  for (const minTopProbability of [42, 44, 46, 48, 50, 52]) {
    for (const minSpread of [4, 5, 6, 8, 10, 12]) {
      for (const minClassSupport of [12, 16, 20, 24, 28]) {
        for (const minTotalSupport of [4, 6, 8, 10]) {
          for (const minPatternSupport of [18, 24, 30, 36]) {
            for (const minConsensusCount of [1]) {
              for (const minAgreementCount of [2, 3, 4]) {
                for (const minConsensusStrength of [10, 12, 14, 16]) {
                  for (const maxTotalPatternGap of [10, 8, 6]) {
                    thresholdGrid.push({
                      minTopProbability,
                      minSpread,
                      minClassSupport,
                      minTotalSupport,
                      minPatternSupport,
                      minConsensusCount,
                      minAgreementCount,
                      minConsensusStrength,
                      maxTotalPatternGap,
                    })
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  let best = null
  for (const config of rollingConfigs) {
    const snapshots = buildSelectiveSnapshots(roundsDesc, config)
    for (const thresholds of thresholdGrid) {
      const candidateBase = evaluateSelectiveThresholds(snapshots, thresholds, strategyMode)
      if (!candidateBase) continue

      const candidate = { ...candidateBase, config }
      if (
        !best ||
        candidate.utility > best.utility ||
        (candidate.utility === best.utility && candidate.hitRate > best.hitRate) ||
        (candidate.utility === best.utility && candidate.hitRate === best.hitRate && candidate.qualifyingBets > best.qualifyingBets) ||
        (candidate.utility === best.utility &&
          candidate.hitRate === best.hitRate &&
          candidate.qualifyingBets === best.qualifyingBets &&
          candidate.top2HitRate > best.top2HitRate)
      ) {
        best = candidate
      }
    }
  }

  const fallbackThresholds = {
    minTopProbability: 46,
    minSpread: 6,
    minClassSupport: 16,
    minTotalSupport: 6,
    minPatternSupport: 24,
    minConsensusCount: 1,
    minAgreementCount: 3,
    minConsensusStrength: 12,
    maxTotalPatternGap: 8,
  }
  const fallbackConfig = rollingConfigs[1]
  const selectedThresholds = best?.thresholds || fallbackThresholds
  const selectedConfig = best?.config || fallbackConfig
  const selectedSnapshots = buildSelectiveSnapshots(roundsDesc, selectedConfig)
  const currentSnapshot = computeSelectiveSnapshot(roundsDesc, selectedConfig)
  const recentQualifiedStrict = selectedSnapshots
    .filter((snapshot) => selectiveShouldBet(snapshot, selectedThresholds))
  const recentQualifiedThresholds = buildRecentQualifiedThresholds(selectedThresholds)
  const recentQualified = selectedSnapshots
    .filter((snapshot) => selectiveShouldBet(snapshot, recentQualifiedThresholds))
    .slice(-18)
    .reverse()
    .map((snapshot) => ({
      roundId: snapshot.actualId,
      expected: snapshot.topResult,
      actual: snapshot.actualResult,
      hit: snapshot.topResult === snapshot.actualResult,
      topProbability: snapshot.topProbability,
      spread: snapshot.spread,
      support: snapshot.classSupport,
      consensusTotal: snapshot.consensusTotals[0]?.total ?? null,
      softQualified: !selectiveShouldBet(snapshot, selectedThresholds),
    }))

  const drift = detectSelectiveDrift(roundsDesc, selectedConfig, recentQualifiedStrict
    .slice(-12)
    .reverse()
    .map((snapshot) => ({
      roundId: snapshot.actualId,
      expected: snapshot.topResult,
      actual: snapshot.actualResult,
      hit: snapshot.topResult === snapshot.actualResult,
      topProbability: snapshot.topProbability,
      spread: snapshot.spread,
      support: snapshot.classSupport,
      consensusTotal: snapshot.consensusTotals[0]?.total ?? null,
    })))
  const shouldBetByThreshold = currentSnapshot ? selectiveShouldBet(currentSnapshot, selectedThresholds) : false
  const shouldBet = shouldBetByThreshold && !drift.safeMode
  const missedBets = selectedSnapshots
    .filter((snapshot) => selectiveShouldBet(snapshot, selectedThresholds) && snapshot.topResult !== snapshot.actualResult)
    .slice(-12)
    .reverse()
    .map((snapshot) => ({
      roundId: snapshot.actualId,
      expected: snapshot.topResult,
      actual: snapshot.actualResult,
      actualTotal: snapshot.actualTotal,
      topProbability: snapshot.topProbability,
      spread: snapshot.spread,
      consensusTotal: snapshot.consensusTotals[0]?.total ?? null,
      reasons: summarizeSelectiveMiss(snapshot, selectedThresholds),
    }))

  const currentDecision = currentSnapshot
    ? {
        decision: drift.safeMode ? 'SAFE_SKIP' : shouldBet ? 'BET' : 'SKIP',
        shouldBet,
        thresholdBet: shouldBetByThreshold,
        safeMode: drift.safeMode,
        driftLevel: drift.level,
        recommendedResult: currentSnapshot.topResult,
        topProbability: currentSnapshot.topProbability,
        spread: currentSnapshot.spread,
        latestRound: currentSnapshot.latestRound,
        resultBreakdown: currentSnapshot.rankedResults,
        totalSignals: currentSnapshot.totalSignals,
        patternSignals: currentSnapshot.patternSignals,
        consensusTotals: currentSnapshot.consensusTotals.slice(0, 4),
        gateChecks: [
          {
            label: 'Top probability',
            value: currentSnapshot.topProbability,
            threshold: selectedThresholds.minTopProbability,
            pass: currentSnapshot.topProbability >= selectedThresholds.minTopProbability,
          },
          {
            label: 'Spread',
            value: currentSnapshot.spread,
            threshold: selectedThresholds.minSpread,
            pass: currentSnapshot.spread >= selectedThresholds.minSpread,
          },
          {
            label: 'Class support',
            value: currentSnapshot.classSupport,
            threshold: selectedThresholds.minClassSupport,
            pass: currentSnapshot.classSupport >= selectedThresholds.minClassSupport,
          },
          {
            label: 'Total support',
            value: currentSnapshot.totalSupport,
            threshold: selectedThresholds.minTotalSupport,
            pass: currentSnapshot.totalSupport >= selectedThresholds.minTotalSupport,
          },
          {
            label: 'Pattern support',
            value: currentSnapshot.patternSupport,
            threshold: selectedThresholds.minPatternSupport,
            pass: currentSnapshot.patternSupport >= selectedThresholds.minPatternSupport,
          },
          {
            label: 'Consensus count',
            value: currentSnapshot.consensusTotals.length,
            threshold: selectedThresholds.minConsensusCount,
            pass: currentSnapshot.consensusTotals.length >= selectedThresholds.minConsensusCount,
          },
          {
            label: 'Agreement count',
            value: currentSnapshot.agreementCount,
            threshold: selectedThresholds.minAgreementCount,
            pass: currentSnapshot.agreementCount >= selectedThresholds.minAgreementCount,
          },
          {
            label: 'Consensus strength',
            value: currentSnapshot.consensusStrength,
            threshold: selectedThresholds.minConsensusStrength,
            pass: currentSnapshot.consensusStrength >= selectedThresholds.minConsensusStrength,
          },
          {
            label: 'Total-pattern gap',
            value: currentSnapshot.totalPatternGap,
            threshold: selectedThresholds.maxTotalPatternGap,
            pass: currentSnapshot.totalPatternGap <= selectedThresholds.maxTotalPatternGap,
          },
          {
            label: 'Consensus lead match',
            value: currentSnapshot.consensusLeadMatch ? 1 : 0,
            threshold: 1,
            pass: currentSnapshot.consensusLeadMatch,
          },
          {
            label: 'Alternative result pressure',
            value: currentSnapshot.alternativeResultPressure ? 1 : 0,
            threshold: 0,
            pass: !currentSnapshot.alternativeResultPressure,
          },
          {
            label: 'Draw pressure',
            value: currentSnapshot.drawProbability,
            threshold: 26,
            pass: !currentSnapshot.drawPressure,
          },
          {
            label: 'Drift pressure',
            value: Number((drift.pressure * 100).toFixed(2)),
            threshold: 12,
            pass: !drift.safeMode,
          },
        ],
      }
    : null

  return {
    currentDecision,
    backtest: {
      sampleSize: best?.sampleSize || selectedSnapshots.length,
      qualifyingBets: best?.qualifyingBets || 0,
      hitRate: best?.hitRate || 0,
      top2HitRate: best?.top2HitRate || 0,
      coverage: best?.coverage || 0,
      skipRate: best?.skipRate || 0,
      utility: best?.utility || 0,
      mode: strategyMode,
      config: selectedConfig,
      thresholds: selectedThresholds,
      recentQualifiedThresholds,
      note: 'Selective mode now uses rolling retune and drift-aware safe mode.',
    },
    drift,
    recentQualified,
    review: {
      missedBets,
    },
  }
}

function buildSelectiveRecommendedTotals({ currentDecision, diagnosis }) {
  if (!currentDecision?.recommendedResult) return []

  const targetResult = currentDecision.recommendedResult
  const scoreMap = new Map()

  function pushCandidate(total, result, rawScore, source) {
    if (result !== targetResult) return
    if (!Number.isFinite(total) || !Number.isFinite(rawScore)) return

    const existing = scoreMap.get(total) || {
      total,
      result,
      weightedScore: 0,
      sources: [],
    }
    existing.weightedScore += rawScore
    if (!existing.sources.includes(source)) existing.sources.push(source)
    scoreMap.set(total, existing)
  }

  ;(diagnosis?.topTotals || []).forEach((item, index) => {
    pushCandidate(item.total, item.result, (item.probability || 0) * 100 * (index === 0 ? 0.7 : 0.5), 'model')
  })

  ;(currentDecision.totalSignals || []).forEach((item, index) => {
    pushCandidate(item.total, item.result, (item.probability || 0) * (index === 0 ? 0.9 : 0.7), 'after_total')
  })

  ;(currentDecision.patternSignals || []).forEach((item, index) => {
    pushCandidate(item.total, item.result, (item.probability || 0) * (index === 0 ? 0.75 : 0.55), 'after_pattern')
  })

  ;(currentDecision.consensusTotals || []).forEach((item, index) => {
    pushCandidate(item.total, item.result, (item.averageProbability || 0) * (index === 0 ? 1.2 : 0.95), 'consensus')
  })

  return [...scoreMap.values()]
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, 3)
    .map((item, index) => ({
      rank: index + 1,
      total: item.total,
      result: item.result,
      score: Number(item.weightedScore.toFixed(2)),
      sources: item.sources,
    }))
}

function buildBetPortfolio({ diagnosis, analytics, selectiveStrategy }) {
  const currentDecision = selectiveStrategy?.currentDecision || {}
  const latestRound = currentDecision.latestRound || {}
  const recommendedResult = currentDecision.recommendedResult || diagnosis?.mostLikelyResult || null
  const latestHour = roundHourBucket(latestRound)
  const resultRangeLabel =
    recommendedResult === 'Small'
      ? '3-9'
      : recommendedResult === 'Big'
        ? '12-18'
        : recommendedResult === 'Draw'
          ? '10-11'
          : '--'

  const faceScoreMap = new Map()
  ;(diagnosis?.topFaces || []).forEach((item, index) => {
    faceScoreMap.set(item.face, (faceScoreMap.get(item.face) || 0) + (item.score || 0) * (index === 0 ? 0.7 : 0.52))
  })
  ;(analytics?.betTypes?.singleFaces || []).forEach((item, index) => {
    faceScoreMap.set(item.face, (faceScoreMap.get(item.face) || 0) + (item.score || 0) * (index === 0 ? 1 : 0.82))
  })

  const topFaceRawScore = Math.max(...faceScoreMap.values(), 1)
  const singleFaces = [...faceScoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([face, score], index) => {
      const analyticsFace = (analytics?.betTypes?.singleFaces || []).find((item) => item.face === face)
      const diagnosisFace = (diagnosis?.topFaces || []).find((item) => item.face === face)
      return {
        rank: index + 1,
        face,
        score: scoreTo100(score, topFaceRawScore),
        probabilityHint: Number((diagnosisFace?.probabilityHint || 0).toFixed(2)),
        recentRate: analyticsFace?.recentRate ?? null,
        todayRate: analyticsFace?.todayRate ?? null,
      }
    })

  const exactDoubles = (analytics?.betTypes?.exactDoubles || [])
    .slice(0, 4)
    .map((item, index) => ({
      rank: index + 1,
      face: item.face,
      pattern: item.pattern,
      score: item.score,
      recentRate: item.recentRate,
      todayRate: item.todayRate,
    }))

  const tripleHourMatch = (analytics?.betTypes?.tripleHotHours || []).find((item) => item.hour === latestHour) || null
  const exactTripleRecommendations = (analytics?.betTypes?.exactTriples || [])
    .slice(0, 6)
    .map((item) => {
      const hotFace = (analytics?.betTypes?.exactTripleHotHours || []).find((candidate) => candidate.face === item.face)
      const hotHour = hotFace?.hours?.find((hour) => hour.hour === latestHour) || hotFace?.hours?.[0] || null
      const boostedScore = item.score + (hotHour ? hotHour.score * 0.3 : 0)
      return {
        face: item.face,
        exact: `${item.face}${item.face}${item.face}`,
        score: Number(boostedScore.toFixed(2)),
        baseScore: item.score,
        recentRate: item.recentRate,
        todayRate: item.todayRate,
        hotHourLabel: hotHour?.label || null,
        hotHourScore: hotHour?.score ?? null,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item, index) => ({
      rank: index + 1,
      ...item,
    }))

  const anyTriple = analytics?.betTypes?.anyTriple || {}
  const anyTripleStatus =
    (anyTriple.score || 0) >= 4.5 && (tripleHourMatch?.score || 0) >= 18
      ? 'BET'
      : 'SKIP'

  return {
    decision: currentDecision.decision || 'SKIP',
    recommendedResult,
    latestHour,
    highHit: {
      summary:
        currentDecision.shouldBet
          ? `Ưu tiên đánh xác suất cao: ${labelResultForPortfolio(recommendedResult)} rồi mới chọn tổng và mặt số cùng hướng.`
          : 'Tín hiệu chưa đủ đẹp để dồn lệnh. Nếu vẫn theo, nên ưu tiên kèo trúng cao thay vì kèo nhân lớn.',
      resultRange: resultRangeLabel,
      totals: currentDecision.recommendedTotals || [],
      singleFaces,
      exactDoubles,
    },
    highPayout: {
      summary: 'Chỉ nên vào kèo nhân cao khi giờ và pattern cùng hỗ trợ, nếu không thì đứng ngoài.',
      anyTriple: {
        status: anyTripleStatus,
        score: Number((anyTriple.score || 0).toFixed(2)),
        overallRate: anyTriple.overallRate ?? 0,
        recentRate: anyTriple.recentRate ?? 0,
        todayRate: anyTriple.todayRate ?? 0,
        hotHour: tripleHourMatch?.label || null,
        hotHourScore: tripleHourMatch?.score ?? null,
      },
      exactTriples: exactTripleRecommendations,
      tripleHotHours: (analytics?.betTypes?.tripleHotHours || []).slice(0, 3),
    },
  }
}

function labelResultForPortfolio(value) {
  return ({ Big: 'Lớn', Small: 'Nhỏ', Draw: 'Hòa' }[value]) || value || '--'
}

export function buildPrediction(rounds, options = {}) {
  const recentWindow = options.recentWindow ?? 300
  const shortWindow = options.shortWindow ?? 90
  const longWindow = options.longWindow ?? 900
  const includeAnalytics = options.includeAnalytics ?? true
  const includeDistributions = options.includeDistributions ?? true
  const exactCombos = options.exactCombos ?? enumerateExactCombos()
  const theory = options.theory ?? buildTheoryMaps(exactCombos)
  const roundsDesc = Array.isArray(rounds) ? rounds : []

  const features = buildFeatureSet(roundsDesc, {
    recentWindow,
    shortWindow,
    longWindow,
    exactCombos,
    theory,
  })
  const regime = detectRegime(roundsDesc, features.latestDayRounds)
  const regimeBreak = detectRegimeBreak(features)
  const tuning = pickBestProfile(roundsDesc, regime, {
    recentWindow,
    shortWindow,
    longWindow,
    evalRounds: 120,
    trainWindow: 1800,
    exactCombos,
    theory,
  })
  const contextTuning = pickBestContextExperts(roundsDesc, regime, {
    evalRounds: 120,
    trainWindow: 4000,
    exactCombos,
    theory,
  })
  const blendWeights = buildProfileBlendWeights(tuning.evaluations)
  const contextBlendWeights = buildExpertBlendWeights(contextTuning.evaluations, 'expertId')
  const blendedTotalInputs = []
  const blendedExactInputs = []
  const blendedContextTotalInputs = []
  const blendedContextExactInputs = []
  const blendedContextFaceInputs = []

  for (const blend of blendWeights) {
    const profile =
      PROFILE_LIBRARY.find((item) => item.id === blend.profileId) || tuning.chosenProfile
    const totalModel = scoreTotalsForProfile(features, profile, features.latestClass)
    const exactModel = scoreExactDiceForProfile(features, profile, totalModel.probabilities)

    blendedTotalInputs.push({
      map: totalModel.probabilities,
      weight: blend.weight,
      components: totalModel.componentMap,
    })
    blendedExactInputs.push({
      map: exactModel.probabilities,
      weight: blend.weight,
    })
  }

  const asc = roundsDesc.slice().reverse()
  for (const blend of contextBlendWeights) {
    const expert = CONTEXT_LIBRARY.find((item) => item.id === blend.id) || CONTEXT_LIBRARY[0]
    const contextModel = buildContextExpertPredictionFromAsc(asc, expert, { exactCombos, theory })
    blendedContextTotalInputs.push({
      map: contextModel.totalProbabilities,
      weight: blend.weight,
    })
    blendedContextExactInputs.push({
      map: contextModel.exactProbabilities,
      weight: blend.weight,
    })
    blendedContextFaceInputs.push({
      map: contextModel.faceProbabilities,
      weight: blend.weight,
      diagnostics: contextModel.diagnostics,
    })
  }

  const profileTotalProbabilities = blendProbabilityMaps(
    blendedTotalInputs.map(({ map, weight }) => ({ map, weight })),
  )
  const profileExactProbabilities = blendProbabilityMaps(blendedExactInputs)
  const contextTotalProbabilities = blendProbabilityMaps(blendedContextTotalInputs)
  const contextExactProbabilities = blendProbabilityMaps(blendedContextExactInputs)
  const contextFaceProbabilities = blendProbabilityMaps(blendedContextFaceInputs)

  const metaRaw = [
    { family: 'profile', score: tuning.evaluations[0]?.avgLogScore ?? -999 },
    { family: 'context', score: contextTuning.evaluations[0]?.avgLogScore ?? -999 },
  ]
  const metaBest = Math.max(...metaRaw.map((item) => item.score))
  const metaWeights = metaRaw.map((item) => ({
    family: item.family,
    weight: Math.exp((item.score - metaBest) * 10),
  }))
  const metaTotalWeight = metaWeights.reduce((sum, item) => sum + item.weight, 0) || 1
  const familyBlend = Object.fromEntries(
    metaWeights.map((item) => [item.family, Number((item.weight / metaTotalWeight).toFixed(6))]),
  )

  const totalProbabilities = blendProbabilityMaps([
    { map: profileTotalProbabilities, weight: familyBlend.profile || 0 },
    { map: contextTotalProbabilities, weight: familyBlend.context || 0 },
  ])
  const exactProbabilities = blendProbabilityMaps([
    { map: profileExactProbabilities, weight: familyBlend.profile || 0 },
    { map: contextExactProbabilities, weight: familyBlend.context || 0 },
  ])
  const topTotals = rankTotalsFromProbabilityMap(
    totalProbabilities,
    blendedTotalInputs.map(({ components, weight }) => ({ components, weight })),
  ).slice(0, 6)
  const topExactDice = rankExactDiceFromProbabilityMap(exactProbabilities, exactCombos)

  const faceRecommendations = Array.from({ length: 6 }, (_, index) => {
    const face = index + 1
    const score =
      (features.faceMomentum.get(face) || 0) * 0.35 +
      (contextFaceProbabilities.get(face) || 0) * 0.25 +
      (topExactDice.slice(0, 8).filter((item) => item.dice.includes(face)).reduce((sum, item) => sum + item.probability, 0)) * 0.25 +
      analyticsLikeFaceRate(roundsDesc, features, face) * 0.15
    return { face, score }
  })
    .sort((a, b) => b.score - a.score)
    .map((item, _, all) => ({
      face: item.face,
      score: scoreTo100(item.score, all[0]?.score || 1),
      probabilityHint: Number((item.score * 100).toFixed(2)),
    }))

  let bigProbability = 0
  let smallProbability = 0
  let drawProbability = 0
  for (const [total, probability] of totalProbabilities.entries()) {
    const label = classifyTotal(total)
    if (label === 'Big') bigProbability += probability
    else if (label === 'Small') smallProbability += probability
    else drawProbability += probability
  }

  const confidenceModel = calibrateConfidence({
    totalProbabilities,
    topTotals,
    regimeBreak,
    familyBlend,
    contextTuning,
  })

  const diagnosis = {
    mostLikelyResult:
      bigProbability > smallProbability && bigProbability > drawProbability
        ? 'Big'
        : smallProbability > drawProbability
          ? 'Small'
          : 'Draw',
    resultProbabilities: {
      Big: Number(bigProbability.toFixed(6)),
      Small: Number(smallProbability.toFixed(6)),
      Draw: Number(drawProbability.toFixed(6)),
    },
    topTotals,
    topExactDice,
    topFaces: faceRecommendations.slice(0, 6),
    confidenceModel,
    confidenceSpread:
      topTotals.length >= 2
        ? Number((topTotals[0].probability - topTotals[1].probability).toFixed(6))
        : 0,
  }

  const analytics = includeAnalytics ? buildAnalytics(roundsDesc, features, diagnosis) : null
  diagnosis.recommendations = buildRecommendations({
    diagnosis,
    methodology: {
      regimeBreak,
    },
    analytics,
  })
  const selectiveStrategy = buildSelectiveStrategyV2(roundsDesc)
  if (selectiveStrategy?.currentDecision) {
    selectiveStrategy.currentDecision.recommendedTotals = buildSelectiveRecommendedTotals({
      currentDecision: selectiveStrategy.currentDecision,
      diagnosis,
    })
  }
  const betPortfolio = buildBetPortfolio({
    diagnosis,
    analytics,
    selectiveStrategy,
  })

  const result = {
    methodology: {
      note: 'Auto-tuned scoring engine combining same-day momentum, recent rounds, class transitions, total transitions, double-pattern pressure, and long-term history.',
      caution:
        'This model increases the weight of today and regime-style transitions. It ranks tendencies from observed history, not guaranteed outcomes.',
      selectedProfile: {
        id: tuning.chosenProfile.id,
        label: tuning.chosenProfile.label,
      },
      profileBlend: blendWeights,
      contextBlend: contextBlendWeights.map((item) => ({
        expertId: item.id,
        weight: item.weight,
      })),
      familyBlend,
      regime,
      regimeBreak,
      weights: tuning.chosenProfile,
      backtest: {
        preferredByRegime: tuning.preferredProfileId,
        bestByBacktest: tuning.backtestBestProfileId,
        evaluations: tuning.evaluations,
        contextEvaluations: contextTuning.evaluations,
        bestContextExpert: contextTuning.bestExpertId,
      },
      windows: {
        shortWindow,
        recentWindow,
        longWindow,
      },
    },
    dataset: {
      totalRounds: roundsDesc.length,
      recentRounds: features.recentRounds.length,
      latestDayKey: features.latestDayKey,
      latestDayRounds: features.latestDayRounds.length,
      latestRound: features.latestRound
        ? {
            id: features.latestRound.id,
            total: features.latestRound.total,
            dice: features.latestRound.dice,
            result: classifyTotal(features.latestRound.total),
            time: features.latestRound.time,
            pattern: features.latestPattern,
          }
        : null,
    },
    diagnosis,
    selectiveStrategy,
    betPortfolio,
  }

  if (includeAnalytics) {
    result.analytics = analytics
  }

  if (includeDistributions) {
    result.distributions = {
      totals: Object.fromEntries(
        [...totalProbabilities.entries()].map(([total, probability]) => [
          total,
          Number(probability.toFixed(6)),
        ]),
      ),
    }
  }

  return result
}
