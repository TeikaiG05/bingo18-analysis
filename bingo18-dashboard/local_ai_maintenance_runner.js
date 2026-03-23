import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildLocalMaintenanceReport,
  normalizeStoredRound,
} from './local_ai_pipeline.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data.json')
const OUTPUT_FILE = process.env.LOCAL_AI_MAINTENANCE_FILE
  ? path.resolve(process.env.LOCAL_AI_MAINTENANCE_FILE)
  : path.join(__dirname, 'local-ai-maintenance-report.json')
const OUTPUT_MARKDOWN_FILE = OUTPUT_FILE.replace(/\.json$/i, '.md')

function readRounds() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  return (Array.isArray(parsed?.rounds) ? parsed.rounds : [])
    .map(normalizeStoredRound)
    .filter(Boolean)
}

const roundsDesc = readRounds()
const report = buildLocalMaintenanceReport(roundsDesc, {
  evalRounds: Number(process.env.LOCAL_AI_EVAL_ROUNDS || 180),
  minTrainRounds: Number(process.env.LOCAL_AI_MIN_TRAIN_ROUNDS || 180),
  trainWindow: Number(process.env.LOCAL_AI_TRAIN_WINDOW || 320),
})

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf8')

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`
}

function renderTopTotals(items = []) {
  return items
    .map((item) => `${Number(item?.total)} (${formatPercent(Number(item?.probability || 0) * 100)})`)
    .join(', ')
}

function renderWindowRows(version) {
  const rows = []
  for (let window = 2; window <= 30; window += 1) {
    const row = version.backtest.windows[String(window)]
    rows.push(
      `| ${window} | ${row.hits} | ${row.misses} | ${formatPercent(Number(row.hitRate || 0) * 100)} | ${row.longestHitStreak} | ${row.longestMissStreak} | ${(row.topSuggestedTotals || []).slice(0, 3).map((item) => `${item.total}x${item.count}`).join(', ') || '--'} | ${formatPercent(Number(row.avgConfidence || 0) * 100)} |`,
    )
  }
  return rows.join('\n')
}

const bestVersion = report.versions.find(
  (version) => version.id === report.bestVersionId,
)

const markdown = [
  '# Local AI Maintenance Report',
  '',
  `Generated: ${report.generatedAt}`,
  `Latest round: ${report.dataset.latestRoundId}`,
  `Dataset rounds: ${report.dataset.totalRounds}`,
  `Eval rounds: ${report.dataset.evalRounds}`,
  `Train window: ${report.dataset.trainWindow}`,
  '',
  '## A. Thay doi pipeline',
  '- Them pipeline versioned cho Local AI voi 4 triet ly: baseline, ngan han, can bang, on dinh.',
  '- Dung feature co giai thich: nhip ngan han, nhip trung han, nen lich su, transition sau ky truoc, gap, deficit so voi prior, drift, edge boost theo gap.',
  '- Chuan hoa confidence ve thang 0-1 va cham version theo backtest 20-30 ky thay vi chon cam tinh.',
  '- Backfill worker cua AI LOCAL da doi sang baseline versioned thay cho rolling scorer cu.',
  '',
  '## B. Danh sach version',
  ...report.versions.map(
    (version) =>
      `- ${version.label} (\`${version.id}\`): ${version.philosophy}`,
  ),
  '',
  '## C. Top 3 tong hien tai cua tung version',
  ...report.versions.map((version) => {
    const current = version.current
    return `- ${version.label}: ${renderTopTotals(current.topTotals)} | result=${current.result} | confidence=${formatPercent(Number(current.confidence || 0) * 100)} | ${current.explanation}`
  }),
  '',
  '## D. Bang doi chieu 2-30 ky cho tung version',
  ...report.versions.flatMap((version) => [
    '',
    `### ${version.label}`,
    '',
    '| Window | Hits | Misses | Hit rate | Longest hit | Longest miss | Top totals de xuat nhieu nhat | Avg confidence |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    renderWindowRows(version),
  ]),
  '',
  '## E. So sanh version',
  '| Rank | Version | Score | Hit rate 30 ky | Longest miss 30 ky | Avg confidence 30 ky |',
  '| --- | --- | --- | --- | --- | --- |',
  ...report.ranking.map(
    (item, index) =>
      `| ${index + 1} | ${item.label} | ${Number(item.score || 0).toFixed(4)} | ${formatPercent(Number(item.window30HitRate || 0) * 100)} | ${item.window30LongestMiss} | ${formatPercent(Number(item.window30AvgConfidence || 0) * 100)} |`,
  ),
  '',
  '## F. Version nen dung chinh',
  bestVersion
    ? `- Nen uu tien **${bestVersion.label}** lam version chinh hien tai vi score backtest tong hop dang cao nhat trong nhom maintenance.`
    : '- Chua xac dinh duoc version tot nhat.',
  '',
  '## G. Buoc cai tien tiep theo',
  '- Tiep tuc hieu chinh confidence de giam do lech giua confidence va hit-rate 20-30 ky.',
  '- Dua report maintenance vao UI/route rieng de doi chieu version truc tiep.',
  '- Neu hit-rate 20-30 ky van duoi muc tieu, can them feature theo chuoi ket qua va profile theo khung gio/ngay.',
  '- Khong khang dinh 100%; version duoc chon chi la version co so lieu backtest tot hon o thoi diem maintenance.',
  '',
].join('\n')

fs.writeFileSync(OUTPUT_MARKDOWN_FILE, markdown, 'utf8')

const rankingText = (report.ranking || [])
  .slice(0, 4)
  .map(
    (item, index) =>
      `${index + 1}. ${item.label} | score=${Number(item.score || 0).toFixed(4)} | win30=${Number((item.window30HitRate || 0) * 100).toFixed(2)}% | miss30=${item.window30LongestMiss}`,
  )
  .join('\n')

console.log(
  [
    `[local-ai-maintenance] best=${report.bestVersionId}`,
    `[local-ai-maintenance] output=${OUTPUT_FILE}`,
    `[local-ai-maintenance] markdown=${OUTPUT_MARKDOWN_FILE}`,
    rankingText,
  ]
    .filter(Boolean)
    .join('\n'),
)
