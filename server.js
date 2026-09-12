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
            groupProfiles[roomId] = { title: roomId, description: 'گروه چت آزاد' };
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

    socket.on('start-session', ({ roomId, gameType, participants }) => {
        let sessionId = 'sess_' + Math.random().toString(36).substring(2, 9);
        let room = rooms[roomId];
        if (!room) return;

        if (!room.sessions) room.sessions = {};
        
        let sessionData = {
            gameType,
            participants,
            state: {}
        };

        if (gameType === 'xo') {
            sessionData.state = { board: Array(9).fill(''), turn: participants[0] };
        } else if (gameType === 'rps') {
            sessionData.state = { choices: {} };
        } else if (gameType === 'dice') {
            sessionData.state = { rolls: {} };
        }

        room.sessions[sessionId] = sessionData;

        participants.forEach(pId => {
            io.to(pId).emit('enter-session', { sessionId, gameType, participants });
        });
    });

    socket.on('session-xo-move', ({ roomId, sessionId, index }) => {
        let room = rooms[roomId];
        if (!room || !room.sessions[sessionId]) return;
        let sess = room.sessions[sessionId];
        if (sess.state.turn !== socket.id) return;
        if (sess.state.board[index] !== '') return;

        let pIdx = sess.participants.indexOf(socket.id);
        let symbol = pIdx === 0 ? 'X' : 'O';
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

        if (winner) {
            let winId = winner === 'X' ? sess.participants[0] : sess.participants[1];
            let loseId = sess.participants.find(id => id !== winId);
            let wName = room.usernames[winId];
            let lName = room.usernames[loseId];

            users[wName].coins += 50;
            users[lName].coins = Math.max(0, users[lName].coins - 50);
            saveData(USERS_FILE, users);

            sess.participants.forEach(pId => {
                io.to(pId).emit('session-xo-over', { board: sess.state.board, msg: `برنده: ${wName} 🎉` });
            });
            delete room.sessions[sessionId];
        } else if (isDraw) {
            sess.participants.forEach(pId => {
                io.to(pId).emit('session-xo-over', { board: sess.state.board, msg: 'مساوی!' });
            });
            delete room.sessions[sessionId];
        } else {
            sess.participants.forEach(pId => {
                io.to(pId).emit('session-xo-update', { board: sess.state.board, turn: sess.state.turn });
            });
        }
    });

    socket.on('session-rps-move', ({ roomId, sessionId, move }) => {
        let room = rooms[roomId];
        if (!room || !room.sessions[sessionId]) return;
        let sess = room.sessions[sessionId];
        sess.state.choices[socket.id] = move;

        if (Object.keys(sess.state.choices).length === sess.participants.length) {
            let [p1, p2] = sess.participants;
            let c1 = sess.state.choices[p1];
            let c2 = sess.state.choices[p2];
            let u1 = room.usernames[p1];
            let u2 = room.usernames[p2];

            let res1 = '', res2 = '';
            if (c1 === c2) {
                res1 = res2 = 'مساوی!';
            } else if ((c1 === 'سنگ' && c2 === 'قیچی') || (c1 === 'کاغذ' && c2 === 'سنگ') || (c1 === 'قیچی' && c2 === 'کاغذ')) {
                res1 = 'برنده شدید! (+50)'; res2 = 'باختید! (-50)';
                users[u1].coins += 50; users[u2].coins = Math.max(0, users[u2].coins - 50);
            } else {
                res1 = 'باختید! (-50)'; res2 = 'برنده شدید! (+50)';
                users[u2].coins += 50; users[u1].coins = Math.max(0, users[u1].coins - 50);
            }
            saveData(USERS_FILE, users);

            io.to(p1).emit('session-rps-result', { myMove: c1, oppMove: c2, result: res1, newCoins: users[u1].coins });
            io.to(p2).emit('session-rps-result', { myMove: c2, oppMove: c1, result: res2, newCoins: users[u2].coins });
            delete room.sessions[sessionId];
        }
    });

    socket.on('session-dice-roll', ({ roomId, sessionId }) => {
        let room = rooms[roomId];
        if (!room || !room.sessions[sessionId]) return;
        let sess = room.sessions[sessionId];
        let roll = Math.floor(Math.random() * 6) + 1;
        sess.state.rolls[socket.id] = roll;

        if (Object.keys(sess.state.rolls).length === sess.participants.length) {
            let maxR = -1;
            let winners = [];
            for (let pId in sess.state.rolls) {
                if (sess.state.rolls[pId] > maxR) { maxR = sess.state.rolls[pId]; winners = [pId]; }
                else if (sess.state.rolls[pId] === maxR) { winners.push(pId); }
            }

            if (winners.length === 1) {
                let wId = winners[0];
                let wName = room.usernames[wId];
                users[wName].coins += (sess.participants.length - 1) * 30;
                sess.participants.forEach(pId => {
                    if (pId !== wId) {
                        let lName = room.usernames[pId];
                        users[lName].coins = Math.max(0, users[lName].coins - 30);
                    }
                });
                saveData(USERS_FILE, users);
            }

            sess.participants.forEach(pId => {
                io.to(pId).emit('session-dice-result', { rolls: sess.state.rolls, names: room.usernames, newCoins: users[room.usernames[pId]].coins });
            });
            delete room.sessions[sessionId];
        }
    });

    socket.on('update-group-profile', ({ roomId, title, description }) => {
        if (groupProfiles[roomId]) {
            if (title) groupProfiles[roomId].title = title;
            if (description) groupProfiles[roomId].description = description;
            io.to(roomId).emit('room-profile', groupProfiles[roomId]);
        }
    });

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