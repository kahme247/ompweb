#!/usr/bin/env node
"use strict";

// `ompweb host`: link this machine to a main omp-web so sessions can run here (lib/hosts/host-cli.ts).
//   ompweb host login --url <url>   reads the host token from stdin
//   ompweb host [--allow-http]      dials the saved server and keeps the link up (http:// is accepted without the flag for loopback)

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./node-version").exitIfUnsupportedNode();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const jiti = require("jiti").createJiti(__filename);
jiti.import("../lib/hosts/host-cli.ts").then(
  ({ runHostCli }) => runHostCli(process.argv.slice(2)).then((code) => process.exit(code)),
  (error) => {
    console.error(`ompweb host: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
