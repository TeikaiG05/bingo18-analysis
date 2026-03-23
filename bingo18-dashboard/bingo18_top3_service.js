import fs from 'fs'
import path from 'path'

const TOTALS = Array.from({ length: 16 }, (_, index) => index + 3)
const EDGE_TOTALS = new Set([3, 4, 5, 16, 17, 18])
const WEEKDAY_NAMES_VI = [
  'Chủ Nhật',
  'Thứ Hai',
  'Thứ Ba',
  'Thứ Tư',
  'Thứ Năm',
  'Thứ Sáu',
  'Thứ Bảy',
]
const DEFAULT_LOG_COLUMNS = [
  'prediction_key',
  'predicted_period_id',
  'predicted_date',
  'predicted_slot_in_day',
  'predicted_weekday',
  'prediction_created_at',
  'status',
  'prev_total',
  'prev_state',
  'predicted_top3',
  'pred_1',
  'pred_2',
  'pred_3',
  'prob_1',
  'prob_2',
  'prob_3',
  'actual_period_id',
  'actual_date',
  'actual_slot_in_day',
  'actual_d1',
  'actual_d2',
  'actual_d3',
  'actual_total',
  'actual_state',
  'hit_top3',
  'resolved_at',
  'model_version',
  'state_version',
  'source',
]
const DEFAULT_WEIGHTS = {
  // Giảm theoretical + global để nhường chỗ cho recent memory
  theoretical: 0.85,
  global: 0.78,
  // BUG FIX: recent_short = 0.0 khiến model mù trước trend ngắn hạn
  recent_short: 0.18,   // Từ 0.0 → 0.18 — nhớ 50 kỳ gần nhất
  recent_medium: 0.32,  // Từ 0.1 → 0.32 — nhớ 300 kỳ vừa
  prev_state: 0.22,
  prev_total: 0.22,
  slot: 0.22,   // Từ 0.4 → 0.22 — giảm bịt ảnh hưởng của slot lịch sử xa
  weekday: 0.04,
}
const HIT_LABELS = {
  hit: 'Trúng',
  miss: 'Trượt',
  pending: 'Chờ kết quả',
}
const DEFAULT_MODEL_VERSION = 'bayesian-contextual-v1-web'
const DEFAULT_MAX_SLOT_IN_DAY = 159
const THEORETICAL_COUNTS = {}
const THEORETICAL_PROB = {}

for (const total of TOTALS) THEORETICAL_COUNTS[total] = 0
for (let die1 = 1; die1 <= 6; die1 += 1) {
  for (let die2 = 1; die2 <= 6; die2 += 1) {
    for (let die3 = 1; die3 <= 6; die3 += 1) {
      THEORETICAL_COUNTS[die1 + die2 + die3] += 1
    }
  }
}
for (const total of TOTALS) {
  THEORETICAL_PROB[String(total)] = THEORETICAL_COUNTS[total] / 216
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '')
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function nowIso() {
  return new Date().toISOString()
}

function backupFile(filePath, backupsDir) {
  if (!fs.existsSync(filePath)) return null
  ensureDir(backupsDir)
  const parsed = path.parse(filePath)
  const target = path.join(
    backupsDir,
    `${parsed.name}-${timestampSlug()}${parsed.ext}`,
  )
  fs.copyFileSync(filePath, target)
  return target
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath, payload, backupsDir) {
  backupFile(filePath, backupsDir)
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
}

function parseCsv(text) {
  const source = stripBom(text)
  const rows = []
  let currentRow = []
  let currentField = ''
  let inQuotes = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const nextChar = source[index + 1]

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"'
        index += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        currentField += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === ',') {
      currentRow.push(currentField)
      currentField = ''
      continue
    }
    if (char === '\n') {
      currentRow.push(currentField)
      rows.push(currentRow)
      currentRow = []
      currentField = ''
      continue
    }
    if (char === '\r') continue
    currentField += char
  }

  if (currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField)
    rows.push(currentRow)
  }

  if (!rows.length) return []
  const header = rows.shift().map((value) => String(value || '').trim())
  return rows
    .filter((row) => row.some((value) => String(value || '').trim() !== ''))
    .map((row) => {
      const item = {}
      header.forEach((column, index) => {
        item[column] = row[index] ?? ''
      })
      return item
    })
}

function escapeCsvValue(value) {
  if (value == null) return ''
  const text = String(value)
  if (/["\n,]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function stringifyCsv(rows, columns) {
  const headerLine = columns.join(',')
  const dataLines = rows.map((row) =>
    columns.map((column) => escapeCsvValue(row[column])).join(','),
  )
  return [headerLine, ...dataLines].join('\n')
}

function canonicalPeriodId(value) {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw || raw.toLowerCase() === 'nan') return null
  const normalized = raw.replace(/,/g, '')
  return /^\d+$/.test(normalized) ? String(Number(normalized)) : raw
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function normalizeDateString(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  let match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (match) {
    const [, day, month, year] = match
    return `${year}-${pad2(month)}-${pad2(day)}`
  }

  match = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`
}

function weekdayIndexFromDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`)
  return Number.isNaN(date.getTime()) ? 0 : date.getDay()
}

function weekdayNameVi(weekdayIndex) {
  return WEEKDAY_NAMES_VI[Number(weekdayIndex) || 0] || 'Không rõ'
}

function computeStateLabel(total) {
  const numeric = Number(total)
  if (numeric === 10 || numeric === 11) return 'Hòa'
  if (numeric < 10) return 'Nhỏ'
  return 'Lớn'
}

function normalizeStateValue(value, total = null) {
  const raw = String(value || '').trim()
  if (!raw || raw.toLowerCase() === 'nan') {
    return total == null ? '' : computeStateLabel(total)
  }

  const lowered = raw.toLowerCase()
  if (lowered.includes('hòa') || lowered.includes('hoa') || lowered.includes('hã²a')) {
    return 'Hòa'
  }
  if (
    lowered.includes('lớn') ||
    lowered.includes('lon') ||
    lowered.includes('tài') ||
    lowered.includes('tai') ||
    lowered.includes('lá»›n')
  ) {
    return 'Lớn'
  }
  if (
    lowered.includes('nhỏ') ||
    lowered.includes('nho') ||
    lowered.includes('xỉu') ||
    lowered.includes('xiu') ||
    lowered.includes('nhá»')
  ) {
    return 'Nhỏ'
  }
  return total == null ? raw : computeStateLabel(total)
}

function numericValue(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

function emptyTotalCounts() {
  return Object.fromEntries(TOTALS.map((total) => [String(total), 0]))
}

function buildPredictionKey(periodId, dateString, slotInDay) {
  const normalizedPeriod = canonicalPeriodId(periodId)
  if (normalizedPeriod) return `period:${normalizedPeriod}`
  return `date:${dateString}|slot:${slotInDay}`
}

function normalizeHitLabel(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw || raw === 'nan') return HIT_LABELS.pending
  if (['trúng', 'hit', 'true', '1', 'yes'].includes(raw)) return HIT_LABELS.hit
  if (['trượt', 'miss', 'false', '0', 'no'].includes(raw)) return HIT_LABELS.miss
  return HIT_LABELS.pending
}

function resolvePaths(baseDir) {
  const workspaceRoot = path.resolve(baseDir, '..')
  const configPath = path.join(workspaceRoot, 'config', 'paths.json')
  const config = readJsonFile(configPath, {})
  const source = config.source || {}
  const runtime = config.runtime || {}
  const resolveFromWorkspace = (input, fallback) => {
    const value = input || fallback
    if (!value) return null
    return path.isAbsolute(value)
      ? value
      : path.resolve(workspaceRoot, value)
  }

  return {
    workspaceRoot,
    configPath,
    crawlerDataJson: path.resolve(baseDir, 'data.json'),
    sourceHistoryCsv: resolveFromWorkspace(source.history_csv, path.join('..', 'bingo18.csv')),
    sourceAnalysisReport: resolveFromWorkspace(source.analysis_report, path.join('..', 'bingo18_analysis_report.md')),
    sourcePredictionLog: resolveFromWorkspace(source.prediction_log, path.join('..', 'bingo18_prediction_log.csv')),
    sourceModelState: resolveFromWorkspace(source.model_state, path.join('..', 'bingo18_model_state.json')),
    sourcePredictor: resolveFromWorkspace(source.legacy_predictor, path.join('..', 'bingo18_predictor.py')),
    runtimeHistoryCsv: resolveFromWorkspace(runtime.history_csv, 'data/runtime/bingo18_history.csv'),
    runtimePredictionLog: resolveFromWorkspace(runtime.prediction_log, 'data/runtime/bingo18_prediction_log.csv'),
    runtimeModelState: resolveFromWorkspace(runtime.model_state, 'data/runtime/bingo18_model_state.json'),
    runtimeAnalysisReport: resolveFromWorkspace(runtime.analysis_report, 'data/source/bingo18_analysis_report.md'),
    runtimePredictor: resolveFromWorkspace(runtime.legacy_predictor, 'data/source/bingo18_predictor.py'),
    backupsDir: resolveFromWorkspace(runtime.backups_dir, 'backups'),
  }
}

function ensureBootstrap(paths) {
  const actions = []
  const copyIfMissing = (sourcePath, targetPath, label) => {
    if (!targetPath || fs.existsSync(targetPath) || !sourcePath || !fs.existsSync(sourcePath)) return
    ensureDir(path.dirname(targetPath))
    fs.copyFileSync(sourcePath, targetPath)
    actions.push(`Bootstrap ${label}`)
  }

  ensureDir(path.dirname(paths.runtimeHistoryCsv))
  ensureDir(path.dirname(paths.runtimePredictionLog))
  ensureDir(path.dirname(paths.runtimeModelState))
  ensureDir(path.dirname(paths.runtimeAnalysisReport))
  ensureDir(path.dirname(paths.runtimePredictor))
  ensureDir(paths.backupsDir)

  copyIfMissing(paths.sourceHistoryCsv, paths.runtimeHistoryCsv, 'history CSV')
  copyIfMissing(paths.sourcePredictionLog, paths.runtimePredictionLog, 'prediction log')
  copyIfMissing(paths.sourceModelState, paths.runtimeModelState, 'model state')
  copyIfMissing(paths.sourceAnalysisReport, paths.runtimeAnalysisReport, 'analysis report')
  copyIfMissing(paths.sourcePredictor, paths.runtimePredictor, 'legacy predictor')

  if (!fs.existsSync(paths.runtimePredictionLog)) {
    fs.writeFileSync(paths.runtimePredictionLog, stringifyCsv([], DEFAULT_LOG_COLUMNS), 'utf8')
    actions.push('Tạo prediction log rỗng trong runtime')
  }

  return actions
}

function readCsvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return []
  return parseCsv(fs.readFileSync(filePath, 'utf8'))
}

function readTextFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return ''
  return stripBom(fs.readFileSync(filePath, 'utf8'))
}

function normalizeCrawlerRounds(rawRounds) {
  if (!Array.isArray(rawRounds) || rawRounds.length === 0) return []

  return rawRounds
    .map((round) => {
      const dice = Array.isArray(round?.dice) ? round.dice.map((value) => numericValue(value)) : []
      const d1 = dice[0] ?? null
      const d2 = dice[1] ?? null
      const d3 = dice[2] ?? null
      const hasFullDice = [d1, d2, d3].every((value) => value != null)
      const totalFromDice = hasFullDice ? d1 + d2 + d3 : null
      const total = numericValue(round?.total) ?? totalFromDice
      const dateString = normalizeDateString(
        round?.rawSourceTime ?? round?.sourceDate ?? round?.time,
      )

      if (!dateString || total == null || total < 3 || total > 18) return null
      if ([d1, d2, d3].some((value) => value != null && (value < 1 || value > 6))) return null

      return {
        period_id: canonicalPeriodId(round?.id),
        date: dateString,
        slot_in_day: null,
        d1,
        d2,
        d3,
        result_text: hasFullDice ? `${d1} ${d2} ${d3}` : '',
        total,
        state: normalizeStateValue(round?.result, total),
      }
    })
    .filter(Boolean)
}

function readCrawlerRounds(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return []
  const payload = readJsonFile(filePath, null)
  return normalizeCrawlerRounds(payload?.rounds || [])
}

function normalizeHistoryRows(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) return []
  const aliasMap = {
    period_id: ['period_id', 'id', 'issue_id', 'round_id', 'ma_ky'],
    date: ['date', 'play_date', 'ngay', 'datetime', 'created_at'],
    slot_in_day: ['slot_in_day', 'slot', 'session', 'slot_day'],
    result: ['result', 'dice', 'dice_result', 'xuc_xac'],
    d1: ['d1', 'dice_1', 'die_1'],
    d2: ['d2', 'dice_2', 'die_2'],
    d3: ['d3', 'dice_3', 'die_3'],
    total: ['total', 'sum', 'tong'],
    state: ['state', 'status', 'large_small', 'tai_xiu_hoa'],
  }

  const normalized = rawRows.map((row, index) => {
    const source = {}
    for (const [targetKey, aliases] of Object.entries(aliasMap)) {
      const directValue = row[targetKey]
      if (directValue != null && String(directValue).trim() !== '') {
        source[targetKey] = directValue
        continue
      }
      const aliasKey = aliases.find((alias) => row[alias] != null && String(row[alias]).trim() !== '')
      source[targetKey] = aliasKey ? row[aliasKey] : ''
    }

    const dateString = normalizeDateString(source.date)
    if (!dateString) {
      throw new Error(`Không parse được ngày ở dòng ${index + 1}.`)
    }

    const resultText = String(source.result || '').trim()
    const diceFromResult = resultText.match(/(\d+)\D+(\d+)\D+(\d+)/)
    const d1 = numericValue(String(source.d1 ?? '').trim() || (diceFromResult ? diceFromResult[1] : null))
    const d2 = numericValue(String(source.d2 ?? '').trim() || (diceFromResult ? diceFromResult[2] : null))
    const d3 = numericValue(String(source.d3 ?? '').trim() || (diceFromResult ? diceFromResult[3] : null))

    for (const [position, value] of [
      ['d1', d1],
      ['d2', d2],
      ['d3', d3],
    ]) {
      if (value != null && (value < 1 || value > 6)) {
        throw new Error(`Giá trị xúc xắc ${position} ngoài khoảng 1-6 ở dòng ${index + 1}.`)
      }
    }

    const inferredTotal = d1 != null && d2 != null && d3 != null ? d1 + d2 + d3 : null
    let total = numericValue(source.total)
    if (total == null) total = inferredTotal
    if (total == null) {
      throw new Error(`Thiếu tổng hoặc thiếu 3 viên xúc xắc ở dòng ${index + 1}.`)
    }
    if (total < 3 || total > 18) {
      throw new Error(`Tổng phải nằm trong khoảng 3-18 ở dòng ${index + 1}.`)
    }
    if (inferredTotal != null && total !== inferredTotal) {
      throw new Error(`Tổng không khớp với 3 viên xúc xắc ở dòng ${index + 1}.`)
    }

    return {
      period_id: canonicalPeriodId(source.period_id),
      date: dateString,
      slot_in_day: numericValue(source.slot_in_day),
      d1,
      d2,
      d3,
      result_text:
        resultText ||
        (d1 != null && d2 != null && d3 != null ? `${d1} ${d2} ${d3}` : ''),
      total,
      state: normalizeStateValue(source.state, total),
    }
  })

  normalized.sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date)
    const leftNumeric = numericValue(left.period_id)
    const rightNumeric = numericValue(right.period_id)
    if (leftNumeric != null && rightNumeric != null && leftNumeric !== rightNumeric) {
      return leftNumeric - rightNumeric
    }
    return String(left.period_id || '').localeCompare(String(right.period_id || ''))
  })

  const dayCounters = new Map()
  const deduped = []
  const seen = new Set()

  for (const row of normalized) {
    const counter = dayCounters.get(row.date) || 0
    if (row.slot_in_day == null || row.slot_in_day <= 0) {
      row.slot_in_day = counter + 1
    }
    dayCounters.set(row.date, Math.max(counter + 1, row.slot_in_day))

    if (!row.period_id) row.period_id = `${row.date}-slot-${row.slot_in_day}`
    if (seen.has(row.period_id)) continue
    seen.add(row.period_id)
    const weekdayIdx = weekdayIndexFromDate(row.date)
    deduped.push({
      ...row,
      weekday_idx: weekdayIdx,
      weekday_name: weekdayNameVi(weekdayIdx),
    })
  }

  return deduped
}

function resequenceHistoryRows(rows) {
  const normalized = normalizeHistoryRows(rows).map((row) => ({ ...row }))
  let currentDate = null
  let slotCounter = 0

  for (const row of normalized) {
    if (row.date !== currentDate) {
      currentDate = row.date
      slotCounter = 0
    }
    slotCounter += 1
    row.slot_in_day = slotCounter
  }

  return normalized
}

