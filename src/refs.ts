import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AgentBrowserError, errorMessage } from "./errors.js";
import type { SnapshotRef } from "./snapshot.js";

const REFS_SCHEMA_VERSION = 1;

export interface RefSnapshotMetadata {
  targetId: string;
  url: string;
  title?: string;
  documentId: string;
  refs: readonly SnapshotRef[];
}

export interface PersistedRefSnapshot {
  version: typeof REFS_SCHEMA_VERSION;
  targetId: string;
  url: string;
  title?: string;
  documentId: string;
  createdAt: string;
  refs: SnapshotRef[];
}

export interface ExpectedRefPage {
  targetId: string;
  url: string;
  documentId: string;
}

/**
 * Parse the strict public ref syntax. Whitespace, @0, signs and leading zeroes
 * are rejected so malformed model output never aliases a different element.
 */
export function parseRef(ref: string): number {
  if (typeof ref !== "string" || !/^@[1-9]\d*$/u.test(ref)) {
    throw new AgentBrowserError(
      "INVALID_REF",
      `Invalid element ref ${JSON.stringify(ref)}; expected @ followed by a positive integer, for example @1.`,
    );
  }
  const index = Number(ref.slice(1));
  if (!Number.isSafeInteger(index)) {
    throw new AgentBrowserError(
      "INVALID_REF",
      `Element ref ${ref} is larger than JavaScript's safe integer range.`,
    );
  }
  return index;
}

/**
 * Validate untrusted JSON loaded from disk and return it with a concrete type.
 */
export function validatePersistedRefs(value: unknown): PersistedRefSnapshot {
  if (!isRecord(value)) {
    invalidSchema("root must be an object");
  }
  if (value.version !== REFS_SCHEMA_VERSION) {
    invalidSchema(
      `version must be ${REFS_SCHEMA_VERSION}, received ${JSON.stringify(value.version)}`,
    );
  }
  const targetId = requireNonEmptyString(value.targetId, "targetId");
  const url = requireString(value.url, "url");
  const createdAt = requireNonEmptyString(value.createdAt, "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) {
    invalidSchema("createdAt must be an ISO-compatible date string");
  }
  const title =
    value.title === undefined ? undefined : requireString(value.title, "title");
  const documentId = requireNonEmptyString(value.documentId, "documentId");
  if (!Array.isArray(value.refs)) {
    invalidSchema("refs must be an array");
  }

  const refs: SnapshotRef[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.refs.length; index += 1) {
    const entry = value.refs[index];
    if (!isRecord(entry)) {
      invalidSchema(`refs[${index}] must be an object`);
    }
    const ref = requireString(entry.ref, `refs[${index}].ref`);
    parseSchemaRef(ref, `refs[${index}].ref`);
    if (seen.has(ref)) {
      invalidSchema(`refs contains duplicate ref ${ref}`);
    }
    seen.add(ref);

    const backendNodeId = entry.backendNodeId;
    if (
      typeof backendNodeId !== "number" ||
      !Number.isInteger(backendNodeId) ||
      backendNodeId <= 0
    ) {
      invalidSchema(
        `refs[${index}].backendNodeId must be a positive integer`,
      );
    }
    const frameId =
      entry.frameId === undefined
        ? undefined
        : requireNonEmptyString(entry.frameId, `refs[${index}].frameId`);
    const role = requireString(entry.role, `refs[${index}].role`);
    const name = requireString(entry.name, `refs[${index}].name`);
    const entryTargetId = requireNonEmptyString(
      entry.targetId,
      `refs[${index}].targetId`,
    );
    const entryUrl = requireString(entry.url, `refs[${index}].url`);
    const entryDocumentId = requireNonEmptyString(
      entry.documentId,
      `refs[${index}].documentId`,
    );
    if (entryTargetId !== targetId) {
      invalidSchema(
        `refs[${index}].targetId does not match snapshot targetId`,
      );
    }
    if (entryUrl !== url) {
      invalidSchema(`refs[${index}].url does not match snapshot url`);
    }
    if (entryDocumentId !== documentId) {
      invalidSchema(
        `refs[${index}].documentId does not match snapshot documentId`,
      );
    }

    refs.push({
      ref,
      backendNodeId,
      ...(frameId === undefined ? {} : { frameId }),
      role,
      name,
      targetId: entryTargetId,
      url: entryUrl,
      documentId: entryDocumentId,
    });
  }

  return {
    version: REFS_SCHEMA_VERSION,
    targetId,
    url,
    ...(title === undefined ? {} : { title }),
    documentId,
    createdAt,
    refs,
  };
}

export class RefStore {
  readonly refsFile: string;

  constructor(refsFile: string) {
    if (typeof refsFile !== "string" || refsFile.length === 0) {
      throw new TypeError("refsFile must be a non-empty string");
    }
    this.refsFile = refsFile;
  }

