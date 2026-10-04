/**
 * Tests for the staged background-review skill proposal commands:
 * `/memory-skills pending`, `/memory-skill-approve <id|all>`,
 * `/memory-skill-reject <id|all>`.
 *
 * The command behavior is exercised through the pure
 * `handleSkillProposalCommand(args, proposalStore)` entry point so the tests
 * never need a running Pi runtime; a stub registration surface covers that the
 * three command names are advertised to Pi.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import { SkillStore } from "../../src/store/skill-store.js";
import {
  SkillProposalStore,
  type SkillProposalInput,
} from "../../src/store/skill-proposal-store.js";
import {
  handleSkillProposalCommand,
  registerSkillProposalCommands,
  registerSkillsCommand,
} from "../../src/handlers/skills-command.js";

let ROOT = "";
let PENDING_DIR = "";
let GLOBAL_SKILLS_DIR = "";
let PROJECT_SKILLS_DIR = "";
let PI_GLOBAL_SKILLS_DIR = "";
let PI_AGENTS_SKILLS_DIR = "";

function makeSkillStore(): SkillStore {
  return new SkillStore({
    globalSkillsDir: GLOBAL_SKILLS_DIR,
    piGlobalSkillsDir: PI_GLOBAL_SKILLS_DIR,
    piAgentsSkillsDir: PI_AGENTS_SKILLS_DIR,
    projectSkillsDir: PROJECT_SKILLS_DIR,
    projectName: "demo-project",
  });
}

function makeProposalStore(store: SkillStore, maxBodyChars = 1000): SkillProposalStore {
  return new SkillProposalStore({ pendingDir: PENDING_DIR, store, maxBodyChars });
}

async function cleanSlate(): Promise<void> {
  try {
    await fs.rm(ROOT, { recursive: true, force: true });
  } catch {
    // ignore
  }
  await fs.mkdir(GLOBAL_SKILLS_DIR, { recursive: true });
  await fs.mkdir(PROJECT_SKILLS_DIR, { recursive: true });
  await fs.mkdir(PI_GLOBAL_SKILLS_DIR, { recursive: true });
  await fs.mkdir(PI_AGENTS_SKILLS_DIR, { recursive: true });
}

function createInput(overrides: Partial<SkillProposalInput> = {}): SkillProposalInput {
  return {
    action: "create",
    scope: "global",
    name: "Debug TypeScript Errors",
    description: "How to debug TypeScript errors",
    content: "## Procedure\n1. Read the error",
    source: { kind: "background-review", projectName: null },
    ...overrides,
  };
}

function patchInput(skillId: string, overrides: Partial<SkillProposalInput> = {}): SkillProposalInput {
  return {
    action: "patch",
    scope: "global",
    name: "debug-typescript-errors",
    skillId,
    section: "Procedure",
    content: "1. New way",
    source: { kind: "background-review", projectName: null },
    ...overrides,
  };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function pendingEntries(): Promise<string[]> {
  return (await listDir(PENDING_DIR)).filter((entry) => entry.endsWith(".json"));
}

async function stage(proposals: SkillProposalStore, input: SkillProposalInput): Promise<string> {
  const result = await proposals.stage(input);
  assert.ok(result.ok, `stage failed: ${result.ok ? "" : result.error}`);
  if (!result.ok) throw new Error(result.error);
  return result.proposal.id;
}

describe("handleSkillProposalCommand", { concurrency: 1 }, () => {
  before(async () => {
    ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-proposal-cmd-test-"));
    PENDING_DIR = path.join(ROOT, "pending");
    GLOBAL_SKILLS_DIR = path.join(ROOT, "global-skills");
    PROJECT_SKILLS_DIR = path.join(ROOT, "project-skills");
    PI_GLOBAL_SKILLS_DIR = path.join(ROOT, "pi-global-skills");
    PI_AGENTS_SKILLS_DIR = path.join(ROOT, "pi-agents-skills");
  });

  after(async () => {
    try {
      await fs.rm(ROOT, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await cleanSlate();
  });

  it("pending reports clearly when there are no proposals", async () => {
    const proposals = makeProposalStore(makeSkillStore());

    const output = await handleSkillProposalCommand("pending", proposals);

    assert.match(output, /no pending skill proposals/i);
  });

  it("pending lists id, action, target, byte size and first line per proposal", async () => {
    const store = makeSkillStore();
    const proposals = makeProposalStore(store);
    const input = createInput();
    const id = await stage(proposals, input);

    const output = await handleSkillProposalCommand("pending", proposals);

    assert.ok(output.includes(id), "missing proposal id");
    assert.ok(output.includes("create"), "missing action");
    assert.ok(output.includes(`global/${input.name}`), "missing target");
    assert.ok(output.includes(`${Buffer.byteLength(input.content, "utf-8")} B`), "missing byte size");
    assert.ok(output.includes("## Procedure"), "missing first line");
  });

  it("approve <id> applies the proposal and prints the on-disk path", async () => {
    const store = makeSkillStore();
    const proposals = makeProposalStore(store);
    const id = await stage(proposals, createInput());

    const output = await handleSkillProposalCommand(`approve ${id}`, proposals);

    assert.match(output, /approved/i);
    assert.ok(output.includes(path.join(GLOBAL_SKILLS_DIR, "debug-typescript-errors", "SKILL.md")));

    const onDisk = await fs.readFile(
      path.join(GLOBAL_SKILLS_DIR, "debug-typescript-errors", "SKILL.md"),
      "utf-8",
    );
    assert.ok(onDisk.includes("## Procedure"), "skill body missing from the written skill");
    assert.deepStrictEqual(await pendingEntries(), [], "proposal should leave pending/");
    assert.deepStrictEqual(
      await listDir(path.join(PENDING_DIR, "applied")),
      [`${id}.json`],
      "proposal should move to applied/",
    );
  });

  it("approve all aggregates a per-proposal failure without aborting the batch", async () => {
    const store = makeSkillStore();
    const proposals = makeProposalStore(store);
    const applied = await store.create("debug-typescript-errors", "How to debug", "## Procedure\n1. Old");
    const createId = await stage(proposals, createInput({ name: "Deploy Checklist" }));
    const missingId = await stage(proposals, patchInput("global:ghost-skill"));

    const output = await handleSkillProposalCommand("approve all", proposals);

    assert.match(output, /approved 1\/2/i);
    assert.ok(output.includes(createId), "missing successful proposal id");
    assert.ok(
      output.includes(path.join(GLOBAL_SKILLS_DIR, "deploy-checklist", "SKILL.md")),
      "missing on-disk path for the applied proposal",
    );
    assert.ok(output.includes(missingId), "missing failed proposal id");
    assert.ok(output.includes("ghost-skill"), "missing failure detail");

    // The failed patch proposal stays pending; the applied one is gone.
    assert.deepStrictEqual(await pendingEntries(), [`${missingId}.json`]);
    // The successful create landed on disk.
    const created = await fs.readFile(
      path.join(GLOBAL_SKILLS_DIR, "deploy-checklist", "SKILL.md"),
      "utf-8",
    );
    assert.ok(created.includes("## Procedure"));
    // The unrelated pre-existing skill was untouched.
    const untouched = await fs.readFile(
      path.join(GLOBAL_SKILLS_DIR, "debug-typescript-errors", "SKILL.md"),
      "utf-8",
    );
    assert.ok(untouched.includes("1. Old"), `pre-existing skill changed: ${applied.skillId}`);
  });

  it("reject <id> moves the proposal out of pending without touching skills", async () => {
    const store = makeSkillStore();
    const proposals = makeProposalStore(store);
    const id = await stage(proposals, createInput());

    const output = await handleSkillProposalCommand(`reject ${id}`, proposals);

    assert.match(output, /rejected/i);
    assert.deepStrictEqual(await pendingEntries(), []);
    assert.deepStrictEqual(await listDir(path.join(PENDING_DIR, "rejected")), [`${id}.json`]);
    assert.deepStrictEqual(await listDir(GLOBAL_SKILLS_DIR), [], "no skill should be created");
  });

  it("reject all rejects every pending proposal", async () => {
    const store = makeSkillStore();
    const proposals = makeProposalStore(store);
    const first = await stage(proposals, createInput());
    const second = await stage(proposals, patchInput("global:ghost-skill"));

    const output = await handleSkillProposalCommand("reject all", proposals);

    assert.match(output, /rejected 2\/2/i);
    assert.ok(output.includes(first));
    assert.ok(output.includes(second));
    assert.deepStrictEqual(await pendingEntries(), []);
  });

  it("reports a clear failure when approving an unknown id", async () => {
    const proposals = makeProposalStore(makeSkillStore());

    const output = await handleSkillProposalCommand("approve does-not-exist", proposals);

    assert.match(output, /does-not-exist/);
    assert.match(output, /not found/i);
  });

  it("prints usage help for an unknown subcommand", async () => {
    const proposals = makeProposalStore(makeSkillStore());

    const output = await handleSkillProposalCommand("bogus", proposals);

    assert.match(output, /usage/i);
    assert.match(output, /\/memory-skill-approve/);
    assert.match(output, /\/memory-skill-reject/);
  });
});

describe("skill proposal command registration", () => {
  it("registers the approve/reject commands beside the existing memory-skills command", () => {
    const registered: Array<{ name: string; description?: string }> = [];
    const pi = {
      registerCommand: (name: string, options: { description?: string }) => {
        registered.push({ name, description: options.description });
      },
    };
    const skillStore = { loadIndex: async () => [], getProjectName: () => null };
    const proposalStore = {} as SkillProposalStore;

    registerSkillsCommand(pi as any, skillStore as any, proposalStore);
    registerSkillProposalCommands(pi as any, proposalStore);

    assert.deepStrictEqual(
      registered.map((entry) => entry.name),
      ["memory-skills", "memory-skill-approve", "memory-skill-reject"],
    );

    const descriptions = new Map(registered.map((entry) => [entry.name, entry.description ?? ""]));
    assert.match(descriptions.get("memory-skills")!, /procedural skills/i);
    assert.match(descriptions.get("memory-skill-approve")!, /approve/i);
    assert.match(descriptions.get("memory-skill-reject")!, /reject/i);
  });

  it("routes /memory-skills pending to the proposal listing instead of the modal", async () => {
    const registered: Array<{ name: string; handler: Function }> = [];
    const pi = {
      registerCommand: (name: string, options: { handler: Function }) => {
        registered.push({ name, handler: options.handler });
      },
    };
    const skillStore = { loadIndex: async () => [], getProjectName: () => null };
    const proposalStore = makeProposalStore(makeSkillStore());

    registerSkillsCommand(pi as any, skillStore as any, proposalStore);

    const notifications: Array<{ message: string; severity: string }> = [];
    let customOpened = false;
    await registered[0].handler("pending", {
      hasUI: true,
      ui: {
        custom: async () => {
          customOpened = true;
          return undefined;
        },
        notify: (message: string, severity: string) => notifications.push({ message, severity }),
      },
    });

    assert.strictEqual(customOpened, false, "pending must not open the skills manager modal");
    assert.strictEqual(notifications.length, 1);
    assert.match(notifications[0].message, /no pending skill proposals/i);
  });
});
