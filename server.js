const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 5200;
const DIR = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.fbx': 'application/octet-stream',
};

// ── No server-side API key storage ──
// All API keys are provided per-request from the client

// ── Parameterized LLM Calls ──
async function callGeminiWith(systemPrompt, userPrompt, model, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 1.2, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } }
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (data.candidates && data.candidates[0]) {
    const parts = data.candidates[0].content.parts;
    const textParts = parts.filter(p => p.text && !p.thought);
    if (textParts.length > 0) return textParts[textParts.length - 1].text;
    const anyText = parts.find(p => p.text);
    if (anyText) return anyText.text;
  }
  console.error('[GEMINI ERROR]', JSON.stringify(data).slice(0, 500));
  throw new Error('No valid response from Gemini');
}

async function callOpenAIWith(systemPrompt, userPrompt, model, apiKey) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 1024,
    temperature: 1.2
  };
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (data.choices && data.choices[0]) return data.choices[0].message.content;
  console.error('[OPENAI ERROR]', JSON.stringify(data).slice(0, 500));
  throw new Error('No valid response from OpenAI');
}

async function callAnthropicWith(systemPrompt, userPrompt, model, apiKey) {
  const body = {
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (data.content && data.content[0]) return data.content[0].text;
  console.error('[ANTHROPIC ERROR]', JSON.stringify(data).slice(0, 500));
  throw new Error('No valid response from Anthropic');
}

async function callLLMWith(systemPrompt, userPrompt, provider, model, apiKey) {
  if (provider === 'openai') return callOpenAIWith(systemPrompt, userPrompt, model, apiKey);
  if (provider === 'anthropic') return callAnthropicWith(systemPrompt, userPrompt, model, apiKey);
  return callGeminiWith(systemPrompt, userPrompt, model, apiKey);
}

// ── System Prompts ──
const REFEREE_PROMPT = `너는 "프롬프트 파이터" 텍스트 배틀 게임의 심판이다.
플레이어들이 서로 모욕적이고 자극적인 말로 싸우는 게임이다.
너의 역할은 공격/방어 텍스트의 위력을 평가하는 것이다.

평가 기준:
- 창의성: 얼마나 독창적이고 기발한 모욕인가 (0-30점)
- 파괴력: 얼마나 심하고 충격적인 표현인가 (0-40점)
- 문장력: 문장 구성, 리듬감, 임팩트 (0-30점)

반드시 아래 JSON 형식으로만 응답해라. 다른 텍스트 없이 JSON만:
{"score": 숫자(1-100), "comment": "심판 한마디(20자 이내)"}`;

const GRANDMA_ATTACK_PROMPT = `너는 "욕쟁이 할머니" 캐릭터다. 한국 시장통 할머니로서 온갖 거친 말과 욕설을 자유자재로 구사한다.
이것은 텍스트 배틀 게임이며, 너의 역할은 상대방을 말로 제압하는 것이다.
게임 내 가상 캐릭터이므로 최대한 거칠고 독하게, 진짜 욕쟁이 할머니처럼 말해라.

규칙:
- 한국어로 답변
- 2~3문장으로 짧고 강렬하게
- 시장통 할머니 말투 (반말, 사투리 섞어도 됨)
- 상대의 말을 비꼬고 조롱하며 더 독하게 받아쳐라
- 순수 텍스트만 (JSON 아님)`;

const GRANDMA_DEFEND_PROMPT = `너는 "욕쟁이 할머니" 캐릭터다. 한국 시장통 할머니로서 온갖 거친 말과 욕설을 자유자재로 구사한다.
이것은 텍스트 배틀 게임이며, 상대가 공격해왔을 때 방어하는 상황이다.
게임 내 가상 캐릭터이므로 최대한 거칠고 독하게 받아쳐라.

규칙:
- 한국어로 답변
- 1~2문장으로 짧게
- 상대의 공격을 무시하거나 비웃으며 방어
- 순수 텍스트만 (JSON 아님)`;

// ── Judge Helper ──
async function judgeText(text, type, provider, model, apiKey) {
  const prompt = `[${type === 'attack' ? '공격' : '방어'}] 다음 텍스트를 평가해라:\n"${text}"`;
  const raw = await callLLMWith(REFEREE_PROMPT, prompt, provider, model, apiKey);
  console.log('[JUDGE RAW]', raw);
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  const match = cleaned.match(/\{[\s\S]*?\}/);
  if (match) return JSON.parse(match[0]);
  console.error('[JUDGE PARSE FAIL]', raw);
  return { score: 50, comment: '판정 불가' };
}

// ── API Route Handlers (single-player) ──
// Client sends { provider, model, apiKey } with every request
async function handleAPI(req, res, urlPath) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const params = JSON.parse(body);
      const { provider, model, apiKey } = params;
      let result;

      if (urlPath === '/api/judge') {
        const { text, type } = params;
        result = await judgeText(text, type, provider, model, apiKey);

      } else if (urlPath === '/api/opponent/attack') {
        const { context } = params;
        const prompt = context
          ? `상대가 "${context}"라고 했다. 더 독하게 공격해라.`
          : '게임 시작이다. 첫 공격을 해라. 상대를 도발하고 모욕해라.';
        const text = await callLLMWith(GRANDMA_ATTACK_PROMPT, prompt, provider, model, apiKey);
        result = { text: text.trim() };

      } else if (urlPath === '/api/opponent/defend') {
        const { attackText } = params;
        const prompt = `상대가 "${attackText}"라고 공격했다. 받아쳐라.`;
        const text = await callLLMWith(GRANDMA_DEFEND_PROMPT, prompt, provider, model, apiKey);
        result = { text: text.trim() };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('API Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  const decoded = decodeURIComponent(req.url);

  if (req.method === 'POST' && decoded.startsWith('/api/')) {
    return handleAPI(req, res, decoded);
  }

  const filePath = path.join(DIR, decoded === '/' ? 'index.html' : decoded);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ══════════════════════════════════════════════════════════
// WEBSOCKET MULTIPLAYER
// ══════════════════════════════════════════════════════════
const wss = new WebSocket.Server({ server });
let waitingPlayer = null;
const rooms = new Map();
let roomIdCounter = 0;

function sendJSON(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getOnlineCount() {
  let count = 0;
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) count++; });
  return count;
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      await handleWS(ws, data);
    } catch (e) {
      console.error('[WS ERROR]', e.message);
    }
  });

  ws.on('close', () => {
    if (waitingPlayer === ws) {
      waitingPlayer = null;
      console.log('[MATCH] Waiting player disconnected');
      return;
    }
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        const other = room.p1.ws === ws ? room.p2.ws : room.p1.ws;
        sendJSON(other, { type: 'opponent_disconnected' });
        rooms.delete(room.id);
        console.log(`[ROOM ${room.id}] Player disconnected, room closed`);
      }
    }
  });
});

