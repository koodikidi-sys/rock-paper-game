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
let groupProfiles = {}; // ذخیره اطلاعات پروفایل گروه‌ها

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

let rooms = {};
const valuesOrder = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };

function createDeck() {
    const suits = ['♠️', '♥️', '♦️', '♣️'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let suit of suits) {
        for (let val of values) {
            deck.push({ suit, val, name: val + suit });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {
    console.log('یک کاربر وصل شد:', socket.id);

    socket.on('join-room', ({ roomId, username }) => {
        socket.rooms.forEach(r => {
            if (r !== socket.id) socket.leave(r);
        });

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                usernames: {},
                scores: {},
                gameType: 'rps',
                choices: {},
                xoBoard: Array(9).fill(''),
                xoTurn: null,
                diceRolls: {},
                hokmState: 'waiting',
                hakem: null,
                hokmSuit: null,
                hands: {},
                tableCards: {},
                currentTurn: null,
                deck: [],
                leadSuit: null
            };
        }

        // پروفایل پیش‌فرض گروه اگر ساخته نشده باشد
        if (!groupProfiles[roomId]) {
            groupProfiles[roomId] = {
                title: roomId,
                description: 'گروه چت و دورهمی بازی‌ها'
            };
        }

        let room = rooms[roomId];

        if (!room.players.includes(socket.id)) {
            const maxPlayers = (room.gameType === 'dice' || room.gameType === 'hokm') ? 4 : 2;

            if (room.players.length < maxPlayers) {
                room.players.push(socket.id);
                room.usernames[socket.id] = username;
                
                if (!users[username].coins) users[username].coins = 300;
                room.scores[socket.id] = users[username].coins;

                socket.emit('joined', { coins: room.scores[socket.id] });
                socket.emit('room-profile', groupProfiles[roomId]);

                if (roomChats[roomId]) {
                    socket.emit('load-chat-history', roomChats[roomId]);
                }

                io.to(roomId).emit('update-players', {
                    players: room.players.map(id => room.usernames[id]),
                    count: room.players.length
                });

                if (room.gameType === 'dice' && room.players.length === 4) {
                    io.to(roomId).emit('start-game', { msg: 'تاس‌بازی ۴ نفره شروع شد!' });
                } else if (room.gameType === 'hokm' && room.players.length === 4) {
                    startHokmGame(roomId);
                } else if ((room.gameType === 'rps' || room.gameType === 'xo') && room.players.length === 2) {
                    if (room.gameType === 'xo') room.xoTurn = room.players[0];
                    io.to(roomId).emit('start-game', { msg: 'بازی شروع شد!' });
                }
            } else {
                socket.emit('room-full', 'ظرفیت این گروه پر است!');
                return;
            }
        }
    });

    // به‌روزرسانی پروفایل گروه
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

    socket.on('change-game', ({ roomId, gameType }) => {
        let room = rooms[roomId];
        if (!room) return;

        const maxPlayers = (gameType === 'dice' || gameType === 'hokm') ? 4 : 2;
        if (room.players.length > maxPlayers) {
            socket.emit('room-full', 'تعداد بازیکنان این گروه زیاد است!');
            return;
        }

        room.gameType = gameType;
        room.choices = {};
        room.xoBoard = Array(9).fill('');
        room.xoTurn = room.players[0];
        room.diceRolls = {};

        io.to(roomId).emit('game-changed', { gameType, xoBoard: room.xoBoard, xoTurn: room.xoTurn });

        if (gameType === 'hokm' && room.players.length === 4) {
            startHokmGame(roomId);
        }
    });

    function startHokmGame(roomId) {
        let room = rooms[roomId];
        room.hokmState = 'selecting_hokm';
        room.deck = createDeck();
        room.hands = {};
        room.tableCards = {};
        room.leadSuit = null;

        room.players.forEach((pId) => {
            room.hands[pId] = room.deck.splice(0, 5);
        });

        room.hakem = room.players[Math.floor(Math.random() * room.players.length)];
        room.currentTurn = room.hakem;

        room.players.forEach(pId => {
            io.to(pId).emit('hokm-deal-first', {
                hand: room.hands[pId],
                hakemName: room.usernames[room.hakem],
                isHakem: (room.hakem === pId)
            });
        });
    }

    socket.on('select-hokm', ({ roomId, suit }) => {
        let room = rooms[roomId];
        if (!room || room.hakem !== socket.id) return;

        room.hokmSuit = suit;
        room.hokmState = 'playing';

        room.players.forEach(pId => {
            let extraCards = room.deck.splice(0, 8);
            room.hands[pId] = room.hands[pId].concat(extraCards);
        });

        room.players.forEach(pId => {
            io.to(pId).emit('hokm-game-started', {
                suit: suit,
                hand: room.hands[pId],
                turn: room.currentTurn,
                turnName: room.usernames[room.currentTurn]
            });
        });
    });

    function updateRoomCoins(room) {
        room.players.forEach(pId => {
            let uName = room.usernames[pId];
            if (uName && users[uName]) {
                users[uName].coins = room.scores[pId];
            }
        });
        saveData(USERS_FILE, users);
    }

    socket.on('make-move', ({ roomId, move }) => {
        let room = rooms[roomId];
        if (!room || room.gameType !== 'rps') return;

        room.choices[socket.id] = move;

        if (Object.keys(room.choices).length === 2) {
            const p1 = room.players[0];
            const p2 = room.players[1];
            const c1 = room.choices[p1];
            const c2 = room.choices[p2];

            let res1 = '', res2 = '';
            if (c1 === c2) {
                res1 = res2 = 'مساوی!';
            } else if (
                (c1 === 'سنگ' && c2 === 'قیچی') ||
                (c1 === 'کاغذ' && c2 === 'سنگ') ||
                (c1 === 'قیچی' && c2 === 'کاغذ')
            ) {
                res1 = 'برنده شدید! 🎉'; res2 = 'باختید! 😢';
                room.scores[p1] += 50; room.scores[p2] -= 50;
            } else {
                res1 = 'باختید! 😢'; res2 = 'برنده شدید! 🎉';
                room.scores[p2] += 50; room.scores[p1] -= 50;
            }

            if (room.scores[p1] < 0) room.scores[p1] = 0;
            if (room.scores[p2] < 0) room.scores[p2] = 0;
            updateRoomCoins(room);

            io.to(p1).emit('round-result', { myMove: c1, oppMove: c2, result: res1, myCoins: room.scores[p1] });
            io.to(p2).emit('round-result', { myMove: c2, oppMove: c1, result: res2, myCoins: room.scores[p2] });
            room.choices = {};
        }
    });

    socket.on('make-xo-move', ({ roomId, index }) => {
        let room = rooms[roomId];
        if (!room || room.gameType !== 'xo') return;
        if (room.xoTurn !== socket.id) return;
        if (room.xoBoard[index] !== '') return;

        const symbol = socket.id === room.players[0] ? 'X' : 'O';
        room.xoBoard[index] = symbol;
        room.xoTurn = room.players.find(id => id !== socket.id);

        const winPatterns = [[0,1,2], [3,4,5], [6,7,8], [0,3,6], [1,4,7], [2,5,8], [0,4,8], [2,4,6]];
        let winner = null;
        for (let pattern of winPatterns) {
            const [a, b, c] = pattern;
            if (room.xoBoard[a] && room.xoBoard[a] === room.xoBoard[b] && room.xoBoard[a] === room.xoBoard[c]) {
                winner = room.xoBoard[a];
                break;
            }
        }

        let isDraw = !winner && room.xoBoard.every(cell => cell !== '');
        if (winner) {
            const winnerSocketId = winner === 'X' ? room.players[0] : room.players[1];
            const loserSocketId = room.players.find(id => id !== winnerSocketId);

            room.scores[winnerSocketId] += 50;
            room.scores[loserSocketId] -= 50;
            if (room.scores[loserSocketId] < 0) room.scores[loserSocketId] = 0;
            updateRoomCoins(room);

            io.to(roomId).emit('xo-game-over', {
                board: room.xoBoard, winnerId: winnerSocketId,
                myCoins1: room.scores[room.players[0]], myCoins2: room.scores[room.players[1]]
            });
            room.xoBoard = Array(9).fill('');
        } else if (isDraw) {
            io.to(roomId).emit('xo-game-over', {
                board: room.xoBoard, winnerId: 'draw',
                myCoins1: room.scores[room.players[0]], myCoins2: room.scores[room.players[1]]
            });
            room.xoBoard = Array(9).fill('');
        } else {
            io.to(roomId).emit('xo-update', { board: room.xoBoard, xoTurn: room.xoTurn });
        }
    });

    socket.on('roll-dice', ({ roomId }) => {
        let room = rooms[roomId];
        if (!room || room.gameType !== 'dice') return;

        const roll = Math.floor(Math.random() * 6) + 1;
        room.diceRolls[socket.id] = roll;

        io.to(roomId).emit('dice-rolled-status', { playerName: room.usernames[socket.id] });

        if (Object.keys(room.diceRolls).length === room.players.length) {
            let maxRoll = -1;
            let winners = [];
            for (let pId in room.diceRolls) {
                if (room.diceRolls[pId] > maxRoll) {
                    maxRoll = room.diceRolls[pId];
                    winners = [pId];
                } else if (room.diceRolls[pId] === maxRoll) {
                    winners.push(pId);
                }
            }

            if (winners.length === 1) {
                const winnerId = winners[0];
                room.players.forEach(pId => {
                    if (pId === winnerId) room.scores[pId] += (room.players.length - 1) * 30;
                    else {
                        room.scores[pId] -= 30;
                        if (room.scores[pId] < 0) room.scores[pId] = 0;
                    }
                });
                updateRoomCoins(room);
            }

            io.to(roomId).emit('dice-round-result', {
                rolls: room.diceRolls, winners: winners, scores: room.scores, names: room.usernames
            });
            room.diceRolls = {};
        }
    });

    // مدیریت چت گروهی و ارسال به همه (حتی فرستنده)
socket.on('send-message', ({ roomId, message, senderName }) => {
    if (!roomChats[roomId]) roomChats[roomId] = [];
    roomChats[roomId].push({ senderName, message });
    saveData(CHATS_FILE, roomChats);

    // ارسال به همه اعضای اتاق از جمله فرستنده
    io.to(roomId).emit('receive-message', { message, senderName });
});

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            rooms[roomId].players = rooms[roomId].players.filter(id => id !== socket.id);
            if (rooms[roomId].players.length === 0) {
                delete rooms[roomId];
            } else {
                io.to(roomId).emit('opponent-left', 'یک نفر از گروه خارج شد.');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});