function normalizePredictionLogRows(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) return []
  const normalized = rawRows.map((row) => {
    const predictedPeriodId = canonicalPeriodId(
      row.predicted_period_id ?? row.id ?? row.predictedPeriodId,
    )
    const predictedDate = normalizeDateString(
      row.predicted_date ?? row.date ?? row.predictedDate,
    )
    const predictedSlotInDay =
      numericValue(row.predicted_slot_in_day ?? row.slot_in_day ?? row.predictedSlotInDay) ?? 1
    const actualTotal = numericValue(row.actual_total)
    const pred1 = numericValue(row.pred_1)
    const pred2 = numericValue(row.pred_2)
    const pred3 = numericValue(row.pred_3)
    const predictionKey =
      String(row.prediction_key || '').trim() ||
      buildPredictionKey(predictedPeriodId, predictedDate, predictedSlotInDay)
    const predictedTop3 =
      String(row.predicted_top3 || '').trim() ||
      [pred1, pred2, pred3].filter((value) => value != null).join(',')
    const resolved = actualTotal != null

    const normalizedRow = {
      prediction_key: predictionKey,
      predicted_period_id: predictedPeriodId,
      predicted_date: predictedDate,
      predicted_slot_in_day: predictedSlotInDay,
      predicted_weekday:
        String(row.predicted_weekday || row.weekday || '').trim() ||
        weekdayNameVi(weekdayIndexFromDate(predictedDate)),
      prediction_created_at: row.prediction_created_at || row.created_at || null,
      status: row.status || (resolved ? 'resolved' : 'pending'),
      prev_total: numericValue(row.prev_total),
      prev_state: normalizeStateValue(row.prev_state, numericValue(row.prev_total)),
      predicted_top3: predictedTop3,
      pred_1: pred1,
      pred_2: pred2,
      pred_3: pred3,
      prob_1: numericValue(row.prob_1),
      prob_2: numericValue(row.prob_2),
      prob_3: numericValue(row.prob_3),
      actual_period_id: canonicalPeriodId(row.actual_period_id ?? row.id),
      actual_date:
        normalizeDateString(row.actual_date ?? (resolved ? predictedDate : null)) ||
        null,
      actual_slot_in_day:
        numericValue(row.actual_slot_in_day ?? (resolved ? predictedSlotInDay : null)) || null,
      actual_d1: numericValue(row.actual_d1),
      actual_d2: numericValue(row.actual_d2),
      actual_d3: numericValue(row.actual_d3),
      actual_total: actualTotal,
      actual_state:
        actualTotal != null
          ? normalizeStateValue(row.actual_state, actualTotal)
          : normalizeStateValue(row.actual_state),
      hit_top3: normalizeHitLabel(row.hit_top3),
      resolved_at: row.resolved_at || null,
      model_version: String(row.model_version || 'legacy-bayesian-contextual-v1').trim(),
      state_version: numericValue(row.state_version) || 1,
      source: row.source || row.phase || 'legacy_log_migration',
    }

    if (
      normalizedRow.source === 'web_tab_top3' &&
      normalizedRow.status === 'resolved' &&
      normalizedRow.actual_total != null &&
      normalizedRow.actual_date &&
      normalizedRow.predicted_date
    ) {
      const predictedTime = new Date(`${normalizedRow.predicted_date}T00:00:00`).getTime()
      const actualTime = new Date(`${normalizedRow.actual_date}T00:00:00`).getTime()
      const dayDiff = Math.abs(predictedTime - actualTime) / (24 * 60 * 60 * 1000)
      if (Number.isFinite(dayDiff) && dayDiff > 45) {
        normalizedRow.predicted_date = normalizedRow.actual_date
        normalizedRow.predicted_slot_in_day =
          normalizedRow.actual_slot_in_day || normalizedRow.predicted_slot_in_day
        normalizedRow.predicted_weekday = weekdayNameVi(
          weekdayIndexFromDate(normalizedRow.predicted_date),
        )
      }
      normalizedRow.hit_top3 =
        [normalizedRow.pred_1, normalizedRow.pred_2, normalizedRow.pred_3].includes(
          normalizedRow.actual_total,
        )
          ? HIT_LABELS.hit
          : HIT_LABELS.miss
      normalizedRow.resolved_at = normalizedRow.resolved_at || normalizedRow.prediction_created_at || nowIso()
    }

    return normalizedRow
  })

  const latestByKey = new Map()
  for (const row of normalized) latestByKey.set(row.prediction_key, row)
  return Array.from(latestByKey.values()).sort((left, right) => {
    const leftDate = left.predicted_date || ''
    const rightDate = right.predicted_date || ''
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)
    return numberOrZero(left.predicted_slot_in_day) - numberOrZero(right.predicted_slot_in_day)
  })
}

function initEmptyState() {
  return {
    version: 2,
    model_version: DEFAULT_MODEL_VERSION,
    max_slot_in_day: DEFAULT_MAX_SLOT_IN_DAY,
    weights: { ...DEFAULT_WEIGHTS },
    window_short: 50,
    window_medium: 300,
    totals: [...TOTALS],
    theoretical_prob: { ...THEORETICAL_PROB },
    counts: {
      global: emptyTotalCounts(),
      prev_state: {
        Hòa: emptyTotalCounts(),
        Lớn: emptyTotalCounts(),
        Nhỏ: emptyTotalCounts(),
      },
      prev_total: Object.fromEntries(TOTALS.map((total) => [String(total), emptyTotalCounts()])),
      slot: {},
      weekday: Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [String(index), emptyTotalCounts()]),
      ),
    },
    recent_windows: { short: [], medium: [] },
    history_row_count: 0,
    last_observation: null,
  }
}

function ensureSlotBucket(state, slotInDay) {
  const slotKey = String(Number(slotInDay))
  if (!state.counts.slot[slotKey]) state.counts.slot[slotKey] = emptyTotalCounts()
}

function normalizeStateDict(rawState) {
  if (!rawState || typeof rawState !== 'object') return initEmptyState()

  const state = initEmptyState()
  state.version = numberOrZero(rawState.version) || state.version
  state.model_version = rawState.model_version || state.model_version
  state.max_slot_in_day = numberOrZero(rawState.max_slot_in_day) || state.max_slot_in_day
  state.weights = { ...state.weights, ...(rawState.weights || {}) }
  state.window_short = numberOrZero(rawState.window_short) || state.window_short
  state.window_medium = numberOrZero(rawState.window_medium) || state.window_medium

  for (const [key, value] of Object.entries(rawState.theoretical_prob || {})) {
    if (state.theoretical_prob[key] != null) state.theoretical_prob[key] = Number(value)
  }

  const counts = rawState.counts || {}
  for (const [key, value] of Object.entries(counts.global || {})) {
    if (state.counts.global[key] != null) state.counts.global[key] = numberOrZero(value)
  }
  for (const [rawPrevState, totalMap] of Object.entries(counts.prev_state || {})) {
    const prevState = normalizeStateValue(rawPrevState)
    if (!state.counts.prev_state[prevState]) continue
    for (const [key, value] of Object.entries(totalMap || {})) {
      if (state.counts.prev_state[prevState][key] != null) {
        state.counts.prev_state[prevState][key] = numberOrZero(value)
      }
    }
  }
  for (const [prevTotal, totalMap] of Object.entries(counts.prev_total || {})) {
    if (!state.counts.prev_total[String(prevTotal)]) continue
    for (const [key, value] of Object.entries(totalMap || {})) {
      if (state.counts.prev_total[String(prevTotal)][key] != null) {
        state.counts.prev_total[String(prevTotal)][key] = numberOrZero(value)
      }
    }
  }
  for (const [slotKey, totalMap] of Object.entries(counts.slot || {})) {
    ensureSlotBucket(state, slotKey)
    for (const [key, value] of Object.entries(totalMap || {})) {
      if (state.counts.slot[String(Number(slotKey))][key] != null) {
        state.counts.slot[String(Number(slotKey))][key] = numberOrZero(value)
      }
    }
  }
  for (const [weekdayKey, totalMap] of Object.entries(counts.weekday || {})) {
    if (!state.counts.weekday[String(Number(weekdayKey))]) continue
    for (const [key, value] of Object.entries(totalMap || {})) {
      if (state.counts.weekday[String(Number(weekdayKey))][key] != null) {
        state.counts.weekday[String(Number(weekdayKey))][key] = numberOrZero(value)
      }
    }
  }

  const recentWindows = rawState.recent_windows || {}
  state.recent_windows.short = Array.isArray(recentWindows.short)
    ? recentWindows.short.slice(-state.window_short).map((value) => Number(value))
    : []
  state.recent_windows.medium = Array.isArray(recentWindows.medium)
    ? recentWindows.medium.slice(-state.window_medium).map((value) => Number(value))
    : []

  const rawLast = rawState.last_observation
  if (rawLast && rawLast.date) {
    const dateString = normalizeDateString(rawLast.date)
    const prevTotalForNext = numberOrZero(rawLast.prev_total_for_next ?? rawLast.total) || 0
    state.last_observation = {
      date: dateString,
      period_id: canonicalPeriodId(rawLast.period_id ?? rawLast.id),
      slot_in_day: numberOrZero(rawLast.slot_in_day) || 1,
      weekday_idx: numberOrZero(rawLast.weekday_idx) || weekdayIndexFromDate(dateString),
      prev_total_for_next: prevTotalForNext,
      prev_state_for_next: normalizeStateValue(
        rawLast.prev_state_for_next ?? rawLast.prev_state,
        prevTotalForNext,
      ),
    }
  }

  const derivedHistoryRowCount = Object.values(state.counts.global).reduce(
    (sum, value) => sum + numberOrZero(value),
    0,
  )
  state.history_row_count = numberOrZero(rawState.history_row_count) || derivedHistoryRowCount
  return state
}

