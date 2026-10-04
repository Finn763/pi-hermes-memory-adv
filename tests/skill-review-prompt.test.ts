/**
 * Background-review skill proposals: prompt contract (#skillReviewMode, R11).
 *
 * The "off" texts must reproduce the pre-skill-review prompts byte for byte.
 * Skill proposals are a DIRECT-transport-only capability: the subprocess child
 * registers skill_manage and its stdout is never parsed into operations, so the
 * subprocess prompt must always carry the historical denial (R11).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCombinedReviewPrompt,
  buildDirectReviewSystemPrompt,
  COMBINED_REVIEW_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
} from "../src/constants.js";
import {
  buildDirectReviewSystemPrompt as buildDirectReviewSystemPromptForInput,
  buildSubprocessReviewPrompt,
} from "../src/handlers/background-review.js";
import { parseReviewOperations } from "../src/handlers/review-memory-ops.js";

const HISTORICAL_COMBINED_REVIEW_PROMPT = `Review the conversation above and consider these aspects:

**Memory**: Has the user revealed things about themselves — their persona, desires, preferences, or personal details? Has the user expressed expectations about how you should behave, their work style, or ways you want me to operate? If so, save using memory_add.

**Failures & Corrections**: Did anything fail or go wrong? Extract these as failure memories:
- [failure] What was tried but didn't work? (e.g., "Used localStorage for tokens — XSS vulnerability")
- [correction] Did the user correct you? (e.g., "Use pnpm, not npm")
- [insight] What was learned from the experience?
- [convention] Any project conventions discovered?
- [tool-quirk] Any tool-specific knowledge gained?

For failures, include: what was tried, why it failed, what error occurred, and what worked instead.

**Skills**: Do NOT create or modify skills in this background review. Procedural skills are managed explicitly by the main agent through the skill_manage tool during normal work, not by this review subprocess.

Only act if there's something genuinely worth saving. If nothing stands out, just say 'Nothing to save.' and stop.`;

const HISTORICAL_DIRECT_REVIEW_SYSTEM_PROMPT = `You review coding conversations and extract durable memories worth saving across sessions.

Review these aspects:
- **Memory**: User persona, preferences, expectations about how the agent should behave, work style.
- **Failures & Corrections**: What failed, user corrections, insights, conventions, tool quirks.

Do NOT create or modify skills. Only save genuinely durable facts — not task progress, session outcomes, or temporary state.

Respond with JSON only (no markdown fences):
{"operations": [ /* one operation object per entry, using the fields below */ ]}

Operation fields:
- action: "add" | "replace" | "remove"
- target: "memory" | "user" | "project" | "failure"
- content: required for add/replace
- old_text: required for replace/remove (substring match)
- category: for failure target — failure | correction | insight | convention | tool-quirk | preference
- failure_reason: optional context for failure entries

Put the JSON in the assistant text, not only in thinking.

If nothing is worth saving, return {"operations":[]}.`;

/** Balanced {...} regions parsed as JSON — the parseable operation examples in
 * a prompt, exactly what the #197 guard must bound. */
function parseableJsonObjects(text: string): string[] {
  const spans: Array<[number, number]> = [];
  const open: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") open.push(i);
    else if (ch === "}") {
      const start = open.pop();
      if (start !== undefined) spans.push([start, i]);
    }
  }
  const found: string[] = [];
  for (const [start, end] of spans) {
    const slice = text.slice(start, end + 1);
    try {
      JSON.parse(slice);
      found.push(slice);
    } catch {
      // Unparseable placeholders are allowed — they cannot become operations.
    }
  }
  return found;
}

function promptInput(overrides: Record<string, unknown> = {}) {
  return {
    parts: ["[USER] hello", "[ASSISTANT] hi"],
    currentMemory: "global fact",
    currentUser: "user preference",
    currentProject: null as string | null,
    ...overrides,
  };
}

const CANDIDATE = { skillId: "global:debug-ts", name: "debug-ts", body: "## Procedure\n1. run tsc" };

describe("review prompt skill gating", () => {
  it("keeps the historical combined prompt byte for byte", () => {
    assert.strictEqual(buildCombinedReviewPrompt(), HISTORICAL_COMBINED_REVIEW_PROMPT);
    assert.strictEqual(COMBINED_REVIEW_PROMPT, HISTORICAL_COMBINED_REVIEW_PROMPT);
  });

  it("keeps the historical direct system prompt byte for byte when off", () => {
    const off = buildDirectReviewSystemPrompt("off", {
      maxProposals: 3,
      maxBodyChars: 12000,
    });

    assert.strictEqual(off, HISTORICAL_DIRECT_REVIEW_SYSTEM_PROMPT);
    assert.strictEqual(DIRECT_REVIEW_SYSTEM_PROMPT, HISTORICAL_DIRECT_REVIEW_SYSTEM_PROMPT);
    assert.strictEqual(
      buildDirectReviewSystemPrompt(undefined, { maxProposals: 3, maxBodyChars: 12000 }),
      HISTORICAL_DIRECT_REVIEW_SYSTEM_PROMPT,
    );
  });

  it("withholds skill permission on the subprocess transport regardless of skillReviewMode", () => {
    const build = (mode: string) =>
      buildSubprocessReviewPrompt(promptInput({
        skillReviewMode: mode,
        skillCandidates: [CANDIDATE],
        skillReviewMaxProposals: 2,
        skillReviewMaxBodyChars: 4321,
      }));

    const off = build("off");
    const stage = build("stage");
    const apply = build("apply");

    for (const prompt of [off, stage, apply]) {
      // The whole historical combined prompt (denial included) heads the
      // subprocess prompt byte for byte.
      assert.ok(prompt.startsWith(HISTORICAL_COMBINED_REVIEW_PROMPT));
      assert.doesNotMatch(prompt, /You may also propose procedural skill changes/);
      assert.ok(!prompt.includes("global:debug-ts"), "candidates are not injected on the subprocess transport");
      assert.ok(!prompt.includes("under 4321 characters"));
    }

    assert.strictEqual(stage, off, "skillReviewMode must not reach the subprocess prompt");
    assert.strictEqual(apply, off, "skillReviewMode must not reach the subprocess prompt");
  });

  it("permits skills with the limits and fields on the direct transport", () => {
    for (const mode of ["stage", "apply"] as const) {
      const direct = buildDirectReviewSystemPromptForInput(promptInput({
        skillReviewMode: mode,
        skillReviewMaxProposals: 2,
        skillReviewMaxBodyChars: 4321,
      }));

      assert.match(direct, /You may also propose procedural skill changes/);
      assert.match(direct, /skill_create fields: name, description, and content/);
      assert.match(direct, /skill_patch fields: skill_id, section, and content/);
      assert.match(direct, /skill_patch/);
      assert.ok(direct.includes("at most 2 skill operations"), "states the proposal limit");
      assert.ok(direct.includes("under 4321 characters"), "states the body limit");
      assert.match(direct, /global skills directory/);
      assert.match(direct, /generalize beyond the current repo/);
      assert.doesNotMatch(direct, /Do NOT create or modify skills/);
    }
  });

  it("injects referenced skills as candidates on the direct transport only", () => {
    const input = promptInput({ skillReviewMode: "stage", skillCandidates: [CANDIDATE] });

    const direct = buildDirectReviewSystemPromptForInput(input);
    assert.ok(direct.includes("global:debug-ts"), "candidate id reaches the direct prompt");
    assert.ok(direct.includes("1. run tsc"), "candidate body reaches the direct prompt");

    const subprocess = buildSubprocessReviewPrompt(input);
    assert.ok(!subprocess.includes("global:debug-ts"));
    assert.ok(!subprocess.includes("1. run tsc"));
  });

  it("keeps the direct prompt's only parseable JSON at the empty operations example (#197)", () => {
    const stageDirect = buildDirectReviewSystemPrompt("stage", {
      maxProposals: 3,
      maxBodyChars: 12000,
      candidates: [CANDIDATE],
    });

    assert.deepStrictEqual(
      [...new Set(parseableJsonObjects(stageDirect))],
      ['{"operations":[]}'],
      "the only parseable JSON in the direct prompt is the empty operations example",
    );
    assert.doesNotMatch(stageDirect, /<[a-z_]+>/, "no angle-bracket placeholders");

    assert.deepStrictEqual(parseableJsonObjects(buildCombinedReviewPrompt()), []);
  });

  it("does not parse any live operation out of the stage prompts (#197)", () => {
    const stageDirect = buildDirectReviewSystemPrompt("stage", { maxProposals: 3, maxBodyChars: 12000 });
    const subprocess = buildSubprocessReviewPrompt(promptInput({
      skillReviewMode: "stage",
      skillCandidates: [CANDIDATE],
    }));

    for (const prompt of [stageDirect, subprocess]) {
      const parsed = parseReviewOperations(prompt);
      assert.ok(parsed === null || parsed.length === 0);
    }
  });
});
