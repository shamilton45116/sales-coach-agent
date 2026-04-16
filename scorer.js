const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a senior B2B sales coach. Score this call on 6 dimensions (0-100) and return ONLY valid JSON — no markdown, no preamble.

DIMENSIONS:
- discovery: Pain/budget/timeline/stakeholders uncovered. 0-39=pitched immediately, 40-59=surface questions, 60-79=solid MEDDIC, 80-100=deep layered discovery
- rapport: Human connection built. 0-39=robotic, 40-59=polite but generic, 60-79=genuine warmth, 80-100=trusted advisor feel
- objectionHandling: 0-39=defensive/caved, 40-59=acknowledged but generic, 60-79=explored root cause, 80-100=turned into deeper conversation
- talkListenRatio: 100=rep spoke less than 30% of time. Penalise monologues heavily.
- nextStepsClose: 0-39=vague follow-up, 40-59=agreed to reconnect no date, 60-79=next meeting booked, 80-100=specific step+date+agenda confirmed on the call
- productKnowledge: 0-39=struggled/wrong info, 40-59=basics only, 60-79=solid command tied to pain, 80-100=expert with case studies+ROI

VERDICT: Strong (80-100), Solid (60-79), Needs Work (40-59), Struggling (0-39)

strengths and coachingNotes: 0-5 items each. ONLY include what is clearly evidenced. Do NOT pad. Every item needs a specific quote or moment from the transcript.

Return exactly:
{"scores":{"discovery":0,"rapport":0,"objectionHandling":0,"talkListenRatio":0,"nextStepsClose":0,"productKnowledge":0},"overall":0,"verdict":"Solid","callSummary":"2-3 sentences about what happened and deal stage","strengths":[{"point":"what they did well","evidence":"exact quote or moment"}],"coachingNotes":[{"note":"what to improve","callMoment":"exact quote or moment"}],"priorityAction":"single most important fix — one sentence","momentOfTruth":"the one quote that tells the whole story","nextCallTip":"one tactical thing to do on their very next call"}`;

async function scoreCall(call) {
  const transcript = (call.transcript || '').substring(0, 7000);

  const userMessage = `Rep: ${call.rep}
Title: ${call.title}
Duration: ${Math.round((call.duration || 0) / 60)} minutes
Date: ${new Date(call.started).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}

IMPORTANT: Every strength and coaching note must reference a specific quote or moment from this transcript.

--- TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  const feedback = JSON.parse(raw);
  return { ...call, feedback };
}

module.exports = { scoreCall };
