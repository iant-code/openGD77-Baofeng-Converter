#!/usr/bin/env node
"use strict";

/**
 * End-to-end pipeline: OpenGD77 JSON -> dmrconfig .conf -> baked onto a
 * template .rdt's flash content -> repackaged as a real .rdt file.
 *
 * dmrconfig's own raw image format (MEMSZ = 0xd0000 bytes, flat) is NOT the
 * same as the Baofeng/TYT CPS's .rdt ("RTD") file format. uv380_read_image
 * in dmrconfig (uv380.c) documents the difference precisely:
 *
 *   RTD file size = MEMSZ + 0x225 + 0x10
 *   - bytes [0x000000, 0x000225)            : DfuSe header (untouched)
 *   - bytes [0x000225, 0x040225)            : flash segment 1 (0x40000 bytes)
 *   - bytes [0x040225, 0x040235)            : 16-byte segment gap/marker (untouched)
 *   - bytes [0x040235, 0x040235+0x90000)    : flash segment 2 (rest of MEMSZ)
 *
 * dmrconfig reads that layout correctly, but uv380_save_image always writes
 * the plain flat MEMSZ image - it does not reconstruct the RTD container.
 * So to get a file the stock Baofeng CPS will recognise as a .rdt, this
 * script splices dmrconfig's flat output back into the original file's
 * header/gap structure, taken from a real template .rdt (e.g. a factory
 * default codeplug, or a backup of your own radio).
 *
 * This was verified against converter/dmrconfig/dmrconfig.exe (built from
 * https://github.com/OpenRTX/dmrconfig) and Baofeng/sample-template.rdt -
 * see README.md.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { convert } = require("./convert.js");

const HEADER_LEN = 0x225;
const GAP_OFFSET = 0x40225;
const GAP_LEN = 0x10;
const SEGMENT1_LEN = 0x40000;
const MEMSZ = 0xd0000;
const RTD_SIZE = MEMSZ + HEADER_LEN + GAP_LEN;

function usage() {
  return `Usage: node build-rdt.js <opengd77.json> <template.rdt> <output.rdt> [--dmrconfig path/to/dmrconfig.exe] [--radio "Retevis RT84"]

  <opengd77.json>   OpenGD77 CPS JSON codeplug export
  <template.rdt>    An existing DM-1701 .rdt file (factory default or a real
                     backup) to use as the base - its DfuSe header and
                     inter-segment bytes are reused verbatim; only the
                     channel/zone/contact/etc. flash content is replaced.
  <output.rdt>      Where to write the resulting .rdt

  --dmrconfig PATH  Path to dmrconfig(.exe). Defaults to
                     converter/dmrconfig/dmrconfig.exe next to this script.
  --radio NAME      Radio: line to emit (default "Retevis RT84").
`;
}

function parseArgs(argv) {
  const args = { dmrconfig: path.join(__dirname, "dmrconfig", "dmrconfig.exe"), radio: "Retevis RT84" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dmrconfig") args.dmrconfig = argv[++i];
    else if (argv[i] === "--radio") args.radio = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") args.help = true;
    else rest.push(argv[i]);
  }
  [args.json, args.template, args.output] = rest;
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.json || !args.template || !args.output) {
    process.stdout.write(usage());
    process.exit(args.help ? 0 : 1);
  }

  const template = fs.readFileSync(path.resolve(args.template));
  if (template.length !== RTD_SIZE) {
    console.error(
      `Template "${args.template}" is ${template.length} bytes, expected exactly ${RTD_SIZE} (a DM-1701/RT84 .rdt file).`
    );
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(path.resolve(args.json), "utf8"));
  const conf = convert(data, args.radio);

  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dm1701-"));
  const confPath = path.join(tmpDir, "codeplug.conf");
  const baseImgPath = path.join(tmpDir, "base.img");
  const outImgPath = path.join(tmpDir, "device.img");

  fs.writeFileSync(confPath, conf, "utf8");
  fs.writeFileSync(baseImgPath, template);

  try {
    const result = execFileSync(path.resolve(args.dmrconfig), ["-c", baseImgPath, confPath], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    process.stdout.write(result);
  } catch (err) {
    process.stderr.write(err.stdout || "");
    process.stderr.write(err.stderr || "");
    console.error(`\ndmrconfig failed to apply the configuration - see errors above. No output file written.`);
    process.exit(1);
  }

  const flat = fs.readFileSync(outImgPath);
  if (flat.length !== MEMSZ) {
    console.error(`Unexpected dmrconfig output size ${flat.length}, expected ${MEMSZ}. Aborting.`);
    process.exit(1);
  }

  const rebuilt = Buffer.concat([
    template.subarray(0, HEADER_LEN),
    flat.subarray(0, SEGMENT1_LEN),
    template.subarray(GAP_OFFSET, GAP_OFFSET + GAP_LEN),
    flat.subarray(SEGMENT1_LEN),
  ]);

  fs.writeFileSync(path.resolve(args.output), rebuilt);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\nWrote ${args.output} (${rebuilt.length} bytes)`);
}

if (require.main === module) {
  main();
}
