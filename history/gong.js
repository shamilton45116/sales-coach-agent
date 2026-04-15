// gong.js — Gong API client
// Docs: https://us-66211.api.gong.io/v2/api-explorer/

const fetch = require('node-fetch');

const GONG_BASE = 'https://us-43298.api.gong.io';

function gongHeaders() {
  const credentials = Buffer.from(
    `${process.env.GONG_ACCESS_KEY}:${process.env.GONG_ACCESS_KEY_SECRET}`
  ).toString('base64');
  return {
    Authorization: `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };
}

// Returns calls from yesterday (midnight → midnight local time)
async function fetchYesterdaysCalls() {
  const now = new Date();

  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);

  const yesterdayMidnight = new Date(todayMidnight);
  yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);

  const fromDateTime = yesterdayMidnight.toISOString();
  const toDateTime = todayMidnight.toISOString();

  console.log(`Fetching Gong calls: ${fromDateTime} → ${toDateTime}`);

  const res = await fetch(
    `${GONG_BASE}/v2/calls?fromDateTime=${fromDateTime}&toDateTime=${toDateTime}`,
    { headers: gongHeaders() }
  );

  if (!res.ok) {
    throw new Error(`Gong calls fetch failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const calls = data.calls || [];

  if (calls.length === 0) return [];

  // Fetch transcripts in parallel (batched to avoid rate limits)
  const enriched = await Promise.all(
    calls.map(async (call) => {
      const transcript = await fetchTranscript(call.id);
      const rep = identifyRep(call);
      return {
        id: call.id,
        title: call.title || 'Untitled call',
        rep,
        duration: call.duration || 0,
        started: call.started,
        transcript,
      };
    })
  );

  // Skip calls where we couldn't get a transcript
  return enriched.filter((c) => c.transcript && c.transcript.length > 100);
}

async function fetchTranscript(callId) {
  const res = await fetch(`${GONG_BASE}/v2/calls/transcript`, {
    method: 'POST',
    headers: gongHeaders(),
    body: JSON.stringify({ filter: { callIds: [callId] } }),
  });

  if (!res.ok) {
    console.warn(`  Transcript fetch failed for ${callId}: ${res.status}`);
    return null;
  }

  const data = await res.json();
  const transcriptData = data.callTranscripts?.[0];
  if (!transcriptData) return null;

  // Format into readable text: "SpeakerName: sentence sentence..."
  return transcriptData.transcript
    .map((segment) => {
      const text = segment.sentences.map((s) => s.text).join(' ');
      return `${segment.speakerName}: ${text}`;
    })
    .join('\n');
}

function identifyRep(call) {
  // Gong marks internal parties — find the first internal speaker
  const internal = call.parties?.find(
    (p) => p.affiliation === 'Internal' && p.name
  );
  return internal?.name || 'Unknown Rep';
}

module.exports = { fetchYesterdaysCalls };

// ── Gong Library ──────────────────────────────────────────────────────────
// Adds qualifying calls to the Gong call library.
// Gong API: PUT /v2/library/calls
// Docs: https://us-66211.api.gong.io/v2/api-explorer/#/Library
async function addCallsToLibrary(callIds) {
  if (!callIds || callIds.length === 0) return;

  const res = await fetch(`${GONG_BASE}/v2/library/calls`, {
    method: 'PUT',
    headers: gongHeaders(),
    body: JSON.stringify({ callIds }),
  });

  if (!res.ok) {
    const text = await res.text();
    // Non-fatal — log and continue so the rest of the report still sends
    console.warn(`  Gong library tagging failed: ${res.status} ${text}`);
    return false;
  }

  console.log(`  Added ${callIds.length} call(s) to Gong Library`);
  return true;
}

module.exports = { fetchYesterdaysCalls, addCallsToLibrary };
