console.log(JSON.stringify({ lease: "held" }));
await sleep(8_000);
console.log(JSON.stringify({ lease: "released" }));
