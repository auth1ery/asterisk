const db = require('../db/database');

function banUser(userId, ip = null, banReason = 'Manual ban', io = null) {
    const timestamp = Date.now();

    db.run(
        `UPDATE users SET banned = 1, ban_reason = ?, banned_at = ? WHERE id = ?`,
        [banReason, timestamp, userId]
    );

    if (ip) {
        db.run(
            `INSERT OR IGNORE INTO banned_ips (ip, banned_at) VALUES (?, ?)`,
            [ip, timestamp]
        );
    }

    // Soft-delete messages
    db.run(`UPDATE messages SET deleted = 1 WHERE user_id = ?`, [userId]);

    // Disconnect all sockets of this user
    if (io) {
        for (const [id, socket] of io.sockets.sockets) {
            if (socket.userId === userId) socket.disconnect(true);
        }
    }
}

module.exports = { banUser };
