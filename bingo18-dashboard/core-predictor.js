const DEFAULT_OPTIONS = {
  includeHourFeatures: false,
  selective: true,
  contextDepth: 3,
  includeBacktest: false,
};

const DRAW_TOTALS = new Set([10, 11]);
const RESULT_ORDER = ["Big", "Small", "Draw"];
const TOTAL_MIN = 3;
const TOTAL_MAX = 18;

function sumDice(dice) {
  return dice.reduce((sum, value) => sum + value, 0);
}

function classifyTotal(total) {
  if (DRAW_TOTALS.has(total)) return "Draw";
  return total >= 12 ? "Big" : "Small";
}

function normalizeMap(input, keys) {
  const output = {};
  let total = 0;
  for (const key of keys) {
    const value = Number(input[key] || 0);
    output[key] = value;
    total += value;
  }
  if (total <= 0) {
    const fallback = 1 / keys.length;
    for (const key of keys) output[key] = fallback;
    return output;
  }
  for (const key of keys) output[key] /= total;
  return output;
}

function blendDistributions(parts, keys) {
  const merged = {};
  for (const key of keys) merged[key] = 0;
  let totalWeight = 0;
  for (const part of parts) {
    if (!part || !part.weight || !part.dist) continue;
    totalWeight += part.weight;
    for (const key of keys) {
      merged[key] += (part.dist[key] || 0) * part.weight;
    }
  }
  if (totalWeight <= 0) {
    return normalizeMap({}, keys);
  }
  for (const key of keys) merged[key] /= totalWeight;
  return normalizeMap(merged, keys);
}

function topEntries(dist, count) {
  return Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, probability]) => ({ key, probability }));
}

