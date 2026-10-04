/**
 * SkillProposalStore — staged background-review skill changes.
 *
 * Background review can propose create/patch operations against the SkillStore
 * without mutating skills directly (`skillReviewMode: "stage"`). Each proposal
 * is persisted as `<pendingDir>/<id>.json` and later approved (applied to disk
 * and moved to `applied/`) or rejected (moved to `rejected/`, skill untouched).
 * `skillReviewMode: "apply"` calls `apply()` instead: the same validation runs,
 * then the change is written straight to disk with no proposal file created.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanContent } from "./content-scanner.js";
import { exists, parseSkillId, slugify } from "./skill-utils.js";
import { SkillStore } from "./skill-store.js";
import type { SkillIndex, SkillResult, SkillScope } from "../types.js";

export interface SkillProposal {
  id: string;                       // `${action}-${slug}-${Date.now()}` (-2/-3 on same-ms collisions)
  action: "create" | "patch";
  scope: SkillScope;
  name: string;
  skillId?: string;
  section?: string;
  description?: string;
  content: string;
  createdAt: string;                // ISO
  source: { kind: "background-review"; projectName?: string | null };
}

export type SkillProposalInput = Omit<SkillProposal, "id" | "createdAt">;

export interface SkillProposalStoreOptions {
  pendingDir: string;
  store: SkillStore;
  maxBodyChars: number;
}

type Validation =
  | { ok: true; slug: string; name: string; skillId: string; section: string; description: string }
  | { ok: false; error: string };

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class SkillProposalStore {
  private readonly pendingDir: string;
  private readonly store: SkillStore;
  private readonly maxBodyChars: number;

  constructor(options: SkillProposalStoreOptions) {
    this.pendingDir = options.pendingDir;
    this.store = options.store;
    this.maxBodyChars = options.maxBodyChars;
  }

  async stage(input: SkillProposalInput): Promise<{ ok: true; proposal: SkillProposal } | { ok: false; error: string }> {
    const validation = await this.validate(input);
    if (!validation.ok) return { ok: false, error: validation.error };

    const allocated = await this.allocateId(input.action, validation.slug);
    if (!allocated.ok) return { ok: false, error: allocated.error };

    const proposal: SkillProposal = {
      ...input,
      name: validation.name,
      id: allocated.id,
      createdAt: new Date().toISOString(),
    };
    if (validation.skillId) proposal.skillId = validation.skillId;
    if (validation.section) proposal.section = validation.section;
    if (validation.description) proposal.description = validation.description;

    await fs.mkdir(this.pendingDir, { recursive: true });
    await fs.writeFile(this.proposalPath(allocated.id), `${JSON.stringify(proposal, null, 2)}\n`, "utf-8");

    return { ok: true, proposal };
  }

  async apply(input: SkillProposalInput): Promise<{ ok: boolean; error?: string; path?: string }> {
    const validation = await this.validate(input);
    if (!validation.ok) return { ok: false, error: validation.error };

    const result = input.action === "create"
      ? await this.store.create(validation.name, validation.description || "", input.content, input.scope)
      : await this.store.patch(validation.skillId, validation.section, input.content);

    if (!result.success) return { ok: false, error: result.error };
    return { ok: true, path: result.path };
  }

  /** Resolve the extension's current skills for callers that must look up a
   * patch target before building a proposal (background review synthesizes the
   * proposal's name/scope from the matched index entry). */
  loadIndex(scope?: SkillScope): Promise<SkillIndex[]> {
    return this.store.loadIndex(scope);
  }

  async list(): Promise<SkillProposal[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.pendingDir);
    } catch {
      return [];
    }

    const proposals: SkillProposal[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const proposal = await this.readFileProposal(entry);
      if (proposal) proposals.push(proposal);
    }

    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async read(id: string): Promise<SkillProposal | null> {
    if (!this.isSafeProposalId(id)) return null;
    return this.readFileProposal(`${id}.json`);
  }

  async approve(id: string): Promise<{ ok: boolean; error?: string; path?: string }> {
    const proposal = await this.read(id);
    if (!proposal) return { ok: false, error: `Proposal '${id}' not found.` };

    let result: SkillResult;
    if (proposal.action === "create") {
      const name = asTrimmed(proposal.name);
      if (!name) return { ok: false, error: "Proposal is missing a valid name." };
      result = await this.store.create(
        name,
        asTrimmed(proposal.description),
        proposal.content ?? "",
        proposal.scope,
      );
    } else {
      const skillId = asTrimmed(proposal.skillId);
      const section = asTrimmed(proposal.section);
      if (!skillId) return { ok: false, error: "Proposal is missing skillId." };
      if (!section) return { ok: false, error: "Proposal is missing section." };
      result = await this.store.patch(skillId, section, proposal.content ?? "");
    }

    if (!result.success) return { ok: false, error: result.error };

    await this.moveProposal(id, "applied");
    return { ok: true, path: result.path };
  }

  async reject(id: string): Promise<boolean> {
    const proposal = await this.read(id);
    if (!proposal) return false;

    await this.moveProposal(id, "rejected");
    return true;
  }

  /**
   * Shared validation for stage() and apply(). Mirrors the SkillStore's own
   * write-path guards (slug validity, body length, content scan, and Pi's
   * shadowing guard for global creates) so a proposal that stages can also be
   * applied, and a direct apply can never bypass the checks.
   */
  private async validate(input: SkillProposalInput): Promise<Validation> {
    const action = input?.action;
    const scope = input?.scope;
    const name = asTrimmed(input?.name);
    const skillId = asTrimmed(input?.skillId);
    const section = asTrimmed(input?.section);
    const description = asTrimmed(input?.description);
    const content = typeof input?.content === "string" ? input.content : "";

    if (action !== "create" && action !== "patch") {
      return { ok: false, error: `Unsupported action '${String(action)}'.` };
    }
    if (scope !== "global" && scope !== "project") {
      return { ok: false, error: `Unsupported scope '${String(scope)}'.` };
    }

    let slug: string;
    if (action === "create") {
      if (!name) return { ok: false, error: "Skill name is required." };
      // SkillStore.create refuses a description-less skill, so without this the
      // proposal would stage and then be unapprovable forever (stage/apply parity).
      if (!description) return { ok: false, error: "Skill description is required." };
      slug = slugify(name);
      if (!slug) return { ok: false, error: "Skill name produces empty slug." };
    } else {
      if (!skillId) return { ok: false, error: "skillId is required for patch." };
      if (!section) return { ok: false, error: "section is required for patch." };
      const parsed = parseSkillId(skillId);
      if (!parsed || !parsed.slug) return { ok: false, error: `Skill '${skillId}' is invalid.` };
      // Reuse the repo's canonical slug form (skill-utils.ts `slugify`) so a
      // crafted skillId slug cannot smuggle path separators into the proposal
      // id / on-disk path.
      if (parsed.slug !== slugify(parsed.slug)) {
        return { ok: false, error: `Skill '${skillId}' has an invalid slug.` };
      }
      slug = parsed.slug;
    }

    if (!content.trim()) return { ok: false, error: "Skill content is required." };
    if (content.length > this.maxBodyChars) {
      return {
        ok: false,
        error: `Skill content is ${content.length} characters, exceeding the ${this.maxBodyChars} character limit.`,
      };
    }

    const scanTarget = action === "create" ? `${name} ${description} ${content}` : content;
    const scanError = scanContent(scanTarget);
    if (scanError) return { ok: false, error: scanError };

    if (action === "create" && scope === "global") {
      const shadowedBy = await this.store.findShadowingPiGlobalSkill(slug);
      if (shadowedBy) {
        return {
          ok: false,
          error: `Pi already loads a global skill named '${slug}' from ${shadowedBy}. `
            + `Choose a different name, or edit that skill directly.`,
        };
      }
    }

    return { ok: true, slug, name, skillId, section, description };
  }

  private proposalPath(id: string): string {
    return path.join(this.pendingDir, `${id}.json`);
  }

  private isSafeProposalId(id: string): boolean {
    return (
      typeof id === "string" &&
      id.length > 0 &&
      id === path.basename(id) &&
      !id.includes("/") &&
      !id.includes("\\")
    );
  }

  private async readFileProposal(fileName: string): Promise<SkillProposal | null> {
    try {
      const raw = await fs.readFile(path.join(this.pendingDir, fileName), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as SkillProposal).id === "string" &&
        typeof (parsed as SkillProposal).createdAt === "string"
      ) {
        return parsed as SkillProposal;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async allocateId(action: "create" | "patch", slug: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const base = `${action}-${slug}-${Date.now()}`;
    let id = base;
    let suffix = 2;
    while (await this.idInUse(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }

    // Defense-in-depth: never build a path from an id that could escape the
    // pending directory, even if validation above regressed.
    if (!this.isSafeProposalId(id)) {
      return { ok: false, error: `Refusing to write proposal under unsafe id '${id}'.` };
    }
    return { ok: true, id };
  }

  private async idInUse(id: string): Promise<boolean> {
    return (
      await exists(this.proposalPath(id)) ||
      await exists(path.join(this.pendingDir, "applied", `${id}.json`)) ||
      await exists(path.join(this.pendingDir, "rejected", `${id}.json`))
    );
  }

  private async moveProposal(id: string, destination: "applied" | "rejected"): Promise<void> {
    const targetDir = path.join(this.pendingDir, destination);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.rename(this.proposalPath(id), path.join(targetDir, `${id}.json`));
  }
}