function buildCountVector(countMap) {
  return TOTALS.map((total) => numberOrZero(countMap?.[String(total)]))
}

function listToCountVector(values) {
  const counts = new Map()
  for (const value of values || []) {
    const numeric = Number(value)
    counts.set(numeric, (counts.get(numeric) || 0) + 1)
  }
  return TOTALS.map((total) => counts.get(total) || 0)
}

function normalizeVector(vector) {
  const total = vector.reduce((sum, value) => sum + value, 0)
  return total ? vector.map((value) => value / total) : TOTALS.map(() => 0)
}

function combineDistribution(base, weight, addition) {
  for (let index = 0; index < base.length; index += 1) {
    base[index] += weight * addition[index]
  }
}

function scoreNextTotals(state, nextSlotInDay, nextWeekdayIdx, prevTotal, prevState, historyRows) {
  const weights = state.weights || DEFAULT_WEIGHTS
  const theoretical = TOTALS.map((total) => Number(state.theoretical_prob[String(total)] || 0))
  const weightedScores = TOTALS.map(() => 0)
  const components = {}

  components.theoretical = theoretical
  combineDistribution(weightedScores, weights.theoretical, theoretical)

  const globalCounts = buildCountVector(state.counts.global)
  const globalDistribution = normalizeVector(
    globalCounts.map((count, index) => count + 5 * theoretical[index]),
  )
  components.global = globalDistribution
  combineDistribution(weightedScores, weights.global, globalDistribution)

  if (weights.recent_short && state.recent_windows.short.length) {
    const shortCounts = listToCountVector(state.recent_windows.short)
    const shortDistribution = normalizeVector(
      shortCounts.map((count, index) => count + 2 * theoretical[index]),
    )
    components.recent_short = shortDistribution
    combineDistribution(weightedScores, weights.recent_short, shortDistribution)
  }

  if (weights.recent_medium && state.recent_windows.medium.length) {
    const mediumCounts = listToCountVector(state.recent_windows.medium)
    const mediumDistribution = normalizeVector(
      mediumCounts.map((count, index) => count + 2 * theoretical[index]),
    )
    components.recent_medium = mediumDistribution
    combineDistribution(weightedScores, weights.recent_medium, mediumDistribution)
  }

  const normalizedPrevState = normalizeStateValue(prevState, prevTotal)
  if (state.counts.prev_state[normalizedPrevState]) {
    const prevStateCounts = buildCountVector(state.counts.prev_state[normalizedPrevState])
    const prevStateDistribution = normalizeVector(
      prevStateCounts.map((count, index) => count + theoretical[index]),
    )
    components.prev_state = prevStateDistribution
    combineDistribution(weightedScores, weights.prev_state, prevStateDistribution)
  }

  if (state.counts.prev_total[String(prevTotal)]) {
    const prevTotalCounts = buildCountVector(state.counts.prev_total[String(prevTotal)])
    const prevTotalDistribution = normalizeVector(
      prevTotalCounts.map((count, index) => count + theoretical[index]),
    )
    components.prev_total = prevTotalDistribution
    combineDistribution(weightedScores, weights.prev_total, prevTotalDistribution)
  }

  ensureSlotBucket(state, nextSlotInDay)
  const slotCounts = buildCountVector(state.counts.slot[String(nextSlotInDay)])
  const slotDistribution = normalizeVector(
    slotCounts.map((count, index) => count + theoretical[index]),
  )
  components.slot = slotDistribution
  combineDistribution(weightedScores, weights.slot, slotDistribution)

  const weekdayCounts = buildCountVector(state.counts.weekday[String(nextWeekdayIdx)])
  const weekdayDistribution = normalizeVector(
    weekdayCounts.map((count, index) => count + theoretical[index]),
  )
  components.weekday = weekdayDistribution
  combineDistribution(weightedScores, weights.weekday, weekdayDistribution)

  const recent6Raw = Array.isArray(historyRows) && historyRows.length
    ? historyRows.slice(-6).map(r => r.total).filter(t => t != null)
    : (state.recent_windows?.short || []).slice(-6)
  const recent6 = recent6Raw.map(Number).filter(Number.isFinite)
  const centerShare6 = recent6.length ? recent6.filter(t => t >= 9 && t <= 12).length / recent6.length : 0
  const edgeShare6 = recent6.length ? recent6.filter(t => t <= 8 || t >= 13).length / recent6.length : 0

  // Fix: phân biệt small edge (3-8) và large edge (13-18) riêng biệt
  const recentSmallShare6 = recent6.length ? recent6.filter(t => t <= 8).length / recent6.length : 0
  const recentLargeShare6 = recent6.length ? recent6.filter(t => t >= 13).length / recent6.length : 0

  for (let index = 0; index < weightedScores.length; index += 1) {
    const total = TOTALS[index]
    // Khi center nhiều (9-12) → boost edge (phân biệt small/large edge)
    if (centerShare6 >= 0.5) {
      if (total <= 8) weightedScores[index] *= 1.0 + recentSmallShare6 * 0.6
      else if (total >= 13) weightedScores[index] *= 1.0 + recentLargeShare6 * 0.6
    }
    // Khi edge nhiều (pha trộn) → boost center nhớm 9-12
    if (edgeShare6 >= 0.6 && total >= 9 && total <= 12) {
      weightedScores[index] *= 1.25
    }
    // Center quá nóng cụm 9-11 (>= 66%) → penalize
    if (centerShare6 >= 0.66 && total >= 9 && total <= 11) {
      const rawSupport = weightedScores[index]
      const dynamicPenaltyModifier = clamp(0.6 + (rawSupport - 0.1) * 2, 0.6, 0.88)
      weightedScores[index] *= dynamicPenaltyModifier
    }
  }

  const normalizedScores = normalizeVector(weightedScores)
  return {
    top3: TOTALS.map((total, index) => ({
      total,
      prob: normalizedScores[index],
      score: weightedScores[index],
    }))
      .sort((left, right) => right.prob - left.prob)
      .slice(0, 3),
    components,
  }
}

function topTotalFromComponent(distribution) {
  if (!Array.isArray(distribution) || !distribution.length) return null
  let bestIndex = 0
  for (let index = 1; index < distribution.length; index += 1) {
    if (distribution[index] > distribution[bestIndex]) bestIndex = index
  }
  return TOTALS[bestIndex]
}

function computeConfidenceScore(topScores) {
  if (!topScores || topScores.length < 3) return 0
  const top3Mass = topScores[0] + topScores[1] + topScores[2]
  const topGap = Math.max(0, topScores[0] - topScores[2])
  const raw =
    Math.min(top3Mass / 0.5, 1) * 0.5 +
    Math.min(topGap / 0.08, 1) * 0.35 +
    Math.min(topScores[0] / 0.26, 1) * 0.15
  return Math.max(0.15, Math.min(0.85, raw * 0.9))
}

function buildAvoidanceList(historyRows) {
  const totalsToAvoid = []
  const recent6 = historyRows.slice(-6).map(r => r.total).filter(t => t != null)
  const recent12 = historyRows.slice(-12).map(r => r.total).filter(t => t != null)
  const centerShare6 = recent6.length ? recent6.filter(t => t >= 9 && t <= 12).length / recent6.length : 0

  for (let total = 3; total <= 18; total++) {
    const r6Count = recent6.filter(t => t === total).length
    const r12Count = recent12.filter(t => t === total).length
    
    let gap = 0
    for (let i = historyRows.length - 1; i >= 0; i--) {
      if (historyRows[i].total === total) break
      gap++
    }

    if (r6Count >= 3 || (r12Count >= 4 && r6Count >= 2)) {
      totalsToAvoid.push({
        total,
        reason: 'Burnout (Nhịp ngắn quá dày)',
        severity: r6Count >= 3 ? 'HIGH' : 'MEDIUM'
      })
    } else if (gap >= 40) {
      totalsToAvoid.push({
        total,
        reason: 'Deep Gap (Đang đóng băng/chu kỳ trễ)',
        severity: gap >= 60 ? 'HIGH' : 'MEDIUM'
      })
    } else if (centerShare6 >= 0.66 && total >= 9 && total <= 12) {
      totalsToAvoid.push({
        total,
        reason: 'Center Heating (Rủi ro đảo nhịp biên)',
        severity: 'LOW'
      })
    }
  }
  return totalsToAvoid
}

