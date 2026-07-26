export interface AxValueLike {
  value?: unknown;
}

export interface AxPropertyLike {
  name: string;
  value?: AxValueLike;
}

export interface AxIgnoredReasonLike {
  name?: string;
}

/**
 * The subset of a CDP Accessibility.AXNode consumed by the formatter.
 *
 * The intentionally loose value types keep this module independent from a
 * particular CDP client or generated protocol package.
 */
export interface AxNodeLike {
  nodeId: string;
  ignored?: boolean;
  ignoredReasons?: AxIgnoredReasonLike[];
  role?: AxValueLike;
  name?: AxValueLike;
  description?: AxValueLike;
  value?: AxValueLike;
  properties?: AxPropertyLike[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface SnapshotRef {
  ref: string;
  backendNodeId: number;
  frameId?: string;
  role: string;
  name: string;
  targetId: string;
  url: string;
  documentId: string;
}

export interface BuildSnapshotOptions {
  targetId: string;
  url: string;
  title: string;
  maxChars?: number | undefined;
  frameId?: string;
  hasChildFrames?: boolean | undefined;
  documentId?: string;
  maxFieldChars?: number;
}

export interface SnapshotResult {
  content: string;
  refs: SnapshotRef[];
  truncated: boolean;
}

interface RenderContext {
  depth: number;
  inheritedFrameId?: string;
  suppressStaticText: boolean;
}

interface RenderState {
  nodes: Map<string, AxNodeLike>;
  children: Map<string, string[]>;
  refs: SnapshotRef[];
  lines: RenderedLine[];
  targetId: string;
  url: string;
  documentId: string;
  mainFrameId?: string;
  omittedCrossFrameRef: boolean;
  fieldLimit: number;
  fieldTruncated: boolean;
  visited: Set<string>;
  staticTextCache: Map<string, string>;
}

interface ClippedText {
  text: string;
  truncated: boolean;
}

interface RenderedLine {
  text: string;
  ref?: string;
}

const MIN_MAX_CHARS = 128;
const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_MAX_FIELD_CHARS = 240;

const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const STRUCTURAL_ROLES = new Set([
  "alert",
  "alertdialog",
  "article",
  "banner",
  "blockquote",
  "caption",
  "cell",
  "code",
  "columnheader",
  "complementary",
  "contentinfo",
  "definition",
  "dialog",
  "document",
  "feed",
  "figure",
  "form",
  "grid",
  "group",
  "heading",
  "list",
  "listitem",
  "log",
  "main",
  "menu",
  "navigation",
  "paragraph",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "search",
  "status",
  "table",
  "tablist",
  "term",
  "toolbar",
  "tree",
  "rootwebarea",
  "webarea",
]);

const DESCRIPTIVE_ROLES = new Set([
  "image",
  "img",
  "math",
  "meter",
  "progressbar",
  "separator",
  "timer",
]);

const HIDDEN_IGNORED_REASONS = new Set([
  "ariaHiddenElement",
  "ariaHiddenSubtree",
  "hiddenRoot",
  "inertElement",
  "notRendered",
  "notVisible",
]);

const STATE_PROPERTIES = [
  "checked",
  "pressed",
  "selected",
  "expanded",
  "disabled",
  "readonly",
  "required",
  "invalid",
  "focused",
  "multiline",
  "multiselectable",
  "haspopup",
  "orientation",
  "level",
  "valuemin",
  "valuemax",
  "valuetext",
  "autocomplete",
] as const;

const STATE_PROPERTY_ALIASES = new Map([
  ["hasPopup", "haspopup"],
  ["valueMin", "valuemin"],
  ["valueMax", "valuemax"],
  ["valueText", "valuetext"],
]);

/**
 * Convert a CDP accessibility tree into compact, deterministic agent text.
 *
 * Refs are allocated in rendered tree order. A node receives a ref only when
 * it is actionable or focusable and has a backendDOMNodeId that CDP can later
 * resolve. Refs omitted by whole-snapshot truncation are not returned.
 */
export function buildSnapshot(
  inputNodes: readonly AxNodeLike[],
  options: BuildSnapshotOptions,
): SnapshotResult {
  validateOptions(options);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const dynamicFieldLimit = Math.max(24, Math.floor(maxChars / 4));
  const configuredFieldLimit =
    options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;
  if (
    !Number.isInteger(configuredFieldLimit) ||
    configuredFieldLimit < 16
  ) {
    throw new TypeError("maxFieldChars must be an integer of at least 16");
  }
  const fieldLimit = Math.min(configuredFieldLimit, dynamicFieldLimit);

  const { nodes, children, roots } = indexTree(inputNodes);
  const rootBackendNodeId = roots
    .map((rootId) => nodes.get(rootId)?.backendDOMNodeId)
    .find(isPositiveInteger);
  const documentId =
    options.documentId ??
    (rootBackendNodeId === undefined
      ? undefined
      : `backend-node:${rootBackendNodeId}`);
  if (documentId === undefined) {
    throw new TypeError(
      "documentId is required when the AX root has no backendDOMNodeId",
    );
  }
  const state: RenderState = {
    nodes,
    children,
    refs: [],
    lines: [],
    targetId: options.targetId,
    url: options.url,
    documentId,
    ...(options.frameId === undefined
      ? {}
      : { mainFrameId: options.frameId }),
    omittedCrossFrameRef: false,
    fieldLimit,
    fieldTruncated: false,
    visited: new Set(),
    staticTextCache: new Map(),
  };

  const clippedTitle = clipText(options.title, fieldLimit);
  const clippedUrl = clipText(options.url, fieldLimit);
  state.fieldTruncated ||= clippedTitle.truncated || clippedUrl.truncated;
  state.lines.push({
    text: `page title=${quote(clippedTitle.text)} url=${quote(clippedUrl.text)}`,
  });

  for (const rootId of roots) {
    renderNode(rootId, state, {
      depth: 0,
      ...(options.frameId === undefined
        ? {}
        : { inheritedFrameId: options.frameId }),
      suppressStaticText: false,
    });
  }
  if (options.hasChildFrames === true || state.omittedCrossFrameRef) {
    state.lines.unshift({
      text: "note: iframe controls have no refs (unsupported)",
    });
  }

  const fullContent = state.lines.map((line) => line.text).join("\n");
  if (fullContent.length <= maxChars) {
    return {
      content: fullContent,
      refs: state.refs,
      truncated: state.fieldTruncated,
    };
  }

  const marker = `… [snapshot truncated; originalLength=${fullContent.length}; maxChars=${maxChars}]`;
  const keptLines: RenderedLine[] = [];
  let length = 0;
  for (const line of state.lines) {
    const separatorLength = keptLines.length === 0 ? 0 : 1;
    const markerSeparatorLength = keptLines.length === 0 ? 0 : 1;
    if (
      length +
        separatorLength +
        line.text.length +
        markerSeparatorLength +
        marker.length >
      maxChars
    ) {
      break;
    }
    keptLines.push(line);
    length += separatorLength + line.text.length;
  }

  const content =
    keptLines.length === 0
      ? marker
      : `${keptLines.map((line) => line.text).join("\n")}\n${marker}`;
  const visibleRefIds = new Set(
    keptLines.flatMap((line) => (line.ref === undefined ? [] : [line.ref])),
  );

  return {
    content,
    refs: state.refs.filter((entry) => visibleRefIds.has(entry.ref)),
    truncated: true,
  };
}

function validateOptions(options: BuildSnapshotOptions): void {
  if (typeof options.targetId !== "string" || options.targetId.length === 0) {
    throw new TypeError("targetId must be a non-empty string");
  }
  if (typeof options.url !== "string") {
    throw new TypeError("url must be a string");
  }
  if (typeof options.title !== "string") {
    throw new TypeError("title must be a string");
  }
  if (
    options.maxChars !== undefined &&
    (!Number.isInteger(options.maxChars) ||
      options.maxChars < MIN_MAX_CHARS)
  ) {
    throw new TypeError(
      `maxChars must be an integer of at least ${MIN_MAX_CHARS}`,
    );
  }
  if (
    options.frameId !== undefined &&
    (typeof options.frameId !== "string" || options.frameId.length === 0)
  ) {
    throw new TypeError("frameId must be a non-empty string when provided");
  }
  if (
    options.hasChildFrames !== undefined &&
    typeof options.hasChildFrames !== "boolean"
  ) {
    throw new TypeError("hasChildFrames must be a boolean when provided");
  }
  if (
    options.documentId !== undefined &&
    (typeof options.documentId !== "string" || options.documentId.length === 0)
  ) {
    throw new TypeError("documentId must be a non-empty string when provided");
  }
}

function indexTree(inputNodes: readonly AxNodeLike[]): {
  nodes: Map<string, AxNodeLike>;
  children: Map<string, string[]>;
  roots: string[];
} {
  const nodes = new Map<string, AxNodeLike>();
  const inputOrder: string[] = [];

  for (const node of inputNodes) {
    if (
      node === null ||
      typeof node !== "object" ||
      typeof node.nodeId !== "string" ||
      node.nodeId.length === 0
    ) {
      throw new TypeError("Every AX node must have a non-empty string nodeId");
    }
    if (nodes.has(node.nodeId)) {
      throw new TypeError(`Duplicate AX nodeId: ${node.nodeId}`);
    }
    nodes.set(node.nodeId, node);
    inputOrder.push(node.nodeId);
  }

  const children = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  for (const node of inputNodes) {
    const childIds: string[] = [];
    for (const childId of node.childIds ?? []) {
      if (!nodes.has(childId) || childIds.includes(childId)) {
        continue;
      }
      childIds.push(childId);
      if (!parentByChild.has(childId)) {
        parentByChild.set(childId, node.nodeId);
      }
    }
    children.set(node.nodeId, childIds);
  }

  for (const node of inputNodes) {
    if (
      node.parentId === undefined ||
      !nodes.has(node.parentId) ||
      parentByChild.has(node.nodeId)
    ) {
      continue;
    }
    const siblings = children.get(node.parentId);
    if (siblings !== undefined && !siblings.includes(node.nodeId)) {
      siblings.push(node.nodeId);
      parentByChild.set(node.nodeId, node.parentId);
    }
  }

  const roots = inputOrder.filter((nodeId) => !parentByChild.has(nodeId));
  if (roots.length === 0 && inputOrder[0] !== undefined) {
    roots.push(inputOrder[0]);
  }

  return { nodes, children, roots };
}

function renderNode(
  nodeId: string,
  state: RenderState,
  context: RenderContext,
): void {
  if (state.visited.has(nodeId)) {
    return;
  }
  state.visited.add(nodeId);

  const node = state.nodes.get(nodeId);
  if (node === undefined || hidesSubtree(node)) {
    return;
  }

  const role = normalizedRole(node);
  const name = stringValue(node.name);
  const frameId = node.frameId ?? context.inheritedFrameId;
  const properties = propertyMap(node);
  const focusable = properties.get("focusable") === true;
  const actionable = ACTIONABLE_ROLES.has(role) || focusable;
  const isStaticText = role === "statictext";
  const isInlineText = role === "inlinetextbox";
  const isInteresting =
    isStaticText ||
    actionable ||
    STRUCTURAL_ROLES.has(role) ||
    DESCRIPTIVE_ROLES.has(role);

  let renderedSelf = false;
  let suppressStaticText = context.suppressStaticText;
  if (
    !node.ignored &&
    !isInlineText &&
    isInteresting &&
    !(isStaticText && context.suppressStaticText)
  ) {
    const clippedName = clipText(name, state.fieldLimit);
    state.fieldTruncated ||= clippedName.truncated;

    const frameSupportsRefs =
      state.mainFrameId === undefined || frameId === state.mainFrameId;
    if (actionable && !frameSupportsRefs) {
      state.omittedCrossFrameRef = true;
    }
    const ref =
      actionable &&
      frameSupportsRefs &&
      isPositiveInteger(node.backendDOMNodeId)
        ? addRef(
            state,
            node.backendDOMNodeId,
            frameId,
            role,
            clippedName.text,
          )
        : undefined;
    const line = formatNodeLine(
      role,
      clippedName.text,
      node,
      properties,
      ref,
      state,
    );
    if (line !== null) {
      state.lines.push({
        text: `${"  ".repeat(context.depth)}- ${line}`,
        ...(ref === undefined ? {} : { ref }),
      });
      renderedSelf = true;
    }

    if (
      name.length > 0 &&
      normalizedText(name) ===
        normalizedText(descendantStaticText(nodeId, state, new Set()))
    ) {
      suppressStaticText = true;
    }
  }

  const childDepth = renderedSelf ? context.depth + 1 : context.depth;
  for (const childId of state.children.get(nodeId) ?? []) {
    renderNode(childId, state, {
      depth: childDepth,
      ...(frameId === undefined ? {} : { inheritedFrameId: frameId }),
      suppressStaticText,
    });
  }
}

function formatNodeLine(
  role: string,
  name: string,
  node: AxNodeLike,
  properties: Map<string, unknown>,
  ref: string | undefined,
  state: RenderState,
): string | null {
  const outputRole =
    role === "rootwebarea" || role === "webarea" ? "document" : role;
  if (outputRole === "statictext") {
    return name.length === 0 ? null : `text ${quote(name)}`;
  }

  const parts = [outputRole.length === 0 ? "node" : outputRole];
  if (ref !== undefined) {
    parts.push(ref);
  }
  if (name.length > 0) {
    parts.push(quote(name));
  }

  const value = primitiveValue(node.value);
  if (value !== undefined && value !== "") {
    const clippedValue = clipText(String(value), state.fieldLimit);
    state.fieldTruncated ||= clippedValue.truncated;
    parts.push(`value=${quote(clippedValue.text)}`);
  }

  const states: string[] = [];
  for (const stateName of STATE_PROPERTIES) {
    const propertyValue = properties.get(stateName);
    if (propertyValue === undefined || propertyValue === null) {
      continue;
    }
    if (propertyValue === true) {
      states.push(stateName);
    } else if (typeof propertyValue === "string") {
      const clippedState = clipText(propertyValue, state.fieldLimit);
      state.fieldTruncated ||= clippedState.truncated;
      states.push(`${stateName}=${quote(clippedState.text)}`);
    } else {
      states.push(`${stateName}=${String(propertyValue)}`);
    }
  }
  if (states.length > 0) {
    parts.push(`[${states.join(" ")}]`);
  }

  return parts.join(" ");
}

function addRef(
  state: RenderState,
  backendNodeId: number,
  frameId: string | undefined,
  role: string,
  name: string,
): string {
  const ref = `@${state.refs.length + 1}`;
  state.refs.push({
    ref,
    backendNodeId,
    ...(frameId === undefined ? {} : { frameId }),
    role,
    name,
    targetId: state.targetId,
    url: state.url,
    documentId: state.documentId,
  });
  return ref;
}

function propertyMap(node: AxNodeLike): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const property of node.properties ?? []) {
    if (typeof property.name !== "string") {
      continue;
    }
    const name =
      STATE_PROPERTY_ALIASES.get(property.name) ?? property.name.toLowerCase();
    result.set(name, primitiveValue(property.value));
  }
  return result;
}

