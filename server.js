const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let rooms = {};

io.on('connection', (socket) => {
    console.log('کاربر متصل شد:', socket.id);

    socket.on('join-room', ({ roomId, playerName }) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                scores: {},
                names: {},
                choices: {}
            };
        }

        let room = rooms[roomId];

        if (room.players.length < 2) {
            room.players.push(socket.id);
            room.scores[socket.id] = 500; // سکه اولیه ۵۰۰
            room.names[socket.id] = playerName || 'بازیکن';

            socket.emit('joined', { coins: 500 });

            if (room.players.length === 2) {
                io.to(roomId).emit('start-game', 'حریف متصل شد! بازی شروع شد.');
            }
        } else {
            socket.emit('room-full', 'این اتاق پر است!');
        }
    });

    socket.on('make-move', ({ roomId, move }) => {
        let room = rooms[roomId];
        if (!room) return;

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

            io.to(p1).emit('round-result', { myMove: c1, oppMove: c2, result: res1, myCoins: room.scores[p1], oppCoins: room.scores[p2] });
            io.to(p2).emit('round-result', { myMove: c2, oppMove: c1, result: res2, myCoins: room.scores[p2], oppCoins: room.scores[p1] });

            room.choices = {};
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
                io.to(roomId).emit('opponent-left', 'حریف از بازی خارج شد.');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});