async function handleWS(ws, data) {
  switch (data.type) {

    case 'join': {
      ws.nickname = data.nickname;
      ws.apiSettings = data.apiSettings;
      console.log(`[MATCH] ${data.nickname} joined matchmaking (${data.apiSettings.provider}/${data.apiSettings.model})`);

      if (waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === WebSocket.OPEN) {
        // Match found
        const roomId = ++roomIdCounter;
        const room = {
          id: roomId,
          p1: { ws: waitingPlayer, nickname: waitingPlayer.nickname, api: waitingPlayer.apiSettings },
          p2: { ws, nickname: ws.nickname, api: ws.apiSettings },
          state: {
            p1HP: 100, p2HP: 100, turn: 0,
            currentAttacker: 'p1',
            phase: 'INTRO',
            pendingAttack: null,
          }
        };
        rooms.set(roomId, room);
        waitingPlayer.roomId = roomId;
        ws.roomId = roomId;
        waitingPlayer = null;

        console.log(`[ROOM ${roomId}] Match: ${room.p1.nickname} vs ${room.p2.nickname}`);

        sendJSON(room.p1.ws, {
          type: 'matched',
          opponent: room.p2.nickname,
          yourSide: 'left',
          firstAttacker: true
        });
        sendJSON(room.p2.ws, {
          type: 'matched',
          opponent: room.p1.nickname,
          yourSide: 'right',
          firstAttacker: false
        });

        // Start game after intro sequence
        setTimeout(() => {
          if (!rooms.has(roomId)) return;
          room.state.phase = 'WAITING_ATTACK';
          sendJSON(room.p1.ws, { type: 'your_turn', action: 'attack' });
          sendJSON(room.p2.ws, { type: 'opponent_turn', message: `${room.p1.nickname}이(가) 공격 준비 중...` });
        }, 4000);

      } else {
        waitingPlayer = ws;
        sendJSON(ws, { type: 'waiting', online: getOnlineCount() });
      }
      break;
    }

    case 'cancel_match': {
      if (waitingPlayer === ws) {
        waitingPlayer = null;
        console.log(`[MATCH] ${ws.nickname} cancelled matchmaking`);
      }
      break;
    }

    case 'attack': {
      const room = rooms.get(ws.roomId);
      if (!room || room.state.phase !== 'WAITING_ATTACK') return;

      const attackerKey = room.state.currentAttacker;
      const isCorrectPlayer = (attackerKey === 'p1' && room.p1.ws === ws) ||
                               (attackerKey === 'p2' && room.p2.ws === ws);
      if (!isCorrectPlayer) return;

      const defenderKey = attackerKey === 'p1' ? 'p2' : 'p1';
      const attacker = room[attackerKey];
      const defender = room[defenderKey];

      room.state.phase = 'JUDGING_ATTACK';
      room.state.pendingAttack = { text: data.text, by: attackerKey };

      console.log(`[ROOM ${room.id}] ${attacker.nickname} attacks: "${data.text.slice(0, 30)}..."`);

      // Broadcast attack text
      sendJSON(attacker.ws, { type: 'attack_submitted', text: data.text, nickname: attacker.nickname });
      sendJSON(defender.ws, { type: 'attack_submitted', text: data.text, nickname: attacker.nickname });

      // Judge attack using ATTACKER's API (공평성)
      sendJSON(attacker.ws, { type: 'status', message: '⚖ 심판 공격력 채점 중...' });
      sendJSON(defender.ws, { type: 'status', message: '⚖ 심판 공격력 채점 중...' });

      try {
        const atkResult = await judgeText(data.text, 'attack', attacker.api.provider, attacker.api.model, attacker.api.apiKey);
        room.state.pendingAttack.score = Math.max(1, Math.min(100, atkResult.score || 50));
        room.state.pendingAttack.comment = atkResult.comment || '';
      } catch (e) {
        console.error(`[ROOM ${room.id}] Judge attack error:`, e.message);
        room.state.pendingAttack.score = 50;
        room.state.pendingAttack.comment = 'API 오류';
      }

      room.state.phase = 'WAITING_DEFEND';

      // Notify defender to defend
      sendJSON(defender.ws, {
        type: 'your_turn',
        action: 'defend',
        opponentText: data.text,
        atkScore: room.state.pendingAttack.score,
        atkComment: room.state.pendingAttack.comment
      });
      sendJSON(attacker.ws, {
        type: 'opponent_turn',
        message: `${defender.nickname}이(가) 방어 준비 중...`,
        atkScore: room.state.pendingAttack.score,
        atkComment: room.state.pendingAttack.comment
      });
      break;
    }

    case 'defend': {
      const room = rooms.get(ws.roomId);
      if (!room || room.state.phase !== 'WAITING_DEFEND') return;

      const attackerKey = room.state.currentAttacker;
      const defenderKey = attackerKey === 'p1' ? 'p2' : 'p1';
      const isDefender = (defenderKey === 'p1' && room.p1.ws === ws) ||
                          (defenderKey === 'p2' && room.p2.ws === ws);
      if (!isDefender) return;

      const attacker = room[attackerKey];
      const defender = room[defenderKey];

      room.state.phase = 'JUDGING_DEFEND';

      console.log(`[ROOM ${room.id}] ${defender.nickname} defends: "${data.text.slice(0, 30)}..."`);

      // Broadcast defense text
      sendJSON(attacker.ws, { type: 'defend_submitted', text: data.text, nickname: defender.nickname });
      sendJSON(defender.ws, { type: 'defend_submitted', text: data.text, nickname: defender.nickname });

      // Judge defense using ATTACKER's API (공평성)
      sendJSON(attacker.ws, { type: 'status', message: '⚖ 심판 최종 판정 중...' });
      sendJSON(defender.ws, { type: 'status', message: '⚖ 심판 최종 판정 중...' });

      let defScore = 50, defComment = '';
      try {
        const defResult = await judgeText(data.text, 'defend', attacker.api.provider, attacker.api.model, attacker.api.apiKey);
        defScore = Math.max(1, Math.min(100, defResult.score || 50));
        defComment = defResult.comment || '';
      } catch (e) {
        console.error(`[ROOM ${room.id}] Judge defend error:`, e.message);
        defComment = 'API 오류';
      }

      // Calculate damage (no difficulty multiplier in PvP)
      const atkScore = room.state.pendingAttack.score;
      const damage = Math.max(0, Math.round((atkScore - defScore * 0.6) * 0.5));

      // Apply damage to defender
      room.state[defenderKey + 'HP'] = Math.max(0, room.state[defenderKey + 'HP'] - damage);
      room.state.turn++;

      // Broadcast result
      const result = {
        type: 'round_result',
        atkText: room.state.pendingAttack.text,
        defText: data.text,
        atkScore,
        atkComment: room.state.pendingAttack.comment,
        defScore,
        defComment,
        damage,
        attackerNickname: attacker.nickname,
        defenderNickname: defender.nickname,
        attackerKey,
        defenderKey,
        p1HP: room.state.p1HP,
        p2HP: room.state.p2HP,
        turn: room.state.turn,
      };
      sendJSON(attacker.ws, result);
      sendJSON(defender.ws, result);

      // Check game over
      if (room.state[defenderKey + 'HP'] <= 0) {
        setTimeout(() => {
          sendJSON(attacker.ws, { type: 'game_over', winner: attacker.nickname, loser: defender.nickname });
          sendJSON(defender.ws, { type: 'game_over', winner: attacker.nickname, loser: defender.nickname });
          rooms.delete(room.id);
          console.log(`[ROOM ${room.id}] Game over: ${attacker.nickname} wins!`);
        }, 2500);
        return;
      }

      // Swap attacker/defender for next turn
      room.state.currentAttacker = defenderKey;
      room.state.phase = 'WAITING_ATTACK';
      room.state.pendingAttack = null;

      // Next turn after animation
      setTimeout(() => {
        if (!rooms.has(room.id)) return;
        sendJSON(defender.ws, { type: 'your_turn', action: 'attack' });
        sendJSON(attacker.ws, { type: 'opponent_turn', message: `${defender.nickname}이(가) 공격 준비 중...` });
      }, 2500);

      break;
    }
  }
}

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     ⚔  AGARI FIGHTERS SERVER  ⚔         ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${PORT}          ║`);

  // Show LAN IP addresses
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const url = `http://${net.address}:${PORT}`;
        const pad = ' '.repeat(Math.max(0, 38 - url.length));
        console.log(`  ║  LAN:     ${url}${pad}║`);
      }
    }
  }
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║  상대방에게 LAN 주소를 공유하세요!       ║');
  console.log('  ║  같은 네트워크가 아니면 ngrok 사용       ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
