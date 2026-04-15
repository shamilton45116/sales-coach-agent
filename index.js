const { fetchYesterdaysCalls, addCallsToLibrary } = require('./gong');
const { scoreCall }                               = require('./scorer');
const { sendDailyReport }                         = require('./reporter');
const { saveToday, getWoWTrends }                 = require('./history');

const LIBRARY_THRESHOLD = 80;

async function main() {
  console.log('🎯 Sales Coach Agent starting...');
  console.log(`Date: ${new Date().toLocaleDateString()}\n`);

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
