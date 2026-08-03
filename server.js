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

const TOTAL_ROUNDS = 5;        // 一局5回合
const ROUND_DELAY = 2600;      // 结算后延迟
const PROP_TIMER = null;

const CARD_NAME = { emperor: '皇帝', citizen: '市民', slave: '奴隶' };

// 出牌胜负矩阵：key 克 value 则 true
const BEATS = { emperor: ['citizen'], citizen: ['slave'], slave: ['emperor'] };

// 每方5张：1张身份牌 + 4张市民（新规则不再重新发牌，用完即弃）
function dealCards(side) {
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
        this.ws = [null, null];
        this.sides = [null, null];
        this.hands = [[], []];      // 剩余手牌
        this.round = 0;
        this.swapped = false;
        this.moves = [null, null];
        this.running = false;
        this.over = false;
        this.settleTimer = null;
        this.rematchReady = [false, false];
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

        this.round = 0;
        this.moves = [null, null];
        this.running = true;
        this.over = false;
        this.rematchReady = [false, false];

        // 发一手牌（不再在每回合重新发）
        this.hands[0] = dealCards(this.sides[0]);
        this.hands[1] = dealCards(this.sides[1]);

        this.broadcastTo(0, { type: 'gameStart', side: this.sides[0], player: 0, round: TOTAL_ROUNDS });
        this.broadcastTo(1, { type: 'gameStart', side: this.sides[1], player: 1, round: TOTAL_ROUNDS });
        this.broadcast({ type: 'gameReady', round: TOTAL_ROUNDS });
        this.newRound();
    }

    newRound() {
        this.round++;
        this.moves = [null, null];
        // 发给各自剩余手牌
        this.broadcastTo(0, { type: 'newRound', round: this.round, total: TOTAL_ROUNDS, hand: this.hands[0].slice() });
        this.broadcastTo(1, { type: 'newRound', round: this.round, total: TOTAL_ROUNDS, hand: this.hands[1].slice() });
    }

    play(ws, card) {
        if (!this.running || this.over) return;
        const i = this.ws.indexOf(ws);
        if (i === -1 || this.moves[i] !== null) return;
        if (!this.hands[i].includes(card)) return;

        // 用掉并丢弃这张牌
        this.hands[i] = this.removeOne(this.hands[i], card);

        this.moves[i] = card;
        this.broadcastTo(i, { type: 'moveLocked', card, hand: this.hands[i].slice() });

        if (this.moves[0] !== null && this.moves[1] !== null) {
            this.settle();
        }
    }

    removeOne(arr, card) {
        const idx = arr.indexOf(card);
        if (idx === -1) return arr;
        const copy = arr.slice();
        copy.splice(idx, 1);
        return copy;
    }

    settle() {
        const [a, b] = this.moves;
        let winnerIdx = -1;
        if (a !== b) {
            if (BEATS[a].includes(b)) winnerIdx = 0;
            else if (BEATS[b].includes(a)) winnerIdx = 1;
        }

        // 广播本回合结果（含双方出的牌）
        const result = {
            type: 'roundResult',
            round: this.round,
            cards: [CARD_NAME[a], CARD_NAME[b]],
            winner: winnerIdx === -1 ? -1 : winnerIdx,
        };

        if (winnerIdx !== -1) {
            // 有一方输，立即整局结束
            this.broadcast(result);
            this.over = true;
            this.running = false;
            setTimeout(() => {
                this.broadcastTo(0, { type: 'gameOver', winner: winnerIdx, youWin: winnerIdx === 0 });
                this.broadcastTo(1, { type: 'gameOver', winner: winnerIdx, youWin: winnerIdx === 1 });
            }, 1200);
        } else {
            // 平局：若牌已用尽则平局结束，否则下一回合
            if (this.round >= TOTAL_ROUNDS || (this.hands[0].length === 0 && this.hands[1].length === 0)) {
                this.broadcast(result);
                this.over = true;
                this.running = false;
                setTimeout(() => {
                    this.broadcast({ type: 'gameOver', winner: -1, youWin: false, draw: true });
                }, 1200);
            } else {
                this.broadcast(result);
                const self = this;
                this.settleTimer = setTimeout(() => self.newRound(), ROUND_DELAY);
            }
        }
    }

    rematch(idx) {
        if (!this.over) return;
        this.rematchReady[idx] = true;
        const other = 1 - idx;
        if (this.rematchReady[0] && this.rematchReady[1]) {
            // 双方都点了再来一局，同房间重开
            this.start();
        } else {
            // 通知对方我已准备
            this.broadcastTo(other, { type: 'rematchWaiting' });
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
        if (this.settleTimer) clearTimeout(this.settleTimer);
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
            case 'rematch': {
                const room = rooms.get(ws.roomId);
                if (room) room.rematch(thisIdx(room, ws));
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

function thisIdx(room, ws) { return room.ws.indexOf(ws); }

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`皇帝与奴隶 服务器运行在 http://localhost:${PORT}`));