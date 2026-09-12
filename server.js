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
                scores: {}
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
        io.to(challengerId).emit('challenge-accepted', { gameType, roomId });
        io.to(roomId).emit('receive-message', {
            senderName: 'سیستم',
            message: `🎮 دعوت به بازی ${gameType} پذیرفته شد!`
        });
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