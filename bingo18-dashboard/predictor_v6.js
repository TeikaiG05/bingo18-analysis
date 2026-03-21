import { buildPrediction as buildPredictionV1 } from './predictor.js'
import { buildPrediction as buildPredictionV2 } from './predictor_v2.js'
import { buildPrediction as buildPredictionV3 } from './predictor_v3.js'
import { buildPrediction as buildPredictionV4 } from './predictor_v4.js'
import { buildPrediction as buildPredictionV5 } from './predictor_v5.js'

const RESULT_ORDER = ['Small', 'Draw', 'Big']
const RESULT_LABEL = {
  Small: 'Nho',
  Draw: 'Hoa',
  Big: 'Lon',
}

const MODEL_SPECS = [
  { id: 'V1', focus: 'number', baseWeight: 1.0, builder: buildPredictionV1 },
  { id: 'V2', focus: 'number', baseWeight: 0.95, builder: buildPredictionV2 },
  { id: 'V3', focus: 'number', baseWeight: 1.15, builder: buildPredictionV3 },
  { id: 'V4', focus: 'result', baseWeight: 1.1, builder: buildPredictionV4 },
  { id: 'V5', focus: 'result', baseWeight: 1.2, builder: buildPredictionV5 },
]

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

function normalizeUnitProbability(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return 0
  return num > 1 ? num / 100 : num
}

function normalizeMap(scores) {
  const sum = Object.values(scores).reduce((acc, value) => acc + Math.max(0, value || 0), 0) || 1
  const normalized = {}
  for (const [key, value] of Object.entries(scores)) {
    normalized[key] = roundNumber((Math.max(0, value || 0)) / sum)
  }
  return normalized
}

function recentContext(roundsDesc) {
  const latest = roundsDesc[0] || null
  const recentResults = roundsDesc.slice(0, 6).map((round) => round.result || classifyTotal(Number(round.total)))
  const recentTotals = roundsDesc.slice(0, 6).map((round) => Number(round.total))

  let streak = 1
  for (let index = 1; index < recentResults.length; index += 1) {
    if (recentResults[index] === recentResults[0]) streak += 1
    else break
  }

  let flips = 0
  for (let index = 1; index < recentResults.length; index += 1) {
    if (recentResults[index] !== recentResults[index - 1]) flips += 1
  }

  const drawCount = recentResults.filter((result) => result === 'Draw').length
  const averageTotal =
    recentTotals.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0) /
    (recentTotals.length || 1)

  return {
    latest,
    recentResults,
    recentTotals,
    streak,
    flips,
    drawCount,
    averageTotal: roundNumber(averageTotal),
  }
}

function safeResultProbabilities(prediction) {
  const diagnosis = prediction?.diagnosis || {}
  const current = prediction?.selectiveStrategy?.currentDecision || {}
  const direct = diagnosis.resultProbabilities

  if (direct && typeof direct === 'object') {
    return normalizeMap({
      Small: normalizeUnitProbability(direct.Small),
      Draw: normalizeUnitProbability(direct.Draw),
      Big: normalizeUnitProbability(direct.Big),
    })
  }

  if (Array.isArray(current.resultBreakdown) && current.resultBreakdown.length) {
    const scores = { Small: 0, Draw: 0, Big: 0 }
    for (const item of current.resultBreakdown) {
      const result = item.result
      if (!RESULT_ORDER.includes(result)) continue
      scores[result] = normalizeUnitProbability(item.probability)
    }
    return normalizeMap(scores)
  }

  const fallback = current.recommendedResult || diagnosis.recommendedResult || 'Draw'
  return normalizeMap({
    Small: fallback === 'Small' ? 0.5 : 0.25,
    Draw: fallback === 'Draw' ? 0.5 : 0.25,
    Big: fallback === 'Big' ? 0.5 : 0.25,
  })
}

function safeTopTotals(prediction) {
  const current = prediction?.selectiveStrategy?.currentDecision || {}
  const diagnosis = prediction?.diagnosis || {}
  const raw =
    (Array.isArray(current.recommendedTotals) && current.recommendedTotals.length
      ? current.recommendedTotals
      : Array.isArray(diagnosis.topTotals)
        ? diagnosis.topTotals
        : []
    ).slice(0, 4)

  return raw
    .map((item) => {
      const total = Number(item.total)
      if (!Number.isFinite(total)) return null
      return {
        total,
        result: item.result || item.resultClass || item.classification || classifyTotal(total),
        probability: normalizeUnitProbability(item.probability ?? item.score ?? 0),
        score: normalizeUnitProbability(item.score ?? item.probability ?? 0),
        source: item.source || null,
      }
    })
    .filter(Boolean)
}

