const evalRoundsArg = process.argv[2]
const evalRounds = Number(evalRoundsArg || 30)

if (!Number.isFinite(evalRounds) || evalRounds <= 0) {
  console.error('Invalid eval rounds. Usage: node benchmark-v2-runner.js <positive-number>')
  process.exit(1)
}

process.env.BENCH_EVAL_ROUNDS = String(evalRounds)

await import('./benchmark-v2.js')
