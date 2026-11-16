import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type MdcrmConfig } from "../src/config/config.js";
import { idempotencyKey } from "../src/jobs/idempotency.js";
import { rebuildFullTextIndex, searchFullText } from "../src/indexing/fullText.js";
import { createId } from "../src/models/ids.js";
import type { CaptureRecord, ContactRecord, EventRecord, MarkdownRecord, ProcessingJobRecord } from "../src/models/records.js";
import { processCapture } from "../src/processors/capturePipeline.js";
import { FileSystemRepository, RevisionConflictError } from "../src/storage/repository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function harness(): Promise<{ repository: FileSystemRepository; config: MdcrmConfig }> {
  const root = await mkdtemp(join(tmpdir(), "mdcrm-test-")); roots.push(root);
  const repository = new FileSystemRepository(root); await repository.initialize();
  return { repository, config: { ...structuredClone(DEFAULT_CONFIG), knowledgeBasePath: root } };
}

function capture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  const now = "2026-08-03T09:22:00.000Z";
  return { schema_version: 1, type: "capture", id: createId("capture"), created_at: now, updated_at: now,
    captured_by: "test-device", capture_method: "camera", capture_kind: "business_card", processing_status: "captured",
    review_status: "unreviewed", attachments: [], event_context: { event_name: "Defense Expo 2026", event_date: "2026-08-03", location: "London" },
    extracted: { name: "Jane Smith", title: "Director of Partnerships", company: "Acme Industries", email: "jane@acme.example", phone_display: "+1 (202) 555-0142", phone_normalized: "+12025550142" },
    ...overrides };
}

/** Document ids currently listed by the on-disk full-text index. */
async function rebuiltIndexDocuments(repository: FileSystemRepository): Promise<string[]> {
  const raw = await readFile(join(repository.root, "indexes", "full-text-v1.json"), "utf8").catch(() => null);
  if (raw === null) return [];
  return Object.keys((JSON.parse(raw) as { documents: Record<string, unknown> }).documents);
}

async function storeCapture(repository: FileSystemRepository, value: CaptureRecord): Promise<MarkdownRecord<CaptureRecord>> {
  const path = await repository.writeRecord({ frontmatter: value, body: `# Capture\n\n## User Notes\n\nMet at an event.\n` }, { filenameHint: value.id });
  return await repository.readPath(path) as MarkdownRecord<CaptureRecord>;
}

