const version = await cdp("Browser.getVersion", {}, { browser: true });
console.log(JSON.stringify({ closing: version.product }));
await cdp("Browser.close", {}, { browser: true });