function hidesSubtree(node: AxNodeLike): boolean {
  const properties = propertyMap(node);
  if (properties.get("hidden") === true || properties.get("inert") === true) {
    return true;
  }
  return (
    node.ignored === true &&
    (node.ignoredReasons ?? []).some(
      (reason) =>
        typeof reason.name === "string" &&
        HIDDEN_IGNORED_REASONS.has(reason.name),
    )
  );
}

function descendantStaticText(
  nodeId: string,
  state: RenderState,
  seen: Set<string>,
): string {
  const cached = state.staticTextCache.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }
  if (seen.has(nodeId)) {
    return "";
  }
  seen.add(nodeId);

  const texts: string[] = [];
  for (const childId of state.children.get(nodeId) ?? []) {
    const child = state.nodes.get(childId);
    if (child === undefined || hidesSubtree(child)) {
      continue;
    }
    const role = normalizedRole(child);
    if (!child.ignored && role === "statictext") {
      const text = stringValue(child.name);
      if (text.length > 0) {
        texts.push(text);
      }
    } else if (!ACTIONABLE_ROLES.has(role)) {
      const nested = descendantStaticText(childId, state, seen);
      if (nested.length > 0) {
        texts.push(nested);
      }
    }
  }
  const result = texts.join(" ");
  state.staticTextCache.set(nodeId, result);
  return result;
}

function normalizedRole(node: AxNodeLike): string {
  return stringValue(node.role).replaceAll("_", "").toLowerCase();
}

function stringValue(value: AxValueLike | undefined): string {
  const primitive = primitiveValue(value);
  return primitive === undefined || primitive === null ? "" : String(primitive);
}

function primitiveValue(value: AxValueLike | undefined): unknown {
  const candidate = value?.value;
  if (
    candidate === null ||
    typeof candidate === "string" ||
    typeof candidate === "number" ||
    typeof candidate === "boolean"
  ) {
    return candidate;
  }
  return undefined;
}

function clipText(value: string, maxChars: number): ClippedText {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  const marker = "…[truncated]";
  const prefixLength = Math.max(0, maxChars - marker.length);
  return {
    text: `${value.slice(0, prefixLength)}${marker}`,
    truncated: true,
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isPositiveInteger(value: number | undefined): value is number {
  return Number.isInteger(value) && (value ?? 0) > 0;
}
