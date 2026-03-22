const RESULT_ORDER = ['Small', 'Draw', 'Big']

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

function normalizeMap(scores) {
  const sum = Object.values(scores).reduce((acc, value) => acc + Math.max(0, Number(value) || 0), 0) || 1
  const normalized = {}
  for (const [key, value] of Object.entries(scores)) {
    normalized[key] = roundNumber(Math.max(0, Number(value) || 0) / sum)
  }
  return normalized
}

function totalRegime(total) {
  if (total >= 13) return 'upper'
  if (total <= 8) return 'lower'
  return 'center'
}

function regimeLabel(regime) {
  if (regime === 'upper') return 'Bien tren'
  if (regime === 'lower') return 'Bien duoi'
  return 'Trung tam'
}

function regimeBaseTotals(regime) {
  if (regime === 'upper') return [14, 13, 15, 16, 12, 17]
  if (regime === 'lower') return [8, 7, 9, 6, 10, 5]
  return [10, 11, 9, 12, 8, 13]
}

function buildRecentTotals(roundsDesc, length = 18) {
  return roundsDesc
    .slice(0, length)
    .map((round) => Number(round.total))
    .filter(Number.isFinite)
}

function buildRegimeProfile(recentTotals) {
  let centerWeight = 0
  let upperWeight = 0
  let lowerWeight = 0
  let volatility = 0

  recentTotals.forEach((total, index) => {
    const weight = 1 / (1 + index * 0.14)
    if (total >= 9 && total <= 12) centerWeight += weight
    if (total >= 13) upperWeight += weight
    if (total <= 8) lowerWeight += weight
    if (index > 0) volatility += Math.abs(total - recentTotals[index - 1]) * weight
  })

  const sum = centerWeight + upperWeight + lowerWeight || 1
  return {
    center: centerWeight / sum,
    upper: upperWeight / sum,
    lower: lowerWeight / sum,
    volatility: recentTotals.length > 1 ? volatility / (recentTotals.length - 1) : 0,
  }
}

function buildRegimeTransitions(roundsDesc) {
  const asc = [...roundsDesc].reverse()
  const transitions = new Map()

  for (let index = 1; index < asc.length; index += 1) {
    const current = asc[index]
    const next = asc[index - 1]
    const currentRegime = totalRegime(Number(current.total))
    const nextRegime = totalRegime(Number(next.total))
    if (!transitions.has(currentRegime)) {
      transitions.set(currentRegime, { center: 0, upper: 0, lower: 0 })
    }
    transitions.get(currentRegime)[nextRegime] += 1
  }

  return transitions
}

function buildResultProbabilities(regimeScores) {
  return normalizeMap({
    Small: regimeScores.lower * 0.74 + regimeScores.center * 0.12,
    Draw: regimeScores.center * 0.58 + regimeScores.upper * 0.05 + regimeScores.lower * 0.05,
    Big: regimeScores.upper * 0.74 + regimeScores.center * 0.12,
  })
}

function buildTopTotals(regime, regimeScores) {
  const totals = regimeBaseTotals(regime)
  const topTotals = totals.map((total, index) => {
    const regimeWeight =
      regime === 'center'
        ? regimeScores.center
        : regime === 'upper'
          ? regimeScores.upper
          : regimeScores.lower
    const base = 0.22 - index * 0.022
    const centerBias =
      total === 10 || total === 11
        ? regimeScores.center * 0.12
        : total === 9 || total === 12
          ? regimeScores.center * 0.07
          : 0
    return {
      total,
      result: classifyTotal(total),
      probability: base + regimeWeight * 0.28 + centerBias,
      score: 0,
      sources: [
        {
          source: 'number-regime-specialist',
          probability: 0,
          support: 18,
        },
      ],
    }
  })

  const sum = topTotals.reduce((acc, item) => acc + item.probability, 0) || 1
  return topTotals
    .map((item) => {
      const probability = item.probability / sum
      return {
        ...item,
        probability: roundNumber(probability),
        score: roundNumber(probability * 100, 4),
        sources: [
          {
            source: 'number-regime-specialist',
            probability: roundNumber(probability),
            support: 18,
          },
        ],
      }
    })
    .sort((a, b) => b.probability - a.probability)
}

