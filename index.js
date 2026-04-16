const fs   = require('fs');
const path = require('path');

const { fetchYesterdaysCalls, addCallsToLibrary } = require('./gong');
const { scoreCall }                               = require('./scorer');
const { sendDailyReport }                         = require('./reporter');
const { saveToday, getWoWTrends }                 = require('./history');

const LIBRARY_THRESHOLD = 80;

// Guard against duplicate runs — GitHub Actions scheduler can fire twice
function alreadyRanToday() {
  const historyFile = path.join(__dirname, 'history', 'scores.json');
  if (!fs.existsSync(historyFile)) return false;
  const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const key = yesterday.toISOString().split('T')[0];
  return !!history[key];
}

async function main() {
  console.log('🎯 Sales Coach Agent starting...');
  console.log(`Date: ${new Date().toLocaleDateString()}\n`);

  if (alreadyRanToday()) {
    console.log('Already ran for yesterday — exiting to prevent duplicate reports.');
    return;
  }

  const calls = await fetchYesterdaysCalls();
  console.log(`Found ${calls.length} call(s) to review`);

  if (calls.length === 0) {
    console.log('No calls to review — no report sent.');
    return;
  }

  const scoredCalls = [];
  for (const call of calls) {
    console.log(`  Scoring: "${call.title}" — ${call.rep}`);
    try {
      const scored = await scoreCall(call);
      scoredCalls.push(scored);
      console.log(`    → ${scored.feedback.verdict} (${scored.feedback.overall})`);
    } catch (err) {
      console.error(`  Failed to score call ${call.id}:`, err.message);
    }
  }

  const libraryCalls = scoredCalls.filter(c => c.feedback.overall >= LIBRARY_THRESHOLD);
  if (libraryCalls.length > 0) {
    console.log(`\nTagging ${libraryCalls.length} call(s) for Gong Library...`);
    await addCallsToLibrary(libraryCalls.map(c => c.id));
  }

  scoredCalls.forEach(c => {
    c.addedToLibrary = c.feedback.overall >= LIBRARY_THRESHOLD;
  });

  const history   = saveToday(scoredCalls);
  const wowTrends = getWoWTrends(history);

  await sendDailyReport(scoredCalls, wowTrends);
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