function buildPredictionExplanation(top3, components, prevTotal, prevState, nextSlotInDay) {
  const totals = top3.map((item) => item.total)
  const bullets = []

  if (totals.some((total) => total >= 9 && total <= 13)) {
    bullets.push(
      'Phân phối dài hạn vẫn nghiêng về nhóm trung tâm 9-13, nên top 3 bám khá sát xác suất nền của 3 xúc xắc.',
    )
  } else {
    bullets.push(
      'Top 3 hiện lệch khỏi vùng trung tâm, nhưng đây vẫn chỉ là điều chỉnh mềm theo xác suất chứ không phải luật cứng.',
    )
  }

  const prevSignals = []
  const prevStateTop = topTotalFromComponent(components.prev_state)
  const prevTotalTop = topTotalFromComponent(components.prev_total)
  if (totals.includes(prevStateTop)) prevSignals.push(prevStateTop)
  if (totals.includes(prevTotalTop)) prevSignals.push(prevTotalTop)
  if (prevSignals.length) {
    bullets.push(
      `Ngữ cảnh kỳ trước ${normalizeStateValue(prevState, prevTotal)} / tổng ${prevTotal} đang kéo nhẹ về các tổng ${[...new Set(prevSignals)].join(', ')}.`,
    )
  }

  const softContexts = []
  const slotTop = topTotalFromComponent(components.slot)
  const recentTop = topTotalFromComponent(components.recent_medium)
  if (totals.includes(slotTop)) softContexts.push(`slot ${nextSlotInDay}`)
  if (totals.includes(recentTop)) softContexts.push('300 kỳ gần nhất')
  if (softContexts.length) {
    bullets.push(`Tín hiệu mềm từ ${softContexts.join(' và ')} đang ủng hộ thêm một phần cho top 3 hiện tại.`)
  }

  const spread = (top3[0]?.prob || 0) - (top3[2]?.prob || 0)
  bullets.push(
    spread < 0.01
      ? 'Khoảng cách giữa ba lựa chọn khá sát nhau, nên mức tự tin chỉ ở mức thấp-vừa.'
      : 'Top 1 có nhỉnh hơn nhưng khoảng cách không lớn; đây là dự đoán xác suất chứ không phải điều chắc chắn.',
  )

  return bullets.slice(0, 3)
}

function updateModelState(
  rawState,
  total,
  slotInDay,
  weekdayIdx,
  { prevTotal = null, prevState = null, date = null, periodId = null } = {},
) {
  const state = normalizeStateDict(rawState)
  ensureSlotBucket(state, slotInDay)
  state.counts.global[String(total)] += 1
  state.counts.slot[String(slotInDay)][String(total)] += 1
  state.counts.weekday[String(weekdayIdx)][String(total)] += 1

  if (prevState) {
    const normalizedPrevState = normalizeStateValue(prevState, prevTotal)
    if (state.counts.prev_state[normalizedPrevState]) {
      state.counts.prev_state[normalizedPrevState][String(total)] += 1
    }
  }
  if (prevTotal != null && state.counts.prev_total[String(prevTotal)]) {
    state.counts.prev_total[String(prevTotal)][String(total)] += 1
  }

  state.recent_windows.short.push(Number(total))
  state.recent_windows.short = state.recent_windows.short.slice(-state.window_short)
  state.recent_windows.medium.push(Number(total))
  state.recent_windows.medium = state.recent_windows.medium.slice(-state.window_medium)
  state.history_row_count = numberOrZero(state.history_row_count) + 1
  state.last_observation = {
    date,
    period_id: canonicalPeriodId(periodId),
    slot_in_day: Number(slotInDay),
    weekday_idx: Number(weekdayIdx),
    prev_total_for_next: Number(total),
    prev_state_for_next: computeStateLabel(total),
  }
  return state
}

function buildStateFromHistory(historyRows) {
  let state = initEmptyState()
  let prevTotal = null
  let prevState = null
  for (const row of historyRows) {
    state = updateModelState(state, row.total, row.slot_in_day, row.weekday_idx, {
      prevTotal,
      prevState,
      date: row.date,
      periodId: row.period_id,
    })
    prevTotal = row.total
    prevState = row.state
  }
  return state
}

function syncStateWithHistory(historyRows, rawState) {
  if (!historyRows.length) return { state: initEmptyState(), syncMode: 'empty_history' }
  const history = [...historyRows]
  const state = normalizeStateDict(rawState)
  const latestHistory = history[history.length - 1]
  const lastStateObservation = state.last_observation || {}

  if (
    canonicalPeriodId(lastStateObservation.period_id) === canonicalPeriodId(latestHistory.period_id) &&
    numberOrZero(state.history_row_count) === history.length
  ) {
    return { state, syncMode: 'loaded' }
  }

  const existingCount = numberOrZero(state.history_row_count)
  if (existingCount > 0 && existingCount < history.length) {
    const boundaryRow = history[existingCount - 1]
    if (
      boundaryRow &&
      canonicalPeriodId(boundaryRow.period_id) === canonicalPeriodId(lastStateObservation.period_id)
    ) {
      let nextState = normalizeStateDict(state)
      let prevTotal = boundaryRow.total
      let prevState = boundaryRow.state
      for (const row of history.slice(existingCount)) {
        nextState = updateModelState(nextState, row.total, row.slot_in_day, row.weekday_idx, {
          prevTotal,
          prevState,
          date: row.date,
          periodId: row.period_id,
        })
        prevTotal = row.total
        prevState = row.state
      }
      return { state: nextState, syncMode: 'incremental_sync' }
    }
  }

  return { state: buildStateFromHistory(history), syncMode: 'rebuilt' }
}

function nextPredictionContextFromState(state) {
  if (!state.last_observation) {
    throw new Error('State chưa có quan sát lịch sử để dự đoán.')
  }

  const lastDate = new Date(`${state.last_observation.date}T00:00:00`)
  const maxSlotInDay = numberOrZero(state.max_slot_in_day) || DEFAULT_MAX_SLOT_IN_DAY
  let predictedDate = state.last_observation.date
  let predictedSlotInDay = numberOrZero(state.last_observation.slot_in_day) + 1

  if (predictedSlotInDay > maxSlotInDay) {
    lastDate.setDate(lastDate.getDate() + 1)
    predictedDate = `${lastDate.getFullYear()}-${pad2(lastDate.getMonth() + 1)}-${pad2(lastDate.getDate())}`
    predictedSlotInDay = 1
  }

  const lastPeriodId = canonicalPeriodId(state.last_observation.period_id)
  return {
    predicted_period_id: lastPeriodId && /^\d+$/.test(lastPeriodId) ? String(Number(lastPeriodId) + 1) : null,
    predicted_date: predictedDate,
    predicted_slot_in_day: predictedSlotInDay,
    predicted_weekday_idx: weekdayIndexFromDate(predictedDate),
    prev_total: numberOrZero(state.last_observation.prev_total_for_next),
    prev_state: normalizeStateValue(
      state.last_observation.prev_state_for_next,
      numberOrZero(state.last_observation.prev_total_for_next),
    ),
  }
}

function buildPredictionContext(historyRows, state, existingPendingRow = null) {
  const context = nextPredictionContextFromState(state)
  const scored = scoreNextTotals(
    state,
    context.predicted_slot_in_day,
    context.predicted_weekday_idx,
    context.prev_total,
    context.prev_state,
    historyRows
  )
  
  const totalsToAvoid = buildAvoidanceList(historyRows)
  const confidence_score = computeConfidenceScore(scored.top3.map(i => i.prob))

  const prediction = {
    prediction_key: buildPredictionKey(
      context.predicted_period_id,
      context.predicted_date,
      context.predicted_slot_in_day,
    ),
    predicted_period_id: context.predicted_period_id,
    predicted_date: context.predicted_date,
    predicted_slot_in_day: context.predicted_slot_in_day,
    predicted_weekday_idx: context.predicted_weekday_idx,
    predicted_weekday: weekdayNameVi(context.predicted_weekday_idx),
    prev_total: context.prev_total,
    prev_state: context.prev_state,
    top3: scored.top3,
    confidence_score,
    totalsToAvoid,
    explanation: buildPredictionExplanation(
      scored.top3,
      scored.components,
      context.prev_total,
      context.prev_state,
      context.predicted_slot_in_day,
    ),
    model_version: state.model_version || DEFAULT_MODEL_VERSION,
    state_version: state.version || 2,
    created_at: nowIso(),
  }

  if (!existingPendingRow) return prediction
  prediction.created_at = existingPendingRow.prediction_created_at || prediction.created_at
  prediction.top3 = [
    {
      total: numberOrZero(existingPendingRow.pred_1),
      prob: numberOrZero(existingPendingRow.prob_1),
      score: numberOrZero(existingPendingRow.prob_1),
    },
    {
      total: numberOrZero(existingPendingRow.pred_2),
      prob: numberOrZero(existingPendingRow.prob_2),
      score: numberOrZero(existingPendingRow.prob_2),
    },
    {
      total: numberOrZero(existingPendingRow.pred_3),
      prob: numberOrZero(existingPendingRow.prob_3),
      score: numberOrZero(existingPendingRow.prob_3),
    },
  ].filter((item) => item.total >= 3 && item.total <= 18)
  
  prediction.confidence_score = computeConfidenceScore(prediction.top3.map(i => i.prob))
  
  return prediction
}

