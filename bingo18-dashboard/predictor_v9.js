import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { buildTemporalFlowBundle } from './temporal_flow.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CONSENSUS_MEMORY_FILE = process.env.CONSENSUS_V16_AI_MEMORY_FILE
  ? path.resolve(process.env.CONSENSUS_V16_AI_MEMORY_FILE)
  : path.join(__dirname, 'consensus-v16-ai-memory.json')
const V9_MEMORY_FILE = process.env.V9_MEMORY_FILE
  ? path.resolve(process.env.V9_MEMORY_FILE)
  : path.join(__dirname, 'v9-memory.json')
const ADAPTIVE_WINDOW = 14
const RECENT_VALIDATION_WINDOW = 2
const LEDGER_SIMULATION_WINDOW = Math.max(
  ADAPTIVE_WINDOW + RECENT_VALIDATION_WINDOW + 7,
  Number(process.env.V9_LEDGER_SIMULATION_WINDOW || 36),
)
const RECENT_CHECK_ROWS = 7
const RESULT_ORDER = ['Small', 'Draw', 'Big']

const STRATEGIES = [
  { id: 'center_draw', label: 'Center Draw', totals: [10, 11, 12], result: 'Draw', regime: 'center' },
  { id: 'center_soft', label: 'Center Soft', totals: [9, 10, 11], result: 'Draw', regime: 'center' },
  { id: 'center_big', label: 'Center Big', totals: [11, 12, 13], result: 'Big', regime: 'center' },
  { id: 'upper_core', label: 'Upper Core', totals: [12, 13, 14], result: 'Big', regime: 'upper' },
  { id: 'upper_edge', label: 'Upper Edge', totals: [13, 14, 15], result: 'Big', regime: 'upper' },
  { id: 'lower_core', label: 'Lower Core', totals: [8, 9, 7], result: 'Small', regime: 'lower' },
  { id: 'lower_edge', label: 'Lower Edge', totals: [6, 7, 8], result: 'Small', regime: 'lower' },
]
const TOTAL_PRIOR = {
  3: 1, 4: 3, 5: 6, 6: 10, 7: 15, 8: 21, 9: 25, 10: 27,
  11: 27, 12: 25, 13: 21, 14: 15, 15: 10, 16: 6, 17: 3, 18: 1,
}

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function canonicalDiceKey(round) {
  const dice = Array.isArray(round?.dice) ? round.dice.map(Number).filter(Number.isFinite) : []
  if (dice.length !== 3) return null
  return [...dice].sort((a, b) => a - b).join('-')
}