function safeDateKey(value) {
  if (!value) return "";
  if (typeof value === "string" && value.includes("/")) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const day = `${parsed.getUTCDate()}`.padStart(2, "0");
  const month = `${parsed.getUTCMonth() + 1}`.padStart(2, "0");
  const year = parsed.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function hourBucket(round) {
  const parsed = new Date(round.time || round.processTime || 0);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return `${parsed.getUTCHours()}`;
}

function patternKey(round) {
  const dice = [...(round.dice || [])].sort((a, b) => a - b);
  if (dice[0] === dice[2]) return "triple";
  if (dice[0] === dice[1] || dice[1] === dice[2]) return "pair";
  return "mixed";
}

function canonicalDiceKey(dice) {
  return [...dice].sort((a, b) => a - b).join("-");
}

function enumerateExactCombos() {
  const counts = new Map();
  for (let a = 1; a <= 6; a += 1) {
    for (let b = 1; b <= 6; b += 1) {
      for (let c = 1; c <= 6; c += 1) {
        const key = canonicalDiceKey([a, b, c]);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

const EXACT_COMBOS = enumerateExactCombos();

function buildTheoryDistributions() {
  const resultCounts = {};
  const totalCounts = {};
  const faceCounts = {};
  for (const result of RESULT_ORDER) resultCounts[result] = 0;
  for (let total = TOTAL_MIN; total <= TOTAL_MAX; total += 1) totalCounts[total] = 0;
  for (let face = 1; face <= 6; face += 1) faceCounts[face] = 0;

  for (let a = 1; a <= 6; a += 1) {
    for (let b = 1; b <= 6; b += 1) {
      for (let c = 1; c <= 6; c += 1) {
        const total = a + b + c;
        totalCounts[total] += 1;
        resultCounts[classifyTotal(total)] += 1;
        faceCounts[a] += 1;
        faceCounts[b] += 1;
        faceCounts[c] += 1;
      }
    }
  }

  return {
    result: normalizeMap(resultCounts, RESULT_ORDER),
    total: normalizeMap(totalCounts, Object.keys(totalCounts)),
    face: normalizeMap(faceCounts, Object.keys(faceCounts)),
    exact: normalizeMap(
      Object.fromEntries(EXACT_COMBOS.map((entry) => [entry.key, entry.count])),
      EXACT_COMBOS.map((entry) => entry.key)
    ),
  };
}

const THEORY = buildTheoryDistributions();

function buildStats(rounds) {
  const stats = {
    totalRounds: rounds.length,
    byResult: {},
    byTotal: {},
    byFace: {},
    byHourResult: {},
    byDate: {},
    afterTotal: {},
    afterResult: {},
    afterPattern: {},
    byContext: {},
  };

  for (const result of RESULT_ORDER) stats.byResult[result] = 0;
  for (let total = TOTAL_MIN; total <= TOTAL_MAX; total += 1) stats.byTotal[total] = 0;
  for (let face = 1; face <= 6; face += 1) stats.byFace[face] = 0;

  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    const result = round.result || classifyTotal(round.total ?? sumDice(round.dice || []));
    const total = Number.isFinite(round.total) ? round.total : sumDice(round.dice || []);
    const dateKey = safeDateKey(round.sourceDate || round.rawSourceTime || round.time);
    const hour = hourBucket(round);
    const pattern = patternKey(round);

    stats.byResult[result] += 1;
    stats.byTotal[total] = (stats.byTotal[total] || 0) + 1;
    stats.byDate[dateKey] = (stats.byDate[dateKey] || 0) + 1;
    stats.byHourResult[hour] = stats.byHourResult[hour] || {};
    stats.byHourResult[hour][result] = (stats.byHourResult[hour][result] || 0) + 1;

    for (const die of round.dice || []) {
      stats.byFace[die] = (stats.byFace[die] || 0) + 1;
    }

    if (index > 0) {
      const previous = rounds[index - 1];
      const prevTotal = previous.total;
      const prevResult = previous.result;
      const prevPattern = patternKey(previous);

      stats.afterTotal[prevTotal] = stats.afterTotal[prevTotal] || {};
      stats.afterTotal[prevTotal][result] = (stats.afterTotal[prevTotal][result] || 0) + 1;

      stats.afterResult[prevResult] = stats.afterResult[prevResult] || {};
      stats.afterResult[prevResult][result] = (stats.afterResult[prevResult][result] || 0) + 1;

      stats.afterPattern[prevPattern] = stats.afterPattern[prevPattern] || {};
      stats.afterPattern[prevPattern][result] = (stats.afterPattern[prevPattern][result] || 0) + 1;
    }

    if (index >= 3) {
      const context = rounds
        .slice(index - 3, index)
        .map((item) => `${item.result}:${item.total}`)
        .join("|");
      stats.byContext[context] = stats.byContext[context] || {};
      stats.byContext[context][result] = (stats.byContext[context][result] || 0) + 1;
    }
  }

  return stats;
}

function distributionFromCounts(counts, keys, minSamples = 0) {
  const sampleSize = Object.values(counts || {}).reduce((sum, value) => sum + (value || 0), 0);
  if (sampleSize <= minSamples) return null;
  return normalizeMap(counts, keys);
}

function sliceTail(rounds, size) {
  return rounds.slice(Math.max(0, rounds.length - size));
}

function buildRecentDistribution(rounds, size) {
  const counts = {};
  for (const key of RESULT_ORDER) counts[key] = 0;
  for (const round of sliceTail(rounds, size)) {
    counts[round.result] = (counts[round.result] || 0) + 1;
  }
  return normalizeMap(counts, RESULT_ORDER);
}

function buildDayDistribution(rounds) {
  const latest = rounds[rounds.length - 1];
  const latestDate = latest ? safeDateKey(latest.sourceDate || latest.rawSourceTime || latest.time) : "";
  const dayRounds = rounds.filter(
    (round) => safeDateKey(round.sourceDate || round.rawSourceTime || round.time) === latestDate
  );
  if (dayRounds.length < 20) return null;
  const counts = {};
  for (const key of RESULT_ORDER) counts[key] = 0;
  for (const round of dayRounds) counts[round.result] = (counts[round.result] || 0) + 1;
  return normalizeMap(counts, RESULT_ORDER);
}

function buildHourDistribution(stats, latestRound) {
  const hour = hourBucket(latestRound || {});
  const counts = stats.byHourResult[hour];
  return distributionFromCounts(counts, RESULT_ORDER, 400);
}

function buildContextDistribution(stats, rounds) {
  if (rounds.length < 3) return null;
  const context = rounds
    .slice(-3)
    .map((item) => `${item.result}:${item.total}`)
    .join("|");
  return distributionFromCounts(stats.byContext[context], RESULT_ORDER, 10);
}

function buildResultModel(rounds, options) {
  const stats = buildStats(rounds);
  const latest = rounds[rounds.length - 1];

  const globalDist = normalizeMap(stats.byResult, RESULT_ORDER);
  const recentDist = buildRecentDistribution(rounds, 36);
  const shortDist = buildRecentDistribution(rounds, 12);
  const dayDist = buildDayDistribution(rounds);
  const afterTotalDist = latest ? distributionFromCounts(stats.afterTotal[latest.total], RESULT_ORDER, 20) : null;
  const afterResultDist = latest ? distributionFromCounts(stats.afterResult[latest.result], RESULT_ORDER, 20) : null;
  const afterPatternDist = latest
    ? distributionFromCounts(stats.afterPattern[patternKey(latest)], RESULT_ORDER, 20)
    : null;
  const contextDist = buildContextDistribution(stats, rounds);
  const hourDist = options.includeHourFeatures ? buildHourDistribution(stats, latest) : null;

  const resultDist = blendDistributions(
    [
      { weight: 1.8, dist: THEORY.result },
      { weight: 1.8, dist: globalDist },
      { weight: 1.4, dist: recentDist },
      { weight: 1.2, dist: shortDist },
      { weight: 0.8, dist: dayDist },
      { weight: 1.0, dist: afterTotalDist },
      { weight: 0.8, dist: afterResultDist },
      { weight: 0.8, dist: afterPatternDist },
      { weight: 1.0, dist: contextDist },
      { weight: 0.45, dist: hourDist },
    ],
    RESULT_ORDER
  );

  return {
    stats,
    distributions: {
      theory: THEORY.result,
      global: globalDist,
      recent: recentDist,
      short: shortDist,
      day: dayDist,
      afterLatestTotal: afterTotalDist,
      afterLatestClass: afterResultDist,
      afterLatestPattern: afterPatternDist,
      context: contextDist,
      hour: hourDist,
      final: resultDist,
    },
  };
}

function buildTotalDistribution(rounds) {
  const counts = {};
  for (let total = TOTAL_MIN; total <= TOTAL_MAX; total += 1) counts[total] = 0;
  for (const round of rounds) counts[round.total] = (counts[round.total] || 0) + 1;
  const global = normalizeMap(counts, Object.keys(counts));

  const recentCounts = {};
  for (let total = TOTAL_MIN; total <= TOTAL_MAX; total += 1) recentCounts[total] = 0;
  for (const round of sliceTail(rounds, 48)) recentCounts[round.total] = (recentCounts[round.total] || 0) + 1;
  const recent = normalizeMap(recentCounts, Object.keys(recentCounts));

  return blendDistributions(
    [
      { weight: 1.4, dist: THEORY.total },
      { weight: 1.2, dist: global },
      { weight: 0.9, dist: recent },
    ],
    Object.keys(counts)
  );
}

function buildFaceDistribution(rounds) {
  const counts = {};
  for (let face = 1; face <= 6; face += 1) counts[face] = 0;
  for (const round of sliceTail(rounds, 60)) {
    for (const die of round.dice || []) counts[die] = (counts[die] || 0) + 1;
  }
  return blendDistributions(
    [
      { weight: 1.0, dist: THEORY.face },
      { weight: 1.0, dist: normalizeMap(counts, Object.keys(counts)) },
    ],
    Object.keys(counts)
  );
}

function buildExactDistribution(faceDist) {
  const dist = {};
  for (const combo of EXACT_COMBOS) {
    const faces = combo.key.split("-").map(Number);
    const product = faces.reduce((acc, face) => acc * (faceDist[face] || 0), 1);
    dist[combo.key] = product;
  }
  return normalizeMap(dist, EXACT_COMBOS.map((entry) => entry.key));
}

function confidenceFromResultDistribution(resultDist) {
  const ranked = topEntries(resultDist, 3);
  const top = ranked[0]?.probability || 0;
  const runnerUp = ranked[1]?.probability || 0;
  const gap = top - runnerUp;
  let level = "low";
  if (top >= 0.58 && gap >= 0.12) level = "high";
  else if (top >= 0.5 && gap >= 0.07) level = "medium";

  return {
    level,
    topProbability: top,
    margin: gap,
  };
}

function buildSelectiveStrategy(resultDist, totalDist, options) {
  const ranked = topEntries(resultDist, 3);
  const totalRanked = topEntries(totalDist, 3);
  const top = ranked[0];
  const second = ranked[1];
  const confidence = confidenceFromResultDistribution(resultDist);
  const minTopProbability = 0.435;
  const minMargin = 0.055;
  const shouldBet =
    options.selective !== false &&
    top &&
    top.probability >= minTopProbability &&
    top.probability - (second?.probability || 0) >= minMargin;

  return {
    enabled: options.selective !== false,
    currentDecision: {
      shouldBet,
      predictedResult: top?.key || "Big",
      confidence: confidence.level,
      gateChecks: [
        { name: "top_prob", pass: (top?.probability || 0) >= minTopProbability, value: top?.probability || 0 },
        { name: "margin", pass: (top?.probability || 0) - (second?.probability || 0) >= minMargin, value: confidence.margin },
      ],
      recommendedTotals: totalRanked.map((entry) => ({
        total: Number(entry.key),
        probability: entry.probability,
      })),
    },
    backtest: null,
  };
}

function buildPredictionSnapshot(rounds, rawOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  const resultModel = buildResultModel(rounds, options);
  const totalDist = buildTotalDistribution(rounds);
  const faceDist = buildFaceDistribution(rounds);
  const exactDist = buildExactDistribution(faceDist);
  const resultDist = resultModel.distributions.final;
  const rankedResults = topEntries(resultDist, 3);
  const predictedResult = rankedResults[0]?.key || "Big";
  const confidence = confidenceFromResultDistribution(resultDist);

  return {
    options,
    resultModel,
    resultDist,
    totalDist,
    faceDist,
    exactDist,
    predictedResult,
    confidence,
  };
}

function runSelectiveBacktest(rounds, rawOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions, selective: true };
  let qualifyingBets = 0;
  let hits = 0;
  const startIndex = Math.max(120, Math.floor(rounds.length * 0.7));

  for (let index = startIndex; index < rounds.length; index += 1) {
    const history = rounds.slice(0, index);
    const target = rounds[index];
    const snapshot = buildPredictionSnapshot(history, options);
    const strategy = buildSelectiveStrategy(snapshot.resultDist, snapshot.totalDist, options);
    if (!strategy.currentDecision.shouldBet) continue;
    qualifyingBets += 1;
    if (strategy.currentDecision.predictedResult === target.result) hits += 1;
  }

  return {
    sampleSize: Math.max(0, rounds.length - startIndex),
    qualifyingBets,
    coverage: rounds.length > startIndex ? (qualifyingBets / (rounds.length - startIndex)) * 100 : 0,
    hitRate: qualifyingBets > 0 ? (hits / qualifyingBets) * 100 : 0,
  };
}

function buildAnalytics(rounds, snapshot) {
  const latest = rounds[rounds.length - 1];
  const hotFaces = topEntries(snapshot.faceDist, 3).map((entry) => ({
    face: Number(entry.key),
    probability: entry.probability,
    recentRate: Number((entry.probability * 100).toFixed(2)),
    todayRate: Number((entry.probability * 100).toFixed(2)),
    score: `${(entry.probability * 100).toFixed(2)}%`,
  }));
  const topTotals = topEntries(snapshot.totalDist, 5).map((entry) => ({
    total: Number(entry.key),
    probability: entry.probability,
    probabilityHint: Number((entry.probability * 100).toFixed(2)),
    score: `${(entry.probability * 100).toFixed(2)}%`,
    rank: 0,
    result: classifyTotal(Number(entry.key)),
  }));
  topTotals.forEach((item, index) => {
    item.rank = index + 1;
  });

  return {
    hotFaces,
    pairPatterns: [],
    pairPatternsToday: [],
    coOccurrencePairs: [],
    todayTopTotals: topTotals,
    surpriseTotals: [],
    afterLatestRound: latest
      ? {
          total: latest.total,
          result: latest.result,
          pattern: patternKey(latest),
          nextResultBias: snapshot.resultModel.distributions.afterLatestTotal || snapshot.resultDist,
        }
      : null,
    finalPicks: {
      result: snapshot.predictedResult,
      totals: topTotals,
      exactDice: topEntries(snapshot.exactDist, 3).map((entry, index) => {
        const dice = entry.key.split("-").map(Number);
        return {
          rank: index + 1,
          dice,
          pattern: patternKey({ dice }),
          probability: Number((entry.probability * 100).toFixed(2)),
          score: `${(entry.probability * 100).toFixed(2)}%`,
        };
      }),
    },
    betTypes: {
      resultOnly: snapshot.predictedResult,
      topTotals,
      tripleHotHours: [],
      exactTripleHotHours: [],
      exactTriples: [],
      anyTriple: {},
      exactDoubles: [],
      singleFaces: hotFaces,
    },
  };
}

function buildDiagnosis(snapshot) {
  const topTotals = topEntries(snapshot.totalDist, 5).map((entry) => ({
    total: Number(entry.key),
    probability: entry.probability,
    probabilityHint: Number((entry.probability * 100).toFixed(2)),
    score: `${(entry.probability * 100).toFixed(2)}%`,
    result: classifyTotal(Number(entry.key)),
  }));
  const topExactDice = topEntries(snapshot.exactDist, 5).map((entry) => ({
    dice: entry.key.split("-").map(Number),
    probability: entry.probability,
    total: entry.key
      .split("-")
      .map(Number)
      .reduce((sum, value) => sum + value, 0),
    pattern: patternKey({ dice: entry.key.split("-").map(Number) }),
    score: `${(entry.probability * 100).toFixed(2)}%`,
  }));
  const topFaces = topEntries(snapshot.faceDist, 6).map((entry) => ({
    face: Number(entry.key),
    probability: entry.probability,
    probabilityHint: Number((entry.probability * 100).toFixed(2)),
    score: `${(entry.probability * 100).toFixed(2)}%`,
  }));

  return {
    mostLikelyResult: snapshot.predictedResult,
    confidenceSpread: snapshot.confidence.margin,
    resultProbabilities: snapshot.resultDist,
    topTotals,
    topExactDice,
    topFaces,
    confidenceModel: {
      ...snapshot.confidence,
      confidenceScore: Number((snapshot.confidence.topProbability * 100).toFixed(2)),
      shouldAbstain: snapshot.confidence.level === "low",
    },
    recommendations: {
      primaryResult: snapshot.predictedResult,
      selectiveOnly: snapshot.confidence.level !== "low",
    },
  };
}

function buildBetPortfolio(snapshot) {
  return {
    result: {
      primary: snapshot.predictedResult,
      confidence: snapshot.confidence.level,
    },
    totals: topEntries(snapshot.totalDist, 3).map((entry) => ({
      total: Number(entry.key),
      probability: entry.probability,
    })),
  };
}

function buildPrediction(rounds, rawOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  const snapshot = buildPredictionSnapshot(rounds, options);
  const selectiveStrategy = buildSelectiveStrategy(snapshot.resultDist, snapshot.totalDist, options);
  if (options.selective !== false && options.includeBacktest) {
    selectiveStrategy.backtest = runSelectiveBacktest(rounds, options);
  }

  return {
    methodology: {
      name: "core_ensemble_v1",
      summary:
        "Stable probabilistic ensemble using theory prior, historical frequencies, recent drift, transitions, and context retrieval with abstain-first selective gating.",
      includeHourFeatures: options.includeHourFeatures,
    },
    dataset: {
      totalRounds: rounds.length,
      latestRoundId: rounds[rounds.length - 1]?.id || null,
    },
    distributions: {
      result: snapshot.resultModel.distributions,
      total: snapshot.totalDist,
      face: snapshot.faceDist,
      exact: snapshot.exactDist,
    },
    diagnosis: buildDiagnosis(snapshot),
    analytics: buildAnalytics(rounds, snapshot),
    selectiveStrategy,
    betPortfolio: buildBetPortfolio(snapshot),
  };
}

export {
  buildPrediction,
  buildPredictionSnapshot,
  runSelectiveBacktest,
};
