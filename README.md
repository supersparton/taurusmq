# TaurusMQ 🐂
**A Distributed Background Job Engine built with Node.js and Redis.**

TaurusMQ is a production-grade library for handling offline tasks, scheduled jobs, and complex workflows. It is designed for high reliability, atomic concurrency, and language-agnostic extensibility.

## Features
- ✅ **One-off Jobs**: Simple, reliable task processing.
- ✅ **Recurring Jobs**: Native Cron support with UTC normalization.
- ✅ **Distributed Workflows**: Parent-Child job dependencies (DAGs).
- ✅ **Real-time Monitoring**: WebSocket-powered live dashboard.
- ✅ **Fault Tolerance**: Automatic retries with exponential backoff and job recovery.

## Getting Started
1. `npm install`
2. Create `.env` from `.env.example`
3. Run `npm run dev`
