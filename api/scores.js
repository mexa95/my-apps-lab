import { kv } from '@vercel/kv';

const SCORES_KEY = 'tetris:scores';
const MAX_SCORES = 10;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const raw = await kv.zrange(SCORES_KEY, 0, MAX_SCORES - 1, { rev: true, withScores: true });
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
