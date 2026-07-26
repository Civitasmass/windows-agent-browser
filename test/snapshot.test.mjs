import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RefStore, parseRef, validatePersistedRefs } from "../dist/refs.js";
import { buildSnapshot } from "../dist/snapshot.js";

const ax = (nodeId, role, name = "", extra = {}) => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
});

const property = (name, value) => ({ name, value: { value } });

test("buildSnapshot keeps semantics, form state, and actionable refs", () => {
  const result = buildSnapshot(
    [
      ax("root", "RootWebArea", "Checkout", {
        backendDOMNodeId: 10,
        frameId: "frame-main",
        childIds: ["heading", "button", "textbox", "checkbox", "hidden"],
      }),
      ax("heading", "heading", "Checkout", {
        childIds: ["heading-text"],
        properties: [property("level", 1)],
      }),
      ax("heading-text", "StaticText", "Checkout"),
      ax("button", "button", "Submit", {
        backendDOMNodeId: 101,
        childIds: ["button-text"],
      }),
      ax("button-text", "StaticText", "Submit"),
      ax("textbox", "textbox", "Email", {
        backendDOMNodeId: 102,
        value: { value: "alice@example.test" },
        properties: [
          property("focusable", true),
          property("focused", true),
          property("required", true),
        ],
      }),
      ax("checkbox", "checkbox", "Remember me", {
        backendDOMNodeId: 103,
        properties: [
          property("focusable", true),
          property("checked", false),
        ],
      }),
      ax("hidden", "StaticText", "Secret", {
        properties: [property("hidden", true)],
      }),
    ],
    {
      targetId: "target-1",
      frameId: "frame-main",
      url: "https://example.test/form",
      title: "Checkout",
      maxChars: 2_000,
    },
  );

  assert.equal(
    result.content,
    [
      'page title="Checkout" url="https://example.test/form"',
      '- document "Checkout"',
      '  - heading "Checkout" [level=1]',
      '  - button @1 "Submit"',
      '  - textbox @2 "Email" value="alice@example.test" [required focused]',
      '  - checkbox @3 "Remember me" [checked=false]',
    ].join("\n"),
  );
  assert.equal(result.truncated, false);
  assert.deepEqual(result.refs, [
    {
      ref: "@1",
      backendNodeId: 101,
      frameId: "frame-main",
      role: "button",
      name: "Submit",
      targetId: "target-1",
      url: "https://example.test/form",
      documentId: "backend-node:10",
    },
    {
      ref: "@2",
      backendNodeId: 102,
      frameId: "frame-main",
      role: "textbox",
      name: "Email",
      targetId: "target-1",
      url: "https://example.test/form",
      documentId: "backend-node:10",
    },
    {
      ref: "@3",
      backendNodeId: 103,
      frameId: "frame-main",
      role: "checkbox",
      name: "Remember me",
      targetId: "target-1",
      url: "https://example.test/form",
      documentId: "backend-node:10",
    },
  ]);
  assert.equal(result.content.match(/Submit/gu)?.length, 1);
  assert.equal(result.content.includes("Secret"), false);
});

test("buildSnapshot flattens ignored containers and refs focusable generic nodes", () => {
  const result = buildSnapshot(
    [
      ax("root", "RootWebArea", "", { childIds: ["ignored"] }),
      ax("ignored", "generic", "", {
        ignored: true,
        childIds: ["paragraph", "focusable"],
      }),
      ax("paragraph", "paragraph", "", { childIds: ["text"] }),
      ax("text", "StaticText", "Visible copy"),
      ax("focusable", "generic", "Custom widget", {
        backendDOMNodeId: 88,
        properties: [property("focusable", true)],
      }),
    ],
    {
      targetId: "target",
      url: "about:blank",
      title: "",
      documentId: "doc-focusable",
      maxChars: 1_000,
    },
  );

  assert.match(result.content, /- paragraph\n    - text "Visible copy"/u);
  assert.match(result.content, /- generic @1 "Custom widget"/u);
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0].backendNodeId, 88);
});

