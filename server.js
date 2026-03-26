const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/localip', (req, res) => {
  const nets = os.networkInterfaces();
  let ip = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
    }
    if (ip !== 'localhost') break;
  }
  res.json({ ip });
});

// ─── Deck ─────────────────────────────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const VALS  = [2,3,4,5,6,7,8,9,10,11,12,13,14];
const VNAME = v => v===11?'J':v===12?'Q':v===13?'K':v===14?'A':String(v);
const RED   = new Set(['♥','♦']);

function makeDeck() {
  const d = [];
  for (const s of SUITS)
    for (const v of VALS)
      d.push({ s, v, label: VNAME(v)+s, red: RED.has(s) });
  return d;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

// ─── Hand eval ────────────────────────────────────────────────────────────────
function evalHand(cards) {
  const vals = cards.map(c=>c.v).sort((a,b)=>b-a);      // desc
  const suits = cards.map(c=>c.s);
  const flush = suits.every(s=>s===suits[0]);
  const sv = [...vals].sort((a,b)=>a-b);                  // asc

  let straight = sv[2]-sv[1]===1 && sv[1]-sv[0]===1;
  let sCmp = [...vals];                                    // high→low for comparison
  if (!straight && sv[0]===2 && sv[1]===3 && sv[2]===14) {
    straight = true;
    sCmp = [3,2,1];  // A plays low, worst straight
  }

  // 豹子
  if (vals[0]===vals[1] && vals[1]===vals[2])
    return { rank:6, type:'豹子', cmp:[vals[0]] };
  // 顺金
  if (flush && straight) return { rank:5, type:'顺金', cmp:sCmp };
  // 金花
  if (flush)             return { rank:4, type:'金花', cmp:vals };
  // 顺子
  if (straight)          return { rank:3, type:'顺子', cmp:sCmp };
  // 对子
  if (vals[0]===vals[1]) return { rank:2, type:'对子', cmp:[vals[0],vals[2]] };
  if (vals[1]===vals[2]) return { rank:2, type:'对子', cmp:[vals[1],vals[0]] };
  // 散牌
  return { rank:1, type:'散牌', cmp:vals };
}

function cmp(h1, h2) {
  if (h1.rank !== h2.rank) return h1.rank>h2.rank ? 1 : -1;
  for (let i=0; i<Math.max(h1.cmp.length,h2.cmp.length); i++) {
    const a=h1.cmp[i]||0, b=h2.cmp[i]||0;
    if (a!==b) return a>b ? 1 : -1;
  }
  return 0;
}

// ─── Room state ───────────────────────────────────────────────────────────────
const rooms = new Map();

function mkRoom(id) {
  return {
    id, state:'WAITING',
    players: [],
    pot:0, currentBet:10, ante:10,
    curIdx:0, deck:[], log:[]
  };
}

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, mkRoom(id));
  return rooms.get(id);
}

function active(room) {
  return room.players.filter(p=>p.state==='ACTIVE'||p.state==='ALLIN');
}

function log(room, text, type='sys') {
  room.log.push({ text, type, t: Date.now() });
  if (room.log.length>80) room.log.shift();
}

// Broadcast state to all players in room (each gets their own card view)
function broadcast(room) {
  room.players.forEach(me => {
    io.to(me.id).emit('state', {
      roomId: room.id,
      gameState: room.state,
      pot: room.pot,
      currentBet: room.currentBet,
      ante: room.ante,
      curId: room.players[room.curIdx]?.id,
      myId: me.id,
      log: room.log.slice(-25),
      players: room.players.map(p => ({
        id: p.id, name: p.name, chips: p.chips,
        totalBet: p.totalBet, state: p.state,
        isLooking: p.isLooking, revealed: p.revealed,
        isHost: p.isHost,
        cards: (p.id===me.id || p.revealed) ? p.cards : null,
        handType: ((p.id===me.id && p.isLooking) || p.revealed)
          ? evalHand(p.cards).type : null,
      }))
    });
  });
}

// ─── Game logic ───────────────────────────────────────────────────────────────
function startGame(room) {
  room.state = 'PLAYING';
  room.deck = shuffle(makeDeck());
  room.pot = 0;
  room.currentBet = room.ante;

  room.players.forEach(p => {
    p.cards = [room.deck.pop(), room.deck.pop(), room.deck.pop()];
    p.state = 'ACTIVE';
    p.isLooking = false;
    p.revealed = false;
    p.totalBet = room.ante;
    p.chips = Math.max(0, p.chips - room.ante);
    room.pot += room.ante;
  });

  room.curIdx = 0;
  log(room, `新局开始！底注 ${room.ante}，底池 ${room.pot}`, 'sys');
  broadcast(room);
}

function nextTurn(room) {
  const alive = active(room);
  if (alive.length <= 1) { endGame(room); return; }

  // Skip folded/allin
  let idx = (room.curIdx+1) % room.players.length;
  let tries = 0;
  while (room.players[idx].state!=='ACTIVE' && tries<room.players.length) {
    idx = (idx+1) % room.players.length;
    tries++;
  }
  if (room.players[idx].state !== 'ACTIVE') { endGame(room); return; }
  room.curIdx = idx;
  broadcast(room);
}