function roundNumber(value, digits = 6) {
  return Number(value.toFixed(digits))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function readConsensusMemory() {
  try {
    const raw = fs.readFileSync(CONSENSUS_MEMORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const allChecks = Array.isArray(parsed?.allTotalChecks)
      ? parsed.allTotalChecks
      : Array.isArray(parsed?.recentTotalChecks)
        ? parsed.recentTotalChecks
        : []
    return {
      latestRoundId: parsed?.latestRoundId != null ? String(parsed.latestRoundId) : null,
      allTotalChecks: allChecks,
    }
  } catch {
    return {
      latestRoundId: null,
      allTotalChecks: [],
    }
  }
}

function readV9Memory() {
  try {
    const raw = fs.readFileSync(V9_MEMORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      latestRoundId: parsed?.latestRoundId != null ? String(parsed.latestRoundId) : null,
      history: Array.isArray(parsed?.history) ? parsed.history : [],
    }
  } catch {
    return {
      latestRoundId: null,
      history: [],
    }
  }
}

function totalsKey(totals) {
  return totals.slice(0, 3).map(Number).sort((a, b) => a - b).join('|')
}

function totalRegime(total) {
  if (total >= 13) return 'upper'
  if (total <= 8) return 'lower'
  return 'center'
}

function nextRoundIdFromValue(roundId) {
  const latestId = String(roundId || '').trim()
  if (!latestId) return null
  const numeric = Number(latestId)
  if (!Number.isFinite(numeric)) return null
  return String(numeric + 1).padStart(latestId.length, '0')
}

function recentRegimeBias(roundsDesc) {
  const recent = roundsDesc.slice(0, ADAPTIVE_WINDOW).map((round) => Number(round.total)).filter(Number.isFinite)
  const bias = { center: 0, upper: 0, lower: 0 }
  recent.forEach((total, index) => {
    const weight = 1 / (1 + index * 0.18)
    bias[totalRegime(total)] += weight
  })
  const sum = bias.center + bias.upper + bias.lower || 1
  return {
    center: bias.center / sum,
    upper: bias.upper / sum,
    lower: bias.lower / sum,
  }
}

function buildFollowUpComboInsights(roundsDesc) {
  const latest = roundsDesc?.[0]
  if (!latest) {
    return { support: 0, topCombos: [], topTotals: [] }
  }

  const anchorCanonical = canonicalDiceKey(latest)
  const comboCounts = new Map()
  const totalCounts = new Map()
  let support = 0

  for (let index = 1; index < roundsDesc.length; index += 1) {
    const round = roundsDesc[index]
    const newerRound = roundsDesc[index - 1]
    if (!round || !newerRound) continue
    if (canonicalDiceKey(round) !== anchorCanonical) continue
    support += 1

    const comboKey = canonicalDiceKey(newerRound)
    if (comboKey) comboCounts.set(comboKey, (comboCounts.get(comboKey) || 0) + 1)
    const total = Number(newerRound.total)
    if (Number.isFinite(total)) totalCounts.set(total, (totalCounts.get(total) || 0) + 1)
  }

  const comboDenominator = [...comboCounts.values()].reduce((acc, value) => acc + value, 0) || 1
  const totalDenominator = [...totalCounts.values()].reduce((acc, value) => acc + value, 0) || 1
  return {
    support,
    topCombos: [...comboCounts.entries()]
      .map(([combo, count]) => ({ combo, count, probability: count / comboDenominator }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    topTotals: [...totalCounts.entries()]
      .map(([total, count]) => ({
        total: Number(total),
        count,
        probability: count / totalDenominator,
        result: classifyTotal(Number(total)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
  }
}

function buildFollowUpTotalInsights(roundsDesc) {
  const latest = roundsDesc?.[0]
  if (!latest || !Number.isFinite(Number(latest.total))) {
    return { support: 0, topTotals: [] }
  }

  const anchorTotal = Number(latest.total)
  const totalCounts = new Map()
  let support = 0

  for (let index = 1; index < roundsDesc.length; index += 1) {
    const round = roundsDesc[index]
    const newerRound = roundsDesc[index - 1]
    if (!round || !newerRound) continue
    if (Number(round.total) !== anchorTotal) continue
    support += 1
    const total = Number(newerRound.total)
    if (Number.isFinite(total)) totalCounts.set(total, (totalCounts.get(total) || 0) + 1)
  }

  const denominator = [...totalCounts.values()].reduce((acc, value) => acc + value, 0) || 1
  return {
    support,
    topTotals: [...totalCounts.entries()]
      .map(([total, count]) => ({
        total: Number(total),
        count,
        probability: count / denominator,
        result: classifyTotal(Number(total)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
  }
}

function buildFollowUpResultInsights(roundsDesc) {
  const latest = roundsDesc?.[0]
  const latestResult = latest?.result || classifyTotal(Number(latest?.total))
  if (!latestResult) {
    return { support: 0, topTotals: [] }
  }

  const totalCounts = new Map()
  let support = 0

  for (let index = 1; index < roundsDesc.length; index += 1) {
    const round = roundsDesc[index]
    const newerRound = roundsDesc[index - 1]
    if (!round || !newerRound) continue
    const roundResult = round.result || classifyTotal(Number(round.total))
    if (roundResult !== latestResult) continue
    support += 1
    const total = Number(newerRound.total)
    if (Number.isFinite(total)) totalCounts.set(total, (totalCounts.get(total) || 0) + 1)
  }

  const denominator = [...totalCounts.values()].reduce((acc, value) => acc + value, 0) || 1
  return {
    support,
    topTotals: [...totalCounts.entries()]
      .map(([total, count]) => ({
        total: Number(total),
        count,
        probability: count / denominator,
        result: classifyTotal(Number(total)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  }
}

function buildRareGapBonus(roundsDesc) {
  const recent = roundsDesc.slice(0, 36)
  const lastSeen = new Map()

  recent.forEach((round, index) => {
    const total = Number(round?.total)
    if (!Number.isFinite(total)) return
    if (!lastSeen.has(total)) lastSeen.set(total, index)
  })

  const bonusByTotal = {}
  for (let total = 3; total <= 18; total += 1) {
    const seenIndex = lastSeen.has(total) ? lastSeen.get(total) : recent.length + 2
    const gapScore = Math.min(seenIndex / Math.max(recent.length, 1), 1)
    const rarityBase = 1 - ((TOTAL_PRIOR[total] || 1) / 27)
    const edgeBoost = total <= 5 || total >= 15 ? 1.08 : 1
    bonusByTotal[total] = roundNumber(gapScore * rarityBase * 0.06 * edgeBoost, 8)
  }

  return bonusByTotal
}

function listToProbabilityMap(list) {
  const map = new Map()
  ;(list || []).forEach((item) => {
    const total = Number(item?.total)
    const probability = Number(item?.probability)
    if (Number.isFinite(total) && Number.isFinite(probability)) {
      map.set(total, probability)
    }
  })
  return map
}

function regimePreferenceBoost(strategyId, total) {
  switch (strategyId) {
    case 'center_draw':
      return total === 10 || total === 11 ? 0.22 : total === 9 || total === 12 ? 0.12 : 0
    case 'center_soft':
      return total === 9 || total === 10 || total === 11 ? 0.18 : total === 8 || total === 12 ? 0.08 : 0
    case 'center_big':
      return total === 11 || total === 12 || total === 13 ? 0.18 : total === 10 || total === 14 ? 0.08 : 0
    case 'upper_core':
      return total === 12 || total === 13 || total === 14 ? 0.18 : total === 15 || total === 11 ? 0.08 : 0
    case 'upper_edge':
      return total === 13 || total === 14 || total === 15 ? 0.16 : total === 16 || total === 12 || total === 17 ? 0.09 : 0
    case 'lower_core':
      return total === 7 || total === 8 || total === 9 ? 0.17 : total === 6 || total === 10 ? 0.08 : 0
    case 'lower_edge':
      return total === 5 || total === 6 || total === 7 ? 0.14 : total === 4 || total === 8 || total === 3 ? 0.1 : 0
    default:
      return 0
  }
}

function materializeStrategy(strategy, inputs) {
  if (strategy.dynamic && strategy.scoreByTotal) return strategy

  const scoreMap = new Map()
  for (let total = 3; total <= 18; total += 1) {
    scoreMap.set(total, (TOTAL_PRIOR[total] || 1) / 216 * 0.05)
  }

  const comboMap = listToProbabilityMap(inputs.comboInsights?.topTotals)
  const totalMap = listToProbabilityMap(inputs.totalInsights?.topTotals)
  const faceMap = listToProbabilityMap(inputs.faceInsights?.topTotals)
  const resultMap = listToProbabilityMap(inputs.resultInsights?.topTotals)
  const rareBonusMap = inputs.rareBonusMap || {}

  for (let total = 3; total <= 18; total += 1) {
    const comboWeight = comboMap.get(total) || 0
    const totalWeight = totalMap.get(total) || 0
    const faceWeight = faceMap.get(total) || 0
    const resultWeight = resultMap.get(total) || 0
    const edgeBoost = total <= 5 || total >= 15 ? 1.04 : 1
    const score =
      comboWeight * 0.16 +
      totalWeight * 0.34 +
      faceWeight * 0.14 * edgeBoost +
      resultWeight * 0.22 +
      regimePreferenceBoost(strategy.id, total) +
      Number(rareBonusMap[total] || 0) * 0.65
    scoreMap.set(total, (scoreMap.get(total) || 0) + score)
  }

  const totals = topTotalsFromScoreMap(scoreMap, () => true, 3)
  return {
    ...strategy,
    totals,
    result: dominantResultFromTotals(totals),
    regime: totalRegime(totals[0]),
    scoreByTotal: Object.fromEntries(
      [...scoreMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16),
    ),
    support:
      Number(inputs.comboInsights?.support || 0) +
      Number(inputs.totalInsights?.support || 0) +
      Number(inputs.faceInsights?.support || 0) +
      Number(inputs.resultInsights?.support || 0),
  }
}

function buildFaceTransitionInsights(roundsDesc) {
  const latest = roundsDesc?.[0]
  const latestFaces = Array.isArray(latest?.dice) ? latest.dice.map(Number).filter(Number.isFinite) : []
  if (latestFaces.length !== 3) {
    return { support: 0, topTotals: [] }
  }

  const latestSet = new Set(latestFaces)
  const totalCounts = new Map()
  let support = 0

  for (let index = 1; index < roundsDesc.length; index += 1) {
    const round = roundsDesc[index]
    const newerRound = roundsDesc[index - 1]
    const dice = Array.isArray(round?.dice) ? round.dice.map(Number).filter(Number.isFinite) : []
    if (dice.length !== 3 || !newerRound) continue
    const overlap = dice.filter((face) => latestSet.has(face)).length
    if (overlap <= 0) continue
    support += overlap
    const total = Number(newerRound.total)
    if (Number.isFinite(total)) totalCounts.set(total, (totalCounts.get(total) || 0) + overlap)
  }

  const denominator = [...totalCounts.values()].reduce((acc, value) => acc + value, 0) || 1
  return {
    support,
    topTotals: [...totalCounts.entries()]
      .map(([total, count]) => ({
        total: Number(total),
        count,
        probability: count / denominator,
        result: classifyTotal(Number(total)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  }
}

function topTotalsFromScoreMap(scoreMap, predicate = () => true, limit = 3) {
  return [...scoreMap.entries()]
    .map(([total, score]) => ({ total: Number(total), score }))
    .filter((item) => predicate(item.total))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.total)
}

function diversifiedTopTotalsFromScoreMap(scoreMap, limit = 3) {
  const ranked = [...scoreMap.entries()]
    .map(([total, score]) => ({ total: Number(total), score: Number(score) }))
    .filter((item) => Number.isFinite(item.total) && Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)

  if (!ranked.length) return []

  const selected = [ranked[0]]
  const used = new Set([ranked[0].total])

  const pickNext = (predicate) => {
    const candidate = ranked.find((item) => !used.has(item.total) && predicate(item))
    if (!candidate) return false
    selected.push(candidate)
    used.add(candidate.total)
    return true
  }

  const lead = ranked[0]
  const leadRegime = totalRegime(lead.total)
  pickNext((item) => totalRegime(item.total) !== leadRegime && Math.abs(item.total - lead.total) >= 2)
  pickNext((item) => Math.abs(item.total - lead.total) >= 2)
  pickNext((item) => totalRegime(item.total) !== leadRegime)
  pickNext(() => true)

  return selected.slice(0, limit).map((item) => item.total)
}

function buildCoverageAwareTrio(
  weights,
  history = [],
  preferredRegime = 'center',
  context = {},
) {
  const ranked = [...weights.entries()]
    .map(([total, weight]) => ({ total: Number(total), weight: Number(weight) }))
    .filter((item) => Number.isFinite(item.total) && Number.isFinite(item.weight))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)

  if (ranked.length <= 3) return ranked.slice(0, 3).map((item) => item.total)

  const recent = Array.isArray(history) ? history.slice(0, 6) : []
  const recentMisses = recent.filter((item) => item?.hit === false)
  const repeatedMissKey = recentMisses.length >= 2 ? totalsKey(recentMisses[0]?.predictedTotals || []) : null
  const recentActuals = recent
    .map((item) => Number(item?.actualTotal))
    .filter(Number.isFinite)
  const hotActuals = new Set(recentActuals.slice(0, 4))
  const exposureSignals = context?.exposureSignals || null
  const lastPredictionMissed = Boolean(exposureSignals?.lastPredictionMissed)
  const lastPredictionTotals = exposureSignals?.lastPredictionTotals || new Set()
  const cooldownByTotal = exposureSignals?.cooldownByTotal || new Map()
  const jumpTotals = context?.jumpTotals || new Set()
  const holdTotals = context?.holdTotals || new Set()
  const resultStreak = context?.resultStreak || null

  let best = ranked.slice(0, 3).map((item) => item.total)
  let bestScore = -Infinity

  for (let i = 0; i < ranked.length; i += 1) {
    for (let j = i + 1; j < ranked.length; j += 1) {
      for (let k = j + 1; k < ranked.length; k += 1) {
        const trio = [ranked[i].total, ranked[j].total, ranked[k].total]
        const trioKey = totalsKey(trio)
        const sorted = [...trio].sort((a, b) => a - b)
        const regimes = new Set(trio.map((total) => totalRegime(total)))
        const scoreSum = trio.reduce((acc, total) => acc + (weights.get(total) || 0), 0)
        const spread = Math.max(...trio) - Math.min(...trio)
        const adjacencyPenalty =
          (sorted[1] - sorted[0] <= 1 ? 0.08 : 0) +
          (sorted[2] - sorted[1] <= 1 ? 0.08 : 0)
        const repeatedMissPenalty = repeatedMissKey && trioKey === repeatedMissKey ? 0.18 : 0
        const lastMissOverlapPenalty =
          lastPredictionMissed
            ? trio.filter((total) => lastPredictionTotals.has(total)).length * 0.08
            : 0
        const cooldownPenalty = trio.reduce(
          (acc, total) => acc + Number(cooldownByTotal.get(total) || 0),
          0,
        )
        const hotActualBonus = trio.filter((total) => hotActuals.has(total)).length * 0.03
        const jumpBonus =
          trio.filter((total) => jumpTotals.has(total)).length * 0.042
        const holdBonus =
          trio.filter((total) => holdTotals.has(total)).length * 0.024
        const sameResultPenalty =
          resultStreak?.key
            ? trio.filter((total) => classifyTotal(total) === resultStreak.key).length *
              (
                resultStreak.key === 'Draw'
                  ? resultStreak.length >= 2
                    ? 0.09
                    : 0.065
                  : resultStreak.length >= 2
                    ? 0.036
                    : 0
              )
            : 0
        const regimeBonus =
          regimes.size >= 3
            ? 0.12
            : regimes.size === 2
              ? 0.07
              : preferredRegime === totalRegime(trio[0])
                ? 0.01
                : -0.03
        const spreadBonus =
          spread >= 6 ? 0.1 : spread >= 4 ? 0.06 : spread >= 3 ? 0.03 : -0.05
        const edgeBonus = trio.filter((total) => total <= 5 || total >= 15).length * 0.022
        const centerBonusPerHit =
          resultStreak?.key === 'Draw'
            ? Number(resultStreak?.length || 0) >= 2
              ? -0.024
              : -0.012
            : 0.028
        const centerBonus =
          trio.filter((total) => total === 10 || total === 11).length *
          centerBonusPerHit
        const nearDrawPenalty =
          resultStreak?.key === 'Draw'
            ? trio.filter((total) => total === 9 || total === 12).length *
              (Number(resultStreak?.length || 0) >= 2 ? 0.018 : 0.01)
            : 0
        const score =
          scoreSum +
          regimeBonus +
          spreadBonus +
          edgeBonus +
          centerBonus +
          jumpBonus +
          holdBonus +
          hotActualBonus -
          adjacencyPenalty -
          repeatedMissPenalty -
          lastMissOverlapPenalty -
          cooldownPenalty -
          nearDrawPenalty -
          sameResultPenalty

        if (score > bestScore) {
          bestScore = score
          best = trio
        }
      }
    }
  }

  return best
}

function normalizeScoreObject(scoreObject) {
  const pairs = []
  for (let total = 3; total <= 18; total += 1) {
    const score = Number(scoreObject?.[String(total)] || 0)
    pairs.push([String(total), roundNumber(Math.max(0, score), 8)])
  }
  return Object.fromEntries(
    pairs.sort((a, b) => Number(b[1]) - Number(a[1])),
  )
}

function buildProfileScoreObject(baseScoreByTotal, profile = 'neutral') {
  const adjusted = {}
  for (let total = 3; total <= 18; total += 1) {
    let score = Number(baseScoreByTotal?.[String(total)] || 0)
    const regime = totalRegime(total)

    if (profile === 'center') {
      if (regime === 'center') score *= 1.22
      if (regime === 'upper' || regime === 'lower') score *= 0.9
    } else if (profile === 'upper') {
      if (regime === 'upper') score *= 1.2
      if (regime === 'lower') score *= 0.86
    } else if (profile === 'lower') {
      if (regime === 'lower') score *= 1.2
      if (regime === 'upper') score *= 0.86
    } else if (profile === 'edge') {
      if (total <= 5 || total >= 15) score *= 1.28
      if (regime === 'center') score *= 0.92
    } else if (profile === 'draw') {
      if (total === 10 || total === 11) score *= 1.3
      if (total === 9 || total === 12) score *= 1.1
    }

    adjusted[String(total)] = roundNumber(score, 8)
  }
  return normalizeScoreObject(adjusted)
}

function dominantResultFromTotals(totals) {
  const counts = { Small: 0, Draw: 0, Big: 0 }
  totals.forEach((total) => {
    const result = classifyTotal(total)
    counts[result] += 1
  })
  return ['Draw', 'Big', 'Small'].sort((a, b) => counts[b] - counts[a])[0]
}

function normalizeResultScores(scores) {
  const sum = RESULT_ORDER.reduce(
    (acc, result) => acc + Math.max(0, Number(scores?.[result] || 0)),
    0,
  ) || 1
  return Object.fromEntries(
    RESULT_ORDER.map((result) => [
      result,
      roundNumber(Math.max(0, Number(scores?.[result] || 0)) / sum),
    ]),
  )
}

function findTemporalProfile(temporalFlow, profileId) {
  return Array.isArray(temporalFlow?.profiles)
    ? temporalFlow.profiles.find((item) => item?.id === profileId) || null
    : null
}

function buildPredictionExposureSignals(history = []) {
  const recent = Array.isArray(history) ? history.slice(0, 6) : []
  const predictedCount = new Map()
  const missedPredictedCount = new Map()
  const hitPredictedCount = new Map()
  const cooldownByTotal = new Map()
  const latest = recent[0] || null

  recent.forEach((item, index) => {
    const predictedTotals = Array.isArray(item?.predictedTotals)
      ? item.predictedTotals.map(Number).filter(Number.isFinite).slice(0, 3)
      : []
    const weight = 1 / (1 + index * 0.45)

    predictedTotals.forEach((total) => {
      predictedCount.set(total, (predictedCount.get(total) || 0) + weight)
      if (item?.hit) {
        hitPredictedCount.set(total, (hitPredictedCount.get(total) || 0) + weight)
      } else {
        missedPredictedCount.set(
          total,
          (missedPredictedCount.get(total) || 0) + weight,
        )
      }
    })
  })

  for (let total = 3; total <= 18; total += 1) {
    const seen = Number(predictedCount.get(total) || 0)
    const missed = Number(missedPredictedCount.get(total) || 0)
    const hit = Number(hitPredictedCount.get(total) || 0)
    const penalty = clamp(
      missed * 0.07 +
        Math.max(0, seen - hit - 0.9) * 0.03 +
        (latest?.hit === false &&
        Array.isArray(latest?.predictedTotals) &&
        latest.predictedTotals.map(Number).includes(total)
          ? 0.05
          : 0),
      0,
      0.18,
    )
    cooldownByTotal.set(total, roundNumber(penalty, 8))
  }

  return {
    predictedCount,
    missedPredictedCount,
    hitPredictedCount,
    cooldownByTotal,
    lastPredictionMissed: latest ? latest.hit === false : false,
    lastPredictionTotals: new Set(
      Array.isArray(latest?.predictedTotals)
        ? latest.predictedTotals.map(Number).filter(Number.isFinite).slice(0, 3)
        : [],
    ),
  }
}

function applyLatestDrawAndRecoveryBias(weights, history = [], temporalFlow = null) {
  for (let total = 3; total <= 18; total += 1) {
    if (!weights.has(total)) {
      weights.set(total, ((TOTAL_PRIOR[total] || 1) / 216) * 0.002)
    }
  }

  const latestResult = temporalFlow?.summary?.anchors?.latestResult || null
  const resultStreak = temporalFlow?.summary?.resultStreak || {
    key: null,
    length: 0,
  }
  const streakLength = Number(resultStreak?.length || 0)
  const recentActualTotals = Array.isArray(history)
    ? history
        .slice(0, 24)
        .map((item) => Number(item?.actualTotal))
        .filter(Number.isFinite)
    : []
  const recentShortSet = new Set(recentActualTotals.slice(0, 12))
  const recentWideSet = new Set(recentActualTotals)
  const ordered = Array.from(weights.values())
    .map((value) => Math.max(0.000001, Number(value) || 0))
    .sort((a, b) => a - b)
  const median = ordered[Math.floor(ordered.length / 2)] || 0.000001
  const lowerQuartile = ordered[Math.floor(ordered.length * 0.25)] || 0.000001

  for (let total = 3; total <= 18; total += 1) {
    const currentWeight = Math.max(0.000001, Number(weights.get(total) || 0))
    const scarcity =
      currentWeight < median
        ? clamp((median - currentWeight) / Math.max(median, 0.000001), 0, 1.4)
        : 0
    const underExposed = currentWeight <= lowerQuartile
    let factor = 1

    factor += scarcity * 0.078
    if (underExposed) factor += 0.024
    if (!recentShortSet.has(total)) factor += 0.018
    if (!recentWideSet.has(total)) factor += 0.014
    if ((total <= 5 || total >= 15) && underExposed) factor += 0.012

    if (latestResult === 'Draw') {
      if (total === 10 || total === 11) factor *= streakLength >= 2 ? 0.5 : 0.62
      else if (total === 9 || total === 12) {
        factor *= streakLength >= 2 ? 0.74 : 0.84
      } else if (total <= 8 || total >= 13) {
        factor *= streakLength >= 2 ? 1.12 : 1.08
      } else {
        factor *= 1.04
      }
    }

    weights.set(total, Math.max(0.000001, currentWeight * factor))
  }
}

function buildFinalResultProbabilities(
  selectedStrategy,
  topProbability,
  temporalFlow,
  selectedTotals,
) {
  const baseScores = {
    Small: 0.24,
    Draw: 0.24,
    Big: 0.24,
  }
  baseScores[selectedStrategy?.result || 'Draw'] = topProbability
  const remainder = Math.max(0.04, 1 - topProbability)
  const others = RESULT_ORDER.filter(
    (result) => result !== (selectedStrategy?.result || 'Draw'),
  )
  baseScores[others[0]] = roundNumber(remainder * 0.54)
  baseScores[others[1]] = roundNumber(remainder * 0.46)

  const temporalScores = temporalFlow?.resultProbabilities || {}
  const trioResult = dominantResultFromTotals(selectedTotals || [])
  const blendedScores = {
    Small:
      baseScores.Small * 0.66 +
      Number(temporalScores.Small || 0) * 0.34 +
      (trioResult === 'Small' ? 0.07 : 0) +
      (temporalFlow?.primaryResult === 'Small' ? 0.03 : 0),
    Draw:
      baseScores.Draw * 0.66 +
      Number(temporalScores.Draw || 0) * 0.34 +
      (trioResult === 'Draw' ? 0.07 : 0) +
      (temporalFlow?.primaryResult === 'Draw' ? 0.03 : 0),
    Big:
      baseScores.Big * 0.66 +
      Number(temporalScores.Big || 0) * 0.34 +
      (trioResult === 'Big' ? 0.07 : 0) +
      (temporalFlow?.primaryResult === 'Big' ? 0.03 : 0),
  }

  const resultStreak = temporalFlow?.summary?.resultStreak || null
  if (
    resultStreak?.key === 'Draw' &&
    Number(resultStreak?.length || 0) >= 1
  ) {
    const penalty =
      Number(resultStreak.length || 0) >= 2 ? 0.24 : 0.17
    blendedScores.Draw *= 1 - penalty
    blendedScores.Small += penalty * 0.52
    blendedScores.Big += penalty * 0.48
  } else if (resultStreak?.key && Number(resultStreak?.length || 0) >= 2) {
    const key = resultStreak.key
    const penalty =
      Number(resultStreak.length || 0) >= 3 ? 0.16 : 0.1
    blendedScores[key] *= 1 - penalty

    const others = RESULT_ORDER.filter((result) => result !== key)
    blendedScores[others[0]] += penalty * 0.56
    blendedScores[others[1]] += penalty * 0.44
  }

  return normalizeResultScores(blendedScores)
}

function buildDynamicStrategies(roundsDesc, temporalFlow = null) {
  const comboInsights = buildFollowUpComboInsights(roundsDesc)
  const totalInsights = buildFollowUpTotalInsights(roundsDesc)
  const faceInsights = buildFaceTransitionInsights(roundsDesc)
  const resultInsights = buildFollowUpResultInsights(roundsDesc)
  const rareBonusMap = buildRareGapBonus(roundsDesc)
  const scoreMap = new Map()

  for (let total = 3; total <= 18; total += 1) {
    scoreMap.set(total, (TOTAL_PRIOR[total] || 1) / 216 * 0.08)
  }

  comboInsights.topTotals.forEach((item, index) => {
    const score = item.probability * 0.28 + Math.max(0, 0.032 - index * 0.004)
    scoreMap.set(item.total, (scoreMap.get(item.total) || 0) + score)
  })

  totalInsights.topTotals.forEach((item, index) => {
    const score = item.probability * 0.42 + Math.max(0, 0.038 - index * 0.005)
    scoreMap.set(item.total, (scoreMap.get(item.total) || 0) + score)
  })

  comboInsights.topCombos.forEach((item, index) => {
    const comboTotal = String(item.combo || '')
      .split('-')
      .map(Number)
      .filter(Number.isFinite)
      .reduce((acc, value) => acc + value, 0)
    if (!Number.isFinite(comboTotal)) return
    const score = item.probability * 0.035 + Math.max(0, 0.01 - index * 0.0015)
    scoreMap.set(comboTotal, (scoreMap.get(comboTotal) || 0) + score)
  })

  faceInsights.topTotals.forEach((item, index) => {
    const edgeBoost = item.total <= 5 || item.total >= 15 ? 1.1 : 1
    const score = (item.probability * 0.14 + Math.max(0, 0.018 - index * 0.002)) * edgeBoost
    scoreMap.set(item.total, (scoreMap.get(item.total) || 0) + score)
  })

  resultInsights.topTotals.forEach((item, index) => {
    const score = item.probability * 0.18 + Math.max(0, 0.018 - index * 0.0025)
    scoreMap.set(item.total, (scoreMap.get(item.total) || 0) + score)
  })

  const temporalBalanced = temporalFlow?.scoreByTotal || {}
  const temporalDayPulse = findTemporalProfile(
    temporalFlow,
    'temporal_daypulse',
  )?.scoreByTotal || {}
  const temporalRecent50 = findTemporalProfile(
    temporalFlow,
    'temporal_recent50',
  )?.scoreByTotal || {}
  const temporalTransition = findTemporalProfile(
    temporalFlow,
    'temporal_transition',
  )?.scoreByTotal || {}

  for (let total = 3; total <= 18; total += 1) {
    scoreMap.set(
      total,
      (scoreMap.get(total) || 0) +
        Number(temporalBalanced[String(total)] || 0) * 0.18 +
        Number(temporalDayPulse[String(total)] || 0) * 0.08 +
        Number(temporalRecent50[String(total)] || 0) * 0.06 +
        Number(temporalTransition[String(total)] || 0) * 0.1,
    )
  }

  for (let total = 3; total <= 18; total += 1) {
    scoreMap.set(total, (scoreMap.get(total) || 0) + Number(rareBonusMap[total] || 0))
  }

  ;[3, 4, 5, 15, 16, 17, 18].forEach((edgeTotal) => {
    const current = scoreMap.get(edgeTotal) || 0
    scoreMap.set(edgeTotal, current + (TOTAL_PRIOR[edgeTotal] / 216) * 0.02)
  })

  const rankedTotals = [...scoreMap.entries()]
    .map(([total, score]) => ({ total: Number(total), score }))
    .sort((a, b) => b.score - a.score)

  if (rankedTotals.length < 3) {
    return {
      strategies: [],
      insights: { comboInsights, totalInsights, generated: false },
    }
  }

  const blendedTop3 = topTotalsFromScoreMap(scoreMap, () => true, 3)
  const centerTop3 = topTotalsFromScoreMap(scoreMap, (total) => total >= 9 && total <= 12, 3)
  const edgeTop3 = topTotalsFromScoreMap(scoreMap, (total) => total <= 5 || total >= 15, 3)
  const lowerTop3 = topTotalsFromScoreMap(scoreMap, (total) => total <= 9, 3)
  const upperTop3 = topTotalsFromScoreMap(scoreMap, (total) => total >= 10, 3)

  const normalizedScoreByTotal = Object.fromEntries(
    rankedTotals.slice(0, 16).map((item) => [String(item.total), item.score]),
  )
  const centerScoreByTotal = buildProfileScoreObject(normalizedScoreByTotal, 'center')
  const edgeScoreByTotal = buildProfileScoreObject(normalizedScoreByTotal, 'edge')
  const lowerScoreByTotal = buildProfileScoreObject(normalizedScoreByTotal, 'lower')
  const upperScoreByTotal = buildProfileScoreObject(normalizedScoreByTotal, 'upper')
  const drawScoreByTotal = buildProfileScoreObject(normalizedScoreByTotal, 'draw')
  const baseTop3 = topTotalsFromScoreMap(new Map(Object.entries(normalizedScoreByTotal).map(([total, score]) => [Number(total), Number(score)])), () => true, 3)
  const diversifiedTop3 = diversifiedTopTotalsFromScoreMap(
    new Map(Object.entries(normalizedScoreByTotal).map(([total, score]) => [Number(total), Number(score)])),
    3,
  )
  const centerProfileTop3 = topTotalsFromScoreMap(new Map(Object.entries(centerScoreByTotal).map(([total, score]) => [Number(total), Number(score)])), () => true, 3)
  const edgeProfileTop3 = topTotalsFromScoreMap(new Map(Object.entries(edgeScoreByTotal).map(([total, score]) => [Number(total), Number(score)])), () => true, 3)
  const lowerProfileTop3 = topTotalsFromScoreMap(new Map(Object.entries(lowerScoreByTotal).map(([total, score]) => [Number(total), Number(score)])), () => true, 3)
  const upperProfileTop3 = topTotalsFromScoreMap(new Map(Object.entries(upperScoreByTotal).map(([total, score]) => [Number(total), Number(score)])), () => true, 3)
  const drawProfileTop3 = topTotalsFromScoreMap(new Map(Object.entries(drawScoreByTotal).map(([total, score]) => [Number(total), Number(score)])), () => true, 3)

  const strategies = [
    {
      id: `dynamic_followup_${roundsDesc?.[0]?.id || 'latest'}`,
      label: 'Dynamic Follow-up',
      totals: baseTop3.length === 3 ? baseTop3 : blendedTop3,
      result: dominantResultFromTotals(baseTop3.length === 3 ? baseTop3 : blendedTop3),
      regime: totalRegime((baseTop3.length === 3 ? baseTop3 : blendedTop3)[0]),
      dynamic: true,
      support: comboInsights.support + totalInsights.support + faceInsights.support,
      scoreByTotal: normalizedScoreByTotal,
    },
  ]

  if (diversifiedTop3.length === 3) {
    strategies.push({
      id: `dynamic_diversified_${roundsDesc?.[0]?.id || 'latest'}`,
      label: 'Dynamic Diversified',
      totals: diversifiedTop3,
      result: dominantResultFromTotals(diversifiedTop3),
      regime: totalRegime(diversifiedTop3[0]),
      dynamic: true,
      support: comboInsights.support + totalInsights.support + faceInsights.support + resultInsights.support,
      scoreByTotal: normalizedScoreByTotal,
    })
  }

  if (centerTop3.length === 3) {
    strategies.push({
      id: `dynamic_center_${roundsDesc?.[0]?.id || 'latest'}`,
      label: 'Dynamic Center Follow-up',
      totals: centerProfileTop3.length === 3 ? centerProfileTop3 : centerTop3,
      result: dominantResultFromTotals(centerProfileTop3.length === 3 ? centerProfileTop3 : centerTop3),
      regime: 'center',
      dynamic: true,
      support: comboInsights.support + totalInsights.support + faceInsights.support,
      scoreByTotal: centerScoreByTotal,
    })
  }

  if (edgeTop3.length === 3) {
    strategies.push({
      id: `dynamic_edge_${roundsDesc?.[0]?.id || 'latest'}`,
      label: 'Dynamic Edge Follow-up',
      totals: edgeProfileTop3.length === 3 ? edgeProfileTop3 : edgeTop3,
      result: dominantResultFromTotals(edgeProfileTop3.length === 3 ? edgeProfileTop3 : edgeTop3),
      regime: totalRegime((edgeProfileTop3.length === 3 ? edgeProfileTop3 : edgeTop3)[0]),
      dynamic: true,
      support: comboInsights.support + totalInsights.support + faceInsights.support,
      scoreByTotal: edgeScoreByTotal,
    })
  }

  if (lowerTop3.length === 3) {
    strategies.push({
      id: `dynamic_lower_${roundsDesc?.[0]?.id || 'latest'}`,
      label: 'Dynamic Lower Sweep',
      totals: lowerProfileTop3.length === 3 ? lowerProfileTop3 : lowerTop3,
      result: dominantResultFromTotals(lowerProfileTop3.length === 3 ? lowerProfileTop3 : lowerTop3),
      regime: 'lower',
      dynamic: true,
      support: comboInsights.support + totalInsights.support + faceInsights.support,
      scoreByTotal: lowerScoreByTotal,
    })
  }

  if (upperTop3.length === 3) {
    strategies.push({
      id: `dynamic_upper_${roundsDesc?.[0]?.id || 'latest'}`,
      label: 'Dynamic Upper Sweep',
      totals: upperProfileTop3.length === 3 ? upperProfileTop3 : upperTop3,
      result: dominantResultFromTotals(upperProfileTop3.length === 3 ? upperProfileTop3 : upperTop3),
      regime: 'upper',
      dynamic: true,
      support: comboInsights.support + totalInsights.support + faceInsights.support,
      scoreByTotal: upperScoreByTotal,
    })
  }

  if (drawProfileTop3.length === 3) {
    strategies.push({
      id: `dynamic_draw_${roundsDesc?.[0]?.id || 'latest'}`,
      label: 'Dynamic Draw Follow-up',
      totals: drawProfileTop3,
      result: dominantResultFromTotals(drawProfileTop3),
      regime: 'center',
      dynamic: true,
      support: comboInsights.support + totalInsights.support + faceInsights.support + resultInsights.support,
      scoreByTotal: drawScoreByTotal,
    })
  }

  return {
    strategies,
    insights: { comboInsights, totalInsights, faceInsights, resultInsights, rareBonusMap, temporalFlow, generated: true, rankedTotals: rankedTotals.slice(0, 10) },
  }
}

function evaluateStrategies(history, regimeBias, strategies = STRATEGIES) {
  const recent = history.slice(0, ADAPTIVE_WINDOW)
  const recentValidation = history.slice(0, RECENT_VALIDATION_WINDOW)
  return strategies.map((strategy) => {
    let hits = 0
    let weightedHits = 0
    let weightSum = 0
    let probabilityStrength = 0
    let probabilityWeightSum = 0
    const scoreByTotal = strategy?.scoreByTotal || {}
    const rankedTotals = Object.entries(scoreByTotal)
      .map(([total, score]) => ({ total: Number(total), score: Number(score) }))
      .filter((item) => Number.isFinite(item.total) && Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)
    const maxScore = rankedTotals[0]?.score || 1
    const topTotals = rankedTotals.slice(0, 3).map((item) => item.total)
    recent.forEach((item, index) => {
      const actualTotal = Number(item?.actualTotal)
      if (!Number.isFinite(actualTotal)) return
      const weight = 1 / (1 + index * 0.2)
      weightSum += weight
      const actualScore = Number(scoreByTotal[String(actualTotal)] || 0)
      const normalizedScore = maxScore ? actualScore / maxScore : 0
      probabilityStrength += normalizedScore * weight
      probabilityWeightSum += weight
      if (topTotals.includes(actualTotal)) {
        hits += 1
        weightedHits += weight
      }
    })
    const seen = recent.length
    const hitRate = seen ? hits / seen : 0
    const weightedHitRate = weightSum ? weightedHits / weightSum : 0
    const avgProbabilityStrength = probabilityWeightSum ? probabilityStrength / probabilityWeightSum : 0
    const recent2Hits = recentValidation.filter((item) => topTotals.includes(Number(item?.actualTotal))).length
    const recent2Misses = recentValidation.length - recent2Hits
    const recent2Rate = recentValidation.length ? recent2Hits / recentValidation.length : 0
    const spreadPenalty =
      topTotals.length === 3 &&
      Math.max(...topTotals) - Math.min(...topTotals) <= 2 &&
      recent2Hits <= recent2Misses
        ? 0.045
        : 0
    const qualificationBonus =
      recent2Hits === RECENT_VALIDATION_WINDOW
        ? 0.12
        : recent2Hits > recent2Misses
          ? 0.03
          : recentValidation.length
            ? -0.08
            : 0
    const score =
      weightedHitRate * 0.34 +
      hitRate * 0.14 +
      recent2Rate * 0.18 +
      avgProbabilityStrength * 0.16 +
      (regimeBias[strategy.regime] || 0) * 0.1 +
      qualificationBonus +
      Math.min(Number(strategy.support || 0) / 400, 0.08) -
      spreadPenalty
    return {
      ...strategy,
      seen,
      hits,
      hitRate,
      weightedHitRate,
      avgProbabilityStrength,
      recent2Hits,
      recent2Misses,
      recent2Rate,
      topTotals,
      score,
    }
  }).sort((a, b) => b.score - a.score)
}

function findClosestStrategy(history) {
  const latest = history[0]
  if (!latest || !Array.isArray(latest.predictedTotals)) return null
  const currentKey = totalsKey(latest.predictedTotals)
  return STRATEGIES.find((strategy) => totalsKey(strategy.totals) === currentKey) || null
}

function findTheoryFloorStrategy(strategyTable = []) {
  return (
    strategyTable.find((item) => item.id === 'center_soft') ||
    strategyTable.find((item) => item.id === 'center_draw') ||
    strategyTable[0] ||
    null
  )
}

function buildTopTotals(strategy, secondStrategy = null, history = [], options = {}) {
  const weights = new Map()
  const primaryScores = strategy?.scoreByTotal || null
  const recent = Array.isArray(history) ? history.slice(0, 6) : []
  const temporalFlow = options?.temporalFlow || null
  const exposureSignals = buildPredictionExposureSignals(history)

  const addWeight = (total, value) => {
    if (!Number.isFinite(Number(total)) || !Number.isFinite(Number(value)) || Number(value) <= 0) return
    weights.set(Number(total), (weights.get(Number(total)) || 0) + Number(value))
  }

  const applyFactor = (total, factor) => {
    if (!Number.isFinite(Number(total)) || !Number.isFinite(Number(factor))) return
    if (!weights.has(Number(total))) return
    weights.set(
      Number(total),
      Math.max(0.000001, Number(weights.get(Number(total)) || 0) * Number(factor)),
    )
  }

  if (primaryScores) {
    Object.entries(primaryScores)
      .map(([total, score]) => ({ total: Number(total), score: Number(score) }))
      .filter((item) => Number.isFinite(item.total) && Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .forEach((item, index) => {
        addWeight(item.total, item.score * Math.max(0.42, 1 - index * 0.1))
      })
  }

  strategy.totals.forEach((total, index) => {
    const dynamicWeight = primaryScores?.[String(total)]
    addWeight(total, Number.isFinite(dynamicWeight) ? dynamicWeight * 0.75 : 0.46 - index * 0.08)
  })

  if (secondStrategy) {
    const secondaryScores = secondStrategy?.scoreByTotal || null
    if (secondaryScores) {
      Object.entries(secondaryScores)
        .map(([total, score]) => ({ total: Number(total), score: Number(score) }))
        .filter((item) => Number.isFinite(item.total) && Number.isFinite(item.score))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .forEach((item, index) => {
          addWeight(item.total, item.score * Math.max(0.18, 0.4 - index * 0.06))
        })
    }
    secondStrategy.totals.forEach((total, index) => {
      const fallbackWeight = Number.isFinite(secondaryScores?.[String(total)]) ? secondaryScores[String(total)] * 0.35 : 0.16 - index * 0.03
      addWeight(total, fallbackWeight)
    })
  }

  recent.forEach((item, index) => {
    const actualTotal = Number(item?.actualTotal)
    if (!Number.isFinite(actualTotal)) return
    const baseWeight = 0.08 / (1 + index * 0.55)
    if (item?.hit === false) {
      addWeight(actualTotal, baseWeight)
      if (actualTotal === 10 || actualTotal === 11) addWeight(actualTotal, 0.028)
      if (actualTotal <= 5 || actualTotal >= 15) addWeight(actualTotal, 0.022)
    } else {
      addWeight(actualTotal, baseWeight * 0.28)
    }
  })

  const recentActualTotals = recent
    .map((item) => Number(item?.actualTotal))
    .filter(Number.isFinite)
  const latestResult = temporalFlow?.summary?.anchors?.latestResult || null
  const lowerPressure = recentActualTotals.filter((total) => total <= 8).length
  const upperPressure = recentActualTotals.filter((total) => total >= 13).length
  const centerPressure = recentActualTotals.filter((total) => total >= 9 && total <= 12).length

  if (lowerPressure >= 2) [8, 7, 9, 6, 5].forEach((total, index) => addWeight(total, 0.055 - index * 0.008))
  if (upperPressure >= 2) [13, 14, 15, 16, 12, 17].forEach((total, index) => addWeight(total, 0.055 - index * 0.008))
  if (centerPressure >= 2) {
    const centerTargets =
      latestResult === 'Draw' ? [8, 9, 12, 13] : [10, 11, 9, 12]
    centerTargets.forEach((total, index) => addWeight(total, 0.05 - index * 0.007))
  }

  ;(temporalFlow?.components?.resultStreak?.topTotals || [])
    .slice(0, 4)
    .forEach((item, index) => {
      addWeight(
        Number(item?.total),
        Number(item?.probability || 0) * Math.max(0.18, 0.42 - index * 0.05),
      )
    })

  ;(temporalFlow?.components?.regimeStreak?.topTotals || [])
    .slice(0, 4)
    .forEach((item, index) => {
      addWeight(
        Number(item?.total),
        Number(item?.probability || 0) * Math.max(0.12, 0.28 - index * 0.035),
      )
    })

  for (let total = 3; total <= 18; total += 1) {
    const cooldown = Number(exposureSignals.cooldownByTotal.get(total) || 0)
    if (cooldown > 0) {
      applyFactor(total, 1 - cooldown)
    }
  }

  applyLatestDrawAndRecoveryBias(weights, history, temporalFlow)

  const selectedTotals = buildCoverageAwareTrio(
    weights,
    history,
    strategy?.regime || 'center',
    {
      exposureSignals,
      jumpTotals: new Set(
        (temporalFlow?.components?.resultStreak?.topTotals || [])
          .slice(0, 4)
          .map((item) => Number(item?.total))
          .filter(Number.isFinite),
      ),
      holdTotals: new Set(
        (temporalFlow?.components?.regimeStreak?.topTotals || [])
          .slice(0, 4)
          .map((item) => Number(item?.total))
          .filter(Number.isFinite),
      ),
      resultStreak: temporalFlow?.summary?.resultStreak || null,
    },
  )

  const sum = [...weights.values()].reduce((acc, value) => acc + value, 0) || 1
  return [...weights.entries()]
    .map(([total, weight]) => ({
      total,
      result: classifyTotal(total),
      probability: roundNumber(weight / sum),
      score: roundNumber((weight / sum) * 100, 4),
      sources: [
        {
          source: 'v9-adaptive',
          probability: roundNumber(weight / sum),
          support: 0,
        },
      ],
    }))
    .sort((a, b) => {
      const aSelected = selectedTotals.includes(a.total) ? 1 : 0
      const bSelected = selectedTotals.includes(b.total) ? 1 : 0
      if (aSelected !== bSelected) return bSelected - aSelected
      return b.probability - a.probability
    })
}

function simulateAdaptiveLedger(historyNewestFirst) {
  const chronological = [...historyNewestFirst].reverse()
  const simulatedNewest = []
  const rows = []
  let currentStrategyId = null

  chronological.forEach((item) => {
    const roundsForBias = simulatedNewest.map((entry) => ({ total: entry.actualTotal }))
    const regimeBias = recentRegimeBias(roundsForBias)
    const strategyTable = evaluateStrategies(simulatedNewest.slice(0, ADAPTIVE_WINDOW), regimeBias)
    const bestStrategy = strategyTable[0] || {
      ...STRATEGIES[0],
      hitRate: 0,
      weightedHitRate: 0,
      score: 0,
    }
    const theoryFloorStrategy = findTheoryFloorStrategy(strategyTable) || bestStrategy
    const fallbackStrategy = strategyTable[1] || {
      ...STRATEGIES[1],
      hitRate: 0,
      weightedHitRate: 0,
      score: 0,
    }
    const currentStats = strategyTable.find((entry) => entry.id === currentStrategyId) || bestStrategy
    const missStreak = rows.slice(-2).filter((entry) => entry && entry.hit === false).length

    let selectedStrategy = currentStats
    let tuneReason = 'giu chien luoc hien tai'
    if (missStreak >= 2 || currentStats.hitRate < 0.5 || bestStrategy.score > currentStats.score + 0.05) {
      selectedStrategy = bestStrategy
      tuneReason =
        missStreak >= 2
          ? 'retune sau 2 ky lien tiep truot'
          : currentStats.hitRate < 0.5
            ? 'hit rate hien tai thap hon hit rate truot'
            : 'co chien luoc khac dang vuot roi hon'
    }

    if (
      theoryFloorStrategy &&
      (
        selectedStrategy.hitRate < 0.34 ||
        (
          selectedStrategy.hitRate < theoryFloorStrategy.hitRate &&
          selectedStrategy.recent2Hits <= theoryFloorStrategy.recent2Hits
        ) ||
        (
          selectedStrategy.dynamic &&
          selectedStrategy.hitRate <= theoryFloorStrategy.hitRate + 0.02 &&
          selectedStrategy.recent2Hits <= theoryFloorStrategy.recent2Hits &&
          selectedStrategy.score <= theoryFloorStrategy.score + 0.015
        )
      )
    ) {
      selectedStrategy = theoryFloorStrategy
      tuneReason = 'quay ve baseline trung tam vi adaptive dang thua floor'
    }

    const topTotals = buildTopTotals(selectedStrategy, fallbackStrategy, simulatedNewest).slice(0, 3)
    const actualTotal = Number(item?.actualTotal)
    const hit = Number.isFinite(actualTotal)
      ? topTotals.some((entry) => Number(entry.total) === actualTotal)
      : false

    const simulatedRow = {
      id: String(item?.id || ''),
      predictedTotals: topTotals.map((entry) => Number(entry.total)),
      actualTotal,
      actualResult: classifyTotal(actualTotal),
      hit,
      strategyId: selectedStrategy.id,
      strategyLabel: selectedStrategy.label,
      tuneReason,
      missStreak,
    }

    rows.push(simulatedRow)
    simulatedNewest.unshift(simulatedRow)
    currentStrategyId = selectedStrategy.id
  })

  return {
    rowsNewestFirst: rows.slice().reverse(),
    latestStrategyId: currentStrategyId,
  }
}

function normalizeV9HistoryEntry(item) {
  if (!item || typeof item !== 'object') return null
  const predictedTotals = Array.isArray(item.predictedTotals) ? item.predictedTotals.map(Number).filter(Number.isFinite).slice(0, 3) : []
  const actualTotal = Number(item.actualTotal)
  if (!predictedTotals.length || !Number.isFinite(actualTotal)) return null
  return {
    id: String(item.roundId || item.id || ''),
    predictedTotals,
    actualTotal,
    actualResult: String(item.actualResult || classifyTotal(actualTotal)),
    hit: typeof item.hit === 'boolean' ? item.hit : predictedTotals.includes(actualTotal),
    strategyId: item.strategyId || null,
    strategyLabel: item.strategyLabel || null,
  }
}

function readAdaptiveHistory() {
  const v9Memory = readV9Memory()
  const v9History = Array.isArray(v9Memory.history)
    ? v9Memory.history.map(normalizeV9HistoryEntry).filter(Boolean)
    : []
  const recentV9 = v9History.slice(0, ADAPTIVE_WINDOW)
  const recentV9HitRate = recentV9.length
    ? recentV9.filter((item) => item.hit).length / recentV9.length
    : 0
  const recentV9Misses = recentV9.filter((item) => item.hit === false).length

  if (
    v9History.length >= RECENT_CHECK_ROWS &&
    recentV9.length >= RECENT_CHECK_ROWS &&
    recentV9HitRate >= 0.34 &&
    recentV9Misses <= Math.ceil(recentV9.length * 0.66)
  ) {
    return {
      latestRoundId: v9Memory.latestRoundId,
      fullHistory: v9History,
      source: 'v9_memory',
    }
  }

  const consensusMemory = readConsensusMemory()
  const consensusHistory = Array.isArray(consensusMemory.allTotalChecks)
    ? consensusMemory.allTotalChecks
        .map(normalizeV9HistoryEntry)
        .filter(Boolean)
    : []

  return {
    latestRoundId: consensusMemory.latestRoundId,
    fullHistory: consensusHistory,
    source: 'consensus_memory',
  }
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

  const adaptiveHistory = readAdaptiveHistory()
  const fullHistory = Array.isArray(adaptiveHistory.fullHistory)
    ? adaptiveHistory.fullHistory
    : []
  const simulationHistory = fullHistory.slice(0, LEDGER_SIMULATION_WINDOW)
  const history = simulationHistory.slice(0, ADAPTIVE_WINDOW)
  const simulation = simulateAdaptiveLedger(simulationHistory)
  const regimeBias = recentRegimeBias(roundsDesc)
  const temporalFlow = buildTemporalFlowBundle(roundsDesc)
  const dynamicBundle = buildDynamicStrategies(roundsDesc, temporalFlow)
  const materializedBaseStrategies = STRATEGIES.map((strategy) => materializeStrategy(strategy, dynamicBundle.insights))
  const candidateStrategies = [...materializedBaseStrategies, ...dynamicBundle.strategies]
  const strategyTable = evaluateStrategies(history, regimeBias, candidateStrategies)
  const bestStrategy = strategyTable[0] || {
    ...STRATEGIES[0],
    hitRate: 0,
    weightedHitRate: 0,
    score: 0,
  }
  const theoryFloorStrategy = findTheoryFloorStrategy(strategyTable) || bestStrategy
  const fallbackStrategy = strategyTable[1] || {
    ...STRATEGIES[1],
    hitRate: 0,
    weightedHitRate: 0,
    score: 0,
  }
  const currentStrategySeed =
    strategyTable.find((item) => item.id === simulation.latestStrategyId) ||
    findClosestStrategy(history) ||
    bestStrategy
  const missStreak = history.slice(0, 2).filter((item) => item && item.hit === false).length
  const currentStats = strategyTable.find((item) => item.id === currentStrategySeed.id) || bestStrategy

  let selectedStrategy = currentStats
  let tuneReason = 'giu chien luoc hien tai'
  if (
    missStreak >= 2 ||
    currentStats.hitRate < 0.5 ||
    currentStats.recent2Hits <= currentStats.recent2Misses ||
    bestStrategy.score > currentStats.score + 0.05
  ) {
    selectedStrategy = bestStrategy
    tuneReason =
      missStreak >= 2
        ? 'retune sau 2 ky lien tiep truot'
        : currentStats.hitRate < 0.5
          ? 'hit rate hien tai thap hon hit rate truot'
          : currentStats.recent2Hits <= currentStats.recent2Misses
            ? '2 ky kiem dinh gan nhat khong con nghieng ve phia trung'
            : 'co chien luoc khac dang vuot roi hon'
  }

  if (
    theoryFloorStrategy &&
    (
      selectedStrategy.hitRate < 0.34 ||
      (
        selectedStrategy.hitRate < theoryFloorStrategy.hitRate &&
        selectedStrategy.recent2Hits <= theoryFloorStrategy.recent2Hits
      ) ||
      (
        selectedStrategy.dynamic &&
        selectedStrategy.hitRate <= theoryFloorStrategy.hitRate + 0.02 &&
        selectedStrategy.recent2Hits <= theoryFloorStrategy.recent2Hits &&
        selectedStrategy.score <= theoryFloorStrategy.score + 0.015
      )
    )
  ) {
    selectedStrategy = theoryFloorStrategy
    tuneReason = 'quay ve baseline trung tam vi adaptive dang thua floor'
  }

  const rareBonusMap = dynamicBundle.insights?.rareBonusMap || {}
  const topTotals = buildTopTotals(
    selectedStrategy,
    fallbackStrategy,
    history,
    { temporalFlow },
  ).slice(0, 4)
  const selectedScoreByTotal = selectedStrategy?.scoreByTotal || {}
  const totalDistribution = Array.from({ length: 16 }, (_, index) => index + 3)
    .map((total) => ({
      total,
      result: classifyTotal(total),
      score:
        Number(selectedScoreByTotal[String(total)] || 0) * 0.84 +
        Number(temporalFlow?.scoreByTotal?.[String(total)] || 0) * 0.16,
      rareBonus: Number(rareBonusMap[total] || 0),
    }))
    .sort((a, b) => b.score - a.score)
  const totalDistributionSum =
    totalDistribution.reduce((acc, item) => acc + item.score, 0) || 1
  totalDistribution.forEach((item) => {
    item.probability = roundNumber(item.score / totalDistributionSum)
    item.score = roundNumber(item.score, 8)
    item.rareBonus = roundNumber(item.rareBonus, 8)
  })
  const temporalLeadProbability = Number(temporalFlow?.topTotals?.[0]?.probability || 0)
  const temporalSecondProbability = Number(
    temporalFlow?.topTotals?.[1]?.probability || 0,
  )
  const topProbability = clamp(
    selectedStrategy.weightedHitRate * 0.58 +
      selectedStrategy.hitRate * 0.22 +
      temporalLeadProbability * 0.2,
    0.33,
    0.7,
  )
  const secondProbability = clamp(
    fallbackStrategy.weightedHitRate * 0.46 +
      fallbackStrategy.hitRate * 0.18 +
      temporalSecondProbability * 0.36,
    0.22,
    0.6,
  )
  const spread = clamp(topProbability - secondProbability, 0.01, 0.3)
  const temporalTop3 = (temporalFlow?.topTotals || [])
    .slice(0, 3)
    .map((item) => Number(item?.total))
    .filter(Number.isFinite)
  const temporalAlignment = topTotals
    .slice(0, 3)
    .filter((item) => temporalTop3.includes(Number(item.total))).length
  const resultProbabilities = buildFinalResultProbabilities(
    selectedStrategy,
    topProbability,
    temporalFlow,
    topTotals.slice(0, 3).map((item) => Number(item.total)),
  )
  const recommendedResult = RESULT_ORDER.slice().sort(
    (left, right) => resultProbabilities[right] - resultProbabilities[left],
  )[0]
  const shouldBet =
    selectedStrategy.hitRate >= 0.46 &&
    selectedStrategy.recent2Hits >= selectedStrategy.recent2Misses &&
    missStreak < 2 &&
    (
      temporalAlignment >= 1 ||
      recommendedResult === selectedStrategy.result ||
      topProbability >= 0.56
    )

  return {
    methodology: {
      note: 'V9 khong con chi doc ledger 14 ky. No nay da them temporal flow: nhac trong ngay, 50 ky gan nhat, chuyen tiep sau tong moi nhat, chuyen tiep sau ket qua moi nhat, va vi tri hien tai trong ngay de retune Top 3 sau moi ky.',
      model: { id: 'predictor_v9', label: 'Adaptive Ledger V9' },
      adaptive: {
        currentStrategy: currentStats.id,
        selectedStrategy: selectedStrategy.id,
        selectedLabel: selectedStrategy.label,
        tuneReason,
        missStreak,
        memorySamples: history.length,
        adaptiveWindow: ADAPTIVE_WINDOW,
        regimeBias: {
          center: roundNumber(regimeBias.center * 100, 4),
          upper: roundNumber(regimeBias.upper * 100, 4),
          lower: roundNumber(regimeBias.lower * 100, 4),
        },
        strategyTable: strategyTable.slice(0, 6).map((item) => ({
          id: item.id,
          label: item.label,
          totals: item.totals,
          hitRate: roundNumber(item.hitRate * 100, 4),
          weightedHitRate: roundNumber(item.weightedHitRate * 100, 4),
          recent2: `${item.recent2Hits}/${RECENT_VALIDATION_WINDOW}`,
          score: roundNumber(item.score * 100, 4),
          dynamic: Boolean(item.dynamic),
        })),
        dynamicStrategies: dynamicBundle.strategies.map((item) => ({
          id: item.id,
          label: item.label,
          totals: item.totals,
          support: item.support || 0,
        })),
        rareBonusMap,
      },
      temporal: {
        primaryProfile: temporalFlow?.profile?.label || null,
        latestDayKey: temporalFlow?.latestDayKey || null,
        dayRounds: temporalFlow?.summary?.dayRounds || 0,
        slotIndex: temporalFlow?.summary?.slotIndex || 0,
        regimeBias: temporalFlow?.summary?.regimeBias || null,
        topTotals: (temporalFlow?.topTotals || []).slice(0, 3),
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
      ledgerRounds: fullHistory.length,
      adaptiveWindow: ADAPTIVE_WINDOW,
      latestLedgerRound: adaptiveHistory.latestRoundId,
      nextRoundId: nextRoundIdFromValue(adaptiveHistory.latestRoundId),
      adaptiveMemorySource: adaptiveHistory.source,
      latestTemporalDay: temporalFlow?.latestDayKey || null,
    },
    diagnosis: {
      mostLikelyResult: recommendedResult,
      resultProbabilities,
      topTotals,
      confidenceModel: {
        topProbability: roundNumber(topProbability),
        topGap: roundNumber(spread),
        confidenceScore: roundNumber(topProbability * 100, 4),
      },
      totalDistribution,
      temporalFlow: {
        profile: temporalFlow?.profile?.label || null,
        topTotals: (temporalFlow?.topTotals || []).slice(0, 4),
        dayTopTotals: temporalFlow?.components?.day?.topTotals?.slice(0, 3) || [],
        recent50TopTotals:
          temporalFlow?.components?.recent50?.topTotals?.slice(0, 3) || [],
        afterResultTopTotals:
          temporalFlow?.components?.afterResult?.topTotals?.slice(0, 3) || [],
      },
      recommendations: {
        recommendationText: `V9 dang dung ${selectedStrategy.label} va doi chieu them ${temporalFlow?.profile?.label || 'Temporal Flow'}, uu tien ${topTotals.slice(0, 3).map((item) => item.total).join(', ')}.`,
        primaryMethod: 'Adaptive ledger + temporal flow',
        methodNotes: [
          `Adaptive window: ${ADAPTIVE_WINDOW} ky truoc`,
          `Recent validation: ${selectedStrategy.recent2Hits}/${RECENT_VALIDATION_WINDOW} ky gan nhat`,
          `Tune reason: ${tuneReason}`,
          `Current strategy hit-rate: ${roundNumber(currentStats.hitRate * 100, 4)}%`,
          `Selected strategy hit-rate: ${roundNumber(selectedStrategy.hitRate * 100, 4)}%`,
          `Temporal profile: ${temporalFlow?.profile?.label || '--'}`,
          `Temporal day rounds: ${temporalFlow?.summary?.dayRounds || 0}`,
          `Temporal alignment: ${temporalAlignment}/3`,
        ],
      },
    },
    selectiveStrategy: {
      currentDecision: {
        decision: shouldBet ? 'BET' : 'SKIP',
        shouldBet,
        recommendedResult,
        recommendedTotals: topTotals.slice(0, 3),
        topProbability: roundNumber(topProbability),
        topSpread: roundNumber(spread),
        summary: `V9 ${shouldBet ? 'vao lenh' : 'tam skip'} theo ${selectedStrategy.label}, doi chieu ${temporalFlow?.profile?.label || 'Temporal Flow'} va giu ${temporalAlignment}/3 tong giao nhau.`,
        gateChecks: [
          {
            label: 'Selected hit-rate',
            pass: selectedStrategy.hitRate >= 0.46,
            value: roundNumber(selectedStrategy.hitRate * 100, 4),
            threshold: 46,
          },
          {
            label: 'Miss streak',
            pass: missStreak < 2,
            value: missStreak,
            threshold: 1,
          },
          {
            label: 'Recent 2 validation',
            pass: selectedStrategy.recent2Hits >= selectedStrategy.recent2Misses,
            value: selectedStrategy.recent2Hits,
            threshold: 1,
          },
          {
            label: 'Temporal alignment',
            pass: temporalAlignment >= 1,
            value: temporalAlignment,
            threshold: 1,
          },
        ],
      },
      backtest: {
        sampleSize: history.length,
        hitRate: roundNumber(selectedStrategy.hitRate * 100, 4),
        weightedHitRate: roundNumber(selectedStrategy.weightedHitRate * 100, 4),
        recent2Hits: selectedStrategy.recent2Hits,
        recent2Misses: selectedStrategy.recent2Misses,
        missStreak,
        temporalAlignment,
        totalHitRate: roundNumber(
          simulation.rowsNewestFirst.length
            ? (simulation.rowsNewestFirst.filter((item) => item.hit).length / simulation.rowsNewestFirst.length) * 100
            : 0,
          4,
        ),
        recentTotalChecks: simulation.rowsNewestFirst.slice(0, RECENT_CHECK_ROWS),
      },
    },
  }
}
