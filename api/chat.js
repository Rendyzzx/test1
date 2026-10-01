import { randomUUID } from 'crypto';

// ============================================================
// PROXY CHAT AI untuk Vercel
//
// Urutan provider (otomatis):
//   1. ChatEverywhere → persis gaya repo github.com/Rendyzzx/ai_simple
//      (trailing slash, body diteruskan as-is).
//      CATATAN: chateverywhere memblokir IP datacenter/serverless
//      (429 challenge). Cara ini jalan kalau proxy dieksekusi dari
//      IP rumah, mis. `vercel dev` di komputer sendiri.
//   2. Groq → dipakai otomatis kalau chateverywhere diblokkir.
//      Butuh env GROQ_API_KEY (gratis, daftar di console.groq.com).
//      Di Vercel: Settings → Environment Variables → GROQ_API_KEY
// ============================================================

const CHATEVERYWHERE = 'https://chateverywhere.app/api/chat/';
const GROQ = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ---------- 1. ChatEverywhere (gaya repo ai_simple) ----------
async function chatEverywhere(body) {
  const res = await fetch(CHATEVERYWHERE, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://chateverywhere.app'
    },
    body: JSON.stringify(body)
  });

  const textData = await res.text();

  // 429 = challenge/blokir IP datacenter → biarkan fallback ke Groq
  if (res.status === 429) {
    throw new Error(
      'chateverywhere memblokir IP server ini (429 challenge)'
    );
  }
  if (!res.ok) {
    throw new Error(`chateverywhere ${res.status}: ${textData.slice(0, 120)}`);
  }

  // respons bisa plain text atau JSON {text: ...}
  let parsed = null;
  try { parsed = JSON.parse(textData); } catch { parsed = null; }
  if (parsed && parsed.error) {
    throw new Error(JSON.stringify(parsed).slice(0, 150));
  }
  if (parsed && typeof parsed.text === 'string') return parsed.text;
  if (typeof parsed === 'string') return parsed;
  return textData;
}

// ---------- 2. Groq (fallback) ----------
function toGroqMessages(body) {
  const messages = Array.isArray(body?.messages)
    ? body.messages.map((m) => ({
        role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
        content: String(m.content || '')
      }))
    : [];
  // kalau tidak ada system message, pakai prompt sebagai system
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
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature:
        typeof body?.temperature === 'number' ? body.temperature : 0.5,
      messages: toGroqMessages(body)
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`groq ${res.status}: ${JSON.stringify(data).slice(0, 150)}`);
  }
  return data.choices?.[0]?.message?.content || '(kosong)';
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const groqKey = process.env.GROQ_API_KEY;
  const errors = [];

  // 1) ChatEverywhere dulu (persis repo ai_simple)
  try {
    const reply = await chatEverywhere(body);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Provider', 'chateverywhere');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(reply);
  } catch (err) {
    errors.push(err.message);
  }

  // 2) Fallback Groq
  if (groqKey) {
    try {
      const reply = await chatGroq(body, groqKey);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Provider', 'groq');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(reply);
    } catch (err) {
      errors.push(err.message);
    }
  }

  console.error('[chat proxy] semua provider gagal:', errors.join(' | '));
  return res.status(502).json({
    error: 'Semua provider AI gagal',
    detail: errors,
    hint: groqKey
      ? 'Cek GROQ_API_KEY di env Vercel.'
      : 'IP server diblokkir chateverywhere. Set GROQ_API_KEY di Vercel (Settings → Environment Variables). Daftar gratis di console.groq.com'
  });
}
