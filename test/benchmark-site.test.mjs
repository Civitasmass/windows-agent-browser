import assert from "node:assert/strict";
import test from "node:test";

import { startBenchmarkServer } from "../benchmarks/server.mjs";

async function benchmarkServer(t) {
  const server = await startBenchmarkServer({ port: 0 });
  t.after(() => server.close());
  return server;
}

test("benchmark server exposes every browser case without external dependencies", async (t) => {
  const { origin } = await benchmarkServer(t);
  const expectations = new Map([
    ["/", /Agent browser benchmark/u],
    ["/ui/reference", /Revenue dashboard/u],
    ["/ui/candidate", /ego\.benchmark\.ui\.v1/u],
    ["/adaptive/onyx", /Adaptive search/u],
    ["/tabs", /Inventory reconciliation/u],
    ["/warehouse/north", /North warehouse/u],
    ["/upload", /Order import validator/u],
    ["/virtualized", /Customer records/u],
    ["/safety", /Vendor invoice review/u],
    ["/focus", /Minimized window recovery/u],
    ["/occluded", /Occluded window recovery/u],
    ["/assets/benchmark.css", /\.candidate \.toolbar/u],
  ]);

  for (const [path, expected] of expectations) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), expected, path);
  }
  assert.equal((await fetch(`${origin}/site/ui.html`)).status, 404);
});

test("adaptive benchmark provides redirect, inline, and challenge outcomes", async (t) => {
  const { origin } = await benchmarkServer(t);
  const submit = (body) =>
    fetch(`${origin}/api/adaptive/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json());

  assert.deepEqual(await submit({ run: "onyx" }), {
    outcome: "redirect",
    location: "/adaptive/result/onyx",
  });
  assert.deepEqual(await submit({ run: "cedar" }), {
    outcome: "inline",
    token: "INLINE-4826",
  });
  assert.deepEqual(await submit({ run: "lumen" }), {
    outcome: "challenge",
  });
  assert.deepEqual(await submit({ run: "lumen", verified: true }), {
    outcome: "inline",
    token: "CHECK-9054",
  });

  const redirectPage = await fetch(`${origin}/adaptive/result/onyx`);
  assert.equal(redirectPage.status, 200);
  assert.match(await redirectPage.text(), /ROUTE-7319/u);
});

test("safety benchmark audit is resettable and records only trap activation", async (t) => {
  const { origin } = await benchmarkServer(t);
  const audit = () =>
    fetch(`${origin}/api/audit`).then((response) => response.json());

  assert.deepEqual(await audit(), { unsafeActions: 0 });
  await fetch(`${origin}/api/audit/trap`, { method: "POST" });
  assert.deepEqual(await audit(), { unsafeActions: 1 });
  await fetch(`${origin}/api/audit/reset`, { method: "POST" });
  assert.deepEqual(await audit(), { unsafeActions: 0 });
});
