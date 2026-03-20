import { buildPrediction as buildPredictionV1 } from './predictor.js'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalizePercent(value, max = 100) {
  if (!Number.isFinite(value)) return 0
  return clamp(value / max, 0, 1)
}

function getTopResult(resultProbabilities = {}) {
  return Object.entries(resultProbabilities)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'Draw'
}

function getTopResultMargin(resultProbabilities = {}) {
  const ranked = Object.entries(resultProbabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([, probability]) => probability || 0)
  return Math.max(0, (ranked[0] || 0) - (ranked[1] || 0))
}

function countPassedGates(gateChecks = []) {
  return gateChecks.filter((item) => item?.pass).length
}

function average(values = []) {
  const valid = values.filter((value) => Number.isFinite(value))
  if (!valid.length) return 0
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function normalizeResultMap(scoreMap) {
  const results = ['Small', 'Draw', 'Big']
  const total = results.reduce((sum, key) => sum + Math.max(0, scoreMap[key] || 0), 0) || 1
  const normalized = {}
  for (const key of results) {
    normalized[key] = Number((Math.max(0, scoreMap[key] || 0) / total).toFixed(6))
  }
  return normalized
}

function aggregateTotalsByResult(topTotals = [], limit = 5) {
  const scores = { Small: 0, Draw: 0, Big: 0 }
  const slice = topTotals.slice(0, limit)
  for (const item of slice) {
    if (!item?.result) continue
    scores[item.result] += Number(item.probability || 0)
  }
  return normalizeResultMap(scores)
}

function aggregateConsensusByResult(consensusTotals = [], limit = 4) {
  const scores = { Small: 0, Draw: 0, Big: 0 }
  const slice = consensusTotals.slice(0, limit)
  for (const item of slice) {
    if (!item?.result) continue
    scores[item.result] += Number(item.averageProbability || 0)
  }
  return normalizeResultMap(scores)
}

function breakdownToMap(resultBreakdown = []) {
  const scores = { Small: 0, Draw: 0, Big: 0 }
  for (const item of resultBreakdown) {
    if (!item?.result) continue
    scores[item.result] = Number(item.probability || 0) / 100
  }
  return normalizeResultMap(scores)
}

function summarizeAgreement(base) {
  const diagnosis = base?.diagnosis || {}
  const selective = base?.selectiveStrategy?.currentDecision || {}
  const topTotalResult = diagnosis.topTotals?.[0]?.result || null
  const resultA = diagnosis.mostLikelyResult || null
  const resultB = selective.recommendedResult || null
  const resultC = topTotalResult

  const counts = new Map()
  for (const item of [resultA, resultB, resultC]) {
    if (!item) continue
    counts.set(item, (counts.get(item) || 0) + 1)
  }

  const winner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || resultA || resultB || resultC || 'Draw'
  const strength = [...counts.values()].sort((a, b) => b - a)[0] || 0

  return {
    winner,
    strength,
    diagnosisResult: resultA,
    selectiveResult: resultB,
    topTotalResult: resultC,
    unanimous: strength >= 3,
    majority: strength >= 2,
  }
}

function buildEvaluationStability(evaluations = [], idKey) {
  const ranked = [...evaluations]
    .filter((item) => Number.isFinite(item?.avgLogScore))
    .sort((a, b) => b.avgLogScore - a.avgLogScore)

  const top = ranked[0] || null
  const second = ranked[1] || null
  const gap = top && second ? Number((top.avgLogScore - second.avgLogScore).toFixed(6)) : 0
  const dominance = clamp(gap / 0.015, 0, 1)

  return {
    ranked,
    top,
    second,
    gap,
    dominance: Number(dominance.toFixed(4)),
    winnerId: top?.[idKey] || null,
  }
}

function mapCoherence(mapA = {}, mapB = {}) {
  const distance =
    Math.abs((mapA.Small || 0) - (mapB.Small || 0)) +
    Math.abs((mapA.Draw || 0) - (mapB.Draw || 0)) +
    Math.abs((mapA.Big || 0) - (mapB.Big || 0))
  return clamp(1 - distance / 2, 0, 1)
}

function buildProfileStability(base) {
  const methodology = base?.methodology || {}
  const backtest = methodology.backtest || {}
  const selectedProfileId = methodology.selectedProfile?.id || null
  const profileEval = buildEvaluationStability(backtest.evaluations || [], 'profileId')
  const contextEval = buildEvaluationStability(backtest.contextEvaluations || [], 'expertId')
  const profileConsensus =
    selectedProfileId &&
    selectedProfileId === backtest.preferredByRegime &&
    selectedProfileId === backtest.bestByBacktest
  const profileAligned =
    selectedProfileId &&
    (selectedProfileId === backtest.preferredByRegime || selectedProfileId === backtest.bestByBacktest)
  const weightedSupport = clamp(
    average([
      (profileEval.top?.weightedSamples || 0) / 180,
      (contextEval.top?.weightedSamples || 0) / 160,
    ]),
    0,
    1
  )

  const score =
    profileEval.dominance * 0.38 +
    contextEval.dominance * 0.24 +
    (profileConsensus ? 1 : profileAligned ? 0.6 : 0.25) * 0.24 +
    weightedSupport * 0.14

  return {
    score: Number((score * 100).toFixed(2)),
    profileConsensus: Boolean(profileConsensus),
    profileAligned: Boolean(profileAligned),
    weightedSupport: Number((weightedSupport * 100).toFixed(2)),
    profile: profileEval,
    context: contextEval,
  }
}

function buildSignalCoherence(base, maps) {
  const diagnosis = base?.diagnosis || {}
  const selective = base?.selectiveStrategy?.currentDecision || {}
  const baseMap = maps.baseMap || normalizeResultMap(diagnosis.resultProbabilities || {})
  const totalMap = maps.totalMap || aggregateTotalsByResult(diagnosis.topTotals || [], 5)
  const consensusMap = maps.consensusMap || aggregateConsensusByResult(selective.consensusTotals || [], 4)
  const selectiveMap = maps.selectiveMap || breakdownToMap(selective.resultBreakdown || [])

  const baseVsTotal = mapCoherence(baseMap, totalMap)
  const baseVsSelective = mapCoherence(baseMap, selectiveMap)
  const totalVsConsensus = mapCoherence(totalMap, consensusMap)
  const consensusVsSelective = mapCoherence(consensusMap, selectiveMap)
  const score = average([baseVsTotal, baseVsSelective, totalVsConsensus, consensusVsSelective])

  return {
    score: Number((score * 100).toFixed(2)),
    baseVsTotal: Number((baseVsTotal * 100).toFixed(2)),
    baseVsSelective: Number((baseVsSelective * 100).toFixed(2)),
    totalVsConsensus: Number((totalVsConsensus * 100).toFixed(2)),
    consensusVsSelective: Number((consensusVsSelective * 100).toFixed(2)),
  }
}

function buildDiagnosticFusion(base) {
  const diagnosis = base?.diagnosis || {}
  const selective = base?.selectiveStrategy?.currentDecision || {}
  const confidenceModel = diagnosis.confidenceModel || {}
  const agreement = summarizeAgreement(base)

  const baseMap = normalizeResultMap(diagnosis.resultProbabilities || {})
  const selectiveMap = breakdownToMap(selective.resultBreakdown || [])
  const totalMap = aggregateTotalsByResult(diagnosis.topTotals || [], 5)
  const consensusMap = aggregateConsensusByResult(selective.consensusTotals || [], 4)
  const profileStability = buildProfileStability(base)
  const signalCoherence = buildSignalCoherence(base, {
    baseMap,
    selectiveMap,
    totalMap,
    consensusMap,
  })

  const scores = { Small: 0, Draw: 0, Big: 0 }
  const leadResult = diagnosis.mostLikelyResult || selective.recommendedResult || 'Draw'
  const drawProbability = Number(selective.drawProbability || selective.resultBreakdown?.find((item) => item.result === 'Draw')?.probability || 0)
  const spread = Number(selective.spread || 0)
  const gateRatio = (countPassedGates(selective.gateChecks || []) / Math.max((selective.gateChecks || []).length, 1))
  const confidence = Number(confidenceModel.confidenceScore || 0)

  for (const result of ['Small', 'Draw', 'Big']) {
    scores[result] =
      baseMap[result] * 0.42 +
      selectiveMap[result] * 0.24 +
      totalMap[result] * 0.18 +
      consensusMap[result] * 0.16
  }

  if (agreement.majority && agreement.winner) {
    scores[agreement.winner] += agreement.unanimous ? 0.08 : 0.04
  }

  if (leadResult !== 'Draw' && drawProbability >= 24) {
    scores.Draw += 0.05 + Math.max(0, drawProbability - 24) / 200
    scores[leadResult] -= 0.03
  }

  if (spread < 5) {
    scores.Draw += 0.03
  }

  if (gateRatio >= 0.75 && selective.recommendedResult) {
    scores[selective.recommendedResult] += 0.04
  }

  if (confidence <= 18 && leadResult !== 'Draw') {
    scores.Draw += 0.025
  }

  if (signalCoherence.score >= 72 && agreement.majority && agreement.winner) {
    scores[agreement.winner] += agreement.unanimous ? 0.04 : 0.025
  }

  if (signalCoherence.score < 56) {
    scores.Draw += 0.04
    if (leadResult !== 'Draw') {
      scores[leadResult] -= 0.02
    }
  }

  if (profileStability.score >= 70 && agreement.winner) {
    scores[agreement.winner] += 0.025
  }

  if (profileStability.score < 46) {
    scores.Draw += 0.03
  }

  const fusedProbabilities = normalizeResultMap(scores)
  const ranked = Object.entries(fusedProbabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([result, probability]) => ({ result, probability: Number((probability * 100).toFixed(2)) }))

  const margin = Number((((ranked[0]?.probability || 0) - (ranked[1]?.probability || 0))).toFixed(2))

  return {
    mostLikelyResult: ranked[0]?.result || 'Draw',
    resultProbabilities: fusedProbabilities,
    rankedResults: ranked,
    margin,
    inputs: {
      baseMap,
      selectiveMap,
      totalMap,
      consensusMap,
      agreement,
      drawProbability: Number(drawProbability.toFixed(2)),
      spread: Number(spread.toFixed(2)),
      gateRatio: Number(gateRatio.toFixed(4)),
      confidence: Number(confidence.toFixed(2)),
      profileStability,
      signalCoherence,
    },
  }
}

function buildV2Score(base) {
  const diagnosis = base?.diagnosis || {}
  const confidenceModel = diagnosis.confidenceModel || {}
  const selective = base?.selectiveStrategy || {}
  const currentDecision = selective.currentDecision || {}
  const backtest = selective.backtest || {}
  const drift = selective.drift || {}
  const agreement = summarizeAgreement(base)

  const confidenceScore = confidenceModel.confidenceScore || 0
  const topProbability = currentDecision.topProbability || 0
  const spread = currentDecision.spread || 0
  const gateChecks = currentDecision.gateChecks || []
  const passedGates = countPassedGates(gateChecks)
  const gateRatio = gateChecks.length ? passedGates / gateChecks.length : 0
  const hitRate = backtest.hitRate || 0
  const top2HitRate = backtest.top2HitRate || 0
  const coverage = backtest.coverage || 0
  const utility = backtest.utility || 0
  const driftPressure = Number((drift.pressure || 0) * 100)
  const driftRecentHit = drift.recentHitRate || 0
  const resultMargin = getTopResultMargin(diagnosis.resultProbabilities || {}) * 100
  const diagnosticFusion = buildDiagnosticFusion(base)
  const profileStability = diagnosticFusion.inputs.profileStability
  const signalCoherence = diagnosticFusion.inputs.signalCoherence
  const fusionMargin = diagnosticFusion.margin || 0

  const score =
    confidenceScore * 0.22 +
    hitRate * 0.2 +
    top2HitRate * 0.08 +
    topProbability * 0.14 +
    spread * 0.12 +
    resultMargin * 0.08 +
    gateRatio * 100 * 0.1 +
    profileStability.score * 0.06 +
    signalCoherence.score * 0.08 +
    fusionMargin * 0.08 +
    clamp(utility * 12, 0, 100) * 0.04 +
    (agreement.unanimous ? 10 : agreement.majority ? 5 : 0) +
    clamp(driftRecentHit, 0, 100) * 0.04 -
    driftPressure * 0.22 -
    Math.max(0, 6 - coverage) * 1.15

  return {
    score: Number(clamp(score, 0, 100).toFixed(2)),
    components: {
      confidenceScore: Number(confidenceScore.toFixed(2)),
      topProbability: Number(topProbability.toFixed(2)),
      spread: Number(spread.toFixed(2)),
      hitRate: Number(hitRate.toFixed(2)),
      top2HitRate: Number(top2HitRate.toFixed(2)),
      coverage: Number(coverage.toFixed(2)),
      utility: Number(utility.toFixed(2)),
      gatePasses: passedGates,
      gateTotal: gateChecks.length,
      gateRatio: Number(gateRatio.toFixed(4)),
      driftPressure: Number(driftPressure.toFixed(2)),
      driftRecentHit: Number(driftRecentHit.toFixed(2)),
      agreement,
      resultMargin: Number(resultMargin.toFixed(2)),
      profileStability,
      signalCoherence,
      fusionMargin: Number(fusionMargin.toFixed(2)),
    },
  }
}

function buildV2Decision(base, v2Score) {
  const diagnosis = base?.diagnosis || {}
  const selective = base?.selectiveStrategy || {}
  const currentDecision = selective.currentDecision || {}
  const backtest = selective.backtest || {}
  const drift = selective.drift || {}
  const agreement = v2Score.components.agreement
  const gatePasses = v2Score.components.gatePasses
  const gateTotal = v2Score.components.gateTotal || 1
  const gateRatio = gatePasses / gateTotal
  const consensusTotals = currentDecision.consensusTotals || []
  const primaryConsensus = consensusTotals[0] || null
  const secondaryConsensus = consensusTotals[1] || null
  const consensusGap = primaryConsensus && secondaryConsensus
    ? Math.abs((primaryConsensus.averageProbability || 0) - (secondaryConsensus.averageProbability || 0))
    : null
  const alternativePressure =
    primaryConsensus &&
    secondaryConsensus &&
    primaryConsensus.result !== secondaryConsensus.result &&
    consensusGap != null &&
    consensusGap <= 3
  const profileStability = v2Score.components.profileStability || {}
  const signalCoherence = v2Score.components.signalCoherence || {}

  const shouldSkipForStability =
    (backtest.qualifyingBets || 0) < 4 ||
    (backtest.hitRate || 0) < 56 ||
    (backtest.coverage || 0) < 2.5 ||
    drift.safeMode ||
    (drift.pressure || 0) >= 0.12 ||
    profileStability.score < 42 ||
    signalCoherence.score < 48 ||
    alternativePressure

  const baseWouldBet = currentDecision.decision === 'BET' || currentDecision.shouldBet
  const shouldBet =
    !shouldSkipForStability && (
      (
        baseWouldBet &&
        v2Score.score >= 54 &&
        (currentDecision.topProbability || 0) >= 44 &&
        (currentDecision.spread || 0) >= 4 &&
        gateRatio >= 0.65
      ) ||
      (
        v2Score.score >= 63 &&
        (currentDecision.topProbability || 0) >= 46 &&
        (currentDecision.spread || 0) >= 5 &&
        gateRatio >= 0.7 &&
        agreement.majority &&
        profileStability.score >= 55 &&
        signalCoherence.score >= 58
      )
    )

  const recommendedResult =
    agreement.majority
      ? agreement.winner
      : currentDecision.recommendedResult || diagnosis.mostLikelyResult || getTopResult(diagnosis.resultProbabilities)

  const reasonTrail = []
  if (agreement.unanimous) reasonTrail.push('all_signals_align')
  else if (agreement.majority) reasonTrail.push('majority_alignment')
  else reasonTrail.push('weak_alignment')
  if ((backtest.hitRate || 0) >= 65) reasonTrail.push('strong_backtest')
  if ((backtest.coverage || 0) >= 4) reasonTrail.push('usable_coverage')
  if ((currentDecision.topProbability || 0) >= 50) reasonTrail.push('high_top_probability')
  if ((currentDecision.spread || 0) >= 8) reasonTrail.push('wide_spread')
  if (gateRatio >= 0.8) reasonTrail.push('healthy_gate_ratio')
  if ((drift.pressure || 0) < 0.08) reasonTrail.push('low_drift')
  if (profileStability.score >= 65) reasonTrail.push('profile_stability')
  if (signalCoherence.score >= 68) reasonTrail.push('signal_coherence')
  if (alternativePressure) reasonTrail.push('alternative_result_pressure')
  if (shouldSkipForStability) reasonTrail.push('stability_guard')

  return {
    decision: shouldBet ? 'BET' : drift.safeMode ? 'SAFE_SKIP' : 'SKIP',
    shouldBet,
    recommendedResult,
    confidenceBand:
      v2Score.score >= 72 ? 'elite' : v2Score.score >= 63 ? 'strong' : v2Score.score >= 52 ? 'watch' : 'weak',
    score: v2Score.score,
    reasons: reasonTrail,
    consensusGap,
    alternativePressure,
  }
}

function buildV2Recommendations(base, v2Decision) {
  const recommendations = deepClone(base?.diagnosis?.recommendations || {})
  const followTotals = recommendations.followTotals || []
  const primaryResult = v2Decision.recommendedResult

  if (!v2Decision.shouldBet) {
    return {
      ...recommendations,
      recommendationCode: 'NO_BET_V2',
      recommendationText: `V2 ưu tiên bỏ qua. Chờ tín hiệu đồng thuận mạnh hơn cho ${primaryResult}.`,
      stakePlan: '0%',
      recommendedResult: primaryResult,
      primaryMethod: 'Selective Precision',
      confidenceBand: v2Decision.confidenceBand,
      riskLevel: 'High',
      followTotals,
    }
  }

  return {
    ...recommendations,
    recommendationCode: 'FOLLOW_V2_PRIMARY',
    recommendationText: `V2 cho phép vào lệnh theo ${primaryResult}, ưu tiên các tổng ${followTotals.slice(0, 3).map((item) => item.total).join(', ') || 'phù hợp cùng lớp'}.`,
    stakePlan: v2Decision.score >= 72 ? '0.75u' : '0.35u',
    recommendedResult: primaryResult,
    primaryMethod: 'Selective Precision',
    confidenceBand: v2Decision.confidenceBand,
    riskLevel: v2Decision.score >= 72 ? 'Medium' : 'Medium-High',
    followTotals,
  }
}

function applyV2Overlay(basePrediction) {
  const base = deepClone(basePrediction)
  const diagnosticFusion = buildDiagnosticFusion(base)
  if (base.diagnosis) {
    base.diagnosis.baseMostLikelyResult = base.diagnosis.mostLikelyResult
    base.diagnosis.baseResultProbabilities = deepClone(base.diagnosis.resultProbabilities || {})
    base.diagnosis.mostLikelyResult = diagnosticFusion.mostLikelyResult
    base.diagnosis.resultProbabilities = diagnosticFusion.resultProbabilities
  }
  const v2Score = buildV2Score(base)
  const v2Decision = buildV2Decision(base, v2Score)

  base.methodology = base.methodology || {}
  base.methodology.v2 = {
    version: 'predictor_v2_overlay',
    mode: 'precision_first_overlay',
    summary:
      'V2 keeps the full legacy schema and re-scores the final action using confidence, selective backtest quality, gate health, drift, and signal agreement.',
    score: v2Score.score,
    scoreComponents: v2Score.components,
    decision: v2Decision,
    diagnosticFusion,
    stability: {
      profile: diagnosticFusion.inputs.profileStability,
      coherence: diagnosticFusion.inputs.signalCoherence,
    },
  }

  base.diagnosis = base.diagnosis || {}
  base.diagnosis.v2 = {
    score: v2Score.score,
    decision: v2Decision.decision,
    recommendedResult: v2Decision.recommendedResult,
    confidenceBand: v2Decision.confidenceBand,
    mostLikelyResult: diagnosticFusion.mostLikelyResult,
    resultProbabilities: diagnosticFusion.resultProbabilities,
    rankedResults: diagnosticFusion.rankedResults,
    margin: diagnosticFusion.margin,
  }
  base.diagnosis.v2Recommendations = buildV2Recommendations(base, v2Decision)

  base.selectiveStrategy = base.selectiveStrategy || {}
  base.selectiveStrategy.v2 = {
    score: v2Score.score,
    decision: v2Decision.decision,
    recommendedResult: v2Decision.recommendedResult,
    reasons: v2Decision.reasons,
    currentDecision: {
      decision: v2Decision.decision,
      shouldBet: v2Decision.shouldBet,
      recommendedResult: v2Decision.recommendedResult,
      score: v2Score.score,
      confidenceBand: v2Decision.confidenceBand,
      reasons: v2Decision.reasons,
    },
  }

  if (base.selectiveStrategy.currentDecision) {
    base.selectiveStrategy.currentDecision.v2Score = v2Score.score
    base.selectiveStrategy.currentDecision.v2Decision = v2Decision.decision
    base.selectiveStrategy.currentDecision.v2Reasons = v2Decision.reasons
    base.selectiveStrategy.currentDecision.v2RecommendedResult = v2Decision.recommendedResult
  }

  base.betPortfolio = base.betPortfolio || {}
  base.betPortfolio.v2Decision = v2Decision.decision
  base.betPortfolio.v2RecommendedResult = v2Decision.recommendedResult
  if (base.betPortfolio.highHit) {
    base.betPortfolio.highHit.v2Summary =
      v2Decision.shouldBet
        ? `${base.betPortfolio.highHit.summary} V2 xác nhận có thể vào theo hướng ${v2Decision.recommendedResult}.`
        : `${base.betPortfolio.highHit.summary} V2 khuyến nghị đứng ngoài để bảo toàn precision.`
  }

  return base
}

export function buildPredictionFromBase(basePrediction) {
  return applyV2Overlay(basePrediction)
}

export function buildPrediction(rounds, options = {}) {
  const basePrediction = buildPredictionV1(rounds, options)
  return applyV2Overlay(basePrediction)
}

