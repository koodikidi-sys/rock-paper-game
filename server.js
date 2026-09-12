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
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            return {};
        }
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
    if (!username || !password) {
        return res.json({ success: false, message: 'لطفاً نام کاربری و رمز عبور را وارد کنید.' });
    }
    if (users[username]) {
        return res.json({ success: false, message: 'این نام کاربری قبلاً ثبت‌نام کرده است!' });
    }
    users[username] = { password, coins: 300 };
    saveData(USERS_FILE, users);
    res.json({ success: true, message: 'ثبت‌نام با موفقیت انجام شد!' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!users[username] || users[username].password !== password) {
        return res.json({ success: false, message: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
    res.json({ success: true, username, coins: users[username].coins });
});

io.on('connection', (socket) => {
    console.log('یک کاربر وصل شد:', socket.id);

    socket.on('join-room', ({ roomId, username }) => {
        socket.rooms.forEach(r => {
            if (r !== socket.id) socket.leave(r);
        });

        if (!username || typeof username !== 'string') return;

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                usernames: {},
                scores: {},
                xoBoard: Array(9).fill(''),
                xoTurn: null,
                choices: {}
            };
        }

        if (!groupProfiles[roomId]) {
            groupProfiles[roomId] = {
                title: roomId,
                description: 'گروه چت و دورهمی'
            };
        }

        let room = rooms[roomId];

        if (!room.players.includes(socket.id)) {
            room.players.push(socket.id);
        }
        room.usernames[socket.id] = username;

        if (!users[username]) {
            users[username] = { password: '', coins: 300 };
            saveData(USERS_FILE, users);
        }
        room.scores[socket.id] = users[username].coins;

        socket.emit('joined', { coins: room.scores[socket.id] });
        socket.emit('room-profile', groupProfiles[roomId]);

        if (roomChats[roomId]) {
            socket.emit('load-chat-history', roomChats[roomId]);
        }

        updateRoomMembers(roomId);
    });

    function updateRoomMembers(roomId) {
        let room = rooms[roomId];
        if (!room) return;
        let memberList = room.players.map(id => ({
            id: id,
            username: room.usernames[id]
        }));
        io.to(roomId).emit('update-members', memberList);
    }

    // چالش و دعوت به بازی بین دو کاربر
    socket.on('challenge-player', ({ targetId, gameType, roomId }) => {
        let room = rooms[roomId];
        if (!room) return;
        let challengerName = room.usernames[socket.id];
        
        io.to(targetId).emit('game-challenge-received', {
            challengerId: socket.id,
            challengerName: challengerName,
            gameType: gameType,
            roomId: roomId
        });
    });

    socket.on('accept-challenge', ({ challengerId, gameType, roomId }) => {
        // شروع بازی دو نفره بین دعوت‌کننده و پذیرنده
        io.to(challengerId).emit('start-matched-game', { gameType, opponentId: socket.id });
        socket.emit('start-matched-game', { gameType, opponentId: challengerId });

        io.to(roomId).emit('receive-message', {
            senderName: 'سیستم',
            message: `🎮 مسابقه اختصاصی در بازی ${gameType} بین کاربران شروع شد!`
        });
    });

    // منطق بازی سنگ کاغذ قیچی دو نفره
    socket.on('make-match-rps', ({ opponentId, move, roomId }) => {
        let room = rooms[roomId];
        if (!room) return;
        
        if (!room.choices) room.choices = {};
        room.choices[socket.id] = move;

        if (room.choices[opponentId]) {
            let p1 = socket.id;
            let p2 = opponentId;
            let c1 = room.choices[p1];
            let c2 = room.choices[p2];

            let res1 = '', res2 = '';
            let u1Name = room.usernames[p1];
            let u2Name = room.usernames[p2];

            if (c1 === c2) {
                res1 = res2 = 'مساوی!';
            } else if (
                (c1 === 'سنگ' && c2 === 'قیچی') ||
                (c1 === 'کاغذ' && c2 === 'سنگ') ||
                (c1 === 'قیچی' && c2 === 'کاغذ')
            ) {
                res1 = 'برنده شدید! 🎉 (+50 سکه)';
                res2 = 'باختید! 😢 (-50 سکه)';
                users[u1Name].coins += 50;
                users[u2Name].coins -= 50;
                if (users[u2Name].coins < 0) users[u2Name].coins = 0;
            } else {
                res1 = 'باختید! 😢 (-50 سکه)';
                res2 = 'برنده شدید! 🎉 (+50 سکه)';
                users[u2Name].coins += 50;
                users[u1Name].coins -= 50;
                if (users[u1Name].coins < 0) users[u1Name].coins = 0;
            }
            saveData(USERS_FILE, users);

            io.to(p1).emit('match-rps-result', { myMove: c1, oppMove: c2, result: res1, newCoins: users[u1Name].coins });
            io.to(p2).emit('match-rps-result', { myMove: c2, oppMove: c1, result: res2, newCoins: users[u2Name].coins });

            room.choices = {};
        }
    });

    // منطق بازی دوز (XO)
    socket.on('make-match-xo', ({ opponentId, index, roomId, symbol }) => {
        let room = rooms[roomId];
        if (!room) return;
        if (!room.matchBoards) room.matchBoards = {};
        let boardKey = [socket.id, opponentId].sort().join('-');
        if (!room.matchBoards[boardKey]) room.matchBoards[boardKey] = Array(9).fill('');

        let board = room.matchBoards[boardKey];
        if (board[index] !== '') return;

        board[index] = symbol;
        let nextSymbol = symbol === 'X' ? 'O' : 'X';

        const winPatterns = [[0,1,2], [3,4,5], [6,7,8], [0,3,6], [1,4,7], [2,5,8], [0,4,8], [2,4,6]];
        let winner = null;
        for (let p of winPatterns) {
            if (board[p[0]] && board[p[0]] === board[p[1]] && board[p[0]] === board[p[2]]) {
                winner = board[p[0]];
                break;
            }
        }
        let isDraw = !winner && board.every(c => c !== '');

        if (winner) {
            let winnerId = (winner === symbol) ? socket.id : opponentId;
            let loserId = (winnerId === socket.id) ? opponentId : socket.id;
            let wName = room.usernames[winnerId];
            let lName = room.usernames[loserId];

            users[wName].coins += 50;
            users[lName].coins -= 50;
            if (users[lName].coins < 0) users[lName].coins = 0;
            saveData(USERS_FILE, users);

            io.to(winnerId).emit('match-xo-over', { board, result: 'برنده شدید! 🎉 (+50 سکه)', newCoins: users[wName].coins });
            io.to(loserId).emit('match-xo-over', { board, result: 'باختید! 😢 (-50 سکه)', newCoins: users[lName].coins });
            delete room.matchBoards[boardKey];
        } else if (isDraw) {
            io.to(socket.id).emit('match-xo-over', { board, result: 'مساوی!', newCoins: users[room.usernames[socket.id]].coins });
            io.to(opponentId).emit('match-xo-over', { board, result: 'مساوی!', newCoins: users[room.usernames[opponentId]].coins });
            delete room.matchBoards[boardKey];
        } else {
            io.to(socket.id).emit('match-xo-update', { board, turn: false });
            io.to(opponentId).emit('match-xo-update', { board, turn: true });
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
        if (isNaN(amount) || amount <= 0) {
            socket.emit('transfer-result', { success: false, message: 'مقدار سکه نامعتبر است.' });
            return;
        }
        if (!users[targetUser]) {
            socket.emit('transfer-result', { success: false, message: 'کاربر مورد نظر یافت نشد.' });
            return;
        }
        if (senderUser === targetUser) {
            socket.emit('transfer-result', { success: false, message: 'نمی‌توانید به خودتان سکه دهید!' });
            return;
        }
        if (users[senderUser].coins < amount) {
            socket.emit('transfer-result', { success: false, message: 'سکه‌های شما کافی نیست.' });
            return;
        }

        users[senderUser].coins -= amount;
        users[targetUser].coins += amount;
        saveData(USERS_FILE, users);

        socket.emit('transfer-result', { success: true, message: `${amount} سکه هدیه داده شد!`, newCoins: users[senderUser].coins });
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
                delete room.scores[socket.id];

                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    updateRoomMembers(roomId);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});