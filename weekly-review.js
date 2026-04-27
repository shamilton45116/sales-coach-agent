// weekly-review.js
// Runs every Friday via .github/workflows/weekly-review.yml
//
// 1. Reads this week's scored calls from history/scores.json
// 2. Sends scores + coaching notes to Claude
// 3. Claude identifies common patterns and rewrites scorer.js
// 4. Posts a summary to Slack
// 5. The workflow then commits the updated scorer.js back to the repo

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const SCORES_PATH = path.join(__dirname, 'history', 'scores.json');
const SCORER_PATH = path.join(__dirname, 'scorer.js');

const {
  ANTHROPIC_API_KEY,
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL,
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------- helpers ----------

function loadScores() {
  if (!fs.existsSync(SCORES_PATH)) {
    console.log('No scores.json found — nothing to review.');
    return {};
  }
  const raw = fs.readFileSync(SCORES_PATH, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function loadScorer() {
  if (!fs.existsSync(SCORER_PATH)) {
    throw new Error('scorer.js not found at repo root');
  }
  return fs.readFileSync(SCORER_PATH, 'utf8');
}

// scores.json shape (saved by history.js):
// { "2026-04-23": [ {rep, callId, overall, coachingNotes, ...}, ... ], "2026-04-24": [...] }
function filterThisWeek(scores) {
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 7);
  cutoff.setHours(0, 0, 0, 0);

  const recent = [];
  for (const [dateStr, calls] of Object.entries(scores)) {
    const d = new Date(dateStr);
    if (isNaN(d)) continue;
    if (d < cutoff || d > today) continue;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      recent.push({ date: dateStr, ...call });
    }
  }
  return recent;
}

async function postToSlack(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL) {
    console.log('Slack creds missing — skipping Slack post.');
    return;
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text,
      unfurl_links: false,
    }),
  });
  const data = await res.json();
  if (!data.ok) console.error('Slack error:', data);
}

// ---------- main ----------

async function main() {
  const allScores = loadScores();
  const thisWeek = filterThisWeek(allScores);

  console.log(`Found ${thisWeek.length} scored calls in the last 7 days.`);

  if (thisWeek.length === 0) {
    await postToSlack(
      ':brain: *Weekly Rubric Review* — no scored calls this week, rubric unchanged.'
    );
    return;
  }

  const currentScorer = loadScorer();

  const prompt = `You are a sales enablement expert reviewing this week's call coaching data to improve our scoring rubric.

You will receive:
1. The current scorer.js file (the rubric in code)
2. This week's scored calls — each entry has: rep, callId, title, overall (0-100 score), verdict, scores (per-dimension breakdown), callSummary, coachingNotes (array), strengths (array), priorityAction

Your job:
- Identify the 3-5 most common patterns across the coachingNotes and per-dimension scores (recurring weaknesses, missed opportunities, or scoring blind spots)
- Rewrite scorer.js to reflect what you learned (tighten criteria, add new checks, adjust weights)
- Keep the same exported function signatures so the rest of the app keeps working
- Preserve all existing exports and CommonJS module.exports structure

Respond with ONLY a JSON object in this exact shape, nothing else:
{
  "summary": "1-2 sentence overview of what changed and why",
  "patterns": ["pattern 1", "pattern 2", "pattern 3"],
  "updatedScorerJs": "the full new contents of scorer.js as a string"
}

=== CURRENT scorer.js ===
${currentScorer}

=== THIS WEEK'S CALLS (${thisWeek.length}) ===
${JSON.stringify(thisWeek, null, 2)}`;

  console.log('Calling Claude to analyse patterns and update rubric...');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Strip code fences if Claude added them
  const jsonText = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error('Failed to parse Claude response as JSON:');
    console.error(text);
    throw err;
  }

  const { summary, patterns, updatedScorerJs } = parsed;

  if (!updatedScorerJs || typeof updatedScorerJs !== 'string') {
    throw new Error('Claude did not return updatedScorerJs');
  }

  fs.writeFileSync(SCORER_PATH, updatedScorerJs, 'utf8');
  console.log('scorer.js updated.');

  const slackMsg = [
    ':brain: *Weekly Rubric Update — Sales Coach Improved*',
    '',
    `Reviewed *${thisWeek.length}* calls this week and updated the rubric.`,
    '',
    `*Summary:* ${summary}`,
    '',
    '*Patterns identified:*',
    ...(patterns || []).map(p => `• ${p}`),
  ].join('\n');

  await postToSlack(slackMsg);
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