describe("capture processing integration", () => {
  it("creates contact, organization, event, interaction, job, and a rebuildable index", async () => {
    const { repository, config } = await harness();
    const source = await storeCapture(repository, capture());
    const result = await processCapture(repository, config, source.frontmatter.id);
    expect(result.state).toBe("completed");
    expect((await repository.listRecords("contact"))).toHaveLength(1);
    expect((await repository.listRecords("organization"))).toHaveLength(1);
    expect((await repository.listRecords("event"))).toHaveLength(1);
    expect((await repository.listRecords("interaction"))).toHaveLength(1);
    const contact = (await repository.listRecords("contact"))[0];
    expect(contact?.frontmatter.provenance?.[0]?.source_id).toBe(source.frontmatter.id);

    await rebuildFullTextIndex(repository);
    expect((await searchFullText(repository, "Jane partnerships")).map((result) => result.id)).toContain(contact?.frontmatter.id);
  });

  it("indexes and searches prototype-key words like 'constructor' without crashing", async () => {
    const { repository } = await harness();
    const value = capture({ extracted: { name: "Constructor ToString", title: "__proto__ hasOwnProperty" } });
    const source = await storeCapture(repository, value);
    await rebuildFullTextIndex(repository);
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      const ids = (await searchFullText(repository, word)).map((result) => result.id);
      if (word === "valueOf") expect(ids).toEqual([]);
      else expect(ids).toContain(source.frontmatter.id);
    }
  });

  it("is idempotent when the same unchanged capture is processed twice", async () => {
    const { repository, config } = await harness();
    const source = await storeCapture(repository, capture());
    const first = await processCapture(repository, config, source.frontmatter.id);
    const second = await processCapture(repository, config, source.frontmatter.id);
    expect(second).toMatchObject({ jobId: first.jobId, reused: true, state: "completed" });
    expect((await repository.listRecords("contact"))).toHaveLength(1);
    expect((await repository.listRecords("interaction"))).toHaveLength(1);
  });

  it("resumes a previously planned processing job after a restart", async () => {
    const { repository, config } = await harness();
    const source = await storeCapture(repository, capture());
    const jobId = createId("processing_job");
    const outputs = {
      contact_id: createId("contact"), organization_id: createId("organization"),
      event_id: createId("event"), interaction_id: createId("interaction"),
    };
    const job: ProcessingJobRecord = {
      schema_version: 1, type: "processing_job", id: jobId, capture_id: source.frontmatter.id,
      pipeline: "capture-pipeline-v1",
      idempotency_key: idempotencyKey("capture-pipeline", "1.0.0", source.frontmatter.id, source.contentSha256!),
      source_revision: source.contentSha256!, state: "processing", started_at: "2026-08-03T09:23:00.000Z",
      stages: [{ name: "match", state: "processing" }], outputs,
    };
    await repository.writeRecord({ frontmatter: job, body: "# Interrupted processing job\n" }, { filenameHint: job.id });

    const result = await processCapture(repository, config, source.frontmatter.id);
    expect(result).toMatchObject({ jobId, state: "completed", outputs });
    expect((await repository.readById(outputs.contact_id))?.frontmatter.type).toBe("contact");
    expect((await repository.listRecords("processing_job"))).toHaveLength(1);
  });

  it("matches an exact email without creating a duplicate contact", async () => {
    const { repository, config } = await harness();
    const existingCaptureId = createId("capture");
    const existing: ContactRecord = { schema_version: 1, type: "contact", id: createId("contact"),
      name: { display: "Jane Smith", normalized: "jane smith" }, emails: [{ value: "jane@acme.example", normalized: "jane@acme.example", status: "observed", source_capture_id: existingCaptureId }], phones: [],
      record_status: "active", verification_status: "unverified", source_capture_ids: [existingCaptureId] };
    await repository.writeRecord({ frontmatter: existing, body: "# Jane Smith\n" }, { filenameHint: existing.id });
    const source = await storeCapture(repository, capture({ extracted: { name: "Jane Smith", email: "jane@acme.example" } }));
    const result = await processCapture(repository, config, source.frontmatter.id);
    expect(result.outputs.contact_id).toBe(existing.id);
    expect((await repository.listRecords("contact"))).toHaveLength(1);
  });

  it("reuses a same-name event when the capture has no event date", async () => {
    const { repository, config } = await harness();
    const event: EventRecord = {
      schema_version: 1, type: "event", id: createId("event"), name: "Defense Expo 2026",
      start_at: "2026-08-03T09:00:00.000Z", contact_ids: [], capture_ids: [],
    };
    await repository.writeRecord({ frontmatter: event, body: "# Defense Expo 2026\n" }, { filenameHint: event.id });
    const source = await storeCapture(repository, capture({ event_context: { event_name: "Defense Expo 2026" } }));

    const result = await processCapture(repository, config, source.frontmatter.id);
    expect((await repository.listRecords("event"))).toHaveLength(1);
    const interaction = (await repository.listRecords("interaction"))[0];
    expect(interaction?.frontmatter.type === "interaction" && interaction.frontmatter.event_id).toBe(event.id);
    expect(result.state).toBe("completed");
  });

  it("does not mark a job completed when the source changes before final commit", async () => {
    const { repository, config } = await harness();
    const source = await storeCapture(repository, capture());
    const originalReadById = repository.readById.bind(repository);
    let sourceReads = 0;
    repository.readById = async (id: string) => {
      if (id === source.frontmatter.id && ++sourceReads === 7) {
        const current = await originalReadById(id);
        if (current) {
          await repository.writeRecord(
            { frontmatter: current.frontmatter, body: "# User edited during processing\n" },
            { overwrite: true, expectedContentSha256: current.contentSha256!, filenameHint: source.frontmatter.id },
          );
        }
      }
      return originalReadById(id);
    };

    await expect(processCapture(repository, config, source.frontmatter.id)).rejects.toBeInstanceOf(RevisionConflictError);
    const jobs = await repository.listRecords("processing_job");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.frontmatter.type === "processing_job" && jobs[0].frontmatter.state).toBe("failed");
    expect(await repository.listRecords("contact")).toHaveLength(0);
    expect(await repository.listRecords("organization")).toHaveLength(0);
    expect(await repository.listRecords("event")).toHaveLength(0);
    expect(await repository.listRecords("interaction")).toHaveLength(0);
  });

  it("creates a review item for an ambiguous score instead of merging", async () => {
    const { repository, config } = await harness();
    const oldCapture = createId("capture");
    const candidate: ContactRecord = { schema_version: 1, type: "contact", id: createId("contact"),
      name: { display: "Jane Smith", normalized: "jane smith" }, title: "Director of Partnerships", organization: { name: "Acme Industries" },
      emails: [], phones: [], record_status: "active", verification_status: "unverified", source_capture_ids: [oldCapture] };
    await repository.writeRecord({ frontmatter: candidate, body: "# Jane Smith\n" }, { filenameHint: candidate.id });
    const source = await storeCapture(repository, capture({ extracted: { name: "Jane Smith", title: "Director of Partnerships", company: "Acme Industries" } }));
    const result = await processCapture(repository, config, source.frontmatter.id);
    expect(result.state).toBe("review_required");
    expect((await repository.listRecords("review_item"))).toHaveLength(1);
    expect((await repository.listRecords("contact"))).toHaveLength(1);
  });

  it("fails without modifying the capture when an attachment is missing", async () => {
    const { repository, config } = await harness();
    const source = await storeCapture(repository, capture({ attachments: [{ id: createId("attachment"), role: "original", path: "../attachments/originals/missing.jpg", media_type: "image/jpeg", sha256: "0".repeat(64) }] }));
    await expect(processCapture(repository, config, source.frontmatter.id)).rejects.toThrow("attachment is missing");
    expect((await repository.readById(source.frontmatter.id))?.contentSha256).toBe(source.contentSha256);
  });

  it("routes to review instead of guessing when two contacts share the capture's exact email", async () => {
    const { repository, config } = await harness();
    const shared = "jane@acme.example";
    const oldCapture = createId("capture");
    for (const display of ["Jane Smith", "J. A. Smith"]) {
      const existing: ContactRecord = {
        schema_version: 1, type: "contact", id: createId("contact"),
        name: { display, normalized: display.toLowerCase() },
        emails: [{ value: shared, normalized: shared, status: "observed", source_capture_id: oldCapture }],
        phones: [], record_status: "active", verification_status: "unverified", source_capture_ids: [oldCapture],
      };
      await repository.writeRecord({ frontmatter: existing, body: `# ${display}\n` }, { filenameHint: existing.id });
    }
    const source = await storeCapture(repository, capture({ extracted: { name: "Jane Smith", email: shared } }));

    const result = await processCapture(repository, config, source.frontmatter.id);

    // An exact identifier shared by two records is ambiguous, not a match.
    // Auto-linking here silently attaches the interaction to whichever contact
    // sorts first by id.
    expect(result.state).toBe("review_required");
    expect(await repository.listRecords("review_item")).toHaveLength(1);
    expect(await repository.listRecords("contact")).toHaveLength(2);
    expect(await repository.listRecords("interaction")).toHaveLength(0);
  });

  it("still auto-matches when exactly one contact holds the exact email", async () => {
    const { repository, config } = await harness();
    const shared = "solo@acme.example";
    const oldCapture = createId("capture");
    const existing: ContactRecord = {
      schema_version: 1, type: "contact", id: createId("contact"),
      name: { display: "Solo Person", normalized: "solo person" },
      emails: [{ value: shared, normalized: shared, status: "observed", source_capture_id: oldCapture }],
      phones: [], record_status: "active", verification_status: "unverified", source_capture_ids: [oldCapture],
    };
    await repository.writeRecord({ frontmatter: existing, body: "# Solo Person\n" }, { filenameHint: existing.id });
    const source = await storeCapture(repository, capture({ extracted: { name: "Solo Person", email: shared } }));

    const result = await processCapture(repository, config, source.frontmatter.id);

    expect(result.state).toBe("completed");
    expect(result.outputs.contact_id).toBe(existing.id);
    expect(await repository.listRecords("contact")).toHaveLength(1);
  });

  it("does not leave the search index pointing at records a conflict rollback deleted", async () => {
    const { repository, config } = await harness();
    const source = await storeCapture(repository, capture());
    const originalReadById = repository.readById.bind(repository);
    let sourceReads = 0;
    repository.readById = async (id: string) => {
      if (id === source.frontmatter.id && ++sourceReads === 7) {
        const current = await originalReadById(id);
        if (current) {
          await repository.writeRecord(
            { frontmatter: current.frontmatter, body: "# User edited during processing\n" },
            { overwrite: true, expectedContentSha256: current.contentSha256!, filenameHint: source.frontmatter.id },
          );
        }
      }
      return originalReadById(id);
    };

    await expect(processCapture(repository, config, source.frontmatter.id)).rejects.toBeInstanceOf(RevisionConflictError);

    // The index is built before the final revision check, so a rollback that
    // deletes the derived records must not leave them searchable.
    const index = await rebuiltIndexDocuments(repository);
    for (const id of index) {
      expect(await repository.readById(id)).not.toBeNull();
    }
  });

  it("rejects the loser when two writers commit against the same expected revision", async () => {
    const { repository } = await harness();
    const source = await storeCapture(repository, capture());
    const expected = source.contentSha256!;

    const results = await Promise.allSettled([
      repository.writeRecord({ frontmatter: source.frontmatter, body: "# Writer A\n" },
        { overwrite: true, expectedContentSha256: expected, filenameHint: source.frontmatter.id }),
      repository.writeRecord({ frontmatter: source.frontmatter, body: "# Writer B\n" },
        { overwrite: true, expectedContentSha256: expected, filenameHint: source.frontmatter.id }),
    ]);

    // Both read the same pre-image; only one may commit against it.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("never mutates a parsed job record in place while advancing it", async () => {
    const { repository, config } = await harness();
    const source = await storeCapture(repository, capture());
    // Freezing every parsed processing_job turns an in-place field assignment
    // into a TypeError under ES-module strict mode, which is the defect this
    // guards: `job` used to alias the stored record the caller still holds.
    const originalReadPath = repository.readPath.bind(repository);
    repository.readPath = async (path: string) => {
      const record = await originalReadPath(path);
      if (record.frontmatter.type === "processing_job") Object.freeze(record.frontmatter);
      return record;
    };

    const result = await processCapture(repository, config, source.frontmatter.id);
    expect(result.state).toBe("completed");
  });

  it("rejects a stale optimistic write rather than overwriting a user edit", async () => {
    const { repository } = await harness();
    const source = await storeCapture(repository, capture());
    await repository.writeRecord({ frontmatter: source.frontmatter, body: "# User edit\n" }, { overwrite: true, expectedContentSha256: source.contentSha256!, filenameHint: source.frontmatter.id });
    await expect(repository.writeRecord({ frontmatter: source.frontmatter, body: "# Stale processor edit\n" }, { overwrite: true, expectedContentSha256: source.contentSha256!, filenameHint: source.frontmatter.id })).rejects.toBeInstanceOf(RevisionConflictError);
  });
});
