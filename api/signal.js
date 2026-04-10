import { kv } from '@vercel/kv';

// WebRTC signaling via Vercel KV for tennis online multiplayer.
// Single POST endpoint with an `op` discriminator. All keys TTL 300s.

const ROOM_RE = /^[A-Z0-9]{4}$/;
const TTL = 300; // seconds
const MAX_SDP = 8 * 1024;
const MAX_CAND = 1 * 1024;
const MAX_CANDIDATES = 32;

const keyRoom   = c => `tennis:signal:room:${c}`;
const keyOffer  = c => `tennis:signal:room:${c}:offer`;
const keyAnswer = c => `tennis:signal:room:${c}:answer`;
const keyIce    = (c, role) => `tennis:signal:room:${c}:ice:${role}`;

function validSdp(sdp) {
  if (!sdp || typeof sdp !== 'object') return false;
  if (typeof sdp.type !== 'string' || typeof sdp.sdp !== 'string') return false;
  if (JSON.stringify(sdp).length > MAX_SDP) return false;
  return true;
}

function validCandidate(cand) {
  if (cand == null) return false;
  if (typeof cand !== 'object') return false;
  if (JSON.stringify(cand).length > MAX_CAND) return false;
  return true;
}

async function touchTtl(key) {
  try { await kv.expire(key, TTL); } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'tennis-signal' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { op, room, payload } = body;

    if (typeof op !== 'string') {
      return res.status(400).json({ error: 'Missing op' });
    }
    if (typeof room !== 'string' || !ROOM_RE.test(room)) {
      return res.status(400).json({ error: 'Invalid room code' });
    }

    switch (op) {
      case 'create': {
        // Atomic claim: fails if key already exists. @vercel/kv returns
        // 'OK' on success and null when NX condition fails. Be tolerant of
        // variations (some client versions return true/false or { result }).
        let ok;
        try {
          ok = await kv.set(
            keyRoom(room),
            { status: 'waiting', createdAt: Date.now() },
            { nx: true, ex: TTL }
          );
        } catch (e) {
          console.error('POST /api/signal create: kv.set threw:', e);
          return res.status(500).json({ error: 'KV write failed: ' + (e && e.message ? e.message : String(e)) });
        }
        console.log('POST /api/signal create', room, '-> kv.set returned:', ok);
        const success = ok === 'OK' || ok === true || (ok && ok.result === 'OK');
        const collision = ok === null || ok === false || ok === undefined;
        if (success) return res.status(201).json({ ok: true });
        if (collision) return res.status(409).json({ error: 'Room code already in use' });
        // Unknown return shape — treat as success but log loudly.
        console.warn('POST /api/signal create: unexpected kv.set return, treating as success:', ok);
        return res.status(201).json({ ok: true });
      }

      case 'offer': {
        if (!validSdp(payload && payload.sdp)) {
          return res.status(400).json({ error: 'Invalid SDP' });
        }
        const exists = await kv.get(keyRoom(room));
        if (!exists) return res.status(404).json({ error: 'Room not found' });
        await kv.set(keyOffer(room), JSON.stringify(payload.sdp), { ex: TTL });
        await touchTtl(keyRoom(room));
        return res.status(200).json({ ok: true });
      }

      case 'join': {
        const raw = await kv.get(keyOffer(room));
        if (raw == null) return res.status(404).json({ error: 'Room not found' });
        const sdp = typeof raw === 'string' ? JSON.parse(raw) : raw;
        await touchTtl(keyRoom(room));
        await touchTtl(keyOffer(room));
        return res.status(200).json({ sdp });
      }

      case 'answer': {
        if (!validSdp(payload && payload.sdp)) {
          return res.status(400).json({ error: 'Invalid SDP' });
        }
        const exists = await kv.get(keyRoom(room));
        if (!exists) return res.status(404).json({ error: 'Room not found' });
        await kv.set(keyAnswer(room), JSON.stringify(payload.sdp), { ex: TTL });
        await touchTtl(keyRoom(room));
        return res.status(200).json({ ok: true });
      }

      case 'pollAnswer': {
        const raw = await kv.get(keyAnswer(room));
        if (raw == null) return res.status(200).json({});
        const sdp = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return res.status(200).json({ sdp });
      }

      case 'ice': {
        const role = payload && payload.role;
        if (role !== 'host' && role !== 'guest') {
          return res.status(400).json({ error: 'Invalid role' });
        }
        if (!validCandidate(payload.candidate)) {
          return res.status(400).json({ error: 'Invalid candidate' });
        }
        const k = keyIce(room, role);
        await kv.rpush(k, JSON.stringify(payload.candidate));
        await kv.ltrim(k, -MAX_CANDIDATES, -1);
        await kv.expire(k, TTL);
        return res.status(200).json({ ok: true });
      }

      case 'pollIce': {
        const role = payload && payload.role;
        if (role !== 'host' && role !== 'guest') {
          return res.status(400).json({ error: 'Invalid role' });
        }
        const k = keyIce(room, role);
        const raw = await kv.lrange(k, 0, -1);
        // Drain: delete what we just read. Note small race window where a
        // candidate appended between LRANGE and DEL would be lost, but the
        // caller polls continuously so any lost candidate will be re-sent by
        // the peer's ICE restart. Acceptable for v1.
        if (raw && raw.length > 0) await kv.del(k);
        const candidates = (raw || []).map(r => {
          try { return typeof r === 'string' ? JSON.parse(r) : r; }
          catch { return null; }
        }).filter(Boolean);
        return res.status(200).json({ candidates });
      }

      case 'close': {
        await Promise.all([
          kv.del(keyRoom(room)),
          kv.del(keyOffer(room)),
          kv.del(keyAnswer(room)),
          kv.del(keyIce(room, 'host')),
          kv.del(keyIce(room, 'guest')),
        ]);
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: 'Unknown op' });
    }
  } catch (err) {
    console.error('POST /api/signal error:', err);
    return res.status(500).json({ error: 'Signaling failed' });
  }
}
