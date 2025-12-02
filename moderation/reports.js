const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');

function createReport(reporterId, reportedUserId, messageId, reason) {
    const id = uuidv4();
    const timestamp = Date.now();

    db.run(
        `INSERT INTO reports (id, reporter_id, reported_user_id, message_id, reason, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, reporterId, reportedUserId, messageId, reason, timestamp]
    );

    return id;
}

function getPendingReports(callback) {
    db.all(`SELECT * FROM reports WHERE status = 'pending'`, [], callback);
}

module.exports = { createReport, getPendingReports };