export function buildPrediction(rounds, options = {}) {
  void options
  const roundsDesc = [...(Array.isArray(rounds) ? rounds : [])]
    .filter((round) => round && Number.isFinite(Number(round.total)))
    .map((round) => ({
      ...round,
      total: Number(round.total),
      result: round.result || classifyTotal(Number(round.total)),
    }))

  if (roundsDesc.length < 12) {
    const topTotals = buildTopTotals('center', { center: 0.5, upper: 0.25, lower: 0.25 })
    return {
      methodology: {
        note: 'V8 can it nhat mot cum ky gan day de doc regime so.',
        model: { id: 'predictor_v8', label: 'Number Regime Specialist V8' },
        regime: { key: 'center', label: regimeLabel('center') },
      },
      diagnosis: {
        mostLikelyResult: 'Draw',
        resultProbabilities: { Small: 0.25, Draw: 0.5, Big: 0.25 },
        topTotals,
      },
      selectiveStrategy: {
        currentDecision: {
          decision: 'SKIP',
          shouldBet: false,
          recommendedResult: 'Draw',
          recommendedTotals: topTotals.slice(0, 3),
          topProbability: 0.5,
          topSpread: 0.08,
          summary: 'V8 dang cho du mau de xac nhan regime so.',
        },
      },
    }
  }

  const recentTotals = buildRecentTotals(roundsDesc)
  const profile = buildRegimeProfile(recentTotals)
  const latestRegime = totalRegime(recentTotals[0])
  const transitions = buildRegimeTransitions(roundsDesc)
  const afterLatest = transitions.get(latestRegime) || { center: 0, upper: 0, lower: 0 }
  const transitionSum = afterLatest.center + afterLatest.upper + afterLatest.lower || 1

  const regimeScores = {
    center: clamp(profile.center * 0.54 + (afterLatest.center / transitionSum) * 0.32 + (profile.volatility <= 2.8 ? 0.08 : 0), 0.05, 0.92),
    upper: clamp(profile.upper * 0.56 + (afterLatest.upper / transitionSum) * 0.28 + (recentTotals[0] >= 13 ? 0.05 : 0), 0.04, 0.9),
    lower: clamp(profile.lower * 0.56 + (afterLatest.lower / transitionSum) * 0.28 + (recentTotals[0] <= 8 ? 0.05 : 0), 0.04, 0.9),
  }

  const regimeList = Object.entries(regimeScores)
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score)
  const regime = regimeList[0]?.key || 'center'
  const resultProbabilities = buildResultProbabilities(regimeScores)
  const rankedResults = RESULT_ORDER
    .map((result) => ({ result, probability: resultProbabilities[result] }))
    .sort((a, b) => b.probability - a.probability)
  const topTotals = buildTopTotals(regime, regimeScores)
  const topProbability = rankedResults[0]?.probability || 0
  const spread = topProbability - (rankedResults[1]?.probability || 0)
  const shouldBet = topProbability >= 0.34 && spread >= 0.03

  return {
    methodology: {
      note: 'V8 chuyen doc regime so: trung tam, bien tren, bien duoi, roi moi chot Top 3.',
      model: { id: 'predictor_v8', label: 'Number Regime Specialist V8' },
      regime: {
        key: regime,
        label: regimeLabel(regime),
        list: regimeList.map((item) => ({
          key: item.key,
          label: regimeLabel(item.key),
          score: roundNumber(item.score),
        })),
        latestRegime,
      },
      recentProfile: {
        center: roundNumber(profile.center * 100, 4),
        upper: roundNumber(profile.upper * 100, 4),
        lower: roundNumber(profile.lower * 100, 4),
        volatility: roundNumber(profile.volatility, 4),
      },
    },
    diagnosis: {
      mostLikelyResult: rankedResults[0]?.result || 'Draw',
      resultProbabilities,
      topTotals,
    },
    selectiveStrategy: {
      currentDecision: {
        decision: shouldBet ? 'BET' : 'SKIP',
        shouldBet,
        recommendedResult: rankedResults[0]?.result || 'Draw',
        recommendedTotals: topTotals.slice(0, 3),
        topProbability: roundNumber(topProbability),
        topSpread: roundNumber(spread),
        summary: `V8 dang nghieng regime ${regimeLabel(regime).toLowerCase()}, uu tien ${topTotals.slice(0, 3).map((item) => item.total).join(', ')}.`,
      },
    },
  }
}