function endGame(room) {
  const alive = active(room);
  let winner;
  if (alive.length === 1) {
    winner = alive[0];
  } else if (alive.length === 0) {
    winner = room.players[0];
  } else {
    // Compare all
    let best = null;
    alive.forEach(p => {
      if (!best || cmp(evalHand(p.cards), evalHand(best.cards)) > 0) best = p;
    });
    winner = best;
  }

  winner.chips += room.pot;
  room.players.forEach(p => p.revealed = true);
  room.state = 'ENDED';

  const hand = evalHand(winner.cards);
  log(room, `${winner.name} 凭 [${hand.type}] 赢得 ${room.pot} 筹码！`, 'win');
  broadcast(room);

  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    room.players = room.players.filter(p => p.chips > 0);
    if (room.players.length > 0) {
      if (!room.players.some(p=>p.isHost)) room.players[0].isHost = true;
      room.state = 'WAITING';
      log(room, '可以开始下一局了', 'sys');
      broadcast(room);
    }
  }, 7000);
}

function doAction(room, player, { type, payload }) {
  if (room.state !== 'PLAYING') return;
  if (room.players[room.curIdx]?.id !== player.id) return;

  if (type === 'look') {
    if (player.isLooking) return;
    player.isLooking = true;
    log(room, `${player.name} 看牌了`, 'look');
    broadcast(room);
    return; // no turn advance
  }

  if (type === 'fold') {
    player.state = 'FOLDED';
    log(room, `${player.name} 弃牌`, 'fold');
    const alive = active(room);
    if (alive.length <= 1) { endGame(room); return; }
    nextTurn(room); return;
  }

  if (type === 'bet') {
    const minPay = player.isLooking ? room.currentBet : Math.ceil(room.currentBet/2);
    let amount = Math.max(parseInt(payload?.amount)||0, minPay);
    amount = Math.min(amount, player.chips);
    if (amount <= 0) return;

    player.chips -= amount;
    player.totalBet += amount;
    room.pot += amount;

    const eff = player.isLooking ? amount : amount*2;
    if (eff > room.currentBet) room.currentBet = eff;
    if (player.chips === 0) player.state = 'ALLIN';

    log(room,
      `${player.name} ${player.isLooking?'下注':'蒙注'} ${amount}  底池→${room.pot}`,
      'bet');
    nextTurn(room); return;
  }

  if (type === 'compare') {
    if (!player.isLooking) { io.to(player.id).emit('err','蒙牌不能比牌'); return; }
    const target = room.players.find(p=>p.id===payload?.targetId && p.state!=='FOLDED');
    if (!target || target.id===player.id) return;

    const cost = room.currentBet;
    if (player.chips < cost) { io.to(player.id).emit('err','筹码不足'); return; }

    player.chips -= cost;
    player.totalBet += cost;
    room.pot += cost;

    const h1 = evalHand(player.cards);
    const h2 = evalHand(target.cards);
    const res = cmp(h1, h2);
    player.revealed = true;
    target.revealed = true;

    // tie: challenger loses
    const loser = res >= 0 ? (res===0 ? player : target) : player;
    loser.state = 'FOLDED';

    const winnerName = loser.id===player.id ? target.name : player.name;
    log(room,
      `比牌：${player.name}[${h1.type}] vs ${target.name}[${h2.type}] → ${winnerName} 赢`,
      'cmp');

    const alive = active(room);
    if (alive.length <= 1) { endGame(room); return; }
    if (loser.id === player.id) nextTurn(room);
    else broadcast(room);
    return;
  }
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', ({ name, roomId }) => {
    if (!name || !roomId) return;
    const rid = String(roomId).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    if (!rid) return;

    const room = getRoom(rid);
    if (room.state !== 'WAITING') { socket.emit('err','游戏进行中，无法加入'); return; }
    if (room.players.length >= 6) { socket.emit('err','房间已满（最多6人）'); return; }

    socket.join(rid);
    socket._rid = rid;

    const player = {
      id: socket.id, name: String(name).trim().slice(0,12)||'玩家',
      chips: 2000, cards: [], state:'ACTIVE',
      isLooking: false, revealed: false,
      totalBet: 0, isHost: room.players.length===0,
    };
    room.players.push(player);
    log(room, `${player.name} 加入房间（${room.players.length}/6）`);
    broadcast(room);
  });

  socket.on('start', () => {
    const room = rooms.get(socket._rid);
    if (!room) return;
    const p = room.players.find(p=>p.id===socket.id);
    if (!p?.isHost) return;
    if (room.state !== 'WAITING') return;
    if (room.players.length < 2) { socket.emit('err','至少2人才能开始'); return; }
    startGame(room);
  });

  socket.on('action', action => {
    const room = rooms.get(socket._rid);
    if (!room) return;
    const p = room.players.find(p=>p.id===socket.id);
    if (p) doAction(room, p, action);
  });

  socket.on('chat', text => {
    const room = rooms.get(socket._rid);
    if (!room) return;
    const p = room.players.find(p=>p.id===socket.id);
    if (!p) return;
    const safe = String(text).slice(0,60).replace(/</g,'&lt;');
    log(room, `${p.name}: ${safe}`, 'chat');
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket._rid);
    if (!room) return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx === -1) return;
    const p = room.players[idx];
    log(room, `${p.name} 离线了`);
    room.players.splice(idx, 1);
    if (room.players.length === 0) { rooms.delete(room.id); return; }
    if (p.isHost) room.players[0].isHost = true;
    if (room.state==='PLAYING') {
      if (room.curIdx >= room.players.length) room.curIdx = 0;
      const alive = active(room);
      if (alive.length<=1) endGame(room); else broadcast(room);
    } else broadcast(room);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let ip = 'localhost';
  for (const name of Object.keys(nets))
    for (const n of nets[name])
      if (n.family==='IPv4' && !n.internal) { ip=n.address; break; }
  console.log(`炸金花服务器已启动`);
  console.log(`本机: http://localhost:${PORT}`);
  console.log(`局域网: http://${ip}:${PORT}`);
});