test("buildSnapshot shows child-frame content without actionable refs", () => {
  const nodes = [
    ax("root", "RootWebArea", "", {
      backendDOMNodeId: 1,
      frameId: "main-frame",
      childIds: ["main-button", "iframe-root", "main-link"],
    }),
    ax("main-button", "button", "Main action", {
      backendDOMNodeId: 2,
    }),
    ax("iframe-root", "document", "Embedded checkout", {
      backendDOMNodeId: 3,
      frameId: "child-frame",
      childIds: ["iframe-button", "iframe-copy"],
    }),
    ax("iframe-button", "button", "Pay in frame", {
      backendDOMNodeId: 4,
    }),
    ax("iframe-copy", "StaticText", "Child frame details"),
    ax("main-link", "link", "Main link", {
      backendDOMNodeId: 5,
    }),
  ];
  const result = buildSnapshot(nodes, {
    targetId: "target",
    url: "https://example.test/",
    title: "Frames",
    frameId: "main-frame",
    hasChildFrames: true,
    documentId: "doc-frames",
    maxChars: 2_000,
  });

  assert.match(
    result.content,
    /^note: iframe controls have no refs \(unsupported\)$/mu,
  );
  assert.equal(
    result.content.match(/note: iframe controls have no refs/gu)?.length,
    1,
  );
  assert.match(result.content, /button @1 "Main action"/u);
  assert.match(result.content, /button "Pay in frame"/u);
  assert.doesNotMatch(result.content, /button @\d+ "Pay in frame"/u);
  assert.match(result.content, /text "Child frame details"/u);
  assert.match(result.content, /link @2 "Main link"/u);
  assert.deepEqual(
    result.refs.map(({ ref, backendNodeId, frameId }) => ({
      ref,
      backendNodeId,
      frameId,
    })),
    [
      { ref: "@1", backendNodeId: 2, frameId: "main-frame" },
      { ref: "@2", backendNodeId: 5, frameId: "main-frame" },
    ],
  );

  const truncated = buildSnapshot(nodes, {
    targetId: "target",
    url: "https://example.test/",
    title: "Frames",
    frameId: "main-frame",
    hasChildFrames: true,
    documentId: "doc-frames",
    maxChars: 128,
  });
  assert.equal(truncated.truncated, true);
  assert.match(truncated.content, /^note: iframe controls have no refs/u);
  assert.match(truncated.content, /snapshot truncated/u);
});

test("buildSnapshot warns when the frame tree has children absent from AX", () => {
  const result = buildSnapshot(
    [
      ax("root", "RootWebArea", "", {
        backendDOMNodeId: 1,
        frameId: "main-frame",
        childIds: ["button"],
      }),
      ax("button", "button", "Main action", {
        backendDOMNodeId: 2,
      }),
    ],
    {
      targetId: "target",
      url: "https://example.test/",
      title: "Missing OOPIF tree",
      frameId: "main-frame",
      hasChildFrames: true,
      documentId: "doc-oopif-absent",
    },
  );

  assert.match(
    result.content,
    /^note: iframe controls have no refs \(unsupported\)$/mu,
  );
  assert.match(result.content, /button @1 "Main action"/u);
  assert.equal(result.refs.length, 1);
});

test("buildSnapshot does not create an unusable ref without backendDOMNodeId", () => {
  const result = buildSnapshot(
    [ax("root", "RootWebArea", "", { childIds: ["button"] }), ax("button", "button", "Save")],
    {
      targetId: "target",
      url: "https://example.test/",
      title: "Example",
      documentId: "doc-no-backend-node",
    },
  );

  assert.match(result.content, /- button "Save"/u);
  assert.deepEqual(result.refs, []);
});

