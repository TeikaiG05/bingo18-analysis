import fs from 'fs';
const d = JSON.parse(fs.readFileSync('local-ai-memory.json', 'utf8'));
const lines = d.history.slice(0,10).map(x => `${x.roundId} -> Pred: [${x.predictedTotals.join(', ')}] / Act: ${x.actualTotal} / Hit: ${x.hit} / Strat: ${x.bestStrategy}`);
fs.writeFileSync('check_out.txt', lines.join('\n'));
