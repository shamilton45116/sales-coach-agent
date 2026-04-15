// reporter.js — Slack reporter for Sales Coach Agent
// Uses a Slack Incoming Webhook URL (set SLACK_WEBHOOK_URL env var)
// Summary posted to the channel; each rep's full scorecard posted as a thread reply

async function sendDailyReport(scoredCalls, wowTrends = []) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) throw new Error('SLACK_WEBHOOK_URL env var is not set.');

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const avg = Math.round(
    scoredCalls.reduce((s, c) => s + c.feedback.overall, 0) / scoredCalls.length
  );

  const verdictCounts = { Strong: 0, Solid: 0, 'Needs Work': 0, Struggling: 0 };
  scoredCalls.forEach(c => {
    verdictCounts[c.feedback.verdict] = (verdictCounts[c.feedback.verdict] || 0) + 1;
  });

  // ── 1. Post the summary message ──────────────────────────────────────────
  const summaryBlocks = buildSummaryBlocks(scoredCalls, wowTrends, date, avg, verdictCounts);
  const summaryRes = await slackPost(webhook, { blocks: summaryBlocks });

  // Slack returns ts (timestamp) which we need to post thread replies
  const threadTs = summaryRes?.ts;
  const channel  = summaryRes?.channel;

  // ── 2. Post each scorecard as a thread reply (worst first) ────────────────
  if (threadTs && channel) {
    const sorted = [...scoredCalls].sort((a, b) => a.feedback.overall - b.feedback.overall);
    for (const call of sorted) {
      const blocks = buildScorecardBlocks(call);
      await slackPost(webhook, { blocks, thread_ts: threadTs, channel });
      await sleep(300); // avoid Slack rate limits
    }
  }

  console.log(`Slack report posted (${scoredCalls.length} scorecards in thread)`);
}

// ── Slack API helpers ─────────────────────────────────────────────────────

async function slackPost(webhook, payload) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // Incoming webhooks return "ok" as plain text, not JSON
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: text === 'ok' }; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Emoji / label helpers ─────────────────────────────────────────────────

function verdictEmoji(verdict) {
  return { Strong: '🟢', Solid: '🔵', 'Needs Work': '🟡', Struggling: '🔴' }[verdict] || '🟡';
}

function scoreEmoji(n) {
  if (n >= 80) return '🟢';
  if (n >= 60) return '🟡';
  return '🔴';
}

function deltaText(d) {
  if (d === null || d === undefined) return '—';
  if (d > 0) return `↑ +${d}`;
  if (d < 0) return `↓ ${d}`;
  return '→ 0';
}

function scoreBar(n) {
  const filled = Math.round(n / 10); // 0-10 blocks
  const empty  = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty) + ` ${n}`;
}

const SCORE_LABELS = {
  discovery:         'Discovery & Needs',
  rapport:           'Rapport',
  objectionHandling: 'Objection Handling',
  talkListenRatio:   'Talk / Listen',
  nextStepsClose:    'Next Steps / Close',
  productKnowledge:  'Product Knowledge',
};

// ── Summary message blocks ────────────────────────────────────────────────

function buildSummaryBlocks(calls, wowTrends, date, avg, verdictCounts) {
  const strong   = verdictCounts['Strong'] + verdictCounts['Solid'];
  const needAttn = verdictCounts['Needs Work'] + verdictCounts['Struggling'];

  // Leaderboard (best first)
  const leaderboard = [...calls]
    .sort((a, b) => b.feedback.overall - a.feedback.overall)
    .map((c, i) => {
      const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      return `${medal} *${c.rep}* — ${verdictEmoji(c.feedback.verdict)} ${c.feedback.verdict} · *${c.feedback.overall}*${c.addedToLibrary ? ' 📚' : ''}`;
    })
    .join('\n');

  // WoW table
  const wowLines = wowTrends.length
    ? wowTrends.map(r =>
        `• *${r.rep}* — This wk: *${r.thisWeek}* | Last wk: ${r.lastWeek ?? '—'} | ${deltaText(r.delta)}`
      ).join('\n')
    : '_Trends available after two weeks of scored calls._';

  const blocks = [
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
      elements: [{
        type: 'mrkdwn',
        text: `Full scorecards are in the thread below · Powered by Claude`,
      }],
    },
  ];

  return blocks;
}

// ── Individual scorecard blocks ───────────────────────────────────────────

function buildScorecardBlocks(call) {
  const f        = call.feedback;
  const duration = Math.round((call.duration || 0) / 60);
  const callDate = new Date(call.started).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });

  // Score breakdown (monospaced bar chart)
  const scoreLines = Object.entries(f.scores)
    .map(([k, v]) => `\`${scoreBar(v)}\`  ${SCORE_LABELS[k] || k}`)
    .join('\n');

  // Strengths
  const strengthLines = f.strengths && f.strengths.length
    ? f.strengths.map(s => `✅ *${s.point}*\n    _"${s.evidence}"_`).join('\n')
    : '_Nothing notable to highlight._';

  // Coaching notes
  const coachLines = f.coachingNotes && f.coachingNotes.length
    ? f.coachingNotes.map(c => `⚠️ *${c.note}*\n    _"${c.callMoment}"_`).join('\n')
    : '_No coaching notes for this call._';

  const blocks = [
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
      text: {
        type: 'mrkdwn',
        text: `*Strengths (${f.strengths ? f.strengths.length : 0})*\n${strengthLines}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Needs improvement (${f.coachingNotes ? f.coachingNotes.length : 0})*\n${coachLines}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `⚡ *Priority action*\n${f.priorityAction}`,
        },
        {
          type: 'mrkdwn',
          text: `💡 *Next call tip*\n${f.nextCallTip}`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🎯 *Moment of truth*\n_"${f.momentOfTruth}"_`,
      },
    },
  ];

  return blocks;
}

module.exports = { sendDailyReport };
