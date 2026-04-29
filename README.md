# Groq Multi-Agent MVP

A minimal Node.js demo showing how a parent orchestrator can spawn isolated worker subagents using Groq chat completions.

This repository is a small production-shaped proof-of-concept for multi-agent orchestration without creating new VMs or containers for every worker.

## What it does

- Accepts a task request over HTTP
- Uses Groq to generate a subagent plan for independent worker roles
- Spawns local child processes for each worker
- Copies the target workspace into isolated run folders
- Executes each worker with its own prompt and context
- Aggregates worker outputs using Groq into a final summary

## Key components

- `orchestrator/server.js`
  - HTTP API for `/run-agents` and `/health`
  - environment-based configuration
  - workspace snapshotting into `.runs/`
  - concurrency control via `MAX_THREADS`
  - worker planning and aggregation using the Groq API

- `agent/runner.js`
  - loads worker assignment from `config.json`
  - reads the copied workspace from `REPO_PATH`
  - sends a single isolated Groq prompt for the assigned task
  - validates and applies file changes back into the copied workspace
  - returns structured JSON results

- `smoke/`
  - sample demo folders for smoke testing and quote generation

## Requirements

- Node.js 18+ (or recent LTS)
- Groq API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy and configure environment variables:

```bash
cp .env.example .env
```

3. Edit `.env` as needed, for example:

```env
GROQ_API_KEY=your_key_here
MODEL=llama-3.3-70b-versatile
PORT=3000
MAX_THREADS=3
MAX_DEPTH=1
JOB_TIMEOUT_SECONDS=180
```

## Run the server

```bash
npm start
```

The orchestrator listens on `http://127.0.0.1:3000` by default.

## API usage

### Run a multi-agent task

```bash
curl -X POST http://localhost:3000/run-agents \
  -H "Content-Type: application/json" \
  -d '{
    "folderPath": "./smoke/quotes-demo",
    "task": "Add a short motivational quote about persistence.",
    "targetFile": "quote.txt",
    "agents": 3
  }'
```

### Health check

```bash
curl http://localhost:3000/health
```

## Request payload

- `folderPath` - path to the workspace folder to copy and inspect
- `task` - instruction for the orchestrator and workers
- `targetFile` - file workers should create or update
- `agents` - desired number of worker subagents

## Response shape

The response contains:

- `runId` - unique run identifier
- `model` - model name used for Groq calls
- `limits` - requested vs spawned agents, concurrency, depth, timeout
- `plan` - generated worker roles and goals
- `agents` - worker outputs, success state, and logs
- `final` - aggregate summary from the orchestrator

## Configuration

- `GROQ_API_KEY` - required API key for Groq
- `MODEL` - model to use for chat completions
- `PORT` - HTTP server port
- `MAX_THREADS` - max concurrent workers spawned
- `MAX_DEPTH` - allowed orchestration depth (root can spawn workers)
- `JOB_TIMEOUT_SECONDS` - per-worker execution timeout

## How it works

1. The orchestrator reads the request and validates the workspace folder.
2. It uses Groq to plan an array of worker subagents.
3. Each worker gets its own copy of the workspace under `.runs/<runId>/<agentId>/target`.
4. Workers execute `agent/runner.js` with a `config.json` assignment.
5. Workers return structured JSON results and any file changes.
6. The orchestrator aggregates worker outputs into a final summary.

## Notes

- Worker isolation is achieved by copying the workspace into separate local run folders.
- The demo intentionally keeps each worker as a local process for simplicity.
- `.runs/` contains generated workspace copies and can be removed safely.

## Scripts

- `npm start` - start the orchestrator server
- `npm run check` - syntax-check the orchestrator and worker scripts
