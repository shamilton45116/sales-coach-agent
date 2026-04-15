// history.js — Persists daily scores and computes WoW trends
// Scores are saved to history/scores.json and committed back to the repo
// by the GitHub Actions workflow after each run.

const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'history', 'scores.json');
const RETENTION_DAYS = 90;

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}

// Persist today's scored calls; prune entries older than RETENTION_DAYS
function saveToday(scoredCalls) {
  const history = loadHistory();
  const today   = todayKey();

  history[today] = scoredCalls.map((c) => ({
    rep:     c.rep,
    callId:  c.id,
    title:   c.title,
    overall: c.feedback.overall,
    verdict: c.feedback.verdict,
    scores:  c.feedback.scores,
  }));

  // Prune old entries
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  Object.keys(history).forEach((d) => {
    if (new Date(d) < cutoff) delete history[d];
  });

  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`History saved (${Object.keys(history).length} days on record)`);

  return history;
}

// Returns per-rep WoW trend data based on stored history
function getWoWTrends(history) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const thisWeekStart = daysAgo(7);
  const lastWeekStart = daysAgo(14);

  const repMap = {};

  Object.entries(history).forEach(([dateStr, calls]) => {
    const date = new Date(dateStr);
    const inThisWeek = date >= thisWeekStart && date <  today;
    const inLastWeek = date >= lastWeekStart && date <  thisWeekStart;
    if (!inThisWeek && !inLastWeek) return;

    calls.forEach((call) => {
      if (!repMap[call.rep]) {
        repMap[call.rep] = {
          thisWeek: { scores: [], dimensions: {} },
          lastWeek: { scores: [], dimensions: {} },
        };
      }
      const bucket = inThisWeek ? 'thisWeek' : 'lastWeek';
      repMap[call.rep][bucket].scores.push(call.overall);

      // Accumulate dimension scores for sparklines
      Object.entries(call.scores || {}).forEach(([dim, val]) => {
        if (!repMap[call.rep][bucket].dimensions[dim]) {
          repMap[call.rep][bucket].dimensions[dim] = [];
        }
        repMap[call.rep][bucket].dimensions[dim].push(val);
      });
    });
  });

  return Object.entries(repMap)
    .map(([rep, data]) => {
      const thisAvg = avg(data.thisWeek.scores);
      const lastAvg = avg(data.lastWeek.scores);
      const delta   = thisAvg !== null && lastAvg !== null ? thisAvg - lastAvg : null;

      // Per-dimension deltas
      const dimDeltas = {};
      const allDims   = new Set([
        ...Object.keys(data.thisWeek.dimensions),
        ...Object.keys(data.lastWeek.dimensions),
      ]);
      allDims.forEach((dim) => {
        const tw = avg(data.thisWeek.dimensions[dim] || []);
        const lw = avg(data.lastWeek.dimensions[dim] || []);
        if (tw !== null && lw !== null) dimDeltas[dim] = tw - lw;
      });

      return {
        rep,
        thisWeekAvg:  thisAvg,
        lastWeekAvg:  lastAvg,
        delta,
        dimDeltas,
        callsThisWeek: data.thisWeek.scores.length,
        callsLastWeek: data.lastWeek.scores.length,
      };
    })
    .filter((r) => r.thisWeekAvg !== null)
    .sort((a, b) => (b.thisWeekAvg || 0) - (a.thisWeekAvg || 0));
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

module.exports = { loadHistory, saveToday, getWoWTrends };
