import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { buildPrediction as buildPredictionV1 } from './predictor.js'
import { buildPredictionFromBase } from './predictor_v2.js'
import { buildPrediction as buildPredictionV3 } from './predictor_v3.js'
import { buildPrediction as buildPredictionV4 } from './predictor_v4.js'
import { buildPrediction as buildPredictionV5 } from './predictor_v5.js'
import { buildPrediction as buildPredictionV6 } from './predictor_v6.js'
import { adaptPredictionPayload } from './prediction_postprocessor.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data.json')
const MEMORY_FILE = process.env.CONSENSUS_V16_AI_MEMORY_FILE
  ? path.resolve(process.env.CONSENSUS_V16_AI_MEMORY_FILE)
  : path.join(__dirname, 'consensus-v16-ai-memory.json')

function classifyTotal(total) {
  if (total >= 12) return 'Big'
  if (total >= 10) return 'Draw'
  return 'Small'
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.rounds) ? parsed.rounds : []
  } catch {
    return []
  }
}

function isDateOnlyValue(value) {
  return typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value)
}

function extractId(round, time, dice) {
  return `${time}-${dice.join('')}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeStoredRound(round) {
  if (!round || typeof round !== 'object') return null

  const dice = Array.isArray(round.dice)
    ? round.dice.map(Number).filter(Number.isFinite)
    : []
  if (dice.length !== 3) return null

  const sourceDate =
    round.sourceDate ?? (isDateOnlyValue(round.time) ? round.time : null)
  const processTime =
    round.processTime ?? (isDateOnlyValue(round.time) ? null : round.time)
  const rawSourceTime = round.rawSourceTime ?? sourceDate ?? round.time ?? null
  const time =
    round.time ?? processTime ?? sourceDate ?? new Date().toISOString()
  const total = Number(round.total) || dice.reduce((a, b) => a + b, 0)

  return {
    id: String(round.id ?? extractId(round, time, dice)),
    time,
    sourceDate,
    processTime,
    rawSourceTime: rawSourceTime != null ? String(rawSourceTime) : null,
    dice,
    total,
    result: classifyTotal(total),
  }
}

function normalizeStoredRounds(rounds) {
  return rounds.map(normalizeStoredRound).filter(Boolean)
}

function normalizeUnitProbability(value, fallback = 0) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return numeric > 1 ? numeric / 100 : numeric
}

function topTotalsFromPayload(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const fromCurrent = Array.isArray(current.recommendedTotals)
    ? current.recommendedTotals
    : []
  const fromDiagnosis = Array.isArray(payload?.diagnosis?.topTotals)
    ? payload.diagnosis.topTotals
    : []
  const list = fromCurrent.length ? fromCurrent : fromDiagnosis
  return list
    .map((item, index) => ({
      total: Number(item?.total),
      probability: normalizeUnitProbability(
        item?.probability ?? item?.score,
        Math.max(0.06, 0.18 - index * 0.025),
      ),
    }))
    .filter((item) => Number.isFinite(item.total))
}

function resultFromPayload(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  return (
    current.recommendedResult ||
    diagnosis.mostLikelyResult ||
    diagnosis.recommendedResult ||
    'Draw'
  )
}

function decisionFromPayload(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  if (current.decision) return current.decision
  return current.shouldBet ? 'BET' : 'SKIP'
}

function summaryFromPayload(payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  const recommendations = diagnosis?.recommendations
  if (typeof current.summary === 'string' && current.summary.trim()) return current.summary
  if (
    recommendations &&
    typeof recommendations === 'object' &&
    typeof recommendations.recommendationText === 'string' &&
    recommendations.recommendationText.trim()
  ) {
    return recommendations.recommendationText
  }
  if (Array.isArray(recommendations) && typeof recommendations[0] === 'string') {
    return recommendations[0]
  }
  if (typeof diagnosis.primaryMethod === 'string' && diagnosis.primaryMethod.trim()) {
    return diagnosis.primaryMethod
  }
  if (Array.isArray(diagnosis.methodNotes) && typeof diagnosis.methodNotes[0] === 'string') {
    return diagnosis.methodNotes[0]
  }
  if (typeof current.rationale === 'string' && current.rationale.trim()) return current.rationale
  return '--'
}

function modelViewFromPayload(name, payload) {
  const current = payload?.selectiveStrategy?.currentDecision || {}
  const diagnosis = payload?.diagnosis || {}
  return {
    name,
    result: resultFromPayload(payload),
    decision: decisionFromPayload(payload),
    summary: summaryFromPayload(payload),
    totals: topTotalsFromPayload(payload),
    topProbability: normalizeUnitProbability(
      current.topProbability ?? diagnosis?.confidenceModel?.topProbability,
      0.15,
    ),
  }
}

function buildConsensusSnapshotFromPredictions(predictions) {
  const roles = {
    V1: { label: 'Chuyên số', cls: 'number' },
    V2: { label: 'Chuyên số', cls: 'number' },
    V3: { label: 'Chuyên số', cls: 'number' },
    V4: { label: 'Chuyên cửa', cls: 'result' },
    V5: { label: 'Chuyên cửa', cls: 'result' },
    V6: { label: 'AI meta', cls: 'ai' },
  }
  const models = [
    { name: 'V1', payload: predictions.v1 },
    { name: 'V2', payload: predictions.v2 },
    { name: 'V3', payload: predictions.v3 },
    { name: 'V4', payload: predictions.v4 },
    { name: 'V5', payload: predictions.v5 },
    { name: 'V6', payload: predictions.v6 },
  ].map(({ name, payload }) => ({
    ...modelViewFromPayload(name, payload),
    role: roles[name],
    rawPayload: payload
  }))

  const totalScores = new Map()
  const totalVotes = new Map()
  
  // Extract Avoidance lists from V1-V3
  const mergedAvoidance = new Map()
  for (const model of models.filter(m => ['V1', 'V2', 'V3'].includes(m.name))) {
    const list = Array.isArray(model.rawPayload?.totalsToAvoid) ? model.rawPayload.totalsToAvoid : []
    for (const item of list) {
      if (!mergedAvoidance.has(item.total)) {
        mergedAvoidance.set(item.total, { ...item, voteCount: 1 })
      } else {
        mergedAvoidance.get(item.total).voteCount++
        if (item.severity === 'HIGH') mergedAvoidance.get(item.total).severity = 'HIGH'
      }
    }
  }
  const totalsToAvoid = Array.from(mergedAvoidance.values()).sort((a,b) => b.voteCount - a.voteCount)

  const v6Model = models.find(m => m.name === 'V6')
  const v6Decision = v6Model?.decision === 'BET' ? 'BET' : 'SKIP'
  
  for (const model of models) {
    model.totals.slice(0, 4).forEach((item, index) => {
      const total = Number(item.total)
      if (!Number.isFinite(total)) return
      
      // Strict penalty if total is in HIGH severity avoidance list
      const avoidance = mergedAvoidance.get(total)
      if (avoidance && avoidance.severity === 'HIGH') return // Ignore this total completely
      
      const baseWeight = Math.max(0.02, item.probability)
      const rankWeight = index === 0 ? 1 : index === 1 ? 0.75 : index === 2 ? 0.55 : 0.35
      const modelWeight = model.name === 'V6' ? 1.4 : 1
      
      // If V6 says SKIP, reduce all V1-V5 weights to prevent Fake Consensus
      const consensusPenalty = (v6Decision === 'SKIP' && model.name !== 'V6') ? 0.6 : 1
      
      totalScores.set(total, (totalScores.get(total) || 0) + baseWeight * rankWeight * modelWeight * consensusPenalty)
      if (!totalVotes.has(total)) totalVotes.set(total, [])
      totalVotes.get(total).push(model.name)
    })
  }

  const totalDenominator = Array.from(totalScores.values()).reduce((sum, value) => sum + value, 0) || 1
  let topTotals = Array.from(totalScores.entries())
    .map(([total, score]) => ({
      total: Number(total),
      normalized: score / totalDenominator,
      votes: totalVotes.get(total) || [],
    }))
    .sort((a, b) => b.normalized - a.normalized)
    
  // Post-Council Diversity Rule: Top 3 must not be entirely Central numbers
  const top3 = topTotals.slice(0, 3)
  const allCenters = top3.every(t => t.total >= 9 && t.total <= 12)
  if (allCenters && topTotals.length > 3) {
    const edgeIndex = topTotals.findIndex(t => t.total <= 8 || t.total >= 13)
    if (edgeIndex > 0) {
      // Swap the 3rd center with the highest ranked edge
      const temp = topTotals[2]
      topTotals[2] = topTotals[edgeIndex]
      topTotals[edgeIndex] = temp
      // Re-sort after slice(3) to keep others in order
      const remaining = topTotals.slice(3).sort((a,b) => b.normalized - a.normalized)
      topTotals = [...topTotals.slice(0,3), ...remaining]
    }
  }

  return { 
    models, 
    topTotals, 
    totalsToAvoid,
    councilDecision: v6Decision === 'BET' ? 'BET' : 'ABSTAIN_VETO' 
  }
}

function buildRecentMemory() {
  const roundsDesc = normalizeStoredRounds(readData())
  let existing = []
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    existing = Array.isArray(parsed?.allTotalChecks)
      ? parsed.allTotalChecks
      : Array.isArray(parsed?.recentTotalChecks)
        ? parsed.recentTotalChecks
        : []
  } catch {
    existing = []
  }
  const existingMap = new Map(existing.map((item) => [String(item?.id || ''), item]))
  const maxEval = Math.max(0, roundsDesc.length - 900)
  const evalRounds = Math.min(7, maxEval)
  const trainWindow = 1800
  const recentTotalChecks = []
  let totalHits = 0

  for (let offset = evalRounds; offset >= 1; offset -= 1) {
    const actualRound = roundsDesc[offset - 1]
    const existingItem = existingMap.get(String(actualRound?.id || ''))
    if (existingItem) {
      recentTotalChecks.push(existingItem)
      if (existingItem.hit) totalHits += 1
      continue
    }
    const trainRounds = roundsDesc.slice(offset, offset + trainWindow)
    if (!actualRound || trainRounds.length < 900) continue

    const rawV1 = buildPredictionV1(trainRounds)
    const rawV2 = buildPredictionFromBase(rawV1)
    const rawV3 = buildPredictionV3(trainRounds)
    const rawV4 = buildPredictionV4(trainRounds)
    const rawV5 = buildPredictionV5(trainRounds)
    const rawV6 = buildPredictionV6(trainRounds)
    const v1 = adaptPredictionPayload(rawV1, trainRounds, { modelId: 'v1' })
    const v2 = adaptPredictionPayload(rawV2, trainRounds, { modelId: 'v2' })
    const v3 = adaptPredictionPayload(rawV3, trainRounds, { modelId: 'v3' })
    const v4 = adaptPredictionPayload(rawV4, trainRounds, { modelId: 'v4' })
    const v5 = adaptPredictionPayload(rawV5, trainRounds, { modelId: 'v5' })
    const v6 = adaptPredictionPayload(rawV6, trainRounds, { modelId: 'v6' })
    const snapshot = buildConsensusSnapshotFromPredictions({ v1, v2, v3, v4, v5, v6 })
    const predictedTotals = snapshot.topTotals.slice(0, 3).map((item) => Number(item.total))
    const hit = predictedTotals.includes(Number(actualRound.total))
    if (hit) totalHits += 1

    recentTotalChecks.push({
      id: actualRound.id,
      predictedTotals,
      actualTotal: Number(actualRound.total),
      actualResult: actualRound.result,
      hit,
      councilDecision: snapshot.councilDecision,
      leadTotal: snapshot.topTotals[0]?.total ?? null,
      leadProbability: snapshot.topTotals[0]
        ? Number((snapshot.topTotals[0].normalized * 100).toFixed(2))
        : 0,
      totalsToAvoid: snapshot.totalsToAvoid,
    })
  }

  const orderedChecks = recentTotalChecks.slice().reverse()
  return {
    createdAt: new Date().toISOString(),
    latestRoundId: roundsDesc[0]?.id ?? null,
    sampleSize: orderedChecks.length,
    totalHitRate: orderedChecks.length ? totalHits / orderedChecks.length : 0,
    allTotalChecks: orderedChecks,
    recentTotalChecks: orderedChecks.slice(0, 7),
  }
}

try {
  const payload = buildRecentMemory()
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(payload, null, 2), 'utf8')
  if (process.send) process.send({ ok: true, payload })
  process.exit(0)
} catch (error) {
  if (process.send) process.send({ ok: false, error: error.message })
  process.exit(1)
}
