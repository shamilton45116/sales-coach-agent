// weekly-review.js — Weekly rubric improvement agent
// Runs every Friday. Reads the week's scoring history, identifies coaching
// patterns, rewrites scorer.js to reflect what it learned, commits to GitHub,
// and posts a summary to Slack.

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Load this week's calls from history ──────────────────────────────────
function getThisWeeksCalls() {
  const historyFile = path.join(__dirname, 'history', 'scores.json');
  if (!fs.existsSync(historyFile)) return [];

  const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));

  const now  = new Date(); now.setHours(0,0,0,0);
  const week = new Date(now); week.setDate(week.getDate() - 7);

  const calls = [];
  Object.entries(history).forEach(([dateStr, dayCalls]) => {
    if (new Date(dateStr) >= week) {
      dayCalls.forEach(c => calls.push(c));
    }
  });

  return calls;
}

// ── Ask Claude to analyse patterns and rewrite scorer.js ─────────────────
async function analyseAndRewrite(calls, currentScorer) {
  const callSummaries = calls.map(c => ({
    rep:           c.rep,
    title:         c.title,
    overall:       c.overall,
    verdict:       c.verdict,
    scores:        c.scores,
    coachingNotes: c.feedback?.coachingNotes || [],
    strengths:     c.feedback?.strengths || [],
    priorityAction: c.feedback?.priorityAction || '',
  }));

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: `You are an expert sales coaching system designer for TOOLBX, a construction technology company selling ERP-integrated e-commerce, customer portals, and AI Order Automation to independent building material dealers and lumberyards.

Your job is to review a week of sales call scoring data, identify recurring patterns, and improve the scoring rubric in scorer.js to be more accurate and useful for the TOOLBX sales team.

You will be given:
1. A week of scored calls with coaching notes, strengths, and scores
2. The current scorer.js file

Your task:
- Identify the 3-5 most common coaching patterns this week (things reps repeatedly struggled with or did well)
- Identify any scoring dimensions that seem miscalibrated (e.g. scores that seem too high or low given the coaching notes)
- Rewrite the SYSTEM_PROMPT inside scorer.js to better reflect what you learned
- Keep all the JSON output format instructions exactly as they are — only update the rubric descriptions and TOOLBX context
- Do NOT change any JavaScript code outside of the SYSTEM_PROMPT string

Return a JSON object with exactly this structure:
{
  "patterns": [
    { "pattern": "what you observed", "frequency": "how many calls showed this", "action": "what you changed in the rubric" }
  ],
  "changes": "2-3 sentence plain English summary of what you changed and why",
  "updatedScorer": "<complete updated scorer.js file contents as a string>"
}`,
    messages: [{
      role: 'user',
      content: `This week's calls (${calls.length} total):\n${JSON.stringify(callSummaries, null, 2)}\n\nCurrent scorer.js:\n${currentScorer}`,
    }],
  });

  const raw = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ── Post Slack summary ────────────────────────────────────────────────────
async function postSlackSummary(analysis, callCount) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;

  const patternLines = analysis.patterns
    .map(p => `• *${p.pattern}* (${p.frequency})\n  _→ ${p.action}_`)
    .join('\n');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🧠 Weekly Rubric Update — Sales Coach Improved' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Reviewed *${callCount} calls* from this week and updated the scoring rubric.\n\n*What changed:*\n${analysis.changes}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Patterns identified this week:*\n${patternLines}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'scorer.js has been updated and committed to GitHub · Takes effect from Monday' }],
    },
  ];

  // Prefer bot token + channel for consistency with daily report
  if (token && channel) {
    const fetch = require('node-fetch');
    await fetch('https://slack.com/api/chat.postMessage', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ channel, blocks, text: '🧠 Weekly rubric update completed' }),
    });
  } else if (webhook) {
    const fetch = require('node-fetch');
    await fetch(webhook, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ blocks }),
    });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🧠 Weekly Review Agent starting...');

  const calls = getThisWeeksCalls();
  console.log(`Found ${calls.length} call(s) from this week`);

  if (calls.length < 3) {
    console.log('Not enough calls to draw meaningful patterns (need at least 3). Skipping.');
    return;
  }

  const scorerPath    = path.join(__dirname, 'scorer.js');
  const currentScorer = fs.readFileSync(scorerPath, 'utf8');

  console.log('Analysing patterns and rewriting rubric...');
  const analysis = await analyseAndRewrite(calls, currentScorer);

  // Write updated scorer.js
  fs.writeFileSync(scorerPath, analysis.updatedScorer);
  console.log('scorer.js updated');

  // Post Slack summary
  await postSlackSummary(analysis, calls.length);
  console.log('Slack summary posted');

  // Log patterns
  console.log('\nPatterns identified:');
  analysis.patterns.forEach(p => console.log(`  • ${p.pattern} (${p.frequency})`));
  console.log(`\nChanges: ${analysis.changes}`);

  console.log('\n✅ Weekly review complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