  async save(metadata: RefSnapshotMetadata): Promise<PersistedRefSnapshot> {
    const documentIds = new Set(
      metadata.refs.map((entry) => entry.documentId),
    );
    documentIds.add(metadata.documentId);
    if (documentIds.size > 1) {
      throw new AgentBrowserError(
        "INVALID_REFS_FILE",
        "Snapshot refs contain more than one documentId; save each document snapshot separately.",
      );
    }
    const document: unknown = {
      version: REFS_SCHEMA_VERSION,
      targetId: metadata.targetId,
      url: metadata.url,
      ...(metadata.title === undefined ? {} : { title: metadata.title }),
      documentId: metadata.documentId,
      createdAt: new Date().toISOString(),
      refs: metadata.refs,
    };
    const validated = validatePersistedRefs(document);

    const temporaryFile = `${this.refsFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.refsFile), { recursive: true });
      await writeFile(
        temporaryFile,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryFile, this.refsFile);
    } catch (error) {
      try {
        await rm(temporaryFile, { force: true });
      } catch (cleanupError) {
        throw new AgentBrowserError(
          "REFS_WRITE_FAILED",
          `Could not save snapshot refs to ${JSON.stringify(this.refsFile)}, and could not remove temporary file ${JSON.stringify(temporaryFile)}: ${errorMessage(cleanupError)}`,
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      throw new AgentBrowserError(
        "REFS_WRITE_FAILED",
        `Could not save snapshot refs to ${JSON.stringify(this.refsFile)}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    return validated;
  }

  async load(): Promise<PersistedRefSnapshot> {
    let source: string;
    try {
      source = await readFile(this.refsFile, "utf8");
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code === "ENOENT") {
        throw new AgentBrowserError(
          "REFS_NOT_FOUND",
          `No saved snapshot refs exist at ${JSON.stringify(this.refsFile)}; take a new snapshot first.`,
          { cause: error },
        );
      }
      throw new AgentBrowserError(
        "REFS_READ_FAILED",
        `Could not read snapshot refs from ${JSON.stringify(this.refsFile)}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new AgentBrowserError(
        "INVALID_REFS_FILE",
        `Snapshot refs file ${JSON.stringify(this.refsFile)} is not valid JSON: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    try {
      return validatePersistedRefs(parsed);
    } catch (error) {
      if (error instanceof AgentBrowserError) {
        throw new AgentBrowserError(
          error.code,
          `Invalid snapshot refs file ${JSON.stringify(this.refsFile)}: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async resolve(
    ref: string,
    expected: ExpectedRefPage,
  ): Promise<SnapshotRef> {
    parseRef(ref);
    if (
      typeof expected.targetId !== "string" ||
      expected.targetId.length === 0
    ) {
      throw new TypeError("expected.targetId must be a non-empty string");
    }
    if (typeof expected.url !== "string") {
      throw new TypeError("expected.url must be a string");
    }
    if (
      typeof expected.documentId !== "string" ||
      expected.documentId.length === 0
    ) {
      throw new TypeError(
        "expected.documentId must be a non-empty string when provided",
      );
    }

    const snapshot = await this.load();
    if (snapshot.targetId !== expected.targetId) {
      throw new AgentBrowserError(
        "STALE_REF_TARGET",
        `Element ref ${ref} belongs to target ${JSON.stringify(snapshot.targetId)}, but the active target is ${JSON.stringify(expected.targetId)}; take a new snapshot.`,
      );
    }
    if (snapshot.url !== expected.url) {
      throw new AgentBrowserError(
        "STALE_REF_URL",
        `Element ref ${ref} belongs to ${JSON.stringify(snapshot.url)}, but the active page is ${JSON.stringify(expected.url)}; take a new snapshot.`,
      );
    }
    if (snapshot.documentId !== expected.documentId) {
      throw new AgentBrowserError(
        "STALE_REF_DOCUMENT",
        `Element ref ${ref} belongs to document ${JSON.stringify(snapshot.documentId)}, but the active document is ${JSON.stringify(expected.documentId)}; take a new snapshot.`,
      );
    }

    const match = snapshot.refs.find((entry) => entry.ref === ref);
    if (match === undefined) {
      throw new AgentBrowserError(
        "UNKNOWN_REF",
        `Element ref ${ref} is not present in the latest snapshot; take a new snapshot and use one of its refs.`,
      );
    }
    return match;
  }
}

function parseSchemaRef(ref: string, path: string): void {
  if (!/^@[1-9]\d*$/u.test(ref)) {
    invalidSchema(`${path} must match @<positive integer>`);
  }
  if (!Number.isSafeInteger(Number(ref.slice(1)))) {
    invalidSchema(`${path} exceeds JavaScript's safe integer range`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    invalidSchema(`${path} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const result = requireString(value, path);
  if (result.length === 0) {
    invalidSchema(`${path} must not be empty`);
  }
  return result;
}

function invalidSchema(detail: string): never {
  throw new AgentBrowserError(
    "INVALID_REFS_FILE",
    `Snapshot refs schema is invalid: ${detail}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
