// src/core/flowProducer.js
'use strict';

const Queue = require('./queue');

class FlowProducer {
    constructor(options = {}) {
        this.prefix = options.prefix || 'taurusmq';
        this.connectionOpts = options.connection;
        // Shared queue cache: one Queue instance per queueName (reuses connection)
        this._queues = new Map();
    }

    _getQueue(queueName) {
        if (!this._queues.has(queueName)) {
            this._queues.set(queueName, new Queue(queueName, {
                connection: this.connectionOpts,
                prefix: this.prefix
            }));
        }
        return this._queues.get(queueName);
    }

    async add(flow) {
        if (!flow || typeof flow !== 'object') {
            throw new Error("Flow must be a non-null object.");
        }

        // Cycle detection using queue:name keys (stable, not object identity)
        const visited = new Set();
        const checkCycleAndStructure = (node, path = []) => {
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
            const key = `${queueName}:${name}`;
            if (visited.has(key)) {
                throw new Error(`Circular dependency detected in flow graph for node: ${key} (path: ${path.join(' → ')})`);
            }
            visited.add(key);
            if (node.children && Array.isArray(node.children)) {
                for (const child of node.children) {
                    checkCycleAndStructure(child, [...path, key]);
                }
            }
            visited.delete(key);
        };
        checkCycleAndStructure(flow);

        // Collect all node IDs for compensating cleanup on failure
        const createdNodes = [];

        const processNode = async (node, isChild = false, parentQueueName = null) => {
            const dependency = node.opts?.dependency || 'fan-in';
            const childrenIds = [];

            if (dependency === 'fan-out') {
                // Fan-out: parent runs first, children block on parent.
                // The parent carries flow='fan-out' so finalizejob() releases
                // the children via unblock() on completion; each child carries
                // parent=[parentId] so addJob parks it in blocked with count 1.
                node.opts = { ...(node.opts || {}), flow: 'fan-out' };
                const queueName = node.queueName || node.queue;
                const queue = this._getQueue(queueName);
                const parentResult = await queue.add(node.name, node.data, node.opts || {});
                const parentId = parentResult.id;
                createdNodes.push({ queueName, jobId: parentId });

                // Process children — they will be blocked until parent completes
                if (node.children && node.children.length > 0) {
                    const childResults = await Promise.allSettled(
                        node.children.map(child => {
                            const linked = {
                                ...child,
                                opts: {
                                    ...(child.opts || {}),
                                    parent: [parentId, ...((child.opts || {}).parent || [])],
                                },
                            };
                            return processNode(linked, true, queueName);
                        })
                    );
                    for (let i = 0; i < childResults.length; i++) {
                        if (childResults[i].status === 'rejected') {
                            await this._compensate(createdNodes);
                            const childName = node.children[i].name || `child[${i}]`;
                            throw new Error(`Flow child "${childName}" failed: ${childResults[i].reason?.message || childResults[i].reason}`);
                        }
                    }
                }

                return parentId;
            } else {
                // Fan-in (default): children unblocks parent
                if (node.children && node.children.length > 0) {
                    const childResults = await Promise.allSettled(
                        node.children.map(child => processNode(child, true))
                    );
                    for (let i = 0; i < childResults.length; i++) {
                        if (childResults[i].status === 'fulfilled') {
                            childrenIds.push(childResults[i].value);
                        } else {
                            await this._compensate(createdNodes);
                            const childName = node.children[i].name || `child[${i}]`;
                            throw new Error(`Flow child "${childName}" failed: ${childResults[i].reason?.message || childResults[i].reason}`);
                        }
                    }
                }

                const opts = node.opts || {};
                if (childrenIds.length > 0) {
                    // Merge: a fan-out parent may already be listed here —
                    // overwriting would orphan that dependency.
                    opts.parent = [...(opts.parent || []), ...childrenIds];
                }
                if (isChild) {
                    opts.flow = false; // child-unblocks-parent direction
                }

                const queueName = node.queueName || node.queue;
                const queue = this._getQueue(queueName);
                const result = await queue.add(node.name, node.data, opts);
                createdNodes.push({ queueName, jobId: result.id });
                return result.id;
            }
        };

        try {
            const rootId = await processNode(flow);
            return rootId;
        } catch (err) {
            await this._compensate(createdNodes);
            throw err;
        }
    }

    async _compensate(nodes) {
        // Synchronous pipeline DELs — parent never waits on ghost
        const byQueue = new Map();
        for (const { queueName, jobId } of nodes) {
            if (!byQueue.has(queueName)) byQueue.set(queueName, []);
            byQueue.get(queueName).push(jobId);
        }
        for (const [queueName, jobIds] of byQueue) {
            try {
                const queue = this._getQueue(queueName);
                const pipe = queue.client.pipeline();
                for (const jobId of jobIds) {
                    pipe.del(`${this.prefix}:dependent:${jobId}:children:`);
                    pipe.del(`${this.prefix}:dependent:${jobId}:parent:`);
                    pipe.del(`${this.prefix}:job:${jobId}:count`);
                    pipe.del(`${this.prefix}:job:${jobId}:name`);
                    pipe.hdel(`${this.prefix}:jobs:${queueName}`, jobId);
                    pipe.lrem(`${this.prefix}:${queueName}`, 0, jobId);
                    pipe.zrem(`${this.prefix}:delayed:${queueName}`, jobId);
                    pipe.zrem(`${this.prefix}:active:${queueName}`, jobId);
                    pipe.zrem(`${this.prefix}:completed:${queueName}`, jobId);
                    pipe.zrem(`${this.prefix}:failed:${queueName}`, jobId);
                    pipe.hdel(`${this.prefix}:dlq:${queueName}`, jobId);
                    pipe.hdel(`${this.prefix}:blocked:${queueName}`, jobId);
                    // Also remove from any parent's children set (orphan refs)
                    // fetched via parent:* — best-effort scan
                }
                await pipe.exec();
                // Clean orphan refs: SREM this job from each parent's children set
                for (const jobId of jobIds) {
                    try {
                        const parents = await queue.client.smembers(`${this.prefix}:dependent:${jobId}:parent:`);
                        if (parents && parents.length) {
                            const p2 = queue.client.pipeline();
                            for (const p of parents) p2.srem(`${this.prefix}:dependent:${p}:children:`, jobId);
                            await p2.exec();
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }
    }

    async close() {
        for (const queue of this._queues.values()) {
            try { await queue.close(); } catch (_) {}
        }
        this._queues.clear();
    }
}

module.exports = FlowProducer;