test("buildSnapshot truncates on line boundaries and only returns visible refs", () => {
  const children = [];
  const nodes = [ax("root", "RootWebArea", "", { childIds: children })];
  children.push("literal-ref-text");
  nodes.push(ax("literal-ref-text", "StaticText", "Literal @20 is not a ref"));
  for (let index = 0; index < 20; index += 1) {
    const nodeId = `button-${index}`;
    children.push(nodeId);
    nodes.push(
      ax(nodeId, "button", `A deliberately long button label ${index}`, {
        backendDOMNodeId: index + 1,
      }),
    );
  }

  const result = buildSnapshot(nodes, {
    targetId: "target",
    url: "https://example.test/long",
    title: "Long page",
    documentId: "doc-long",
    maxChars: 240,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 240);
  assert.match(result.content, /snapshot truncated/u);
  assert.ok(result.refs.length > 0);
  assert.ok(result.refs.length < 20);
  assert.equal(result.refs.some((entry) => entry.ref === "@20"), false);
  assert.deepEqual(
    result.refs.map((entry) => entry.ref),
    result.refs.map((_, index) => `@${index + 1}`),
  );
  for (const entry of result.refs) {
    assert.match(result.content, new RegExp(`(?:^|\\s)${entry.ref}(?:\\s|$)`, "u"));
  }
});

test("buildSnapshot marks field-level truncation honestly", () => {
  const result = buildSnapshot(
    [
      ax("root", "RootWebArea", "", { childIds: ["text"] }),
      ax("text", "StaticText", "x".repeat(200)),
    ],
    {
      targetId: "target",
      url: "about:blank",
      title: "",
      documentId: "doc-field-truncation",
      maxChars: 1_000,
      maxFieldChars: 40,
    },
  );

  assert.equal(result.truncated, true);
  assert.match(result.content, /…\[truncated\]/u);
});

test("buildSnapshot requires a document identity when it cannot derive one", () => {
  assert.throws(
    () =>
      buildSnapshot([ax("root", "RootWebArea")], {
        targetId: "target",
        url: "about:blank",
        title: "",
      }),
    /documentId is required/u,
  );
});

test("parseRef accepts only canonical positive safe integer refs", () => {
  assert.equal(parseRef("@1"), 1);
  assert.equal(parseRef("@900"), 900);
  for (const invalid of ["1", "@0", "@01", "@-1", " @1", "@1 ", "@x"]) {
    assert.throws(
      () => parseRef(invalid),
      (error) => error.code === "INVALID_REF" && /expected @/u.test(error.message),
    );
  }
  assert.throws(
    () => parseRef("@999999999999999999999"),
    (error) => error.code === "INVALID_REF" && /safe integer/u.test(error.message),
  );
});

test("RefStore persists, validates, and resolves refs for the same page", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-refs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const refsFile = join(directory, "state", "refs.json");
  const store = new RefStore(refsFile);
  const ref = {
    ref: "@1",
    backendNodeId: 42,
    frameId: "frame",
    role: "button",
    name: "Continue",
    targetId: "target-a",
    url: "https://example.test/checkout",
    documentId: "loader-1:root-42",
  };

  const saved = await store.save({
    targetId: "target-a",
    url: "https://example.test/checkout",
    title: "Checkout",
    documentId: "loader-1:root-42",
    refs: [ref],
  });
  assert.equal(saved.version, 1);
  assert.equal(saved.refs.length, 1);
  assert.deepEqual(
    await store.resolve("@1", {
      targetId: "target-a",
      url: "https://example.test/checkout",
      documentId: "loader-1:root-42",
    }),
    ref,
  );

  await assert.rejects(
    store.resolve("@2", {
      targetId: "target-a",
      url: "https://example.test/checkout",
      documentId: "loader-1:root-42",
    }),
    (error) => error.code === "UNKNOWN_REF" && /latest snapshot/u.test(error.message),
  );

  await assert.rejects(
    store.resolve("@1", {
      targetId: "target-a",
      url: "https://example.test/checkout",
    }),
    (error) =>
      error instanceof TypeError &&
      /expected\.documentId must be a non-empty string/u.test(error.message),
  );
  await assert.rejects(
    store.resolve("@1", {
      targetId: "target-a",
      url: "https://example.test/checkout",
      documentId: "loader-2:root-99",
    }),
    (error) =>
      error.code === "STALE_REF_DOCUMENT" &&
      /active document/u.test(error.message),
  );
});

test("RefStore rejects target and URL changes as stale refs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-stale-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RefStore(join(directory, "refs.json"));
  await store.save({
    targetId: "target-a",
    url: "https://example.test/one",
    documentId: "doc-one",
    refs: [
      {
        ref: "@1",
        backendNodeId: 1,
        role: "link",
        name: "Next",
        targetId: "target-a",
        url: "https://example.test/one",
        documentId: "doc-one",
      },
    ],
  });

  await assert.rejects(
    store.resolve("@1", {
      targetId: "target-b",
      url: "https://example.test/one",
      documentId: "doc-one",
    }),
    (error) => error.code === "STALE_REF_TARGET" && /new snapshot/u.test(error.message),
  );
  await assert.rejects(
    store.resolve("@1", {
      targetId: "target-a",
      url: "https://example.test/two",
      documentId: "doc-one",
    }),
    (error) => error.code === "STALE_REF_URL" && /new snapshot/u.test(error.message),
  );
});

test("validatePersistedRefs rejects mismatched metadata and malformed schema", () => {
  const base = {
    version: 1,
    targetId: "target",
    url: "https://example.test/",
    documentId: "doc-base",
    createdAt: new Date().toISOString(),
    refs: [
      {
        ref: "@1",
        backendNodeId: 5,
        role: "button",
        name: "Save",
        targetId: "other-target",
        url: "https://example.test/",
        documentId: "doc-base",
      },
    ],
  };

  assert.throws(
    () => validatePersistedRefs(base),
    (error) =>
      error.code === "INVALID_REFS_FILE" &&
      /does not match snapshot targetId/u.test(error.message),
  );
  assert.throws(
    () => validatePersistedRefs({ ...base, version: 99, refs: [] }),
    (error) => error.code === "INVALID_REFS_FILE" && /version must be 1/u.test(error.message),
  );
  assert.throws(
    () => validatePersistedRefs({ ...base, documentId: undefined, refs: [] }),
    (error) =>
      error.code === "INVALID_REFS_FILE" &&
      /documentId must be a string/u.test(error.message),
  );
});

test("RefStore reports missing and corrupt JSON files clearly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-browser-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const refsFile = join(directory, "refs.json");
  const store = new RefStore(refsFile);

  await assert.rejects(
    store.load(),
    (error) => error.code === "REFS_NOT_FOUND" && /new snapshot/u.test(error.message),
  );

  await writeFile(refsFile, "{bad json", "utf8");
  await assert.rejects(
    store.load(),
    (error) => error.code === "INVALID_REFS_FILE" && /not valid JSON/u.test(error.message),
  );
});
