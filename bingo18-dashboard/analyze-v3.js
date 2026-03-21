import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { buildPrediction } from './predictor_v3.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_FILE = path.join(__dirname, 'data.json')

const raw = fs.readFileSync(DATA_FILE, 'utf8')
const parsed = JSON.parse(raw)
const rounds = Array.isArray(parsed.rounds) ? parsed.rounds : []
const prediction = buildPrediction(rounds)

console.log(JSON.stringify({
  model: prediction.methodology?.model,
  latestRound: prediction.dataset?.latestRound,
  resultProbabilities: prediction.diagnosis?.resultProbabilities,
  topTotals: prediction.diagnosis?.topTotals?.slice(0, 3),
  decision: prediction.selectiveStrategy?.currentDecision,
  validation: prediction.methodology?.validation,
}, null, 2))
