class UnrecoverableError extends Error {
    constructor(message){
        super(message);
        this.name = 'Unrecoverable';
    }
}

module.exports = {UnrecoverableError}