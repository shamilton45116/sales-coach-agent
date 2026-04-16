const fetch = require('node-fetch');

const GONG_BASE = 'https://us-43298.api.gong.io';
const MIN_DURATION_SECS = 600; // 10 minutes

function gongHeaders() {
  const credentials = Buffer.from(
    `${process.env.GONG_ACCESS_KEY}:${process.env.GONG_ACCESS_KEY_SECRET}`
  ).toString('base64');
  return {
    Authorization: `Basic ${credentials}`,
    'Content-Type': 'application/json',
  };
}

async function fetchYesterdaysCalls() {
  const now = new Date();

  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);

  const yesterdayMidnight = new Date(todayMidnight);
  yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1);

  const fromDateTime = yesterdayMidnight.toISOString();
  const toDateTime   = todayMidnight.toISOString();

  console.log(`Fetching Gong calls: ${fromDateTime} → ${toDateTime}`);

  // Step 1: Get list of calls in date range
  const listRes = await fetch(
    `${GONG_BASE}/v2/calls?fromDateTime=${fromDateTime}&toDateTime=${toDateTime}`,
    { headers: gongHeaders() }
  );

  if (!listRes.ok) {
    throw new Error(`Gong calls fetch failed: ${listRes.status} ${await listRes.text()}`);
  }

  const listData = await listRes.json();
  const allCalls = listData.calls || [];
  console.log(`  Total calls found: ${allCalls.length}`);

  // Step 2: Filter by duration
  const longCalls = allCalls.filter(c => (c.duration || 0) >= MIN_DURATION_SECS);
  console.log(`  After 10-min filter: ${longCalls.length}`);

  if (longCalls.length === 0) return [];

  // Step 3: Fetch detailed call data (includes parties/speakers)
  const detailRes = await fetch(`${GONG_BASE}/v2/calls/extensive`, {
    method: 'POST',
    headers: gongHeaders(),
    body: JSON.stringify({
      filter: { callIds: longCalls.map(c => c.id) },
      contentSelector: {
        exposedFields: {
          parties: true,
          content: { pointsOfInterest: false, brief: false, outline: false, highlights: false },
        },
      },
    }),
  });

  const detailData = detailRes.ok ? await detailRes.json() : { calls: [] };
  const detailMap  = {};
  for (const c of detailData.calls || []) {
    detailMap[c.metaData?.id] = c;
  }

  // Step 4: Fetch transcripts
  const transcriptRes = await fetch(`${GONG_BASE}/v2/calls/transcript`, {
    method: 'POST',
    headers: gongHeaders(),
    body: JSON.stringify({ filter: { callIds: longCalls.map(c => c.id) } }),
  });

  const transcriptData = transcriptRes.ok ? await transcriptRes.json() : { callTranscripts: [] };
  const transcriptMap  = {};
  for (const t of transcriptData.callTranscripts || []) {
    transcriptMap[t.callId] = t.transcript
      .map(seg => `${seg.speakerName}: ${seg.sentences.map(s => s.text).join(' ')}`)
      .join('\n');
  }

  // Step 5: Build enriched call objects
  const enriched = longCalls
    .filter(c => transcriptMap[c.id] && transcriptMap[c.id].length > 100)
    .map(c => {
      const detail   = detailMap[c.id];
      const parties  = detail?.parties || [];
      const internal = parties.find(p =>
        (p.affiliation === 'Internal' || p.methods?.some(m => m.affiliation === 'Internal')) && p.name
      );
      const rep = internal?.name || extractRepFromTitle(c.title) || 'Unknown Rep';

      return {
        id:         c.id,
        title:      c.title || 'Untitled call',
        rep,
        duration:   c.duration || 0,
        started:    c.started,
        transcript: transcriptMap[c.id],
      };
    });

  console.log(`  With transcripts: ${enriched.length}`);
  return enriched;
}

// Fallback: try to pull rep name from call title (e.g. "Mohler | TOOLBX - Sync")
function extractRepFromTitle(title) {
  if (!title) return null;
  const match = title.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*[|&-]/);
  return match ? match[1].trim() : null;
}

async function addCallsToLibrary(callIds) {
  if (!callIds || callIds.length === 0) return;

  const res = await fetch(`${GONG_BASE}/v2/library/calls`, {
    method: 'PUT',
    headers: gongHeaders(),
    body: JSON.stringify({ callIds }),
  });

  if (!res.ok) {
    console.warn(`  Gong library tagging failed: ${res.status} ${await res.text()}`);
    return false;
  }

  console.log(`  Added ${callIds.length} call(s) to Gong Library`);
  return true;
}

module.exports = { fetchYesterdaysCalls, addCallsToLibrary };
