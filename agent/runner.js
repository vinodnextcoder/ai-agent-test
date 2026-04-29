const fs = require("fs");
const path = require("path");

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const repoPath = path.resolve(process.env.REPO_PATH || "/workspace/target");
const model = process.env.MODEL || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const SKIP_DIRS = new Set([".git", "node_modules", "coverage", "dist", "build", ".runs"]);
const ALLOWED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".env.example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt"
]);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function extensionRank(file) {
  const rel = path.relative(repoPath, file);
  if (/README|package\.json|test|spec|app|server|runner/i.test(rel)) return 0;
  return 1;
}

function collectFiles() {
  return walk(repoPath)
    .filter((file) => {
      const ext = path.extname(file).toLowerCase();
      const base = path.basename(file).toLowerCase();
      return ALLOWED_EXTENSIONS.has(ext) || ALLOWED_EXTENSIONS.has(base);
    })
    .sort((a, b) => extensionRank(a) - extensionRank(b) || a.length - b.length)
    .slice(0, Number(process.env.MAX_FILES_PER_AGENT || 12))
    .map((file) => ({
      path: path.relative(repoPath, file),
      content: fs.readFileSync(file, "utf8").slice(0, Number(process.env.MAX_FILE_CHARS || 5000))
    }));
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

function normalizeResult(payload) {
  return {
    summary: String(payload.summary || "").slice(0, 2000),
    findings: Array.isArray(payload.findings) ? payload.findings.slice(0, 8) : [],
    recommendations: Array.isArray(payload.recommendations) ? payload.recommendations.slice(0, 8) : [],
    artifacts: Array.isArray(payload.artifacts) ? payload.artifacts.slice(0, 5) : [],
    changes: normalizeChanges(payload.changes),
    confidence: payload.confidence || "medium"
  };
}

function normalizeChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes
    .filter((change) => change && typeof change.path === "string" && typeof change.content === "string")
    .slice(0, 5)
    .map((change) => ({
      path: change.path,
      content: change.content
    }));
}

function isInsideRepo(filePath) {
  const resolved = path.resolve(filePath);
  return resolved === repoPath || resolved.startsWith(`${repoPath}${path.sep}`);
}

function applyChanges(changes) {
  const applied = [];
  for (const change of changes) {
    const target = path.resolve(repoPath, change.path);
    if (!isInsideRepo(target)) throw new Error(`Refusing to write outside worker workspace: ${change.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, change.content, "utf8");
    applied.push({
      path: path.relative(repoPath, target),
      bytes: Buffer.byteLength(change.content, "utf8")
    });
  }
  return applied;
}

async function runWorker() {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing");

  const files = collectFiles();
  const messages = [
    {
      role: "system",
      content:
        "You are a single isolated worker subagent in a production multi-agent system. You cannot spawn other agents. Complete only the assigned slice of work in your copied workspace. If the task asks for a quote, create or update targetFile with one short motivational quote. Return only JSON with shape {\"summary\":\"...\",\"findings\":[{\"severity\":\"low|medium|high\",\"title\":\"...\",\"detail\":\"...\",\"file\":\"optional path\"}],\"recommendations\":[\"...\"],\"artifacts\":[{\"path\":\"...\",\"description\":\"...\"}],\"changes\":[{\"path\":\"...\",\"content\":\"full file content\"}],\"confidence\":\"low|medium|high\"}."
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          parentTask: config.parentTask,
          workerId: config.id,
          role: config.role,
          goal: config.goal,
          input: config.input,
          targetFile: config.targetFile || "quote.txt",
          repoFiles: files
        },
        null,
        2
      )
    }
  ];

  const raw = await callGroq(messages);
  const result = normalizeResult(extractJson(raw));
  const appliedChanges = applyChanges(result.changes);
  return {
    ...result,
    appliedChanges
  };
}

async function main() {
  try {
    const startedAt = Date.now();
    const result = await runWorker();
    console.log(
      JSON.stringify({
        id: config.id,
        role: config.role,
        goal: config.goal,
        success: true,
        runtimeMs: Date.now() - startedAt,
        result,
        logs: `Analyzed ${repoPath} as ${config.role}`
      })
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        id: config.id,
        role: config.role,
        goal: config.goal,
        success: false,
        runtimeMs: 0,
        result: null,
        logs: error.stack || error.message
      })
    );
  }
}

main();