function extractModelMetrics(prediction) {
  const diagnosis = prediction?.diagnosis || {}
  const current = prediction?.selectiveStrategy?.currentDecision || {}
  const backtest = prediction?.selectiveStrategy?.backtest || prediction?.methodology?.validation || {}
  const performance = prediction?.selectiveStrategy?.performance || prediction?.selectiveStrategy?.validation || {}

  const topProbability = normalizeUnitProbability(current.topProbability ?? diagnosis?.confidenceModel?.topProbability ?? 0)
  const spread = normalizeUnitProbability(current.spread ?? diagnosis?.confidenceModel?.spread ?? 0)
  const continuousHit = normalizeUnitProbability(backtest.continuousHitRate ?? performance.continuousHitRate ?? 0)
  const selectiveHit = normalizeUnitProbability(backtest.selectiveHitRate ?? performance.selectiveHitRate ?? continuousHit)
  const confidenceScore = normalizeUnitProbability(diagnosis?.confidenceModel?.confidenceScore ?? current.confidenceScore ?? topProbability)
  const qualifiedCount = Array.isArray(prediction?.selectiveStrategy?.recentQualified)
    ? prediction.selectiveStrategy.recentQualified.length
    : 0

  return {
    topProbability,
    spread,
    continuousHit,
    selectiveHit,
    confidenceScore,
    qualifiedCount,
    shouldBet: Boolean(current.shouldBet),
  }
}

function computeModelWeight(spec, prediction, context) {
  const metrics = extractModelMetrics(prediction)
  const focusBoost =
    spec.focus === 'result'
      ? 1 + clamp((context.drawCount - 1) * 0.05 + (context.flips - 2) * 0.04, -0.08, 0.18)
      : 1 + clamp((context.streak - 1) * 0.04 + (context.averageTotal >= 10 && context.averageTotal <= 12 ? 0.05 : 0), -0.06, 0.18)

  const weight =
    spec.baseWeight *
    focusBoost *
    (0.24 +
      metrics.continuousHit * 0.28 +
      metrics.selectiveHit * 0.24 +
      metrics.topProbability * 0.14 +
      metrics.spread * 0.08 +
      metrics.confidenceScore * 0.02 +
      clamp(metrics.qualifiedCount / 8, 0, 1) * 0.04)

  return {
    ...metrics,
    value: roundNumber(weight),
  }
}

function buildRecentReview(models) {
  return models.map((model) => ({
    model: model.id,
    focus: model.focus,
    weight: model.weight.value,
    topProbability: roundNumber(model.weight.topProbability * 100, 4),
    spread: roundNumber(model.weight.spread * 100, 4),
    continuousHitRate: roundNumber(model.weight.continuousHit * 100, 4),
    selectiveHitRate: roundNumber(model.weight.selectiveHit * 100, 4),
  }))
}

