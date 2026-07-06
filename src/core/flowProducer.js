// src/core/flowProducer.js
'use strict';

const Queue = require('./queue');

class FlowProducer {
    constructor(options = {}) {
        this.prefix = options.prefix || 'taurusmq';
        this.connectionOpts = options.connection;
    }

    async add(flow) {
        if (!flow || typeof flow !== 'object') {
            throw new Error("Flow must be a non-null object.");
        }

        const visited = new Set();
        const checkCycleAndStructure = (node) => {
            if (!node || typeof node !== 'object') {
                throw new Error("Flow node must be an object.");
            }
            const name = node.name;
            const queueName = node.queueName || node.queue;
            if (!name) {
                throw new Error("Each flow node must specify a name.");
            }
            if (!queueName) {
                throw new Error("Each flow node must specify a queueName or queue.");
            }
            if (visited.has(node)) {
                throw new Error(`Circular dependency detected in flow graph for node: ${name}`);
            }
            visited.add(node);
            if (node.children && Array.isArray(node.children)) {
                for (const child of node.children) {
                    checkCycleAndStructure(child);
                }
            }
            visited.delete(node);
        };
        checkCycleAndStructure(flow);

        const processNode = async (node, isChild = false) => {
            const childrenIds = [];
            if (node.children && node.children.length > 0) {
                for (const child of node.children) {
                    const childId = await processNode(child, true);
                    childrenIds.push(childId);
                }
            }

            const opts = node.opts || {};
            if (childrenIds.length > 0) {
                opts.parent = childrenIds;
            }
            if (isChild) {
                opts.flow = false; // child-unblocks-parent direction
            }

            const queueName = node.queueName || node.queue;
            if (!queueName) {
                throw new Error("Each flow node must specify a queueName or queue.");
            }

            const queue = new Queue(queueName, {
                connection: this.connectionOpts,
                prefix: this.prefix
            });

            try {
                const jobId = await queue.add(node.name, node.data, opts);
                return jobId;
            } finally {
                await queue.close();
            }
        };

        return processNode(flow);
    }
}

module.exports = FlowProducer;
