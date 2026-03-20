import fs from 'fs'
import { buildPrediction } from './predictor.js'

const raw = fs.readFileSync(new URL('./data.json', import.meta.url), 'utf8')
const data = JSON.parse(raw)
const prediction = buildPrediction(Array.isArray(data.rounds) ? data.rounds : [])

console.log(JSON.stringify(prediction, null, 2))