export function buildPrediction(rounds, options = {}) {
  const roundsDesc = [...(Array.isArray(rounds) ? rounds : [])]
    .filter((round) => round && Number.isFinite(Number(round.total)))
    .map((round) => ({
      ...round,
      total: Number(round.total),
      result: round.result || classifyTotal(Number(round.total)),
    }))

  if (!roundsDesc.length) {
    return {
      methodology: {
        note: 'V6 AI Meta Council needs at least one round of history.',
        model: { id: 'predictor_v6', label: 'AI Meta Council V6' },
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

  const context = recentContext(roundsDesc)
  const modelOutputs = MODEL_SPECS.map((spec) => {
    const prediction = spec.builder(roundsDesc, options)
    const weight = computeModelWeight(spec, prediction, context)
    return {
      id: spec.id,
      focus: spec.focus,
      prediction,
      weight,
      resultProbabilities: safeResultProbabilities(prediction),
      topTotals: safeTopTotals(prediction),
      recommendedResult:
        prediction?.selectiveStrategy?.currentDecision?.recommendedResult ||
        prediction?.diagnosis?.mostLikelyResult ||
        prediction?.diagnosis?.recommendedResult ||
        'Draw',
      summary:
        prediction?.selectiveStrategy?.currentDecision?.summary ||
        prediction?.diagnosis?.recommendations?.recommendationText ||
        prediction?.diagnosis?.recommendations?.[0] ||
        prediction?.selectiveStrategy?.currentDecision?.rationale?.[0] ||
        '--',
    }
  })

  const resultScores = { Small: 0, Draw: 0, Big: 0 }
  const totalScores = new Map()
  const totalSources = new Map()

  for (const model of modelOutputs) {
    const focusMultiplier = model.focus === 'result' ? 1.16 : 1
    for (const result of RESULT_ORDER) {
      resultScores[result] += (model.resultProbabilities[result] || 0) * model.weight.value * focusMultiplier
    }

    model.topTotals.forEach((item, index) => {
      const rankWeight = Math.max(0.32, 1 - index * 0.2)
      const focusMultiplierForTotal = model.focus === 'number' ? 1.18 : 0.94
      const score = (item.probability || item.score || 0) * model.weight.value * rankWeight * focusMultiplierForTotal
      totalScores.set(item.total, (totalScores.get(item.total) || 0) + score)
      if (!totalSources.has(item.total)) totalSources.set(item.total, [])
      totalSources.get(item.total).push(model.id)
    })
  }

  const normalizedResults = normalizeMap(resultScores)
  const rankedResults = RESULT_ORDER
    .map((result) => ({
      result,
      probability: normalizedResults[result],
    }))
    .sort((a, b) => b.probability - a.probability)

  const topResult = rankedResults[0]?.result || 'Draw'
  const secondResult = rankedResults[1]?.result || 'Small'
  const topProbability = rankedResults[0]?.probability || 0
  const spread = topProbability - (rankedResults[1]?.probability || 0)

  const alignedTotalScores = new Map()
  for (const [total, score] of totalScores.entries()) {
    const resultClass = classifyTotal(total)
    const alignmentMultiplier = resultClass === topResult ? 1.12 : 0.78
    alignedTotalScores.set(total, score * alignmentMultiplier)
  }

  const totalScoreSum = [...alignedTotalScores.values()].reduce((acc, value) => acc + Math.max(0, value || 0), 0) || 1
  const topTotals = [...alignedTotalScores.entries()]
    .map(([total, score]) => ({
      total,
      result: classifyTotal(total),
      probability: roundNumber(score / totalScoreSum),
      score: roundNumber((score / totalScoreSum) * 100, 4),
      sources: [...new Set(totalSources.get(total) || [])],
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 6)
  const alignedTopTotals = topTotals.filter((item) => item.result === topResult)
  const recommendedTotals = (alignedTopTotals.length ? alignedTopTotals : topTotals).slice(0, 3)

  const resultAgreementCount = modelOutputs.filter((model) => model.recommendedResult === topResult).length
  const totalAgreementCount = recommendedTotals[0] ? (totalSources.get(recommendedTotals[0].total) || []).length : 0
  const gateChecks = [
    {
      label: 'Dong thuan cua',
      pass: resultAgreementCount >= 3,
      value: resultAgreementCount,
      threshold: 3,
      detail: 'It nhat 3 model cung nghieng ve cung mot cua.',
    },
    {
      label: 'Xac suat top',
      pass: topProbability >= 0.4,
      value: roundNumber(topProbability * 100, 4),
      threshold: 40,
      detail: 'Meta-AI can mot cua dung tren 40% sau khi tong hop.',
    },
    {
      label: 'Do chenh',
      pass: spread >= 0.045,
      value: roundNumber(spread * 100, 4),
      threshold: 4.5,
      detail: 'Top 1 phai tach Top 2 de tranh quyet dinh mo ho.',
    },
    {
      label: 'Dong thuan tong',
      pass: totalAgreementCount >= 2,
      value: totalAgreementCount,
      threshold: 2,
      detail: 'Tong uu tien can co it nhat 2 model cung ung ho.',
    },
  ]

  const shouldBet = gateChecks.every((item) => item.pass)
  const confidenceScore = clamp(
    topProbability * 58 + spread * 240 + (resultAgreementCount / 5) * 22 + (totalAgreementCount / 5) * 12,
    0,
    99,
  )

  return {
    methodology: {
      note: 'V6 is an AI-style meta council that reads each existing model on every round, weights them by confidence, recent effectiveness, and role specialization, then fuses result and total recommendations.',
      caution:
        'V6 does not claim deterministic prediction. It is a meta-layer that improves decision quality by combining disagreement, confidence, and contextual behavior from V1-V5.',
      model: {
        id: 'predictor_v6',
        label: 'AI Meta Council V6',
      },
      context: {
        latestPattern: context.recentResults.join(' -> '),
        streak: context.streak,
        flips: context.flips,
        drawCount: context.drawCount,
        averageTotal: context.averageTotal,
      },
      metaReview: buildRecentReview(modelOutputs),
    },
    dataset: {
      totalRounds: roundsDesc.length,
      latestRound: {
        id: context.latest?.id || null,
        total: context.latest?.total ?? null,
        dice: context.latest?.dice || [],
        result: context.latest?.result || null,
        time: context.latest?.time || null,
      },
    },
    diagnosis: {
      mostLikelyResult: topResult,
      resultProbabilities: normalizedResults,
      topTotals,
      topExactDice: [],
      topFaces: [],
      confidenceModel: {
        confidenceScore: roundNumber(confidenceScore, 4),
        topProbability: roundNumber(topProbability * 100, 4),
        spread: roundNumber(spread * 100, 4),
        agreementCount: resultAgreementCount,
        totalAgreementCount,
      },
      recommendations: {
        recommendationText: `Hoi dong AI V6 nghieng ve ${RESULT_LABEL[topResult]} va uu tien tong ${topTotals.slice(0, 3).map((item) => item.total).join(', ')}.`,
        primaryMethod: 'Meta fusion from V1-V5',
        methodNotes: [
          `Top result: ${RESULT_LABEL[topResult]} ${roundNumber(topProbability * 100, 2)}%`,
          `Result agreement: ${resultAgreementCount}/5`,
          `Top total agreement: ${totalAgreementCount}/5`,
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
        drawProbability: roundNumber((normalizedResults.Draw || 0) * 100, 4),
        confidenceBand: shouldBet ? 'Meta sang' : 'Quan sat',
        confidenceScore: roundNumber(confidenceScore, 4),
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
          ? `V6 dong y vao ${RESULT_LABEL[topResult]} vi hoi dong da hoi tu kha ro.`
          : `V6 thay hoi dong chua du tach biet, tam thoi uu tien quan sat.`,
        rationale: [
          `Result agreement: ${resultAgreementCount}/5`,
          `Top total: ${recommendedTotals[0]?.total ?? '--'} (${totalAgreementCount}/5)`,
          `Second result: ${RESULT_LABEL[secondResult]}`,
        ],
        modelVoices: modelOutputs.map((model) => ({
          id: model.id,
          focus: model.focus,
          weight: model.weight.value,
          recommendedResult: model.recommendedResult,
          topTotals: model.topTotals.slice(0, 3).map((item) => item.total),
          summary: model.summary,
        })),
      },
      recentQualified: [],
      review: {
        missedBets: [],
      },
      backtest: {
        continuousHitRate: roundNumber(
          modelOutputs.reduce((acc, model) => acc + model.weight.continuousHit, 0) / modelOutputs.length * 100,
          4,
        ),
        selectiveHitRate: roundNumber(
          modelOutputs.reduce((acc, model) => acc + model.weight.selectiveHit, 0) / modelOutputs.length * 100,
          4,
        ),
        selectiveBets: modelOutputs.filter((model) => model.weight.shouldBet).length,
        evaluatedRounds: modelOutputs.length,
      },
    },
    betPortfolio: {
      decision: shouldBet ? 'BET' : 'SKIP',
      recommendedResult: topResult,
      highHit: {
        summary: shouldBet
          ? `Meta AI uu tien ${RESULT_LABEL[topResult]}, tap trung cac tong ${recommendedTotals.map((item) => item.total).join(', ')}.`
          : 'Meta AI chua thay loi the du lon de vao lenh.',
        resultRange: RESULT_LABEL[topResult],
        totals: recommendedTotals,
        singleFaces: [],
        exactDoubles: [],
      },
      highPayout: {
        summary: 'V6 khong tap trung vao exact dice. No uu tien dong thuan cua va tong giua cac model.',
        anyTriple: { status: 'SKIP', score: 0 },
        exactTriples: [],
        tripleHotHours: [],
      },
    },
    analytics: {
      v6: {
        resultAgreementCount,
        totalAgreementCount,
        modelVoices: modelOutputs.map((model) => ({
          id: model.id,
          focus: model.focus,
          weight: model.weight.value,
          result: model.recommendedResult,
          topTotals: model.topTotals.slice(0, 3).map((item) => item.total),
        })),
      },
    },
    distributions: {
      totals: Object.fromEntries(topTotals.map((item) => [item.total, item.probability])),
    },
  }
}
