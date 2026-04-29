const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { execFile: execFileCb } = require("child_process");

const execFile = promisify(execFileCb);
const rootDir = path.resolve(__dirname, "..");
const runsRoot = path.join(rootDir, ".runs");

loadEnv(path.join(rootDir, ".env"));
fs.mkdirSync(runsRoot, { recursive: true });

const model = process.env.MODEL || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const maxThreads = Math.max(1, Number(process.env.MAX_THREADS || 3));
const maxDepth = Math.max(0, Number(process.env.MAX_DEPTH || 1));
const jobTimeoutSeconds = Math.max(10, Number(process.env.JOB_TIMEOUT_SECONDS || 180));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const attempts = [];
  if (candidate.startsWith("{")) attempts.push(candidate);
  const objStart = candidate.indexOf("{");
  const objEnd = candidate.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    attempts.push(candidate.slice(objStart, objEnd + 1));
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {}
  }
  throw new Error(`LLM response did not contain valid JSON: ${candidate.slice(0, 500)}`);
}

async function callGroq(messages, temperature = 0.2) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`Groq API failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

function summarizeTree(folderPath) {
  const skip = new Set([".git", "node_modules", ".runs", "coverage", "dist", "build"]);
  const files = [];

  function walk(dir) {
    if (files.length >= 80) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(folderPath, full));
      if (files.length >= 80) return;
    }
  }

  walk(folderPath);
  return files;
}

function normalizePlan(payload, requestedCount) {
  const rawAgents = Array.isArray(payload.agents) ? payload.agents : [];
  const capped = rawAgents.slice(0, requestedCount).map((agent, index) => ({
    id: `agent-${index + 1}`,
    role: String(agent.role || `Worker ${index + 1}`).slice(0, 80),
    goal: String(agent.goal || "Analyze the assigned task").slice(0, 500),
    input: String(agent.input || "").slice(0, 1000)
  }));

  if (capped.length) {
    return {
      agents: capped,
      aggregation: String(payload.aggregation || "Merge worker findings into a concise production summary").slice(0, 500)
    };
  }

  return fallbackPlan(requestedCount);
}

function fallbackPlan(requestedCount) {
  const templates = [
    ["Motivational quote writer", "Draft a short motivational quote with clear energy."],
    ["Concise editor", "Keep the quote brief, polished, and easy to remember."],
    ["Warm tone reviewer", "Make the quote encouraging without sounding generic."],
    ["Final polish reviewer", "Check that the quote fits the requested topic and target file."]
  ];

  return {
    agents: templates.slice(0, requestedCount).map(([role, goal], index) => ({
      id: `agent-${index + 1}`,
      role,
      goal,
      input: "Use the repository files and parent task as context."
    })),
    aggregation: "Compare worker outputs, remove duplicates, and surface the best motivational quote."
  };
}

async function planSubagents({ task, folderPath, requestedCount, targetFile }) {
  const fileTree = summarizeTree(folderPath);
  const raw = await callGroq([
    {
      role: "system",
      content:
        "You are the orchestrator in a production multi-agent system. Convert the task into independent worker subagent assignments. Do not create nested agents. For quote-writing tasks, create workers with different useful styles or review angles. Return only JSON with shape {\"agents\":[{\"role\":\"...\",\"goal\":\"...\",\"input\":\"...\"}],\"aggregation\":\"...\"}."
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task,
          targetFile,
          maxAgents: requestedCount,
          maxDepth,
          fileTree
        },
        null,
        2
      )
    }
  ]);

  return normalizePlan(extractJson(raw), requestedCount);
}

function copyWorkspace(folderPath, targetCopy) {
  fs.mkdirSync(path.dirname(targetCopy), { recursive: true });
  fs.cpSync(folderPath, targetCopy, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return ![".git", "node_modules", ".runs"].includes(name);
    }
  });
}

function parseWorkerPayload(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

async function runAgent({ assignment, task, folderPath, runDir, targetFile }) {
  const workspace = path.join(runDir, assignment.id);
  const targetCopy = path.join(workspace, "target");
  const configPath = path.join(workspace, "config.json");
  copyWorkspace(folderPath, targetCopy);
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...assignment,
        parentTask: task,
        targetFile
      },
      null,
      2
    )
  );

  const startedAt = Date.now();
  const timeout = jobTimeoutSeconds * 1000;

  try {
    const { stdout, stderr } = await execFile(process.execPath, [path.join(rootDir, "agent/runner.js"), configPath], {
      cwd: rootDir,
      env: { ...process.env, REPO_PATH: targetCopy },
      timeout,
      maxBuffer: 1024 * 1024 * 20
    });

    return {
      ...parseWorkerPayload(stdout, stderr),
      runtimeMs: Date.now() - startedAt,
      workspace: targetCopy,
      runtime: "local-process"
    };
  } catch (error) {
    return {
      id: assignment.id,
      role: assignment.role,
      goal: assignment.goal,
      success: false,
      runtimeMs: Date.now() - startedAt,
      workspace: targetCopy,
      runtime: "local-process",
      result: null,
      logs: error.stderr || error.stdout || error.message
    };
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function consume() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

async function aggregateResults({ task, plan, agents }) {
  const raw = await callGroq([
    {
      role: "system",
      content:
        "You are the parent orchestrator aggregating worker subagent outputs. Return only JSON with shape {\"summary\":\"...\",\"keyFindings\":[\"...\"],\"recommendedNextSteps\":[\"...\"],\"failedAgents\":[\"...\"]}."
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task,
          aggregationInstruction: plan.aggregation,
          agents: agents.map((agent) => ({
            id: agent.id,
            role: agent.role,
            success: agent.success,
            result: agent.result,
            logs: agent.success ? undefined : String(agent.logs || "").slice(0, 1000)
          }))
        },
        null,
        2
      )
    }
  ]);

  return extractJson(raw);
}

async function handleRunAgents(req, res) {
  const body = await readBody(req);
  const task = body.task || "Add a short motivational quote to quote.txt.";
  const folderPath = path.resolve(body.folderPath || ".");
  const targetFile = body.targetFile || "quote.txt";
  const requestedAgents = Math.max(1, Number(body.agents || body.agentCount || 3));
  const effectiveAgents = Math.min(requestedAgents, maxThreads);

  if (!process.env.GROQ_API_KEY) return json(res, 500, { error: "GROQ_API_KEY is missing" });
  if (!fs.existsSync(folderPath)) return json(res, 400, { error: `folderPath does not exist: ${folderPath}` });
  if (!fs.statSync(folderPath).isDirectory()) return json(res, 400, { error: `folderPath must be a directory: ${folderPath}` });
  if (maxDepth < 1) return json(res, 400, { error: "MAX_DEPTH must be at least 1 to spawn worker agents" });

  const runId = crypto.randomUUID();
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const plan = await planSubagents({ task, folderPath, requestedCount: effectiveAgents, targetFile });
  const agents = await runWithConcurrency(plan.agents, maxThreads, (assignment) =>
    runAgent({ assignment, task, folderPath, runDir, targetFile })
  );
  const final = await aggregateResults({ task, plan, agents });

  return json(res, 200, {
    runId,
    model,
    runtime: "local-process",
    targetFile,
    limits: {
      requestedAgents,
      spawnedAgents: plan.agents.length,
      maxThreads,
      maxDepth,
      jobTimeoutSeconds,
      exceededRequestedAgents: requestedAgents > maxThreads
    },
    plan,
    agents,
    final
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && (req.url === "/run-agents" || req.url === "/run-task")) {
      return await handleRunAgents(req, res);
    }

    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        model,
        runtime: "local-process",
        limits: { maxThreads, maxDepth, jobTimeoutSeconds }
      });
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    const status = error.message === "Invalid JSON body" ? 400 : 500;
    return json(res, status, { error: error.message });
  }
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`Multi-agent orchestrator listening on http://${host}:${port}`);
  });
}

module.exports = {
  server,
  fallbackPlan,
  normalizePlan,
  runWithConcurrency,
  loadEnv
};
