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

  // Drop any calls where scoring failed (undefined overall)
  const validCalls = scoredCalls.filter(c => c.feedback && c.feedback.overall !== undefined);
  if (validCalls.length === 0) {
    console.log('No valid scored calls to report.');
    return;
  }

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // 1. Post summary with rep-grouped leaderboard
  const summaryBlocks = buildSummaryBlocks(validCalls, wowTrends, date);
  const summaryRes = await slackPost(token, {
    channel,
    blocks: summaryBlocks,
    text: `🎯 Daily Sales Coach Report — ${date}`,
  });

  if (!summaryRes.ok) {
    throw new Error(`Slack summary post failed: ${JSON.stringify(summaryRes)}`);
  }

  const threadTs = summaryRes.ts;
  console.log(`Slack summary posted (ts: ${threadTs})`);

  // 2. Post individual scorecards in thread (worst first)
  const sorted = [...validCalls].sort((a, b) => a.feedback.overall - b.feedback.overall);
  for (const call of sorted) {
    const blocks = buildScorecardBlocks(call);
    await slackPost(token, {
      channel,
      thread_ts: threadTs,
      blocks,
      text: `${call.rep} — ${call.feedback.verdict} (${call.feedback.overall})`,
    });
    await sleep(500);
  }

  console.log(`Slack report posted (${validCalls.length} scorecards in thread)`);

  // 3. Post brief summary to #agent-sales-coach
  const summaryChannel = process.env.SLACK_SUMMARY_CHANNEL;
  if (summaryChannel) {
    const agentBlocks = buildAgentSummaryBlocks(validCalls, wowTrends, date);
    await slackPost(token, {
      channel: summaryChannel,
      blocks:  agentBlocks,
      text:    `Sales Coach update — ${date}`,
    });
    console.log('Agent summary posted to #agent-sales-coach');
  }
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

function verdictFromScore(n) {
  if (n >= 80) return 'Strong';
  if (n >= 60) return 'Solid';
  if (n >= 40) return 'Needs Work';
  return 'Struggling';
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

// Group calls by rep and compute aggregate stats
function groupByRep(calls) {
  const map = {};
  for (const call of calls) {
    if (!map[call.rep]) map[call.rep] = { rep: call.rep, calls: [], addedToLibrary: false };
    map[call.rep].calls.push(call);
    if (call.addedToLibrary) map[call.rep].addedToLibrary = true;
  }
  return Object.values(map).map(r => {
    const avg = Math.round(r.calls.reduce((s, c) => s + c.feedback.overall, 0) / r.calls.length);
    return {
      rep:            r.rep,
      callCount:      r.calls.length,
      avgScore:       avg,
      verdict:        verdictFromScore(avg),
      addedToLibrary: r.addedToLibrary,
    };
  }).sort((a, b) => b.avgScore - a.avgScore);
}

// ── Summary message ───────────────────────────────────────────────────────
function buildSummaryBlocks(calls, wowTrends, date) {
  const totalAvg = Math.round(calls.reduce((s, c) => s + c.feedback.overall, 0) / calls.length);
  const strong   = calls.filter(c => c.feedback.verdict === 'Strong' || c.feedback.verdict === 'Solid').length;
  const needAttn = calls.filter(c => c.feedback.verdict === 'Needs Work' || c.feedback.verdict === 'Struggling').length;

  // Rep-grouped leaderboard
  const repGroups = groupByRep(calls);
  const leaderboard = repGroups.map((r, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    const callLabel = `${r.callCount} call${r.callCount !== 1 ? 's' : ''}`;
    return `${medal} *${r.rep}* — ${verdictEmoji(r.verdict)} ${r.verdict} · *${r.avgScore}* (${callLabel})${r.addedToLibrary ? ' 📚' : ''}`;
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
        { type: 'mrkdwn', text: `*Team avg score*\n${scoreEmoji(totalAvg)} ${totalAvg}` },
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
      elements: [{ type: 'mrkdwn', text: 'Individual call scorecards in the thread below · Powered by Claude' }],
    },
  ];
}

// ── Individual scorecard (thread reply) ──────────────────────────────────
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


// ── Agent summary (posted to #agent-sales-coach) ─────────────────────────
function buildAgentSummaryBlocks(calls, wowTrends, date) {
  const repGroups  = groupByRep(calls);
  const totalAvg   = Math.round(calls.reduce((s, c) => s + c.feedback.overall, 0) / calls.length);

  // Team trend from WoW data
  let teamTrend = 'stable';
  if (wowTrends.length >= 2) {
    const improving = wowTrends.filter(r => (r.delta || 0) > 3).length;
    const declining = wowTrends.filter(r => (r.delta || 0) < -3).length;
    if (improving > declining) teamTrend = 'improving';
    else if (declining > improving) teamTrend = 'declining';
  }

  // Top performer — highest avg score
  const top = repGroups[0];

  // Rep needing support — lowest avg score among those with Needs Work or Struggling
  const needsSupport = [...repGroups]
    .sort((a, b) => a.avgScore - b.avgScore)
    .find(r => r.verdict === 'Needs Work' || r.verdict === 'Struggling');

  // Most common coaching gap — most repeated coaching note topic across all calls
  const noteWords = calls.flatMap(c =>
    (c.feedback?.coachingNotes || []).map(n => n.note)
  );
  const commonGap = noteWords.length
    ? noteWords.sort((a, b) =>
        noteWords.filter(v => v === b).length - noteWords.filter(v => v === a).length
      )[0]
    : 'No consistent gaps identified this period';

  // Winning pattern — most repeated strength across all calls
  const strengthWords = calls.flatMap(c =>
    (c.feedback?.strengths || []).map(s => s.point)
  );
  const winningPattern = strengthWords.length
    ? strengthWords.sort((a, b) =>
        strengthWords.filter(v => v === b).length - strengthWords.filter(v => v === a).length
      )[0]
    : 'No consistent winning patterns identified yet';

  // Top performer highlight from their strengths
  const topCall   = calls.filter(c => c.rep === top?.rep).sort((a, b) => b.feedback.overall - a.feedback.overall)[0];
  const topStrength = topCall?.feedback?.strengths?.[0]?.point || 'Strong overall performance';

  // Support note from coaching notes
  const supportCall = needsSupport
    ? calls.filter(c => c.rep === needsSupport.rep).sort((a, b) => a.feedback.overall - b.feedback.overall)[0]
    : null;
  const supportNote = supportCall?.feedback?.priorityAction || null;

  const lines = [
    `*Sales Coach update — ${date}*`,
    `*Calls reviewed:* ${calls.length}`,
    `*Team trend:* ${teamTrend === 'improving' ? '↑' : teamTrend === 'declining' ? '↓' : '→'} ${teamTrend.charAt(0).toUpperCase() + teamTrend.slice(1)} — avg score ${totalAvg}/100`,
    `*Top performer this week:* ${top?.rep || '—'} — ${topStrength}`,
    `*Rep needing support:* ${needsSupport ? `${needsSupport.rep} — ${supportNote || 'See full report for details'}` : 'None flagged'}`,
    `*Most common coaching gap:* ${commonGap}`,
    `*Winning pattern to reinforce:* ${winningPattern}`,
    `*Full report:* Say "run the sales coaching report" in #chief-of-staff to get the full detail.`,
  ].join('\n');

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines },
    },
  ];
}

module.exports = { sendDailyReport };
