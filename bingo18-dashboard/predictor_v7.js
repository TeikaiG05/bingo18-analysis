const RESULT_ORDER = ['Small', 'Draw', 'Big']
const RESULT_LABEL = {
  Small: 'Nhỏ',
  Draw: 'Hòa',
  Big: 'Lớn',
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

function normalizeMap(scores) {
  const sum = Object.values(scores).reduce((acc, value) => acc + Math.max(0, Number(value) || 0), 0) || 1
  const normalized = {}
  for (const [key, value] of Object.entries(scores)) {
    normalized[key] = roundNumber(Math.max(0, Number(value) || 0) / sum)
  }
  return normalized
}

function incrementNestedMap(outer, key, valueKey) {
  if (!outer.has(key)) outer.set(key, new Map())
  const inner = outer.get(key)
  inner.set(valueKey, (inner.get(valueKey) || 0) + 1)
}

function buildTheoryTotals() {
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
  for (const [total, value] of totals.entries()) {
    totals.set(total, value / sum)
  }
  return totals
}

function buildTransitions(roundsDesc) {
  const asc = [...roundsDesc]
    .filter((round) => round && Number.isFinite(Number(round.total)))
    .reverse()
    .map((round) => ({
      ...round,
      total: Number(round.total),
      result: round.result || classifyTotal(Number(round.total)),
    }))

  const afterResult = new Map()
  const afterPair = new Map()

  for (let index = 1; index < asc.length; index += 1) {
    const current = asc[index]
    const next = asc[index - 1]
    incrementNestedMap(afterResult, current.result, next.result)
    if (index >= 2) {
      const pairKey = `${asc[index].result}|${asc[index - 1].result}`
      incrementNestedMap(afterPair, pairKey, asc[index - 2].result)
    }
  }

  return {
    afterResult,
    afterPair,
    latestPair: roundsDesc.length >= 2
      ? `${roundsDesc[1].result || classifyTotal(Number(roundsDesc[1].total))}|${roundsDesc[0].result || classifyTotal(Number(roundsDesc[0].total))}`
      : null,
  }
}

function posteriorFromCounts(counts, prior = { Small: 0.375, Draw: 0.25, Big: 0.375 }, alpha = 12) {
  const scores = {}
  let support = 0
  for (const result of RESULT_ORDER) {
    const count = counts?.get?.(result) || 0
    support += count
    scores[result] = count + alpha * prior[result]
  }
  const total = RESULT_ORDER.reduce((acc, result) => acc + scores[result], 0) || 1
  for (const result of RESULT_ORDER) {
    scores[result] = scores[result] / total
  }
  return { support, map: scores }
}

function buildRecentCenterProfile(roundsDesc) {
  const recent = roundsDesc.slice(0, 12)
  let centerMass = 0
  let hardDrawMass = 0
  let sumWeight = 0
  let drawResults = 0

  recent.forEach((round, index) => {
    const total = Number(round.total)
    const result = round.result || classifyTotal(total)
    const weight = 1 / (1 + index * 0.18)
    sumWeight += weight
    if (total === 10 || total === 11) hardDrawMass += weight
    if (total >= 9 && total <= 12) centerMass += weight
    if (result === 'Draw') drawResults += weight
  })

  return {
    centerMass: sumWeight ? centerMass / sumWeight : 0,
    hardDrawMass: sumWeight ? hardDrawMass / sumWeight : 0,
    drawResults: sumWeight ? drawResults / sumWeight : 0,
  }
}

function buildTopTotals(drawStrength, theoryTotals) {
  const totals = []
  const favored = [
    [10, 1.2],
    [11, 1.2],
    [9, 0.72],
    [12, 0.72],
    [8, 0.34],
    [13, 0.34],
  ]
  let sum = 0
  for (const [total, boost] of favored) {
    const probability = (theoryTotals.get(total) || 0) * (0.8 + boost * (0.65 + drawStrength))
    totals.push({
      total,
      result: classifyTotal(total),
      probability,
    })
    sum += probability
  }

  sum ||= 1
  return totals
    .map((item) => ({
      ...item,
      probability: roundNumber(item.probability / sum),
      score: roundNumber((item.probability / sum) * 100, 4),
      sources: [
        {
          source: 'draw-specialist',
          probability: roundNumber(item.probability / sum),
          support: 12,
        },
      ],
    }))
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

  const theoryTotals = buildTheoryTotals()

  if (roundsDesc.length < 6) {
    return {
      methodology: {
        note: 'V7 Draw Specialist cần ít nhất vài kỳ gần nhất để đọc nhịp Hòa.',
        model: { id: 'predictor_v7', label: 'Draw Specialist V7' },
      },
      diagnosis: {
        mostLikelyResult: 'Draw',
        resultProbabilities: { Small: 0.24, Draw: 0.52, Big: 0.24 },
        topTotals: buildTopTotals(0.5, theoryTotals),
      },
      selectiveStrategy: {
        currentDecision: {
          decision: 'SKIP',
          shouldBet: false,
          recommendedResult: 'Draw',
          recommendedTotals: buildTopTotals(0.5, theoryTotals).slice(0, 3),
          gateChecks: [],
        },
      },
    }
  }

  const transitions = buildTransitions(roundsDesc)
  const center = buildRecentCenterProfile(roundsDesc)
  const latestResult = roundsDesc[0].result
  const afterResultPosterior = posteriorFromCounts(transitions.afterResult.get(latestResult))
  const pairPosterior = posteriorFromCounts(
    transitions.latestPair ? transitions.afterPair.get(transitions.latestPair) : null,
    afterResultPosterior.map,
    10,
  )

  const rawScores = {
    Small: afterResultPosterior.map.Small * 0.24 + pairPosterior.map.Small * 0.2 + (1 - center.centerMass) * 0.18,
    Draw:
      afterResultPosterior.map.Draw * 0.26 +
      pairPosterior.map.Draw * 0.28 +
      center.hardDrawMass * 0.3 +
      center.drawResults * 0.22 +
      center.centerMass * 0.14,
    Big: afterResultPosterior.map.Big * 0.24 + pairPosterior.map.Big * 0.2 + (1 - center.centerMass) * 0.18,
  }

  const resultProbabilities = normalizeMap(rawScores)
  const rankedResults = RESULT_ORDER
    .map((result) => ({ result, probability: resultProbabilities[result] }))
    .sort((a, b) => b.probability - a.probability)

  const drawStrength = clamp(
    center.hardDrawMass * 0.55 +
      center.centerMass * 0.25 +
      resultProbabilities.Draw * 0.2,
    0,
    1,
  )
  const topTotals = buildTopTotals(drawStrength, theoryTotals)
  const topProbability = rankedResults[0]?.probability || 0
  const spread = topProbability - (rankedResults[1]?.probability || 0)
  const shouldBet = rankedResults[0]?.result === 'Draw' && topProbability >= 0.34 && spread >= 0.035

  return {
    methodology: {
      note: 'V7 chỉ chuyên đọc Hòa bằng cách tập trung vào tâm 10/11, vùng 9-12, và chuyển trạng thái quanh Hòa.',
      caution: 'V7 không tối ưu Big/Small. Nó là specialist để nhắc khi cụm Hòa bắt đầu đáng cân nhắc.',
      model: {
        id: 'predictor_v7',
        label: 'Draw Specialist V7',
      },
      drawProfile: {
        centerMass: roundNumber(center.centerMass * 100, 4),
        hardDrawMass: roundNumber(center.hardDrawMass * 100, 4),
        recentDrawResults: roundNumber(center.drawResults * 100, 4),
        latestPair: transitions.latestPair,
        afterResultSupport: afterResultPosterior.support,
        pairSupport: pairPosterior.support,
      },
    },
    dataset: {
      totalRounds: roundsDesc.length,
      latestRound: {
        id: roundsDesc[0]?.id || null,
        total: roundsDesc[0]?.total ?? null,
        result: roundsDesc[0]?.result || null,
        time: roundsDesc[0]?.time || null,
      },
    },
    diagnosis: {
      mostLikelyResult: rankedResults[0]?.result || 'Draw',
      resultProbabilities,
      topTotals,
      topExactDice: [],
      topFaces: [],
      confidenceModel: {
        confidenceScore: roundNumber(topProbability * 52 + spread * 210 + drawStrength * 25, 4),
        topProbability: roundNumber(topProbability * 100, 4),
        spread: roundNumber(spread * 100, 4),
      },
      recommendations: {
        recommendationText: shouldBet
          ? `V7 thấy cụm Hòa đang sáng, ưu tiên 10, 11 rồi spill sang 9/12.`
          : `V7 chưa thấy Hòa đủ sáng, nhưng vẫn theo dõi cụm 10/11 và vùng 9-12.`,
        primaryMethod: 'Draw-only specialist',
        methodNotes: [
          `Center mass: ${roundNumber(center.centerMass * 100, 2)}%`,
          `Hard draw mass 10/11: ${roundNumber(center.hardDrawMass * 100, 2)}%`,
          `Top result: ${RESULT_LABEL[rankedResults[0]?.result || 'Draw']}`,
        ],
      },
    },
    selectiveStrategy: {
      currentDecision: {
        decision: shouldBet ? 'BET' : 'SKIP',
        shouldBet,
        recommendedResult: 'Draw',
        recommendedTotals: topTotals.slice(0, 3),
        topProbability: roundNumber((resultProbabilities.Draw || 0) * 100, 4),
        spread: roundNumber(spread * 100, 4),
        drawProbability: roundNumber((resultProbabilities.Draw || 0) * 100, 4),
        confidenceBand: shouldBet ? 'Hòa sáng' : 'Theo dõi Hòa',
        gateChecks: [
          {
            label: 'Draw probability',
            pass: (resultProbabilities.Draw || 0) >= 0.34,
            value: roundNumber((resultProbabilities.Draw || 0) * 100, 4),
            threshold: 34,
            detail: 'Xác suất Hòa cần vượt mức tối thiểu để đáng cân nhắc.',
          },
          {
            label: 'Center pressure',
            pass: center.centerMass >= 0.45,
            value: roundNumber(center.centerMass * 100, 4),
            threshold: 45,
            detail: 'Nhịp gần đây phải co về vùng 9-12.',
          },
          {
            label: '10/11 pressure',
            pass: center.hardDrawMass >= 0.18,
            value: roundNumber(center.hardDrawMass * 100, 4),
            threshold: 18,
            detail: 'Cụm 10/11 phải hiện diện đủ rõ.',
          },
        ],
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
          ? 'V7 bật cảnh báo Hòa: cụm 10/11 đang đủ sáng để cân nhắc.'
          : 'V7 đang theo dõi Hòa, nhưng chưa đủ sáng để tách khỏi Big/Small.',
      },
      recentQualified: [],
      review: {
        missedBets: [],
      },
    },
    betPortfolio: {
      decision: shouldBet ? 'BET' : 'SKIP',
      recommendedResult: 'Draw',
      highHit: {
        summary: 'V7 chỉ dùng cho Hòa và cụm trung tâm 10/11, 9/12.',
        resultRange: 'Hòa',
        totals: topTotals.slice(0, 3),
        singleFaces: [],
        exactDoubles: [],
      },
      highPayout: {
        summary: 'Không dùng exact dice làm lõi.',
        anyTriple: { status: 'SKIP', score: 0 },
        exactTriples: [],
        tripleHotHours: [],
      },
    },
    analytics: {
      drawSpecialist: {
        centerMass: center.centerMass,
        hardDrawMass: center.hardDrawMass,
        latestPair: transitions.latestPair,
      },
    },
    distributions: {
      totals: Object.fromEntries(topTotals.map((item) => [item.total, item.probability])),
    },
  }
}
