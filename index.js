// index.js — Sales Coach Agent (Gong MCP version)
// Claude fetches calls, scores them, and tags standouts in one agentic loop.
// No separate gong.js needed — the MCP handles all Gong API calls.

const Anthropic = require('@anthropic-ai/sdk');
const { SCORING_RUBRIC } = require('./scorer');
const { sendDailyReport } = require('./reporter');
const { saveToday, getWoWTrends, loadHistory } = require('./history');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LIBRARY_THRESHOLD = 80;

// ── Gong MCP server config ────────────────────────────────────────────────
// Gong MCP URL: confirm at https://developers.gong.io/docs/mcp (or your Gong admin)
// Auth: passed as a bearer token in the Authorization header
const GONG_MCP = {
  type:    'url',
  url:     process.env.GONG_MCP_URL || 'https://mcp.gong.io/mcp',
  name:    'gong',
  authorization_token: process.env.GONG_MCP_TOKEN,
};

// ── System prompt ─────────────────────────────────────────────────────────
function buildSystemPrompt(targetDate, teamEmails, minDurationMins) {
  const teamFilter = teamEmails && teamEmails.length
    ? `Only include calls where the sales rep's email is one of: ${teamEmails.join(', ')}.`
    : 'Include all internal Gong users.';

  return `You are a sales coach agent. Your job each morning is to:

1. FETCH all calls from ${targetDate} using the Gong tools available to you.
   - Skip any call shorter than ${minDurationMins} minutes.
   - ${teamFilter}

2. SCORE each qualifying call using this rubric:

${SCORING_RUBRIC}

3. TAG any call scoring ${LIBRARY_THRESHOLD} or above by adding it to the Gong Library
   using the appropriate Gong tool.

4. Return a single JSON object — no markdown, no preamble — in exactly this format:
{
  "date": "${targetDate}",
  "calls": [
    {
      "id": "<gong call id>",
      "rep": "<rep full name>",
      "title": "<call title>",
      "duration": <seconds as integer>,
      "started": "<ISO timestamp>",
      "addedToLibrary": <true|false>,
      "feedback": {
        "scores": {
          "discovery": <0-100>,
          "rapport": <0-100>,
          "objectionHandling": <0-100>,
          "talkListenRatio": <0-100>,
          "nextStepsClose": <0-100>,
          "productKnowledge": <0-100>
        },
        "overall": <0-100>,
        "verdict": "<Strong|Solid|Needs Work|Struggling>",
        "callSummary": "<2-3 sentences>",
        "strengths": [{ "point": "...", "evidence": "exact quote" }],
        "coachingNotes": [{ "note": "...", "callMoment": "exact quote" }],
        "priorityAction": "<one sentence>",
        "momentOfTruth": "<exact quote from transcript>",
        "nextCallTip": "<one tactical tip>"
      }
    }
  ]
}

Rules for strengths and coachingNotes:
- 0 to 5 items each. Only include what is clearly evidenced in the transcript.
- Do NOT pad. Every item must cite a specific quote or moment.`;
}

// ── Agentic loop ──────────────────────────────────────────────────────────
// Keeps calling the API until Claude stops using tools and returns final output.
async function runAgent(systemPrompt, userMessage) {
  const messages = [{ role: 'user', content: userMessage }];

  for (let turn = 0; turn < 20; turn++) {
    const response = await client.messages.create({
      model:       'claude-sonnet-4-20250514',
      max_tokens:  8000,
      system:      systemPrompt,
      messages,
      mcp_servers: [GONG_MCP],
    });

    // Collect any text output
    const textBlocks = response.content.filter(b => b.type === 'text');

    if (response.stop_reason === 'end_turn') {
      // Claude is done — extract the final JSON from the last text block
      return textBlocks.at(-1)?.text || '';
    }

    if (response.stop_reason === 'tool_use') {
      // Claude called MCP tools — add its response and continue
      messages.push({ role: 'assistant', content: response.content });

      // Tool results are returned by the MCP server; add them as user turn
      const toolResults = response.content
        .filter(b => b.type === 'tool_result')
        .map(b => ({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content }));

      if (toolResults.length) {
        messages.push({ role: 'user', content: toolResults });
      }
      continue;
    }

    // Any other stop reason — bail
    break;
  }

  throw new Error('Agent did not complete within turn limit');
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🎯 Sales Coach Agent starting (Gong MCP)...');

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const targetDate = yesterday.toISOString().split('T')[0];
  console.log(`Target date: ${targetDate}`);

  // Optional: comma-separated rep emails to scope to your sales team
  const teamEmails = (process.env.GONG_TEAM_EMAILS || '')
    .split(',').map(e => e.trim()).filter(Boolean);

  const systemPrompt = buildSystemPrompt(targetDate, teamEmails, 10);

  console.log('Running agent...');
  const raw = await runAgent(
    systemPrompt,
    `Please fetch, score, and tag calls for ${targetDate} now.`
  );

  // Parse the final JSON
  let result;
  try {
    result = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    throw new Error(`Failed to parse agent output: ${err.message}\n\nRaw output:\n${raw}`);
  }

  const scoredCalls = result.calls || [];
  console.log(`\nScored ${scoredCalls.length} call(s)`);
  scoredCalls.forEach(c =>
    console.log(`  ${c.addedToLibrary ? '📚 ' : '   '}${c.rep} — ${c.feedback.verdict} (${c.feedback.overall})`)
  );

  if (scoredCalls.length === 0) {
    console.log('No qualifying calls — no report sent.');
    return;
  }

  // Persist and trend
  const history   = saveToday(scoredCalls);
  const wowTrends = getWoWTrends(history);

  // Send Slack report
  await sendDailyReport(scoredCalls, wowTrends);
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
