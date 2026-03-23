const { spawnSync } = require("node:child_process");

const mode = process.argv[2] || "dev";
const port = process.env.WEB_PORT || "3210";
const nextBin = require.resolve("next/dist/bin/next");

const result = spawnSync(process.execPath, [nextBin, mode, "-p", port], {
  stdio: "inherit"
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
