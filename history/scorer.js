// scorer.js — Scoring rubric (referenced by index.js system prompt)
// No longer makes direct API calls — Claude handles scoring via the MCP agent loop.

const SCORING_RUBRIC = `
Score each dimension 0-100:

DISCOVERY (0-100)
0-39: Pitched immediately; no pain, budget, timeline or stakeholders uncovered
40-59: Surface questions only; rep filled gaps with assumptions
60-79: Solid discovery; MEDDIC/BANT mostly covered
80-100: Deep layered discovery; champion identified; full business impact before any pitch

RAPPORT (0-100)
0-39: Robotic or transactional; prospect stayed guarded
40-59: Polite but generic; no real trust built
60-79: Genuine warmth; prospect opened up
80-100: Trusted advisor feel; prospect was candid and engaged

OBJECTION HANDLING (0-100)
0-39: Defensive, caved immediately, or ignored objections
40-59: Acknowledged but gave generic/scripted responses
60-79: Explored root cause; responded with relevant evidence
80-100: Turned objections into deeper conversations; pricing and competitive handled with confidence

TALK / LISTEN RATIO (0-100)
100 = rep spoke less than 30% of the time.
Penalise hard for monologues, interrupting, or not pausing after questions.

NEXT STEPS / CLOSE (0-100)
0-39: Call ended with "I'll follow up" or nothing at all
40-59: Vague agreement to reconnect; no date, no agenda
60-79: Next meeting booked but agenda unclear
80-100: Specific step with date, mutual agenda, confirmed on the call

PRODUCT KNOWLEDGE (0-100)
0-39: Struggled to answer questions; vague or wrong info
40-59: Covered basics but couldn't go deep
60-79: Solid command; features tied to this prospect's pain
80-100: Expert fluency; used case studies, ROI data, and competitive context

VERDICT thresholds: Strong (80-100), Solid (60-79), Needs Work (40-59), Struggling (0-39)
Overall score: weighted average — weight Discovery and Objection Handling most heavily.`;

module.exports = { SCORING_RUBRIC };
