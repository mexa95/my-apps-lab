import { createClient } from '@vercel/kv';

const SCORES_KEY = 'tetris:scores';
const MAX_SCORES = 10;

// Resilient KV client: supports both legacy KV_REST_API_* env vars and the
// Upstash-backed marketplace integration (UPSTASH_REDIS_REST_*). Constructed
// lazily per request so missing env vars surface as a clean 500.
function getKv() {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const present = Object.keys(process.env).filter(k =>
      k.startsWith('KV_') || k.startsWith('UPSTASH_') || k === 'REDIS_URL'
    );
    throw new Error(
      `No KV env vars found. Expected KV_REST_API_URL+KV_REST_API_TOKEN ` +
      `or UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN. ` +
      `KV/UPSTASH-related vars present: ${JSON.stringify(present)}`
    );
  }
  return createClient({ url, token });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const kv = getKv();
      const raw = await kv.zrevrange(SCORES_KEY, 0, MAX_SCORES - 1, { withScores: true });
      // raw is alternating [member, score, member, score, ...]
      const scores = [];
      for (let i = 0; i < raw.length; i += 2) {
        const member = raw[i];
        const score = raw[i + 1];
        try {
          const parsed = typeof member === 'string' ? JSON.parse(member) : member;
          scores.push({ name: parsed.name, score: Number(score), date: parsed.date });
        } catch {
          scores.push({ name: String(member), score: Number(score), date: null });
        }
      }
      return res.status(200).json(scores);
    } catch (err) {
      console.error('GET /api/scores error:', err);
      return res.status(500).json({ error: 'Failed to fetch scores' });
    }
  }

  if (req.method === 'POST') {
    try {
      const kv = getKv();
      const { name, score } = req.body || {};
      if (!name || typeof score !== 'number' || score < 0 || !isFinite(score)) {
        return res.status(400).json({ error: 'Invalid payload: name (string) and score (non-negative number) required' });
      }
      const sanitizedName = String(name).slice(0, 20).replace(/[<>&"']/g, '');
      if (!sanitizedName) {
        return res.status(400).json({ error: 'Name cannot be empty after sanitization' });
      }
      const member = JSON.stringify({ name: sanitizedName, date: new Date().toISOString() });
      await kv.zadd(SCORES_KEY, { score: Math.floor(score), member });
      // Trim to keep only top MAX_SCORES (remove lowest scores)
      await kv.zremrangebyrank(SCORES_KEY, 0, -(MAX_SCORES + 1));
      return res.status(201).json({ ok: true });
    } catch (err) {
      console.error('POST /api/scores error:', err);
      return res.status(500).json({ error: 'Failed to save score' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
