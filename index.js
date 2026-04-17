const fs   = require('fs');
const path = require('path');

const { fetchYesterdaysCalls, addCallsToLibrary } = require('./gong');
const { scoreCall }                               = require('./scorer');
const { sendDailyReport }                         = require('./reporter');
const { saveToday, getWoWTrends }                 = require('./history');

const LIBRARY_THRESHOLD = 80;
const RUN_LOCK_FILE     = path.join(__dirname, 'history', 'last-run.json');

// Guard against duplicate runs — tracks the date the agent last ran
function alreadyRanToday() {
  if (!fs.existsSync(RUN_LOCK_FILE)) return false;
  const { lastRun } = JSON.parse(fs.readFileSync(RUN_LOCK_FILE, 'utf8'));
  const today = new Date().toISOString().split('T')[0];
  return lastRun === today;
}

function markRanToday() {
  const today = new Date().toISOString().split('T')[0];
  fs.writeFileSync(RUN_LOCK_FILE, JSON.stringify({ lastRun: today }));
}

async function main() {
  console.log('🎯 Sales Coach Agent starting...');
  console.log(`Date: ${new Date().toLocaleDateString()}\n`);

  if (alreadyRanToday()) {
    console.log('Already ran today — exiting to prevent duplicate reports.');
    return;
  }

  // Mark as ran immediately so any parallel run exits
  markRanToday();

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