function predictionToLogRecord(prediction, source = 'web_tab_top3') {
  return {
    prediction_key: prediction.prediction_key,
    predicted_period_id: prediction.predicted_period_id,
    predicted_date: prediction.predicted_date,
    predicted_slot_in_day: prediction.predicted_slot_in_day,
    predicted_weekday: prediction.predicted_weekday,
    prediction_created_at: prediction.created_at,
    status: 'pending',
    prev_total: prediction.prev_total,
    prev_state: prediction.prev_state,
    predicted_top3: prediction.top3.map((item) => item.total).join(','),
    pred_1: prediction.top3[0]?.total ?? null,
    pred_2: prediction.top3[1]?.total ?? null,
    pred_3: prediction.top3[2]?.total ?? null,
    prob_1: prediction.top3[0]?.prob ?? null,
    prob_2: prediction.top3[1]?.prob ?? null,
    prob_3: prediction.top3[2]?.prob ?? null,
    actual_period_id: null,
    actual_date: null,
    actual_slot_in_day: null,
    actual_d1: null,
    actual_d2: null,
    actual_d3: null,
    actual_total: null,
    actual_state: null,
    hit_top3: HIT_LABELS.pending,
    resolved_at: null,
    model_version: prediction.model_version || DEFAULT_MODEL_VERSION,
    state_version: prediction.state_version || 2,
    source,
  }
}

function hydratePredictionFromLogRow(row) {
  return {
    prediction_key: row.prediction_key,
    predicted_period_id: canonicalPeriodId(row.predicted_period_id),
    predicted_date: row.predicted_date,
    predicted_slot_in_day: numberOrZero(row.predicted_slot_in_day),
    predicted_weekday_idx: weekdayIndexFromDate(row.predicted_date),
    predicted_weekday: row.predicted_weekday || weekdayNameVi(weekdayIndexFromDate(row.predicted_date)),
    prev_total: numberOrZero(row.prev_total),
    prev_state: normalizeStateValue(row.prev_state, numberOrZero(row.prev_total)),
    top3: [
      { total: numberOrZero(row.pred_1), prob: numberOrZero(row.prob_1), score: numberOrZero(row.prob_1) },
      { total: numberOrZero(row.pred_2), prob: numberOrZero(row.prob_2), score: numberOrZero(row.prob_2) },
      { total: numberOrZero(row.pred_3), prob: numberOrZero(row.prob_3), score: numberOrZero(row.prob_3) },
    ].filter((item) => item.total >= 3 && item.total <= 18),
    explanation: [
      'Đây là dự đoán đã được khóa trong log để giữ phép so sánh đúng cho kỳ đang chờ.',
      'Khoảng cách xác suất giữa các lựa chọn chỉ mang ý nghĩa tương đối.',
    ],
    model_version: row.model_version,
    state_version: numberOrZero(row.state_version) || 1,
    created_at: row.prediction_created_at,
  }
}

function compareWithActual(prediction, actualTotal) {
  const total = numberOrZero(actualTotal)
  const hit = prediction.top3.some((item) => item.total === total)
  return {
    actual_total: total,
    actual_state: computeStateLabel(total),
    hit_top3: hit ? HIT_LABELS.hit : HIT_LABELS.miss,
  }
}

function buildResolvedLogRecord(prediction, actual) {
  const comparison = compareWithActual(prediction, actual.total)
  const record = predictionToLogRecord(prediction)
  record.status = 'resolved'
  record.actual_period_id = canonicalPeriodId(actual.period_id)
  record.actual_date = actual.date
  record.actual_slot_in_day = actual.slot_in_day
  record.actual_d1 = actual.d1 ?? null
  record.actual_d2 = actual.d2 ?? null
  record.actual_d3 = actual.d3 ?? null
  record.actual_total = actual.total
  record.actual_state = comparison.actual_state
  record.hit_top3 = comparison.hit_top3
  record.resolved_at = nowIso()
  record.model_version = prediction.model_version || DEFAULT_MODEL_VERSION
  record.state_version = prediction.state_version || 2
  record.source = 'web_tab_top3'
  return record
}

function buildHistoryRowFromActual(prediction, actual) {
  const weekdayIdx = weekdayIndexFromDate(actual.date)
  return {
    period_id: canonicalPeriodId(actual.period_id) || prediction.predicted_period_id,
    date: actual.date,
    slot_in_day: actual.slot_in_day,
    weekday_idx: weekdayIdx,
    weekday_name: weekdayNameVi(weekdayIdx),
    d1: actual.d1 ?? null,
    d2: actual.d2 ?? null,
    d3: actual.d3 ?? null,
    result_text:
      actual.d1 != null && actual.d2 != null && actual.d3 != null
        ? `${actual.d1} ${actual.d2} ${actual.d3}`
        : '',
    total: actual.total,
    state: computeStateLabel(actual.total),
  }
}

function mergeHistoryRows(existingRows, incomingRows, options = {}) {
  const { resequenceSlots = false } = options
  const existing = normalizeHistoryRows(existingRows)
  const incoming = normalizeHistoryRows(incomingRows)
  const summary = { added: 0, updated: 0, unchanged: 0 }
  const byPeriodId = new Map(existing.map((row) => [row.period_id, { ...row }]))

  for (const row of incoming) {
    const current = byPeriodId.get(row.period_id)
    if (!current) {
      byPeriodId.set(row.period_id, { ...row })
      summary.added += 1
      continue
    }

    const changed = ['date', 'slot_in_day', 'd1', 'd2', 'd3', 'total', 'state'].some(
      (key) => String(current[key] ?? '') !== String(row[key] ?? ''),
    )
    if (changed) {
      byPeriodId.set(row.period_id, { ...current, ...row })
      summary.updated += 1
    } else {
      summary.unchanged += 1
    }
  }

  return {
    rows: resequenceSlots
      ? resequenceHistoryRows(Array.from(byPeriodId.values()))
      : normalizeHistoryRows(Array.from(byPeriodId.values())),
    summary,
  }
}

function upsertPredictionLogRows(existingRows, record) {
  const rows = normalizePredictionLogRows(existingRows)
  const normalizedRecord = normalizePredictionLogRows([record])[0]
  const index = rows.findIndex((row) => row.prediction_key === normalizedRecord.prediction_key)

  if (index === -1) {
    return { rows: normalizePredictionLogRows([...rows, normalizedRecord]), action: 'created' }
  }

  const current = { ...rows[index] }
  let changed = false
  for (const [key, value] of Object.entries(normalizedRecord)) {
    if (value == null || value === '') continue
    if (String(current[key] ?? '') !== String(value)) {
      current[key] = value
      changed = true
    }
  }
  if (current.actual_total != null) current.status = 'resolved'
  const nextRows = [...rows]
  nextRows[index] = current
  return { rows: normalizePredictionLogRows(nextRows), action: changed ? 'updated' : 'unchanged' }
}

function reconcileLogWithHistory(logRows, historyRows) {
  const normalizedLogRows = normalizePredictionLogRows(logRows)
  if (!normalizedLogRows.length || !historyRows.length) {
    return { rows: normalizedLogRows, updatedCount: 0 }
  }

  const historyByPeriod = new Map(historyRows.map((row) => [row.period_id, row]))
  const historyByContext = new Map(
    historyRows.map((row) => [buildPredictionKey(null, row.date, row.slot_in_day), row]),
  )

  let rows = [...normalizedLogRows]
  let updatedCount = 0
  for (const pendingRow of normalizedLogRows.filter((row) => row.status === 'pending')) {
    const historyMatch =
      historyByPeriod.get(canonicalPeriodId(pendingRow.predicted_period_id)) ||
      historyByContext.get(
        buildPredictionKey(null, pendingRow.predicted_date, pendingRow.predicted_slot_in_day),
      )
    if (!historyMatch) continue

    const prediction = hydratePredictionFromLogRow(pendingRow)
    const actual = {
      period_id: historyMatch.period_id,
      date: historyMatch.date,
      slot_in_day: historyMatch.slot_in_day,
      total: historyMatch.total,
      d1: historyMatch.d1,
      d2: historyMatch.d2,
      d3: historyMatch.d3,
    }
    const result = upsertPredictionLogRows(rows, buildResolvedLogRecord(prediction, actual))
    rows = result.rows
    if (result.action === 'updated' || result.action === 'created') updatedCount += 1
  }

  return { rows: normalizePredictionLogRows(rows), updatedCount }
}

