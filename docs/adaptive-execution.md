# Adaptive execution boundaries

## The observed problem

A stdin invocation is compiled as one `AsyncFunction`. `console.log()` writes
bytes to the caller, but those bytes do not become new model context until the
process returns and the agent takes another turn. Code appearing later in the
same submitted program therefore cannot be rewritten by Claude or Codex after
an intermediate snapshot.

This is not specific to the CDP transport. A static `browser_batch` has the
same boundary.

## Three different kinds of adaptation

### 1. Deterministic adaptation inside one program

When all possible outcomes are known in advance, JavaScript can inspect URL or
DOM state and branch without a new model decision. Examples include:

- search redirects versus inline results;
- success versus a known validation alert;
- a result panel versus a known local verification step.

`page.waitForAny()` implements this as one polling evaluation for all
conditions. It returns the first `{ name, index, url }` match, after which the
program can use `if` or `switch`. This directly avoids the extra “print state,
read state, issue diagnosis” calls seen in finite outcome races.

It should not be used to guess unknown actions from page prose. Conditions and
safe handling must be known when the program is submitted.

### 2. Model adaptation over a persistent interactive process

An interactive JSONL/REPL transport could keep one CDP connection and context
lease alive while the agent sends another code fragment after reading each
result. That would save process startup, browser discovery, connection, and
session attachment costs.

It would not remove a model/tool round trip: the model still has to receive the
new observation and produce the next fragment. It also needs explicit framing,
per-command timeouts, cancellation, output size limits, and recovery when the
agent or terminal disappears. This is a useful next transport optimization,
but it is not a solution to semantic adaptation within one model call.

### 3. Semantic adaptation within one external tool call

To let one tool call interpret an arbitrary new snapshot and choose the next
action, the browser process would need an embedded model callback or a broker
that can call Claude/Codex again. That adds model credentials, vendor coupling,
token accounting, prompt-injection boundaries, and another inference latency
inside the browser tool.

For a local, vendor-neutral bridge this is the wrong MVP boundary. Keep model
reasoning in the agent and make deterministic browser state cheap to test.

## Implemented improvements

- `Page.bringToFront` before input restores a minimized Windows browser rather
  than only activating its tab target.
- The launcher disables backgrounding of fully occluded Windows renderers, so
  CDP input does not depend on winning the Windows foreground lock.
- `page.waitForAny` collapses known URL/element/text races.
- `page.setInputFiles` covers direct top-level file inputs with validated local
  paths.
- `page.setViewport` makes responsive UI checks deterministic.
- The skill now includes the compact API signatures, so ordinary sessions do
  not need to load the full API reference mechanically.
- The benchmark suite reports cold schema/skill overhead separately from warm
  task execution.

## Highest-value next steps

1. Add an opt-in framed interactive mode and measure saved startup time without
   claiming it removes agent reasoning turns.
2. Add native file-chooser interception and download events; direct file inputs
   do not cover operating-system chooser-only flows.
3. Add structured observation deltas so a second model turn can receive the
   changed region rather than another full snapshot.
4. Add frame-aware locators before claiming iframe workflow parity.
5. Keep site-specific learnings separate from the generic runtime and verify
   every learning against stable URLs and selectors.

Cases 03, 05, and 06 in the benchmark suite separate deterministic branching,
file transport, and genuinely new DOM observation so these improvements can be
measured independently.
