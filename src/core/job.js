const { v4: uuidv4 } = require('uuid');

class Job {
    constructor(name, data) {
        this.name = name;
        this.data = data;
        this.id = uuidv4();
        this.timestamp = Date.now();
        this.status = 'waiting';
        this.attempts = 0;
        this.maxretries = 3;
    }
    toJson() {
        return JSON.stringify({
            id: this.id,
            name: this.name,
            data: this.data,
            timestamp: this.timestamp,
            status: this.status,
            attempts: this.attempts,
            maxretries: this.maxretries
        });
    }
}

module.exports = Job;