function actualInputFromPayload(payload, prediction) {
  const d1 = numericValue(payload.d1)
  const d2 = numericValue(payload.d2)
  const d3 = numericValue(payload.d3)
  const providedDice = [d1, d2, d3].filter((value) => value != null)
  if (providedDice.length > 0 && providedDice.length !== 3) {
    throw new Error('Nếu nhập xúc xắc thì phải nhập đủ cả 3 viên.')
  }
  if (providedDice.length === 3 && providedDice.some((value) => value < 1 || value > 6)) {
    throw new Error('Mỗi viên xúc xắc phải nằm trong khoảng 1-6.')
  }

  let total = numericValue(payload.total)
  if (providedDice.length === 3) {
    const inferred = d1 + d2 + d3
    if (total != null && total !== inferred) {
      throw new Error('Tổng nhập tay không khớp với 3 viên xúc xắc.')
    }
    total = inferred
  }
  if (total == null || total < 3 || total > 18) {
    throw new Error('Tổng thực tế phải nằm trong khoảng 3-18.')
  }

  const slotInDay =
    numericValue(payload.slot_in_day ?? payload.slotInDay) || prediction.predicted_slot_in_day
  if (slotInDay <= 0) throw new Error('Slot phải lớn hơn 0.')

  return {
    period_id:
      canonicalPeriodId(payload.period_id ?? payload.periodId) ||
      prediction.predicted_period_id,
    date:
      normalizeDateString(payload.date || payload.actual_date) ||
      prediction.predicted_date,
    slot_in_day: slotInDay,
    total,
    d1,
    d2,
    d3,
  }
}

function historyRowsToCsv(historyRows) {
  return stringifyCsv(historyRows, [
    'period_id',
    'date',
    'slot_in_day',
    'weekday_name',
    'd1',
    'd2',
    'd3',
    'result_text',
    'total',
    'state',
  ])
}

function predictionLogRowsToCsv(logRows) {
  return stringifyCsv(logRows, DEFAULT_LOG_COLUMNS)
}

function rollingSeries(resolvedRows, windowSize) {
  const values = []
  for (let index = 0; index < resolvedRows.length; index += 1) {
    const slice = resolvedRows.slice(Math.max(0, index - windowSize + 1), index + 1)
    const hitRate =
      slice.reduce((sum, row) => sum + (row.hit_top3 === HIT_LABELS.hit ? 1 : 0), 0) /
      slice.length
    values.push({ order: index + 1, hit_rate: Number(hitRate.toFixed(4)) })
  }
  return values
}

function buildStats(historyRows, logRows) {
  const resolvedRows = normalizePredictionLogRows(logRows)
    .filter((row) => row.status === 'resolved' && row.actual_total != null)
    .sort((left, right) => {
      if (left.actual_date !== right.actual_date) {
        return String(left.actual_date || '').localeCompare(String(right.actual_date || ''))
      }
      return numberOrZero(left.actual_slot_in_day) - numberOrZero(right.actual_slot_in_day)
    })

  const overallHitRate = resolvedRows.length
    ? resolvedRows.reduce((sum, row) => sum + (row.hit_top3 === HIT_LABELS.hit ? 1 : 0), 0) /
      resolvedRows.length
    : null

  const actualDistributionMap = new Map(TOTALS.map((total) => [total, 0]))
  const predictedDistributionMap = new Map(TOTALS.map((total) => [total, 0]))
  const slotMap = new Map()
  const prevStateMap = new Map()
  const edgeGroupMap = new Map([
    ['Nhóm biên 3-5 / 16-18', { group: 'Nhóm biên 3-5 / 16-18', hits: 0, samples: 0 }],
    ['Ngoài nhóm biên', { group: 'Ngoài nhóm biên', hits: 0, samples: 0 }],
  ])

  for (const row of resolvedRows) {
    actualDistributionMap.set(
      numberOrZero(row.actual_total),
      (actualDistributionMap.get(numberOrZero(row.actual_total)) || 0) + 1,
    )
    for (const total of [row.pred_1, row.pred_2, row.pred_3]) {
      const numeric = numberOrZero(total)
      predictedDistributionMap.set(numeric, (predictedDistributionMap.get(numeric) || 0) + 1)
    }

    const slot = numberOrZero(row.predicted_slot_in_day)
    const slotBucket = slotMap.get(slot) || { slot_in_day: slot, hits: 0, samples: 0 }
    slotBucket.samples += 1
    if (row.hit_top3 === HIT_LABELS.hit) slotBucket.hits += 1
    slotMap.set(slot, slotBucket)

    const prevState = normalizeStateValue(row.prev_state, row.prev_total) || 'Không rõ'
    const prevStateBucket = prevStateMap.get(prevState) || {
      prev_state: prevState,
      hits: 0,
      samples: 0,
    }
    prevStateBucket.samples += 1
    if (row.hit_top3 === HIT_LABELS.hit) prevStateBucket.hits += 1
    prevStateMap.set(prevState, prevStateBucket)

    const edgeGroup = EDGE_TOTALS.has(numberOrZero(row.actual_total))
      ? 'Nhóm biên 3-5 / 16-18'
      : 'Ngoài nhóm biên'
    const edgeBucket = edgeGroupMap.get(edgeGroup)
    edgeBucket.samples += 1
    if (row.hit_top3 === HIT_LABELS.hit) edgeBucket.hits += 1
  }

  return {
    overall_hit_rate: overallHitRate,
    rolling: {
      r20: rollingSeries(resolvedRows, 20),
      r50: rollingSeries(resolvedRows, 50),
      r100: rollingSeries(resolvedRows, 100),
    },
    distributions: {
      total_distribution: TOTALS.map((total) => ({
        total,
        count: historyRows.filter((row) => row.total === total).length,
      })),
      prediction_vs_actual: TOTALS.map((total) => ({
        total,
        actual_count: actualDistributionMap.get(total) || 0,
        predicted_count: predictedDistributionMap.get(total) || 0,
      })),
    },
    performance: {
      by_slot: Array.from(slotMap.values())
        .map((row) => ({
          slot_in_day: row.slot_in_day,
          hit_rate: row.samples ? row.hits / row.samples : 0,
          samples: row.samples,
        }))
        .sort((left, right) => left.slot_in_day - right.slot_in_day),
      by_prev_state: Array.from(prevStateMap.values()).map((row) => ({
        prev_state: row.prev_state,
        hit_rate: row.samples ? row.hits / row.samples : 0,
        samples: row.samples,
      })),
      by_edge_group: Array.from(edgeGroupMap.values()).map((row) => ({
        group: row.group,
        hit_rate: row.samples ? row.hits / row.samples : 0,
        samples: row.samples,
      })),
    },
    latest_r20: rollingSeries(resolvedRows, 20).at(-1)?.hit_rate ?? null,
    latest_r50: rollingSeries(resolvedRows, 50).at(-1)?.hit_rate ?? null,
    latest_r100: rollingSeries(resolvedRows, 100).at(-1)?.hit_rate ?? null,
  }
}

function needsWebLogRepair(rawRows) {
  return (rawRows || []).some((row) => {
    const source = String(row.source || row.phase || '').trim()
    const actualTotal = numericValue(row.actual_total)
    if (source !== 'web_tab_top3' || actualTotal == null) return false
    const hitLabel = normalizeHitLabel(row.hit_top3)
    const predictedDate = normalizeDateString(row.predicted_date ?? row.date)
    const actualDate = normalizeDateString(row.actual_date)
    if (hitLabel === HIT_LABELS.pending) return true
    if (predictedDate && actualDate) {
      const predictedTime = new Date(`${predictedDate}T00:00:00`).getTime()
      const actualTime = new Date(`${actualDate}T00:00:00`).getTime()
      const dayDiff = Math.abs(predictedTime - actualTime) / (24 * 60 * 60 * 1000)
      if (Number.isFinite(dayDiff) && dayDiff > 45) return true
    }
    return false
  })
}

