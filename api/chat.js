import { randomUUID } from 'crypto';

// Proxy serverless Vercel: request dari browser TIDAK pernah menyentuh
// chateverywhere.app secara langsung, jadi CORS tidak berlaku.
// Di sisi server semua header bisa di-set bebas, termasuk User-Agent.

const UPSTREAM = 'https://chateverywhere.app/api/chat';

const UPSTREAM_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0',
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  'output-language': '',
  'user-selected-plugin-id': '',
  'origin': 'https://chateverywhere.app',
  'referer': 'https://chateverywhere.app/id'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const browserId =
      (req.headers['x-browser-id'] || '').trim() || randomUUID();

    const upstreamRes = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        ...UPSTREAM_HEADERS,
        'user-browser-id': browserId
      },
      body: JSON.stringify(req.body)
    });

    const text = await upstreamRes.text();

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(upstreamRes.status).send(text);
  } catch (err) {
    console.error('[chat proxy]', err);
    return res.status(500).json({ error: err.message });
  }
}
