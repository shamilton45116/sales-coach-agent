// reporter.js — Slack reporter using Bot Token (supports threading)
// Requires: SLACK_BOT_TOKEN (xoxb-...) and SLACK_CHANNEL (#channel-name or channel ID)

const SCORE_LABELS = {
  discovery:         'Discovery & Needs',
  rapport:           'Rapport',
  objectionHandling: 'Objection Handling',
  talkListenRatio:   'Talk / Listen',
  nextStepsClose:    'Next Steps / Close',
  productKnowledge:  'Product Knowledge',
};

async function sendDailyReport(scoredCalls, wowTrends = []) {
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;
  if (!token)   throw new Error('SLACK_BOT_TOKEN env var is not set.');
  if (!channel) throw new Error('SLACK_CHANNEL env var is not set.');

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // 1. Post summary message and capture ts for threading
  const summaryBlocks = buildSummaryBlocks(scoredCalls, wowTrends, date);
  const summaryRes    = await slackPost(token, {
    channel,
    blocks: summaryBlocks,
    text:   `🎯 Daily Sales Coach Report — ${date}`,
  });

  if (!summaryRes.ok) {
    throw new Error(`Slack summary post failed: ${JSON.stringify(summaryRes)}`);
  }

  const threadTs = summaryRes.ts;
  console.log(`Slack summary posted (ts: ${threadTs})`);

  // 2. Post each scorecard as a thread reply (worst first)
  const sorted = [...scoredCalls].sort((a, b) => a.feedback.overall - b.feedback.overall);
  for (const call of sorted) {
    const blocks = buildScorecardBlocks(call);
    await slackPost(token, {
      channel,
      thread_ts: threadTs,
      blocks,
      text: `${call.rep} — ${call.feedback.verdict} (${call.feedback.overall})`,
    });
    await sleep(500); // avoid Slack rate limits
  }

  console.log(`Slack report posted (${scoredCalls.length} scorecards in thread)`);
}

// ── Slack API ─────────────────────────────────────────────────────────────
async function slackPost(token, payload) {
  const fetch = require('node-fetch');
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Helpers ───────────────────────────────────────────────────────────────
function verdictEmoji(v) {
  return { Strong: '🟢', Solid: '🔵', 'Needs Work': '🟡', Struggling: '🔴' }[v] || '🟡';
}

function scoreEmoji(n) {
  return n >= 80 ? '🟢' : n >= 60 ? '🟡' : '🔴';
}

function deltaText(d) {
  if (d === null || d === undefined) return '—';
  if (d > 0) return `↑ +${d}`;
  if (d < 0) return `↓ ${d}`;
  return '→ 0';
}

function scoreBar(n) {
  const filled = Math.round(n / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${n}`;
}

// ── Summary message ───────────────────────────────────────────────────────
function buildSummaryBlocks(calls, wowTrends, date) {
  const avg = Math.round(calls.reduce((s, c) => s + c.feedback.overall, 0) / calls.length);
  const strong   = calls.filter(c => c.feedback.verdict === 'Strong' || c.feedback.verdict === 'Solid').length;
  const needAttn = calls.filter(c => c.feedback.verdict === 'Needs Work' || c.feedback.verdict === 'Struggling').length;

  const leaderboard = [...calls]
    .sort((a, b) => b.feedback.overall - a.feedback.overall)
    .map((c, i) => {
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      return `${medal} *${c.rep}* — ${verdictEmoji(c.feedback.verdict)} ${c.feedback.verdict} · *${c.feedback.overall}*${c.addedToLibrary ? ' 📚' : ''}`;
    }).join('\n');

  const wowLines = wowTrends.length
    ? wowTrends.map(r =>
        `• *${r.rep}* — This wk: *${r.thisWeek}* | Last wk: ${r.lastWeek ?? '—'} | ${deltaText(r.delta)}`
      ).join('\n')
    : '_Trends available after two weeks of scored calls._';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎯 Daily Sales Coach Report — ${date}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Calls reviewed*\n${calls.length}` },
        { type: 'mrkdwn', text: `*Avg score*\n${scoreEmoji(avg)} ${avg}` },
        { type: 'mrkdwn', text: `*Strong / Solid*\n🟢 ${strong}` },
        { type: 'mrkdwn', text: `*Need attention*\n🔴 ${needAttn}` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Today\'s leaderboard*\n${leaderboard}` },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Week-over-week trends*\n${wowLines}` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Full scorecards are in the thread below · Powered by Claude' }],
    },
  ];
}

// ── Scorecard (thread reply) ──────────────────────────────────────────────
function buildScorecardBlocks(call) {
  const f        = call.feedback;
  const duration = Math.round((call.duration || 0) / 60);
  const callDate = new Date(call.started).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });

  const scoreLines = Object.entries(f.scores)
    .map(([k, v]) => `\`${scoreBar(v)}\`  ${SCORE_LABELS[k] || k}`)
    .join('\n');

  const strengthLines = f.strengths && f.strengths.length
    ? f.strengths.map(s => `✅ *${s.point}*\n    _"${s.evidence}"_`).join('\n')
    : '_Nothing notable to highlight._';

  const coachLines = f.coachingNotes && f.coachingNotes.length
    ? f.coachingNotes.map(c => `⚠️ *${c.note}*\n    _"${c.callMoment}"_`).join('\n')
    : '_No coaching notes for this call._';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${verdictEmoji(f.verdict)} *${call.rep}* — ${f.verdict} · *${f.overall}/100*${call.addedToLibrary ? '  📚 _Added to Gong Library_' : ''}`,
          `_${call.title} · ${duration} min · ${callDate}_`,
          '',
          f.callSummary,
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Score breakdown*\n${scoreLines}` },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Strengths (${f.strengths ? f.strengths.length : 0})*\n${strengthLines}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Needs improvement (${f.coachingNotes ? f.coachingNotes.length : 0})*\n${coachLines}` },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `⚡ *Priority action*\n${f.priorityAction}` },
        { type: 'mrkdwn', text: `💡 *Next call tip*\n${f.nextCallTip}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🎯 *Moment of truth*\n_"${f.momentOfTruth}"_` },
    },
  ];
}

module.exports = { sendDailyReport };
