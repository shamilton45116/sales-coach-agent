// gong.js — fetches yesterday's Gong calls, filters to your team + 10min+, returns transcripts

const fetch = require('node-fetch');

const GONG_BASE = 'https://us-43298.api.gong.io';
const MIN_DURATION_SECS = 600; // 10 minutes

// Load allowed rep emails from env var (set GONG_TEAM_EMAILS in GitHub Secrets)
// e.g. "michelle.kubas@toolbx.com,joshua.kolenda@toolbx.com,..."
const TEAM_EMAILS = (process.env.GONG_TEAM_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

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

  // 404 = no calls in range (weekends, holidays). Exit cleanly.
  if (listRes.status === 404) {
    console.log('  No calls found in date range — exiting cleanly.');
    return [];
  }

  if (!listRes.ok) {
    throw new Error(`Gong calls fetch failed: ${listRes.status} ${await listRes.text()}`);
  }

  const listData = await listRes.json();
  const allCalls = listData.calls || [];
  console.log(`  Total calls found: ${allCalls.length}`);

  // Step 2: Filter by duration (10 min minimum)
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

  // Step 4: Fetch transcripts for all calls
  const transcriptRes = await fetch(`${GONG_BASE}/v2/calls/transcript`, {
    method: 'POST',
    headers: gongHeaders(),
    body: JSON.stringify({ filter: { callIds: longCalls.map(c => c.id) } }),
  });

  const transcriptData = transcriptRes.ok ? await transcriptRes.json() : { callTranscripts: [] };
  const transcriptMap  = {};
  for (const t of transcriptData.callTranscripts || []) {
    transcriptMap[t.callId] = t.transcript || [];
  }

  // Step 5: Combine + filter by team email
  const finalCalls = [];

  for (const call of longCalls) {
    const detail = detailMap[call.id] || {};
    const parties = detail.parties || [];

    // Find the internal rep
    const repParty = parties.find(p => p.affiliation === 'Internal');
    let repEmail = repParty?.emailAddress?.toLowerCase() || '';
    let repName  = repParty?.name || extractRepFromTitle(call.title) || 'Unknown Rep';

    // Filter to team if GONG_TEAM_EMAILS is set
    if (TEAM_EMAILS.length > 0 && !TEAM_EMAILS.includes(repEmail)) {
      continue;
    }

    // Format transcript as readable text
    const sentences = transcriptMap[call.id] || [];
    const transcriptText = sentences
      .map(s => {
        const speaker = parties.find(p => p.speakerId === s.speakerId);
        const speakerName = speaker?.name || 'Speaker';
        const text = (s.sentences || []).map(x => x.text).join(' ');
        return `${speakerName}: ${text}`;
      })
      .join('\n');

    finalCalls.push({
      id:         call.id,
      title:      call.title || '(untitled)',
      url:        call.url,
      duration:   call.duration,
      started:    call.started,
      repEmail,
      repName,
      transcript: transcriptText,
    });
  }

  console.log(`  After team filter: ${finalCalls.length}`);
  return finalCalls;
}

// Extract rep name from call title (e.g. "Mohler | TOOLBX - Sync" → "Mohler")
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
