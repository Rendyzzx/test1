// ============================================================
// PROXY CHAT AI untuk Vercel
//
// Urutan provider (otomatis fallback):
//   1. Gemini (scraping, tanpa API key)  ← utama, dari scraping
//   2. Groq  ← butuh env GROQ_API_KEY (gratis, console.groq.com)
//   3. ChatEverywhere ← terakhir, sering blokir IP datacenter
//
// Semua respons: JSON { text, sessionId, provider }
// sessionId dipakai Gemini untuk melanjutkan konteks percakapan
// (resumeArray + cookie). Klien menyimpannya dan mengirim balik.
// ============================================================

const UA_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const CHATEVERYWHERE = 'https://chateverywhere.app/api/chat/';

// ---------- 1. GEMINI (port dari scraping) ----------
function decodeSessionId(sessionId) {
  try {
    const json = Buffer.from(sessionId, 'base64').toString();
    const data = JSON.parse(json);
    return {
      resumeArray: data.resumeArray || null,
      cookie: data.cookie || null,
      instruction: data.instruction || ''
    };
  } catch {
    return { resumeArray: null, cookie: null, instruction: '' };
  }
}

function encodeSessionId(resumeArray, cookie, instruction) {
  return Buffer.from(
    JSON.stringify({ resumeArray, cookie, instruction })
  ).toString('base64');
}

async function getGeminiCookie() {
  const res = await fetch(
    'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=maGuAc&source-path=%2F&bl=boq_assistant-bard-web-server_20250814.06_p1&f.sid=-7816331052118000090&hl=en-US&_reqid=173780&rt=c',
    {
      method: 'POST',
      headers: {
        'content-type':
          'application/x-www-form-urlencoded;charset=UTF-8',
        'user-agent': UA_FIREFOX
      },
      body: 'f.req=%5B%5B%5B%22maGuAc%22%2C%22%5B0%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&'
    }
  );

  const raw = res.headers.getSetCookie?.() || [];
  const cookie = (raw[0] || '').split('; ')[0] || '';
  if (!cookie) throw new Error('gemini: cookie kosong');
  return cookie;
}

async function chatGemini({ message, instruction, sessionId }) {
  let resumeArray = null;
  let cookie = null;
  let savedInstruction = instruction || '';

  if (sessionId) {
    const s = decodeSessionId(sessionId);
    resumeArray = s.resumeArray;
    cookie = s.cookie;
    savedInstruction = instruction || s.instruction || '';
  }

  if (!cookie) {
    cookie = await getGeminiCookie();
  }

  const requestBody = [
    [message, 0, null, null, null, null, 0],
    ['en-US'],
    resumeArray || ['', '', '', null, null, null, null, null, null, ''],
    null,
    null,
    null,
    [1],
    1,
    null,
    null,
    1,
    0,
    null,
    null,
    null,
    null,
    null,
    [[0]],
    1,
    null,
    null,
    null,
    null,
    null,
    ['', '', savedInstruction, null, null, null, null, null, 0, null, 1, null, null, null, []],
    null,
    null,
    1,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    1,
    null,
    null,
    null,
    null,
    [1]
  ];

  const payload = [null, JSON.stringify(requestBody)];

  const res = await fetch(
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_assistant-bard-web-server_20250729.06_p0&f.sid=4206607810970164620&hl=en-US&_reqid=2813378&rt=c',
    {
      method: 'POST',
      headers: {
        'content-type':
          'application/x-www-form-urlencoded;charset=UTF-8',
        'x-goog-ext-525001261-jspb':
          '[1,null,null,null,"9ec249fc9ad08861",null,null,null,[4]]',
        cookie,
        'user-agent': UA_FIREFOX
      },
      body: new URLSearchParams({ 'f.req': JSON.stringify(payload) }).toString()
    }
  );

  const data = await res.text();

  const match = Array.from(data.matchAll(/^\d+\n(.+?)\n/gm));
  const array = match.reverse();
  let parse1 = null;

  for (const item of array) {
    const selectedArray = item?.[1];
    if (!selectedArray) continue;
    try {
      const realArray = JSON.parse(selectedArray);
      const candidate = realArray?.[0]?.[2];
      if (!candidate) continue;
      const parsed = JSON.parse(candidate);
      if (parsed?.[4]?.[0]?.[1]?.[0]) {
        parse1 = parsed;
        break;
      }
    } catch {}
  }

  if (!parse1) {
    throw new Error('Gagal mem-parsing response Gemini.');
  }

  const newResumeArray = [...parse1[1], parse1[4][0][0]];
  const text = parse1[4][0][1][0].replace(/\*\*(.+?)\*\*/g, '*$1*');
  const newSessionId = encodeSessionId(
    newResumeArray,
    cookie,
    savedInstruction
  );

  return { text, sessionId: newSessionId };
}

// ---------- 2. GROQ (fallback) ----------
function toGroqMessages(body) {
  const messages = Array.isArray(body?.messages)
    ? body.messages.map((m) => ({
        role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
        content: String(m.content || '')
      }))
    : [];
  const hasSystem = messages.some((m) => m.role === 'system');
  const prompt = String(body?.prompt || '');
  if (!hasSystem && prompt) {
    messages.unshift({ role: 'system', content: prompt });
  }
  return messages;
}

async function chatGroq(body, apiKey) {
  const res = await fetch(GROQ, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: typeof body?.temperature === 'number' ? body.temperature : 0.5,
      messages: toGroqMessages(body)
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`groq ${res.status}: ${JSON.stringify(data).slice(0, 150)}`);
  }
  return data.choices?.[0]?.message?.content || '(kosong)';
}

// ---------- 3. CHATEVERYWHERE (fallback terakhir) ----------
async function chatEverywhere(body) {
  const res = await fetch(CHATEVERYWHERE, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Origin: 'https://chateverywhere.app'
    },
    body: JSON.stringify(body)
  });
  const textData = await res.text();
  if (!res.ok) {
    throw new Error(`chateverywhere ${res.status}: ${textData.slice(0, 100)}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(textData);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.error) {
    throw new Error(JSON.stringify(parsed).slice(0, 150));
  }
  if (parsed && typeof parsed.text === 'string') return parsed.text;
  if (typeof parsed === 'string') return parsed;
  return textData;
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // pesan terakhir dari user
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const message = lastUser ? String(lastUser.content || '') : '';
  const instruction = String(body.prompt || '');

  if (!message) {
    return res.status(400).json({ error: 'Pesan kosong' });
  }

  const groqKey = process.env.GROQ_API_KEY;
  const errors = [];

  // 1) Gemini scraping
  try {
    const result = await chatGemini({
      message,
      instruction,
      sessionId: body.sessionId || null
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      text: result.text,
      sessionId: result.sessionId,
      provider: 'gemini'
    });
  } catch (err) {
    errors.push(err.message);
    console.error('[proxy] gemini gagal:', err.message);
  }

  // 2) Groq
  if (groqKey) {
    try {
      const text = await chatGroq(body, groqKey);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ text, sessionId: null, provider: 'groq' });
    } catch (err) {
      errors.push(err.message);
      console.error('[proxy] groq gagal:', err.message);
    }
  }

  // 3) ChatEverywhere
  try {
    const text = await chatEverywhere(body);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ text, sessionId: null, provider: 'chateverywhere' });
  } catch (err) {
    errors.push(err.message);
    console.error('[proxy] chateverywhere gagal:', err.message);
  }

  return res.status(502).json({
    error: 'Semua provider AI gagal',
    detail: errors
  });
}
