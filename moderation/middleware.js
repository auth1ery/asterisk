const db = require('../db/database');

function blockBanned(io) {
    io.use((socket, next) => {
        const ip = socket.handshake.address;
        const userId = socket.handshake.auth?.userId;

        db.get(`SELECT 1 FROM banned_ips WHERE ip = ?`, [ip], (err, row) => {
            if (err) return next(err);
            if (row) return next(new Error('You are banned.'));

            if (!userId) return next();

            db.get(`SELECT banned FROM users WHERE id = ?`, [userId], (err, row) => {
                if (err) return next(err);
                if (row?.banned) return next(new Error('You are banned.'));
                next();
            });
        });
    });
}

module.exports = { blockBanned };
