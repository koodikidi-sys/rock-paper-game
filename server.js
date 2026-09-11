const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let rooms = {};

io.on('connection', (socket) => {
    console.log('یک کاربر وصل شد:', socket.id);

    socket.on('join-room', ({ roomId, playerName }) => {
        socket.rooms.forEach(r => {
            if (r !== socket.id) socket.leave(r);
        });

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                scores: {},
                names: {},
                gameType: 'rps', // پیش‌فرض سنگ‌کاغذ‌قیچی
                choices: {},     // برای سنگ‌کاغذ‌قیچی
                xoBoard: Array(9).fill(''), // صفحه دوز
                xoTurn: null,     // نوبت بازیکن در دوز
                diceRolls: {}     // برای تاس‌بازی چندنفره
            };
        }

        let room = rooms[roomId];

        if (!room.players.includes(socket.id)) {
            // سقف ظرفیت: برای تاس ۴ نفر، برای بقیه ۲ نفر
            const maxPlayers = room.gameType === 'dice' ? 4 : 2;

            if (room.players.length < maxPlayers) {
                room.players.push(socket.id);
                room.scores[socket.id] = 300;
                room.names[socket.id] = playerName || 'بازیکن';

                socket.emit('joined', { coins: 300 });

                // ارسال وضعیت جدید به همه اعضای اتاق
                io.to(roomId).emit('update-players', {
                    players: room.players.map(id => room.names[id]),
                    count: room.players.length
                });

                if (room.gameType === 'dice' || room.players.length === 2) {
                    if (room.gameType === 'xo') room.xoTurn = room.players[0];
                    io.to(roomId).emit('start-game', {
                        msg: 'بازیکنان کامل شدند! بازی شروع شد.'
                    });
                }
            } else {
                socket.emit('room-full', 'ظرفیت این اتاق پر است!');
                return;
            }
        }
    });

    // تغییر حالت بازی
    socket.on('change-game', ({ roomId, gameType }) => {
        let room = rooms[roomId];
        if (!room) return;

        // بررسی ظرفیت برای بازی جدید
        const maxPlayers = gameType === 'dice' ? 4 : 2;
        if (room.players.length > maxPlayers) {
            socket.emit('room-full', 'تعداد بازیکنان این اتاق برای این بازی زیاد است!');
            return;
        }

        room.gameType = gameType;
        room.choices = {};
        room.xoBoard = Array(9).fill('');
        room.xoTurn = room.players[0];
        room.diceRolls = {};

        io.to(roomId).emit('game-changed', { gameType, xoBoard: room.xoBoard, xoTurn: room.xoTurn });
    });

    // منطق سنگ‌کاغذ‌قیچی (۲ نفره)
    socket.on('make-move', ({ roomId, move }) => {
        let room = rooms[roomId];
        if (!room || room.gameType !== 'rps') return;
        if (room.scores[socket.id] <= 0) return;

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
                res1 = 'برنده شدید! 🎉';
                res2 = 'باختید! 😢';
                room.scores[p1] += 50;
                room.scores[p2] -= 50;
            } else {
                res1 = 'باختید! 😢';
                res2 = 'برنده شدید! 🎉';
                room.scores[p2] += 50;
                room.scores[p1] -= 50;
            }

            if (room.scores[p1] < 0) room.scores[p1] = 0;
            if (room.scores[p2] < 0) room.scores[p2] = 0;

            io.to(p1).emit('round-result', { myMove: c1, oppMove: c2, result: res1, myCoins: room.scores[p1], oppCoins: room.scores[p2] });
            io.to(p2).emit('round-result', { myMove: c2, oppMove: c1, result: res2, myCoins: room.scores[p2], oppCoins: room.scores[p1] });

            room.choices = {};
        }
    });

    // منطق بازی دوز (XO - دو نفره)
    socket.on('make-xo-move', ({ roomId, index }) => {
        let room = rooms[roomId];
        if (!room || room.gameType !== 'xo') return;
        if (room.xoTurn !== socket.id) return;
        if (room.xoBoard[index] !== '') return;

        const symbol = socket.id === room.players[0] ? 'X' : 'O';
        room.xoBoard[index] = symbol;
        room.xoTurn = room.players.find(id => id !== socket.id);

        const winPatterns = [
            [0,1,2], [3,4,5], [6,7,8],
            [0,3,6], [1,4,7], [2,5,8],
            [0,4,8], [2,4,6]
        ];

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

            io.to(roomId).emit('xo-game-over', {
                board: room.xoBoard,
                winnerId: winnerSocketId,
                myCoins1: room.scores[room.players[0]],
                myCoins2: room.scores[room.players[1]]
            });
            room.xoBoard = Array(9).fill('');
        } else if (isDraw) {
            io.to(roomId).emit('xo-game-over', {
                board: room.xoBoard,
                winnerId: 'draw',
                myCoins1: room.scores[room.players[0]],
                myCoins2: room.scores[room.players[1]]
            });
            room.xoBoard = Array(9).fill('');
        } else {
            io.to(roomId).emit('xo-update', { board: room.xoBoard, xoTurn: room.xoTurn });
        }
    });

    // منطق تاس‌بازی چندنفره (تا ۴ نفر)
    socket.on('roll-dice', ({ roomId }) => {
        let room = rooms[roomId];
        if (!room || room.gameType !== 'dice') return;
        if (room.scores[socket.id] <= 0) return;

        // انداختن تاس بین ۱ تا ۶
        const roll = Math.floor(Math.random() * 6) + 1;
        room.diceRolls[socket.id] = roll;

        io.to(roomId).emit('dice-rolled-status', { playerName: room.names[socket.id] });

        // اگر همه بازیکنان حاضر در اتاق تاس انداختند
        if (Object.keys(room.diceRolls).length === room.players.length) {
            let maxRoll = -1;
            let winners = [];

            // پیدا کردن بیشترین عدد
            for (let pId in room.diceRolls) {
                if (room.diceRolls[pId] > maxRoll) {
                    maxRoll = room.diceRolls[pId];
                    winners = [pId];
                } else if (room.diceRolls[pId] === maxRoll) {
                    winners.push(pId);
                }
            }

            // اگر یک نفر برنده شد (بدون مساوی در بیشترین عدد)
            if (winners.length === 1) {
                const winnerId = winners[0];
                room.players.forEach(pId => {
                    if (pId === winnerId) {
                        room.scores[pId] += (room.players.length - 1) * 30;
                    } else {
                        room.scores[pId] -= 30;
                        if (room.scores[pId] < 0) room.scores[pId] = 0;
                    }
                });
            }

            io.to(roomId).emit('dice-round-result', {
                rolls: room.diceRolls,
                winners: winners,
                scores: room.scores,
                names: room.names
            });

            room.diceRolls = {};
        }
    });

    socket.on('send-message', ({ roomId, message, senderName }) => {
        socket.to(roomId).emit('receive-message', { message, senderName });
    });

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            rooms[roomId].players = rooms[roomId].players.filter(id => id !== socket.id);
            if (rooms[roomId].players.length === 0) {
                delete rooms[roomId];
            } else {
                io.to(roomId).emit('opponent-left', 'یکی از بازیکنان از بازی خارج شد.');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});