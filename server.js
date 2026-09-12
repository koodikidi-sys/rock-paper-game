const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

const USERS_FILE = path.join(__dirname, 'users.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');

function loadData(file) {
    if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
    }
    return {};
}

function saveData(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let users = loadData(USERS_FILE);
let roomChats = loadData(CHATS_FILE);
let groupProfiles = {};
let rooms = {};

// صف‌های انتظار برای بازی‌های ۳ و ۴ نفره
let queues = {
    dice3: [],
    hokm4: []
};

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: 'اطلاعات ناقص است.' });
    if (users[username]) return res.json({ success: false, message: 'نام کاربری تکراری است.' });
    users[username] = { password, coins: 300 };
    saveData(USERS_FILE, users);
    res.json({ success: true, message: 'ثبت‌نام موفق!' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!users[username] || users[username].password !== password) {
        return res.json({ success: false, message: 'اطلاعات ورود اشتباه است.' });
    }
    res.json({ success: true, username, coins: users[username].coins });
});

io.on('connection', (socket) => {
    socket.on('join-room', ({ roomId, username }) => {
        socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
        if (!username) return;
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], usernames: {}, sessions: {} };
        }
        if (!groupProfiles[roomId]) {
            groupProfiles[roomId] = { title: roomId, description: 'گروه چت و بازی' };
        }

        let room = rooms[roomId];
        if (!room.players.includes(socket.id)) room.players.push(socket.id);
        room.usernames[socket.id] = username;

        if (!users[username]) {
            users[username] = { password: '', coins: 300 };
            saveData(USERS_FILE, users);
        }

        socket.emit('joined', { coins: users[username].coins });
        socket.emit('room-profile', groupProfiles[roomId]);
        if (roomChats[roomId]) socket.emit('load-chat-history', roomChats[roomId]);

        updateMembers(roomId);
    });

    function updateMembers(roomId) {
        let room = rooms[roomId];
        if (!room) return;
        let list = room.players.map(id => ({ id, username: room.usernames[id] }));
        io.to(roomId).emit('update-members', list);
    }

    // گزینه ۱: بازی با ربات
    socket.on('play-bot', ({ gameType, move }) => {
        let username = getUsernameBySocket(socket.id);
        if (!username) return;

        if (gameType === 'rps') {
            const botMoves = ['سنگ', 'کاغذ', 'قیچی'];
            const botMove = botMoves[Math.floor(Math.random() * botMoves.length)];
            let res = '';
            if (move === botMove) res = 'مساوی!';
            else if ((move === 'سنگ' && botMove === 'قیچی') || (move === 'کاغذ' && botMove === 'سنگ') || (move === 'قیچی' && botMove === 'کاغذ')) {
                res = 'برنده شدید! (+20 سکه)';
                users[username].coins += 20;
            } else {
                res = 'باختید! (-20 سکه)';
                users[username].coins = Math.max(0, users[username].coins - 20);
            }
            saveData(USERS_FILE, users);
            socket.emit('bot-rps-result', { myMove: move, botMove, result: res, newCoins: users[username].coins });
        }
    });

    // گزینه ۲: چالش دو نفره با دوست آنلاین
    socket.on('challenge-player', ({ targetId, gameType, roomId }) => {
        let room = rooms[roomId];
        if (!room) return;
        io.to(targetId).emit('game-challenge-received', {
            challengerId: socket.id,
            challengerName: room.usernames[socket.id],
            gameType,
            roomId
        });
    });

    socket.on('accept-challenge', ({ challengerId, gameType, roomId }) => {
        let sessionId = 'sess_' + Math.random().toString(36).substring(2, 9);
        let room = rooms[roomId];
        if (!room) return;
        if (!room.sessions) room.sessions = {};

        let participants = [challengerId, socket.id];
        let sessionData = { gameType, participants, state: {} };

        if (gameType === 'xo') sessionData.state = { board: Array(9).fill(''), turn: challengerId };
        else if (gameType === 'rps') sessionData.state = { choices: {} };
        else if (gameType === 'dice') sessionData.state = { rolls: {} };

        room.sessions[sessionId] = sessionData;

        participants.forEach(pId => {
            io.to(pId).emit('enter-session', { sessionId, gameType, participants });
        });
    });

    // گزینه ۳ و ۴: پیوستن به صف‌های ۳ نفره (تاس) یا ۴ نفره (حکم)
    socket.on('join-queue', ({ gameType, roomId }) => {
        let username = getUsernameBySocket(socket.id);
        if (!username) return;

        if (gameType === 'dice3') {
            if (!queues.dice3.includes(socket.id)) queues.dice3.push(socket.id);
            socket.emit('queue-status', { msg: `در صف تاس ۳ نفره (${queues.dice3.length}/3)` });

            if (queues.dice3.length >= 3) {
                let participants = queues.dice3.splice(0, 3);
                createMultiplayerSession(roomId, 'dice3', participants);
            }
        } else if (gameType === 'hokm4') {
            if (!queues.hokm4.includes(socket.id)) queues.hokm4.push(socket.id);
            socket.emit('queue-status', { msg: `در صف حکم ۴ نفره (${queues.hokm4.length}/4)` });

            if (queues.hokm4.length >= 4) {
                let participants = queues.hokm4.splice(0, 4);
                createMultiplayerSession(roomId, 'hokm4', participants);
            }
        }
    });

    function createMultiplayerSession(roomId, gameType, participants) {
        let sessionId = 'sess_' + Math.random().toString(36).substring(2, 9);
        let room = rooms[roomId];
        if (!room) return;
        if (!room.sessions) room.sessions = {};

        let sessionData = { gameType, participants, state: {} };
        if (gameType === 'dice3') sessionData.state = { rolls: {} };
        else if (gameType === 'hokm4') sessionData.state = { status: 'started', hakem: participants[0] };

        room.sessions[sessionId] = sessionData;
        participants.forEach(pId => {
            io.to(pId).emit('enter-session', { sessionId, gameType, participants });
        });
    }

    // حرکات بازی‌های دو و چند نفره
    socket.on('session-xo-move', ({ roomId, sessionId, index }) => {
        let room = rooms[roomId];
        if (!room || !room.sessions[sessionId]) return;
        let sess = room.sessions[sessionId];
        if (sess.state.turn !== socket.id || sess.state.board[index] !== '') return;

        let symbol = sess.participants.indexOf(socket.id) === 0 ? 'X' : 'O';
        sess.state.board[index] = symbol;
        sess.state.turn = sess.participants.find(id => id !== socket.id);

        const winPatterns = [[0,1,2], [3,4,5], [6,7,8], [0,3,6], [1,4,7], [2,5,8], [0,4,8], [2,4,6]];
        let winner = null;
        for (let p of winPatterns) {
            if (sess.state.board[p[0]] && sess.state.board[p[0]] === sess.state.board[p[1]] && sess.state.board[p[0]] === sess.state.board[p[2]]) {
                winner = sess.state.board[p[0]];
                break;
            }
        }
        let isDraw = !winner && sess.state.board.every(c => c !== '');

        if (winner || isDraw) {
            let msg = isDraw ? 'مساوی!' : `برنده: ${room.usernames[winner === 'X' ? sess.participants[0] : sess.participants[1]]} 🎉`;
            sess.participants.forEach(pId => io.to(pId).emit('session-xo-over', { board: sess.state.board, msg }));
            delete room.sessions[sessionId];
        } else {
            sess.participants.forEach(pId => io.to(pId).emit('session-xo-update', { board: sess.state.board, turn: sess.state.turn }));
        }
    });

    socket.on('session-dice-roll', ({ roomId, sessionId }) => {
        let room = rooms[roomId];
        if (!room || !room.sessions[sessionId]) return;
        let sess = room.sessions[sessionId];
        sess.state.rolls[socket.id] = Math.floor(Math.random() * 6) + 1;

        if (Object.keys(sess.state.rolls).length === sess.participants.length) {
            sess.participants.forEach(pId => {
                io.to(pId).emit('session-dice-result', { rolls: sess.state.rolls, names: room.usernames });
            });
            delete room.sessions[sessionId];
        }
    });

    function getUsernameBySocket(socketId) {
        for (let rId in rooms) {
            if (rooms[rId].usernames[socketId]) return rooms[rId].usernames[socketId];
        }
        return null;
    }

    socket.on('transfer-coins', ({ targetUser, amount, senderUser }) => {
        amount = parseInt(amount);
        if (isNaN(amount) || amount <= 0 || !users[targetUser] || senderUser === targetUser || users[senderUser].coins < amount) {
            socket.emit('transfer-result', { success: false, message: 'خطا در انتقال سکه.' });
            return;
        }
        users[senderUser].coins -= amount;
        users[targetUser].coins += amount;
        saveData(USERS_FILE, users);
        socket.emit('transfer-result', { success: true, message: 'انتقال موفق!', newCoins: users[senderUser].coins });
    });

    socket.on('send-message', ({ roomId, message, senderName }) => {
        if (!roomChats[roomId]) roomChats[roomId] = [];
        roomChats[roomId].push({ senderName, message });
        saveData(CHATS_FILE, roomChats);
        io.to(roomId).emit('receive-message', { message, senderName });
    });

    socket.on('disconnect', () => {
        for (let rId in queues) {
            queues[rId] = queues[rId].filter(id => id !== socket.id);
        }
        for (let roomId in rooms) {
            let room = rooms[roomId];
            if (room.players.includes(socket.id)) {
                room.players = room.players.filter(id => id !== socket.id);
                delete room.usernames[socket.id];
                if (room.players.length === 0) delete rooms[roomId];
                else updateMembers(roomId);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT);