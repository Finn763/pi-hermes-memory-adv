/**
 * Background review — learning loop that auto-saves memory every N turns.
 * Ported from hermes-agent/run_agent.py (_spawn_background_review, _memory_nudge_interval).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Default transport: in-process complete() side-channel (preserves parent LLM cache).
 * Fallback: pi.exec("pi", ["-p", ...]) subprocess when direct path is unavailable.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildCombinedReviewPrompt,
  buildDirectReviewSystemPrompt as renderDirectReviewSystemPrompt,
  buildMemoryTargetRoutingGuidance,
  DEFAULT_SKILL_REVIEW_MAX_BODY_CHARS,
  DEFAULT_SKILL_REVIEW_MAX_PROPOSALS,
  DEFAULT_REVIEW_NOTIFICATIONS,
  MEMORY_UPDATED_NOTIFICATION,
  SKILL_CANDIDATE_MAX_CHARS,
  skillAppliedNotification,
  type SkillReviewCandidate,
} from "../constants.js";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import type { SkillStore } from "../store/skill-store.js";
import type { SkillProposalStore } from "../store/skill-proposal-store.js";
import type { MemoryConfig, SkillIndex, SkillReviewMode } from "../types.js";
import type { EnsureMemoryReady } from "../memory-initialization.js";
import { applyRecentMessageLimit, collectMessageParts } from "./message-parts.js";
import { cleanChildStderr, execChildPrompt, resolveChildPiModel } from "./pi-child-process.js";
import {
  REVIEW_COMPLETION_TIMEOUT_MS,
  isSkillAppliedSummary,
  parseAppliedSkillSummary,
  parseReviewOperations,
  runDirectMemoryCompletion,
  usesDirectTransport,
  type DirectReviewResult,
} from "./review-memory-ops.js";

import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";
export interface BackgroundReviewOptions {
  ensureMemoryReady?: EnsureMemoryReady;
  dbManager?: DatabaseManager | null;
  projectName?: ProjectNameRef;
  /** Staged/apply skill writes for background review (omit to disable them). */
  skillProposals?: SkillProposalStore;
  /** Skill index the candidate collector matches conversation `SKILL.md` paths
   * against (omit to inject no candidates). */
  skillStore?: SkillStore;
  deps?: BackgroundReviewDeps;
}

export interface BackgroundReviewDeps {
  runDirectReview?: typeof runDirectMemoryCompletion;
  execChildPrompt?: typeof execChildPrompt;
  /** Test-only hook: called once runReview() has fully settled (after the
   * fire-and-forget review work completes and activeReview clears),
   * since production callers never await runReview() directly. */
  onReviewSettled?: () => void;
  /** Test-only override for session_shutdown's wait bound. */
  shutdownGraceMs?: number;
}

export interface ReviewPromptInput {
  parts: string[];
  currentMemory: string;
  currentUser: string;
  currentProject: string | null;
  /** Skill-review mode driving the DIRECT transport's Skills paragraph
   * (defaults to "off"). The subprocess transport ignores it (R11). */
  skillReviewMode?: SkillReviewMode;
  /** Skills referenced in the conversation, injected as patch candidates into
   * the DIRECT transport (task 6). The subprocess transport ignores them. */
  skillCandidates?: SkillReviewCandidate[];
  skillReviewMaxProposals?: number;
  skillReviewMaxBodyChars?: number;
}

function skillReviewPromptOptions(input: ReviewPromptInput): {
  maxProposals: number;
  maxBodyChars: number;
  candidates: SkillReviewCandidate[];
} {
  return {
    maxProposals: input.skillReviewMaxProposals ?? DEFAULT_SKILL_REVIEW_MAX_PROPOSALS,
    maxBodyChars: input.skillReviewMaxBodyChars ?? DEFAULT_SKILL_REVIEW_MAX_BODY_CHARS,
    // R12: the render-time gate for candidate bodies. Every body reaches the
    // prompt through this map, so a body that would parse into operations is
    // neutralized no matter which caller supplied it.
    candidates: (input.skillCandidates ?? []).map((candidate) => ({
      ...candidate,
      body: neutralizeOperationsPayload(candidate.body),
    })),
  };
}

/** The slice of `SkillStore` the candidate collector reads — a projection, so
 * the collector can be exercised without a filesystem-backed store. */
export type SkillBodySource = Pick<SkillStore, "loadSkill">;

export interface SkillCandidateLimits {
  maxCandidates: number;
  maxCharsPerCandidate: number;
}

const SKILL_FILE_NAME = "SKILL.md";

/** Characters that end a candidate path when scanning prose: whitespace plus
 * quotes, markdown brackets and shell punctuation. */
const PATH_BOUNDARY_CHARS = "\"'`<>|*?()[]{},;";

/** Marks a body cut down to the candidate budget, so a partial skill can never
 * read as a whole one. */
const TRUNCATION_MARKER = "…[truncated]";

/** A colon ends a path unless it is the drive colon of `C:\`. */
function isPathBoundary(ch: string, text: string, start: number): boolean {
  if (/\s/.test(ch) || PATH_BOUNDARY_CHARS.includes(ch)) return true;
  if (ch !== ":") return false;
  return !(/[A-Za-z]/.test(text[start - 2] ?? "") && /[\\/]/.test(text[start] ?? ""));
}

/** Every `SKILL.md` path mentioned in the text, in appearance order. Both
 * separators are captured because the conversation may quote a Windows path
 * either way; over-captured runs are harmless (they only have to match nothing
 * in the index). */
function findSkillMdPaths(text: string): string[] {
  const mentioned: string[] = [];
  let at = text.indexOf(SKILL_FILE_NAME);
  while (at !== -1) {
    const end = at + SKILL_FILE_NAME.length;
    let start = at;
    while (start > 0 && !isPathBoundary(text[start - 1] ?? "", text, start)) start--;
    mentioned.push(text.slice(start, end));
    at = text.indexOf(SKILL_FILE_NAME, end);
  }
  return mentioned;
}

/** Windows compares paths case-insensitively, so both sides of an index match
 * are resolved and lowercased (R14). */
function candidatePathKey(value: string): string {
  return path.resolve(value).toLowerCase();
}

function truncateCandidateBody(body: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return body.length <= maxChars ? body : `${body.slice(0, maxChars)}${TRUNCATION_MARKER}`;
}

/**
 * The skill bodies the conversation references (task 6, R14): every `SKILL.md`
 * path quoted in the text is resolved and matched against the skills this
 * extension manages (`SkillStore.loadIndex()`), deduped by resolved path in
 * first-appearance order and capped at `maxCandidates`.
 *
 * A path that matches nothing in the index is skipped silently. The index only
 * covers the extension's own skill directories, so Pi's own roots
 * (`~/.pi/agent/skills`, `~/.agents/skills`) can never be injected.
 */
export async function collectSkillCandidates(
  conversationText: string,
  index: SkillIndex[],
  store: SkillBodySource,
  opts: SkillCandidateLimits,
): Promise<SkillReviewCandidate[]> {
  if (opts.maxCandidates <= 0) return [];

  const byResolvedPath = new Map<string, SkillIndex>();
  for (const entry of index) byResolvedPath.set(candidatePathKey(entry.path), entry);

  const matched: SkillIndex[] = [];
  const seen = new Set<string>();
  for (const mentioned of findSkillMdPaths(conversationText)) {
    const key = candidatePathKey(mentioned);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byResolvedPath.get(key);
    if (!entry) continue;
    matched.push(entry);
    if (matched.length >= opts.maxCandidates) break;
  }

  const candidates: SkillReviewCandidate[] = [];
  for (const entry of matched) {
    const doc = await store.loadSkill(entry.skillId);
    if (!doc) continue;
    candidates.push({
      skillId: entry.skillId,
      name: entry.displayName || entry.name,
      body: truncateCandidateBody(doc.body, opts.maxCharsPerCandidate),
    });
  }
  return candidates;
}

/**
 * R12 (#197): a candidate body is untrusted data quoted into the direct review
 * prompt, and a body carrying a parseable `{"operations": …}` object would
 * become live operations if the model echoed the prompt back. The repo's own
 * operation parser is the detector — no second JSON scanner — and an offending
 * body has its braces escaped, so the payload can no longer parse while the
 * rest of the body stays readable. The only parseable operations literal left
 * in the prompt is the empty `{"operations":[]}` example.
 */
function neutralizeOperationsPayload(text: string): string {
  return parseReviewOperations(text) === null ? text : text.replace(/[{}]/g, "\\$&");
}

/** R13: candidates are built only for the direct prompt's non-off modes, and a
 * failure to read the index or a body must never break the review — an empty
 * candidate list is the pre-task behaviour. */
async function collectReviewSkillCandidates(
  parts: string[],
  config: MemoryConfig,
  skillStore: SkillStore | undefined,
): Promise<SkillReviewCandidate[]> {
  if (!skillStore) return [];
  try {
    const index = await skillStore.loadIndex();
    return await collectSkillCandidates(parts.join("\n\n"), index, skillStore, {
      maxCandidates: config.skillReviewMaxProposals ?? DEFAULT_SKILL_REVIEW_MAX_PROPOSALS,
      maxCharsPerCandidate: SKILL_CANDIDATE_MAX_CHARS,
    });
  } catch {
    return [];
  }
}

export function buildSubprocessReviewPrompt(input: ReviewPromptInput): string {
  // R11: the subprocess transport ALWAYS carries the historical skill denial.
  // The child `pi -p` registers this extension's skill_manage tool, and this
  // channel's stdout is never parsed into operations, so it cannot stage a
  // proposal — a permission paragraph here would be an unhonorable grant and a
  // staging-gate bypass. input.skillReviewMode / skillCandidates are
  // deliberately NOT read here; do not wire them in.
  const reviewPrompt = [
    buildCombinedReviewPrompt(),
    "",
    buildMemoryTargetRoutingGuidance(input.currentProject !== null),
    "",
    "--- Current Memory ---",
    input.currentMemory || "(empty)",
    "",
    "--- Current User Profile ---",
    input.currentUser || "(empty)",
  ];

  if (input.currentProject !== null) {
    reviewPrompt.push(
      "",
      "--- Current Project Memory ---",
      input.currentProject || "(empty)",
    );
  }

  reviewPrompt.push(
    "",
    "--- Conversation to Review ---",
    input.parts.join("\n\n"),
  );

  return reviewPrompt.join("\n");
}

export function buildDirectReviewSystemPrompt(input: ReviewPromptInput): string {
  return [
    renderDirectReviewSystemPrompt(input.skillReviewMode, skillReviewPromptOptions(input)),
    "",
    buildMemoryTargetRoutingGuidance(input.currentProject !== null),
  ].join("\n");
}

export function buildDirectReviewUserPrompt(input: ReviewPromptInput): string {
  const sections = [
    "--- Current Memory ---",
    input.currentMemory || "(empty)",
    "",
    "--- Current User Profile ---",
    input.currentUser || "(empty)",
  ];

  if (input.currentProject !== null) {
    sections.push(
      "",
      "--- Current Project Memory ---",
      input.currentProject || "(empty)",
    );
  }

  sections.push(
    "",
    "--- Conversation to Review ---",
    input.parts.join("\n\n"),
  );

  return sections.join("\n");
}

function shouldNotifySubprocess(stdout: string | undefined): boolean {
  const output = stdout?.trim();
  return !!output && !output.toLowerCase().includes("nothing to save");
}

function diagnosticDetail(value: unknown): string {
  const detail = value instanceof Error ? value.message : String(value ?? "").trim();
  return detail.replace(/\s+/g, " ").slice(0, 300);
}

/** Shutdown wait only. Review still uses its own 120s timeout; 1s covers abort
 * listener + cancel-file write without hanging Pi's awaited session_shutdown. */
const SESSION_REVIEW_SHUTDOWN_GRACE_MS = 1000;

function awaitUpTo(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

async function runSubprocessReview(
  pi: ExtensionAPI,
  prompt: string,
  config: MemoryConfig,
  execChild: typeof execChildPrompt,
  ctx: Pick<ExtensionContext, "cwd" | "model">,
  signal: AbortSignal,
): Promise<{ code: number; stdout?: string; stderr?: string }> {
  return execChild(pi, prompt, config, {
    cwd: ctx.cwd,
    model: resolveChildPiModel(ctx.model),
    // Session-scoped signal only. The turn signal belongs to the interactive
    // agent run; forwarding it cancels unrelated review on a later user abort.
    signal,
    timeoutMs: REVIEW_COMPLETION_TIMEOUT_MS,
  });
}

export interface BackgroundReviewHandle {
  /** Manual `/memory-review` (alias `/refine`) entry. Runs a review immediately
   * regardless of `reviewEnabled`/nudge thresholds, never resets the automatic
   * counters, and refuses to start a second review while one is in flight. */
  runReviewNow: (ctx: ExtensionContext) => Promise<"ran" | "already-running">;
}

export function setupBackgroundReview(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  config: MemoryConfig,
  options: BackgroundReviewOptions = {},
): BackgroundReviewHandle {
  const dbManager = options.dbManager ?? null;
  const projectName = options.projectName ?? null;
  const runDirectReview = options.deps?.runDirectReview ?? runDirectMemoryCompletion;
  const execChild = options.deps?.execChildPrompt ?? execChildPrompt;
  const onReviewSettled = options.deps?.onReviewSettled;
  const skillProposals = options.skillProposals;
  const skillStore = options.skillStore;
  const shutdownGraceMs = options.deps?.shutdownGraceMs ?? SESSION_REVIEW_SHUTDOWN_GRACE_MS;

  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let userTurnCount = 0;
  let activeReview: Promise<void> | undefined;
  const sessionAbort = new AbortController();
  let shutdownPromise: Promise<void> | undefined;

  const sessionCancelled = () => sessionAbort.signal.aborted;

  const shutdownReview = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      sessionAbort.abort();
      const inFlight = activeReview;
      if (inFlight) await awaitUpTo(inFlight, shutdownGraceMs);
    })();
    return shutdownPromise;
  };

  pi.on("session_shutdown", () => shutdownReview());

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") {
      userTurnCount++;
    }
  });

  const notificationMode = (): "off" | "on" | "verbose" =>
    config.reviewNotifications ?? DEFAULT_REVIEW_NOTIFICATIONS;

  const notifyIfSaved = (ctx: ExtensionContext, saved: boolean) => {
    if (sessionCancelled()) return;
    if (saved && notificationMode() !== "off") {
      ctx.ui.notify(MEMORY_UPDATED_NOTIFICATION, "info");
    }
  };

  const notifyDirectOutcome = (ctx: ExtensionContext, result: DirectReviewResult) => {
    if (sessionCancelled()) return;
    const mode = notificationMode();
    const summaries = result.appliedSummaries ?? [];
    const memoryApplied = summaries.length > 0
      ? summaries.some((summary) => !isSkillAppliedSummary(summary))
      : result.appliedCount > 0;

    if (mode !== "off" && memoryApplied) {
      const preview = mode === "verbose" && summaries.length > 0
        ? ` — ${summaries.join(", ")}`
        : "";
      ctx.ui.notify(`${MEMORY_UPDATED_NOTIFICATION}${preview}`, "info");
    }

    if (mode !== "off") {
      for (const summary of summaries) {
        const skill = parseAppliedSkillSummary(summary);
        if (skill) {
          ctx.ui.notify(skillAppliedNotification(skill.name, skill.action), "info");
        }
      }
    }

    const staged = result.stagedCount ?? 0;
    if (mode !== "off" && staged > 0) {
      ctx.ui.notify(
        `🛠️ Staged ${staged} skill proposal${staged === 1 ? "" : "s"} for review — run /memory-skills pending`,
        "info",
      );
    }
  };

  const notifyTransportFailure = (ctx: ExtensionContext, directFailure: string, subprocessDetail: unknown) => {
    if (sessionCancelled()) return;
    ctx.ui.notify(
      `Memory auto-review failed in both transports. Direct: ${diagnosticDetail(directFailure)}. `
        + `Subprocess: ${diagnosticDetail(subprocessDetail)}. Check the active model/provider or set llmModelOverride.`,
      "warning",
    );
  };

  const runReview = async (ctx: ExtensionContext): Promise<void> => {
    if (sessionCancelled()) return;

    let allParts: string[] = [];
    try {
      const entries = ctx.sessionManager.getBranch();
      allParts = collectMessageParts(entries);
    } catch {
      return;
    }
    if (allParts.length < 4) return;
    await options.ensureMemoryReady?.(ctx);
    if (sessionCancelled()) return;

    const parts = applyRecentMessageLimit(allParts, config.reviewRecentMessages);
    const activeProjectStore = resolveProjectStore(projectStore);
    const activeProjectName = resolveProjectName(projectName);
    const skillReviewMode = config.skillReviewMode ?? "off";
    const promptInput: ReviewPromptInput = {
      parts,
      currentMemory: store.getMemoryEntries().join("\n§\n"),
      currentUser: store.getUserEntries().join("\n§\n"),
      currentProject: activeProjectStore ? activeProjectStore.getMemoryEntries().join("\n§\n") : null,
      skillReviewMode,
      skillCandidates: skillReviewMode === "off"
        ? []
        : await collectReviewSkillCandidates(parts, config, skillStore),
      skillReviewMaxProposals: config.skillReviewMaxProposals,
      skillReviewMaxBodyChars: config.skillReviewMaxBodyChars,
    };
    const subprocessPrompt = buildSubprocessReviewPrompt(promptInput);
    const directPrompt = buildDirectReviewUserPrompt(promptInput);

    let directFailure: string | undefined;

    if (usesDirectTransport(config)) {
      try {
        const directResult = await runDirectReview(
          ctx,
          store,
          activeProjectStore,
          {
            userPrompt: directPrompt,
            systemPrompt: buildDirectReviewSystemPrompt(promptInput),
            config,
            timeoutMs: REVIEW_COMPLETION_TIMEOUT_MS,
            signal: sessionAbort.signal,
            skillMode: config.skillReviewMode ?? "off",
            skillProposals,
          },
          dbManager,
          activeProjectName,
        );

        if (sessionCancelled()) return;

        if (directResult.ok) {
          notifyDirectOutcome(ctx, directResult);
          return;
        }

        if (directResult.fallbackReason === "empty" || directResult.fallbackReason === "aborted") {
          return;
        }
        directFailure = [
          directResult.fallbackReason ?? "failed",
          directResult.error,
        ].filter(Boolean).join(": ");
      } catch (error) {
        if (sessionCancelled()) return;
        directFailure = diagnosticDetail(error);
      }
    }

    if (sessionCancelled()) return;

    let subprocessResult: { code: number; stdout?: string; stderr?: string };
    try {
      subprocessResult = await runSubprocessReview(
        pi,
        subprocessPrompt,
        config,
        execChild,
        ctx,
        sessionAbort.signal,
      );
    } catch (error) {
      if (directFailure) {
        notifyTransportFailure(ctx, directFailure, error);
      }
      return;
    }

    if (sessionCancelled()) return;

    if (subprocessResult.code === 0) {
      notifyIfSaved(ctx, shouldNotifySubprocess(subprocessResult.stdout));
    } else if (directFailure) {
      const subprocessDetail = cleanChildStderr(subprocessResult.stderr) || subprocessResult.stdout?.trim()
        || `exit code ${subprocessResult.code}`;
      notifyTransportFailure(ctx, directFailure, subprocessDetail);
    }
  };

  const startReview = (ctx: ExtensionContext): void => {
    // Occupy the in-flight slot before runReview's synchronous preamble so a
    // nested turn_end (or a second manual command) cannot start another review.
    activeReview = Promise.resolve()
      .then(() => runReview(ctx))
      .catch(() => {
        // Best-effort only; transport failures are diagnosed after both paths settle.
      })
      .finally(() => {
        activeReview = undefined;
        onReviewSettled?.();
      });
  };

  const runReviewNow = async (ctx: ExtensionContext): Promise<"ran" | "already-running"> => {
    if (sessionCancelled() || activeReview) return "already-running";
    startReview(ctx);
    return "ran";
  };

  pi.on("turn_end", async (event, ctx) => {
    turnsSinceReview++;

    if (!config.reviewEnabled) return;
    if (sessionCancelled()) return;
    if (activeReview) return;

    try {
      const msg = event.message;
      if (msg?.role === "assistant") {
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && block.type === "toolCall") {
              toolCallsSinceReview++;
            }
          }
        }
      }
    } catch {
      // If we can't count tool calls, fall back to turn-based only
    }

    const turnThresholdMet = turnsSinceReview >= config.nudgeInterval;
    const toolCallThresholdMet = toolCallsSinceReview >= config.nudgeToolCalls;

    if (!turnThresholdMet && !toolCallThresholdMet) return;
    if (userTurnCount < 3) return;
    if (sessionCancelled()) return;

    turnsSinceReview = 0;
    toolCallsSinceReview = 0;

    startReview(ctx);
  });

  return { runReviewNow };
}
