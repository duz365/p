const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    let contentType = 'text/html';
    if (ext === '.js') contentType = 'application/javascript';
    if (ext === '.css') contentType = 'text/css';
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200, { 'Content-Type': contentType }); res.end(data); }
    });
});

const wss = new WebSocket.Server({ server });

const TOTAL_ROUNDS = 12;
const SWAP_AFTER = 5;       // 5回合后交换阵营
const ROUND_DELAY = 2600;   // 结算后延迟

const CARD_EMOJI = { emperor: '👑', citizen: '🏙️', slave: '⛓️' };
const CARD_NAME = { emperor: '皇帝', citizen: '市民', slave: '奴隶' };

// 出牌胜负矩阵：key 克 value 则 true
const BEATS = { emperor: ['citizen'], citizen: ['slave'], slave: ['emperor'] };
const SCORE = { emperor: 5, citizen: 1, slave: 5 };

function shuffledCards(side) {
    const special = side === 'emperor' ? 'emperor' : 'slave';
    const cards = [special, 'citizen', 'citizen', 'citizen', 'citizen'];
    for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
}

class Room {
    constructor(roomId) {
        this.roomId = roomId;
        this.ws = [null, null];       // 两个玩家连接
        this.sides = [null, null];    // 阵营
        this.scores = [0, 0];
        this.round = 0;
        this.swapped = false;
        this.cards = [[], []];
        this.moves = [null, null];
    }

    addPlayer(ws) {
        if (this.ws[0] && this.ws[0].readyState === WebSocket.OPEN) this.ws[1] = ws;
        else this.ws[0] = ws;
        return this.ws[0] === ws ? 0 : 1;
    }

    start() {
        // 随机分配初始阵营
        const rand = Math.random() < 0.5;
        this.sides[0] = rand ? 'emperor' : 'slave';
        this.sides[1] = rand ? 'slave' : 'emperor';
        this.broadcastTo(0, { type: 'gameStart', side: this.sides[0], player: 0 });
        this.broadcastTo(1, { type: 'gameStart', side: this.sides[1], player: 1 });
        this.newRound();
    }

    newRound() {
        this.round++;
        this.moves = [null, null];
        // 5回合后交换阵营
        if (this.round === SWAP_AFTER + 1 && !this.swapped) {
            this.swapped = true;
            this.sides.reverse();
            this.broadcastTo(0, { type: 'sideSwap', newSide: this.sides[0] });
            this.broadcastTo(1, { type: 'sideSwap', newSide: this.sides[1] });
        }
        this.cards[0] = shuffledCards(this.sides[0]);
        this.cards[1] = shuffledCards(this.sides[1]);
        this.broadcast({
            type: 'newRound',
            round: this.round,
            total: TOTAL_ROUNDS,
            scores: this.scores.slice(),
            swapped: this.swapped,
        });
    }

    play(ws, card) {
        const i = this.ws.indexOf(ws);
        if (i === -1 || this.moves[i] !== null) return;
        if (!this.cards[i].includes(card)) return;
        this.moves[i] = card;
        this.broadcastTo(i, { type: 'moveLocked', card });
        if (this.moves[0] !== null && this.moves[1] !== null) {
            this.settle();
        }
    }

    settle() {
        const [a, b] = this.moves;
        let winnerIdx = -1;
        if (a !== b) {
            if (BEATS[a].includes(b)) winnerIdx = 0;
            else if (BEATS[b].includes(a)) winnerIdx = 1;
        }
        let score = 0;
        if (winnerIdx === 0) score = SCORE[a];
        else if (winnerIdx === 1) score = SCORE[b];
        if (winnerIdx !== -1) this.scores[winnerIdx] += score;

        const result = {
            type: 'roundResult',
            round: this.round,
            cards: [CARD_NAME[a], CARD_NAME[b]],
            winner: winnerIdx === -1 ? -1 : winnerIdx,
            score,
            scores: this.scores.slice(),
        };
        this.broadcast(result);

        if (this.round >= TOTAL_ROUNDS) {
            const win = this.scores[0] === this.scores[1] ? -1 : (this.scores[0] > this.scores[1] ? 0 : 1);
            const over = {
                type: 'gameOver',
                winner: win,
                scores: this.scores.slice(),
            };
            this.broadcastTo(0, { ...over, youWin: win === 0 });
            this.broadcastTo(1, { ...over, youWin: win === 1 });
            const self = this;
            setTimeout(() => self.destroy(), 5000);
        } else {
            const self = this;
            setTimeout(() => self.newRound(), ROUND_DELAY);
        }
    }

    chat(ws, msg) {
        const i = this.ws.indexOf(ws);
        if (i === -1) return;
        const safe = String(msg).slice(0, 80);
        if (!safe) return;
        this.broadcast({ type: 'chat', from: i, msg: safe });
    }

    broadcastTo(idx, data) {
        const ws = this.ws[idx];
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    }

    broadcast(data) {
        this.broadcastTo(0, data);
        this.broadcastTo(1, data);
    }

    destroy() {
        clearInterval(this.interval);
        this.ws.forEach(ws => {
            try { ws.roomId = null; } catch (e) {}
        });
    }
}

const rooms = new Map();

// 心跳保活：防止代理/免费平台掐断空闲连接
const HEARTBEAT_INTERVAL = 30000;
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

wss.on('connection', (ws) => {
    ws.roomId = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        switch (msg.type) {
            case 'create': {
                if (!ws.roomId) {
                    const id = Math.random().toString(36).substr(2, 4).toUpperCase();
                    const room = new Room(id);
                    room.addPlayer(ws);
                    rooms.set(id, room);
                    ws.roomId = id;
                    ws.send(JSON.stringify({ type: 'room_created', roomId: id }));
                }
                break;
            }
            case 'join': {
                const room = rooms.get(msg.roomId);
                if (!room) { ws.send(JSON.stringify({ type: 'error', msg: '房间不存在' })); return; }
                if (room.ws[0] && room.ws[1] && room.ws[1].readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', msg: '房间已满' })); return;
                }
                room.addPlayer(ws);
                ws.roomId = msg.roomId;
                ws.send(JSON.stringify({ type: 'joined_room', roomId: msg.roomId }));
                room.start();
                break;
            }
            case 'play': {
                const room = rooms.get(ws.roomId);
                if (room) room.play(ws, msg.card);
                break;
            }
            case 'chat': {
                const room = rooms.get(ws.roomId);
                if (room) room.chat(ws, msg.msg);
                break;
            }
        }
    });

    ws.on('close', () => {
        if (ws.roomId) {
            const room = rooms.get(ws.roomId);
            if (room) {
                const i = room.ws.indexOf(ws);
                if (i !== -1) {
                    const other = room.ws[1 - i];
                    if (other && other.readyState === WebSocket.OPEN)
                        other.send(JSON.stringify({ type: 'opponentLeft' }));
                }
                room.destroy();
                rooms.delete(ws.roomId);
            }
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`皇帝与奴隶 服务器运行在 http://localhost:${PORT}`));