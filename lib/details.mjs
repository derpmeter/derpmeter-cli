// Optional follow-up questions after a vote. Same questions and bounded
// choices as the web (src/lib/vote-details.ts); no free text. Answers go to
// POST /api/votes/details with the vote's idempotency key and are never part
// of the Derp Score.
import { robustFetch, readBody } from "./net.mjs";

export const QUESTIONS = {
  vs_usual: {
    flag: "--vs-usual",
    text: "Compared with a usual day?",
    choices: {
      much_better: "Much better",
      better: "Better",
      same: "About the same",
      worse: "Worse",
      much_worse: "Much worse",
    },
  },
  task: {
    flag: "--task",
    text: "What were you working on?",
    choices: {
      feature: "New feature",
      bugfix: "Bug fix",
      refactor: "Refactor",
      test: "Tests",
      docs: "Docs",
      explore: "Questions, exploring",
    },
  },
  session: {
    flag: "--session",
    text: "How long was the session?",
    choices: {
      lt15m: "Under 15 min",
      lt1h: "Under 1 hour",
      lt3h: "1–3 hours",
      gte3h: "3+ hours",
    },
  },
  languages: {
    flag: "--languages",
    text: "Main languages? (pick any)",
    multi: true,
    choices: {
      ts_js: "TS/JS",
      python: "Python",
      go: "Go",
      rust: "Rust",
      jvm: "Java/Kotlin",
      swift: "Swift",
      c_cpp: "C/C++",
      other: "Other",
    },
  },
  went_well: {
    flag: "--went-well",
    text: "What went well? (pick any)",
    multi: true,
    choices: {
      followed: "Followed instructions",
      one_shot: "Solved in one go",
      fast: "Fast",
      quality: "Clean code",
    },
  },
  frequency: {
    flag: "--frequency",
    text: "How often do you use it?",
    choices: {
      daily: "Daily",
      weekly: "A few times a week",
      sometimes: "Now and then",
    },
  },
};
const FOLLOW_UP_SIZE = 3;

// Same order as the web: vs_usual first, the rest rotate (went_well only
// after a Smart vote), so repeat voters see different questions.
export function followUpQuestions(score, rotation) {
  const rest = ["task", "session", "languages", "frequency"];
  if (score === 0) rest.splice(2, 0, "went_well");
  const start = ((rotation % rest.length) + rest.length) % rest.length;
  const rotated = [...rest.slice(start), ...rest.slice(0, start)];
  return ["vs_usual", ...rotated.slice(0, FOLLOW_UP_SIZE - 1)];
}

// `derp details` flags -> answers. Unknown values are refused, not dropped.
export function parseDetailArgs(args, score) {
  const answers = {};
  for (const [id, q] of Object.entries(QUESTIONS)) {
    const i = args.indexOf(q.flag);
    if (i < 0) continue;
    const raw = args[i + 1];
    const values = (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowed = Object.keys(q.choices);
    if (
      !values.length ||
      values.some((v) => !allowed.includes(v)) ||
      (!q.multi && values.length > 1)
    )
      throw new Error(
        `Use ${q.flag} ${allowed.join(q.multi ? "," : "|")}${q.multi ? " (comma-separated)" : ""}.`,
      );
    if (id === "went_well" && score !== undefined && score !== 0)
      throw new Error("--went-well is only asked after a smart vote.");
    answers[id] = q.multi ? [...new Set(values)] : values[0];
  }
  return answers;
}

// One line per question for non-interactive runs (the /derp command shows
// it to the user, who may answer or ignore it).
export function followUpHint(ids) {
  return [
    "Optional follow-up (choices only, skip freely):",
    ...ids.map((id) => {
      const q = QUESTIONS[id];
      return `  ${q.text} derp details ${q.flag} ${Object.keys(q.choices).join(q.multi ? "," : "|")}`;
    }),
  ].join("\n");
}

// Interactive: numbered choices, Enter skips. `ask` is readline's question().
export async function askFollowUp(ids, ask, write) {
  const answers = {};
  write("A few optional questions (Enter skips, choices only):\n");
  for (const id of ids) {
    const q = QUESTIONS[id];
    const keys = Object.keys(q.choices);
    write(
      `\n${q.text}\n${keys.map((k, i) => `  ${i + 1}) ${q.choices[k]}`).join("\n")}\n`,
    );
    const line = (
      await ask(q.multi ? "Numbers, comma-separated: " : "Number: ")
    ).trim();
    if (!line) continue;
    const picked = line
      .split(",")
      .map((s) => keys[Number(s.trim()) - 1])
      .filter(Boolean);
    if (!picked.length) continue;
    answers[id] = q.multi ? [...new Set(picked)] : picked[0];
  }
  return answers;
}

export async function sendDetails(
  { origin, token, agent, key, answers },
  fetcher = robustFetch,
) {
  const r = await fetcher(`${origin}/api/votes/details`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      agent,
      source: "cli",
      idempotencyKey: key,
      answers,
    }),
  });
  const result = await readBody(r);
  if (!r.ok)
    throw new Error(
      `${result.error || "Saving answers failed"} (HTTP ${r.status}).`,
    );
  return result;
}