export function createBingo18Top3Service({ baseDir } = {}) {
  const paths = resolvePaths(baseDir)
  let cache = null
  let cacheKey = null
  let lastBootstrapActions = []

  function buildFileKey() {
    const files = [
      paths.crawlerDataJson,
      paths.runtimeHistoryCsv,
      paths.runtimePredictionLog,
      paths.runtimeModelState,
      paths.runtimeAnalysisReport,
    ]
    return files
      .map((filePath) => {
        try {
          const stat = fs.statSync(filePath)
          return `${filePath}:${stat.mtimeMs}:${stat.size}`
        } catch {
          return `${filePath}:missing`
        }
      })
      .join('|')
  }

  function persistHistory(historyRows) {
    backupFile(paths.runtimeHistoryCsv, paths.backupsDir)
    fs.writeFileSync(paths.runtimeHistoryCsv, historyRowsToCsv(historyRows), 'utf8')
  }

  function persistPredictionLog(logRows) {
    backupFile(paths.runtimePredictionLog, paths.backupsDir)
    fs.writeFileSync(paths.runtimePredictionLog, predictionLogRowsToCsv(logRows), 'utf8')
  }

  function persistModelState(modelState) {
    writeJsonFile(paths.runtimeModelState, modelState, paths.backupsDir)
  }

  function invalidateCache() {
    cache = null
    cacheKey = null
  }

  function loadMaterialized() {
    lastBootstrapActions = ensureBootstrap(paths)
    const currentKey = buildFileKey()
    if (cache && cacheKey === currentKey) return cache

    let historyRows = normalizeHistoryRows(readCsvFile(paths.runtimeHistoryCsv))
    const crawlerRows = readCrawlerRounds(paths.crawlerDataJson)
    const crawlerSyncSummary = {
      source_available: Boolean(paths.crawlerDataJson && fs.existsSync(paths.crawlerDataJson)),
      imported: crawlerRows.length,
      added: 0,
      updated: 0,
      unchanged: 0,
    }
    if (crawlerRows.length) {
      const crawlerMerge = mergeHistoryRows(historyRows, crawlerRows, {
        resequenceSlots: true,
      })
      historyRows = crawlerMerge.rows
      crawlerSyncSummary.added = crawlerMerge.summary.added
      crawlerSyncSummary.updated = crawlerMerge.summary.updated
      crawlerSyncSummary.unchanged = crawlerMerge.summary.unchanged
      if (crawlerMerge.summary.added > 0 || crawlerMerge.summary.updated > 0) {
        persistHistory(historyRows)
        lastBootstrapActions = [
          ...lastBootstrapActions,
          `Dong bo crawler: +${crawlerMerge.summary.added}, ~${crawlerMerge.summary.updated}`,
        ]
      }
    }
    const rawLogRows = readCsvFile(paths.runtimePredictionLog)
    let logRows = normalizePredictionLogRows(rawLogRows)
    const rawState = readJsonFile(paths.runtimeModelState, null)
    const { state, syncMode } = syncStateWithHistory(historyRows, rawState)
    const reconciliation = reconcileLogWithHistory(logRows, historyRows)
    logRows = reconciliation.rows
    let logChanged = reconciliation.updatedCount > 0 || needsWebLogRepair(rawLogRows)
    let stateChanged = syncMode !== 'loaded'

    let pendingPrediction = null
    if (historyRows.length) {
      const freshPrediction = buildPredictionContext(historyRows, state)
      const existingPendingRow = logRows.find(
        (row) => row.prediction_key === freshPrediction.prediction_key && row.status === 'pending',
      )
      const pendingUpsert = upsertPredictionLogRows(logRows, predictionToLogRecord(freshPrediction))
      if (pendingUpsert.action === 'created' || pendingUpsert.action === 'updated') {
        logRows = pendingUpsert.rows
        logChanged = true
      }
      pendingPrediction = existingPendingRow
        ? buildPredictionContext(historyRows, state, existingPendingRow)
        : freshPrediction
    }

    if (stateChanged) persistModelState(state)
    if (logChanged) persistPredictionLog(logRows)

    cache = {
      historyRows,
      logRows,
      modelState: state,
      pendingPrediction,
      latestRow: historyRows.at(-1) || null,
      analysisReport: readTextFile(paths.runtimeAnalysisReport),
      syncMode,
      bootstrapActions: lastBootstrapActions,
      stats: buildStats(historyRows, logRows),
      crawlerSyncSummary,
      paths: {
        crawler: paths.crawlerDataJson,
        history: paths.runtimeHistoryCsv,
        log: paths.runtimePredictionLog,
        state: paths.runtimeModelState,
        backups: paths.backupsDir,
      },
    }
    cacheKey = buildFileKey()
    return cache
  }

  return {
    invalidateCache,
    getDashboardSnapshot() {
      const materialized = loadMaterialized()
      return {
        ok: true,
        latest_row: materialized.latestRow,
        pending_prediction: materialized.pendingPrediction,
        recent_history: [...materialized.historyRows].slice(-12).reverse(),
        recent_logs: [...materialized.logRows].slice(-40).reverse(),
        summary: {
          history_rows: materialized.historyRows.length,
          log_rows: materialized.logRows.length,
          overall_hit_rate: materialized.stats.overall_hit_rate,
          latest_r20: materialized.stats.latest_r20,
          latest_r50: materialized.stats.latest_r50,
          latest_r100: materialized.stats.latest_r100,
          sync_mode: materialized.syncMode,
          crawler_imported: materialized.crawlerSyncSummary.imported,
          crawler_added: materialized.crawlerSyncSummary.added,
          crawler_updated: materialized.crawlerSyncSummary.updated,
        },
        crawler_sync: materialized.crawlerSyncSummary,
        stats: materialized.stats,
        analysis_report: materialized.analysisReport,
        files: materialized.paths,
        bootstrap_actions: materialized.bootstrapActions,
      }
    },
    getLogs(query = {}) {
      const materialized = loadMaterialized()
      const resultFilter = String(query.result || 'Tất cả')
      const limit = Math.max(1, Math.min(1000, numberOrZero(query.limit) || 100))
      const dateFrom = normalizeDateString(query.date_from || query.dateFrom) || null
      const dateTo = normalizeDateString(query.date_to || query.dateTo) || null
      const slotFrom = numberOrZero(query.slot_from ?? query.slotFrom) || 1
      const slotTo = numberOrZero(query.slot_to ?? query.slotTo) || DEFAULT_MAX_SLOT_IN_DAY

      let rows = [...materialized.logRows]
      if (resultFilter !== 'Tất cả') rows = rows.filter((row) => row.hit_top3 === resultFilter)
      if (dateFrom) rows = rows.filter((row) => String(row.predicted_date || '') >= dateFrom)
      if (dateTo) rows = rows.filter((row) => String(row.predicted_date || '') <= dateTo)
      rows = rows.filter((row) => {
        const slot = numberOrZero(row.predicted_slot_in_day)
        return slot >= slotFrom && slot <= slotTo
      })
      return { ok: true, total: rows.length, rows: rows.slice(-limit).reverse() }
    },
    submitActualResult(payload = {}) {
      const materialized = loadMaterialized()
      if (!materialized.pendingPrediction) {
        throw new Error('Chưa có dự đoán đang chờ để nhập kết quả thực tế.')
      }

      const prediction = materialized.pendingPrediction
      const actual = actualInputFromPayload(payload, prediction)
      const historyMerge = mergeHistoryRows(materialized.historyRows, [buildHistoryRowFromActual(prediction, actual)])
      const logUpsert = upsertPredictionLogRows(materialized.logRows, buildResolvedLogRecord(prediction, actual))
      const directNextContextMatch =
        canonicalPeriodId(actual.period_id) === canonicalPeriodId(prediction.predicted_period_id) &&
        actual.date === prediction.predicted_date &&
        actual.slot_in_day === prediction.predicted_slot_in_day
      const nextState = directNextContextMatch
        ? updateModelState(materialized.modelState, actual.total, actual.slot_in_day, weekdayIndexFromDate(actual.date), {
            prevTotal: prediction.prev_total,
            prevState: prediction.prev_state,
            date: actual.date,
            periodId: actual.period_id,
          })
        : buildStateFromHistory(historyMerge.rows)

      persistHistory(historyMerge.rows)
      persistPredictionLog(logUpsert.rows)
      persistModelState(nextState)
      invalidateCache()

      return {
        ok: true,
        actual,
        comparison: compareWithActual(prediction, actual.total),
        history_action:
          historyMerge.summary.added > 0
            ? 'created'
            : historyMerge.summary.updated > 0
              ? 'updated'
              : 'unchanged',
        log_action: logUpsert.action,
      }
    },
    importHistoryCsv(csvContent) {
      if (!String(csvContent || '').trim()) throw new Error('CSV import đang rỗng.')
      const incomingRows = normalizeHistoryRows(parseCsv(csvContent))
      const materialized = loadMaterialized()
      const historyMerge = mergeHistoryRows(materialized.historyRows, incomingRows)
      const nextState = buildStateFromHistory(historyMerge.rows)
      const reconciliation = reconcileLogWithHistory(materialized.logRows, historyMerge.rows)

      persistHistory(historyMerge.rows)
      persistPredictionLog(reconciliation.rows)
      persistModelState(nextState)
      invalidateCache()

      return {
        ok: true,
        validated_rows: incomingRows.length,
        rows_after_merge: historyMerge.rows.length,
        summary: historyMerge.summary,
        reconciled_logs: reconciliation.updatedCount,
      }
    },
  }
}
