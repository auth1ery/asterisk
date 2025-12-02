const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, '../chat.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        banned INTEGER DEFAULT 0,
        ban_reason TEXT,
        banned_at INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        content TEXT,
        deleted INTEGER DEFAULT 0,
        timestamp INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        reporter_id TEXT,
        reported_user_id TEXT,
        message_id TEXT,
        reason TEXT,
        timestamp INTEGER,
        status TEXT DEFAULT 'pending'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS banned_ips (
        ip TEXT PRIMARY KEY,
        banned_at INTEGER
    )`);
});

module.exports = db;
