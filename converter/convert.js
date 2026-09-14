#!/usr/bin/env node
"use strict";

/**
 * Converts an OpenGD77 CPS JSON codeplug export into a dmrconfig .conf
 * text file targeting the Baofeng DM-1701 (which dmrconfig drives via its
 * "Retevis RT84" device profile - same hardware/firmware family, same
 * uv380.c driver as the TYT MD-UV380).
 *
 * This does NOT talk to any hardware and does NOT produce a .rdt file.
 * It produces a plain-text dmrconfig(.conf) file. dmrconfig itself (a
 * separate tool, https://github.com/OpenRTX/dmrconfig) turns that into a
 * binary image and/or writes it to the radio over USB.
 *
 * Field grammar below was verified against the current dmrconfig master
 * source (uv380.c: parse_digital_channel, parse_analog_channel,
 * parse_zones, parse_scanlist, parse_contact, parse_grouplist,
 * uv380_parse_parameter, uv380_parse_header) - not guessed from examples.
 */

const fs = require("fs");
const path = require("path");

const RADIO_PROFILES = ["TYT MD-UV380", "TYT MD-UV390", "TYT MD-2017", "TYT MD-9600", "Retevis RT84"];

const CAPACITY = { channels: 3000, contacts: 10000, zones: 250, grouplists: 250, scanlists: 250 };

function parseArgs(argv) {
  const args = { radio: "Retevis RT84", input: null, output: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--radio") {
      args.radio = argv[++i];
    } else if (a === "-h" || a === "--help") {
      args.help = true;
    } else {
      rest.push(a);
    }
  }
  args.input = rest[0];
  args.output = rest[1];
  return args;
}

function usage() {
  return `Usage: node convert.js <opengd77.json> <output.conf> [--radio "Retevis RT84"]

  <opengd77.json>  OpenGD77 CPS JSON codeplug export
  <output.conf>    dmrconfig text config to write

  --radio NAME     Radio: line written to the .conf (default: "Retevis RT84",
                    which is the DM-1701's dmrconfig device profile).
                    Valid values: ${RADIO_PROFILES.join(", ")}
`;
}

// ---- small helpers -------------------------------------------------

const warnings = [];
function warn(msg) {
  warnings.push(msg);
}

// dmrconfig tables are whitespace-delimited; names must not contain spaces
// and are truncated by the radio firmware at a fixed character count.
function sanitizeName(raw, maxLen, context) {
  if (!raw) return "-";
  let name = String(raw).trim().replace(/\s+/g, "_");
  name = name.replace(/[^\x20-\x7e]/g, ""); // non-ASCII is unreliable in this codeplug format
  if (name.length === 0) name = "-";
  if (name.length > maxLen) {
    warn(`${context}: name "${raw}" truncated to ${maxLen} chars ("${name.slice(0, maxLen)}")`);
    name = name.slice(0, maxLen);
  }
  return name;
}

function freqStr(mhz) {
  // Fixed decimal avoids floating-point artifacts (e.g. 433.50000000000006)
  let s = Number(mhz).toFixed(5);
  s = s.replace(/0+$/, "").replace(/\.$/, ".0");
  return s;
}

function isValidFrequency(mhz) {
  const f = Math.trunc(mhz);
  return (f >= 136 && f <= 174) || (f >= 400 && f <= 480);
}

function toneStr(tone, context) {
  if (!tone || tone === "None") return "-";
  const s = String(tone).trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s) && !/^[Dd][0-7]{3}[NnIi]$/.test(s)) {
    warn(`${context}: unrecognised tone "${tone}", passing through as-is - dmrconfig will reject it if invalid`);
  }
  return s;
}

function boolFlag(b) {
  return b ? "+" : "-";
}

// dmrconfig's line classifier treats any line NOT starting with a space as
// a table header or "Param: Value" line - table body rows MUST be indented
// (confirmed against dmrconfig's own generated examples and radio.c's
// parser: `if (*p != ' ') { ... treat as header/parameter ... }`).
function indent(rows) {
  return rows.map((r) => "  " + r);
}

function totSeconds(tot, context) {
  let t = Number(tot) || 0;
  if (t > 555) {
    warn(`${context}: TOT ${t}s exceeds max 555s, clamped`);
    t = 555;
  }
  const rounded = Math.round(t / 15) * 15;
  if (rounded !== t) {
    warn(`${context}: TOT ${t}s is not a multiple of 15s, rounded to ${rounded}s`);
  }
  return rounded;
}

function powerStr(power, context) {
  // Stock DM-1701 firmware only knows High/Mid/Low. OpenGD77's per-channel
  // milliwatt power presets have no exact equivalent, so this is a coarse
  // heuristic: the default "Master" (full power) preset maps to High,
  // anything else (OpenGD77's reduced-power presets) maps to Low.
  if (power === "Master") return "High";
  warn(`${context}: power preset "${power}" has no DM-1701 equivalent, mapped to Low`);
  return "Low";
}

function squelchStr(squelch, context) {
  // OpenGD77 analogue squelch in this export is always "Disabled" (uses the
  // global squelch setting instead of a per-channel level). dmrconfig
  // requires a numeric 0-9 per channel; default to 1 as a conservative,
  // commonly-used default (matches dmrconfig's own factory examples).
  if (squelch === "Disabled") return "1";
  const n = parseInt(squelch, 10);
  if (Number.isFinite(n) && n >= 0 && n <= 9) return String(n);
  warn(`${context}: squelch "${squelch}" not translatable, defaulted to 1`);
  return "1";
}

// ---- lookups ---------------------------------------------------------

function buildChannelNumberMap(channels) {
  const map = new Map();
  const seenNumbers = new Set();
  for (const ch of channels) {
    if (map.has(ch.name)) {
      warn(`Duplicate channel name "${ch.name}" - zone/scanlist references to it are ambiguous, last one wins`);
    }
    map.set(ch.name, ch.number);
    if (seenNumbers.has(ch.number)) {
      warn(`Duplicate channel number ${ch.number}`);
    }
    seenNumbers.add(ch.number);
  }
  return map;
}

function buildIndexMap(items) {
  const map = new Map();
  items.forEach((item, i) => map.set(item.name, i + 1));
  return map;
}

function channelListStr(names, channelNumberByName, context, limit) {
  if (!names || names.length === 0) return "-";
  const nums = [];
  for (const n of names) {
    const num = channelNumberByName.get(n);
    if (num === undefined) {
      warn(`${context}: referenced channel "${n}" not found, skipped`);
      continue;
    }
    nums.push(num);
  }
  if (limit && nums.length > limit) {
    warn(`${context}: ${nums.length} channels exceeds this table's ${limit}-per-row limit, extra entries dropped`);
    nums.length = limit;
  }
  return nums.length ? nums.join(",") : "-";
}

// ---- table builders ----------------------------------------------------

function buildChannelRows(channels, channelNumberByName, contactIndexByName, grouplistIndexByName, scanlistIndexByName) {
  const digital = [];
  const analog = [];

  for (const ch of channels) {
    const context = `Channel ${ch.number} "${ch.name}"`;
    if (!isValidFrequency(ch.rxFreq)) {
      warn(`${context}: rx frequency ${ch.rxFreq} MHz is outside the DM-1701's valid ranges (136-174, 400-480 MHz), channel dropped`);
      continue;
    }
    const name = sanitizeName(ch.name, 16, context);
    const rx = freqStr(ch.rxFreq);
    const tx = freqStr(ch.txFreq);
    const power = powerStr(ch.power, context);
    const scanIdx = ch.scanList && ch.scanList !== "None" ? scanlistIndexByName.get(ch.scanList) : undefined;
    if (ch.scanList && ch.scanList !== "None" && scanIdx === undefined) {
      warn(`${context}: scan list "${ch.scanList}" not found, left unset`);
    }
    const scan = scanIdx !== undefined ? String(scanIdx) : "-";
    const tot = totSeconds(ch.tot, context);
    const rxonly = boolFlag(ch.rxOnly);

    if (ch.type === "Digital") {
      const admit = "Color"; // no OpenGD77 equivalent field; Color is the safe DMR default
      const color = Number.isFinite(ch.colorCode) ? ch.colorCode : 1;
      const slot = ch.timeslot === 2 ? 2 : 1;

      let grp = "-";
      if (ch.tgList && ch.tgList !== "None") {
        const idx = grouplistIndexByName.get(ch.tgList);
        if (idx === undefined) warn(`${context}: group list "${ch.tgList}" not found, left unset`);
        else grp = String(idx);
      }
      let contact = "-";
      if (ch.contact && ch.contact !== "None") {
        const idx = contactIndexByName.get(ch.contact);
        if (idx === undefined) warn(`${context}: contact "${ch.contact}" not found, left unset`);
        else contact = String(idx);
      }

      digital.push(
        [ch.number, name, rx, tx, power, scan, tot, rxonly, admit, color, slot, grp, contact].join(" ")
      );
    } else {
      const admit = "-"; // Always - no OpenGD77 equivalent field
      const squelch = squelchStr(ch.squelch, context);
      const rxTone = toneStr(ch.rxTone, context);
      const txTone = toneStr(ch.txTone, context);
      const width = ch.bandwidth === 12.5 ? "12.5" : "25";

      analog.push(
        [ch.number, name, rx, tx, power, scan, tot, rxonly, admit, squelch, rxTone, txTone, width].join(" ")
      );
    }
  }
  return { digital, analog };
}

function buildZoneRows(zones, channelNumberByName) {
  const rows = [];
  zones.forEach((z, i) => {
    const num = i + 1;
    const context = `Zone ${num} "${z.name}"`;
    const name = sanitizeName(z.name, 16, context);
    const chans = z.channels || [];
    const first16 = chans.slice(0, 16);
    const rest16 = chans.slice(16, 32);
    if (chans.length > 32) {
      warn(`${context}: ${chans.length} channels exceeds the 32-per-zone limit (16 per a/b half), extra entries dropped`);
    }
    rows.push(`${num}a  ${name}  ${channelListStr(first16, channelNumberByName, context, 16)}`);
    if (rest16.length) {
      rows.push(`${num}b  -  ${channelListStr(rest16, channelNumberByName, context, 16)}`);
    }
  });
  return rows;
}

function buildScanlistRows(scanLists, channelNumberByName) {
  const rows = [];
  scanLists.forEach((sl, i) => {
    const num = i + 1;
    const context = `Scanlist ${num} "${sl.name}"`;
    const name = sanitizeName(sl.name, 16, context);

    const mapPriority = (v) => {
      if (!v || v === "None") return "-";
      if (v === "Selected") return "Sel";
      const n = channelNumberByName.get(v);
      if (n !== undefined) return String(n);
      warn(`${context}: priority channel "${v}" not found, defaulted to "-"`);
      return "-";
    };
    const mapTx = (v) => {
      if (!v || v === "Last Active" || v === "Last") return "Last";
      if (v === "Selected") return "Sel";
      const n = channelNumberByName.get(v);
      if (n !== undefined) return String(n);
      warn(`${context}: tx designated channel "${v}" not found, defaulted to "Last"`);
      return "Last";
    };

    const pch1 = mapPriority(sl.priorityCh1);
    const pch2 = mapPriority(sl.priorityCh2);
    const txch = mapTx(sl.txDesignatedCh);
    const chans = channelListStr(sl.channels, channelNumberByName, context);

    rows.push(`${num} ${name} ${pch1} ${pch2} ${txch} ${chans}`);
  });
  return rows;
}

function buildContactRows(contacts) {
  const rows = [];
  contacts.forEach((c, i) => {
    const num = i + 1;
    const context = `Contact ${num} "${c.name}"`;
    const name = sanitizeName(c.name, 16, context);
    let type = c.type;
    if (!["Group", "Private", "All"].includes(type)) {
      warn(`${context}: call type "${c.type}" not recognised, defaulted to Group`);
      type = "Group";
    }
    const id = Number(c.dmrId) || 0;
    if (id < 1 || id > 0xffffff) {
      warn(`${context}: DMR ID ${c.dmrId} out of range, contact dropped`);
      return;
    }
    rows.push(`${num} ${name} ${type} ${id} -`);
  });
  return rows;
}

function buildGrouplistRows(tgLists, contactIndexByName) {
  const rows = [];
  tgLists.forEach((gl, i) => {
    const num = i + 1;
    const context = `Grouplist ${num} "${gl.name}"`;
    const name = sanitizeName(gl.name, 16, context);
    const idxs = [];
    for (const cname of gl.contacts || []) {
      const idx = contactIndexByName.get(cname);
      if (idx === undefined) {
        warn(`${context}: contact "${cname}" not found, skipped`);
        continue;
      }
      idxs.push(idx);
    }
    rows.push(`${num} ${name} ${idxs.length ? idxs.join(",") : "-"}`);
  });
  return rows;
}

// ---- main --------------------------------------------------------------

function convert(data, radio) {
  const channels = data.channels || [];
  const contacts = data.contacts || [];
  const tgLists = data.tgLists || [];
  const zones = data.zones || [];
  const scanLists = data.scanLists || [];
  const general = data.general || {};

  for (const [label, items, cap] of [
    ["channels", channels, CAPACITY.channels],
    ["contacts", contacts, CAPACITY.contacts],
    ["zones", zones, CAPACITY.zones],
    ["group lists", tgLists, CAPACITY.grouplists],
    ["scan lists", scanLists, CAPACITY.scanlists],
  ]) {
    if (items.length > cap) {
      warn(`${items.length} ${label} exceeds the DM-1701's capacity of ${cap}, the extras will be rejected by dmrconfig`);
    }
  }

  const channelNumberByName = buildChannelNumberMap(channels);
  const contactIndexByName = buildIndexMap(contacts);
  const grouplistIndexByName = buildIndexMap(tgLists);
  const scanlistIndexByName = buildIndexMap(scanLists);

  const { digital, analog } = buildChannelRows(
    channels,
    channelNumberByName,
    contactIndexByName,
    grouplistIndexByName,
    scanlistIndexByName
  );
  const zoneRows = buildZoneRows(zones, channelNumberByName);
  const scanRows = buildScanlistRows(scanLists, channelNumberByName);
  const contactRows = buildContactRows(contacts);
  const grouplistRows = buildGrouplistRows(tgLists, contactIndexByName);

  const radioName = sanitizeName(general.callsign || general.radioName || "-", 16, "General");
  const dmrId = Number(general.dmrId) || 1;
  const intro1 = sanitizeName(general.infoLine1 || "-", 10, "Intro Line 1");
  const intro2 = sanitizeName(general.infoLine2 || "-", 10, "Intro Line 2");

  const lines = [];
  lines.push(`#`);
  lines.push(`# Generated by openGD77-BaofengCPS/converter/convert.js`);
  lines.push(`# Source: OpenGD77 CPS JSON export`);
  lines.push(`# One-way conversion, review before flashing - see README.md`);
  lines.push(`#`);
  lines.push(`Radio: ${radio}`);
  lines.push(``);

  lines.push(`# Table of digital channels.`);
  lines.push(`# 1) Channel number: 1-${CAPACITY.channels}`);
  lines.push(`# 2) Name: up to 16 characters, use '_' instead of space`);
  lines.push(`# 3) Receive frequency in MHz`);
  lines.push(`# 4) Transmit frequency in MHz`);
  lines.push(`# 5) Transmit power: High, Mid, Low`);
  lines.push(`# 6) Scan list: - or index in Scanlist table`);
  lines.push(`# 7) Transmit timeout timer in seconds: 0, 15, 30, 45... 555`);
  lines.push(`# 8) Receive only: -, +`);
  lines.push(`# 9) Admit criteria: -, Free, Color`);
  lines.push(`# 10) Color code: 0, 1, 2, 3... 15`);
  lines.push(`# 11) Time slot: 1 or 2`);
  lines.push(`# 12) Receive group list: - or index in Grouplist table`);
  lines.push(`# 13) Contact for transmit: - or index in Contacts table`);
  lines.push(`#`);
  lines.push(`Digital Name             Receive   Transmit Power Scan TOT RO Admit  Color Slot RxGL TxContact`);
  lines.push(...indent(digital));
  lines.push(``);

  lines.push(`# Table of analog channels.`);
  lines.push(`# 1) Channel number: 1-${CAPACITY.channels}`);
  lines.push(`# 2) Name: up to 16 characters, use '_' instead of space`);
  lines.push(`# 3) Receive frequency in MHz`);
  lines.push(`# 4) Transmit frequency in MHz`);
  lines.push(`# 5) Transmit power: High, Mid, Low`);
  lines.push(`# 6) Scan list: - or index`);
  lines.push(`# 7) Transmit timeout timer in seconds: 0, 15, 30, 45... 555`);
  lines.push(`# 8) Receive only: -, +`);
  lines.push(`# 9) Admit criteria: -, Free, Tone`);
  lines.push(`# 10) Squelch level: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9`);
  lines.push(`# 11) Guard tone for receive, or '-' to disable`);
  lines.push(`# 12) Guard tone for transmit, or '-' to disable`);
  lines.push(`# 13) Bandwidth in kHz: 12.5, 20, 25`);
  lines.push(`#`);
  lines.push(`Analog  Name             Receive   Transmit Power Scan TOT RO Admit  Sq RxTone TxTone Width`);
  lines.push(...indent(analog));
  lines.push(``);

  lines.push(`# Table of channel zones.`);
  lines.push(`# 1) Zone number: 1-${CAPACITY.zones}`);
  lines.push(`# 2) Name: up to 16 characters, use '_' instead of space`);
  lines.push(`# 3) List of channels: numbers and ranges (N-M) separated by comma`);
  lines.push(`#`);
  lines.push(`Zone    Name             Channels`);
  lines.push(...indent(zoneRows));
  lines.push(``);

  lines.push(`# Table of scan lists.`);
  lines.push(`# 1) Scan list number: 1-${CAPACITY.scanlists}`);
  lines.push(`# 2) Name: up to 16 characters, use '_' instead of space`);
  lines.push(`# 3) Priority channel 1 (50% of scans): -, Sel or index`);
  lines.push(`# 4) Priority channel 2 (25% of scans): -, Sel or index`);
  lines.push(`# 5) Designated transmit channel: Last, Sel or index`);
  lines.push(`# 6) List of channels: numbers and ranges (N-M) separated by comma`);
  lines.push(`#`);
  lines.push(`Scanlist Name             PCh1 PCh2 TxCh Channels`);
  lines.push(...indent(scanRows));
  lines.push(``);

  lines.push(`# Table of contacts.`);
  lines.push(`# 1) Contact number: 1-${CAPACITY.contacts}`);
  lines.push(`# 2) Name: up to 16 characters, use '_' instead of space`);
  lines.push(`# 3) Call type: Group, Private, All`);
  lines.push(`# 4) Call ID: 1...16777215`);
  lines.push(`# 5) Call receive tone: -, +`);
  lines.push(`#`);
  lines.push(`Contact Name             Type    ID       RxTone`);
  lines.push(...indent(contactRows));
  lines.push(``);

  lines.push(`# Table of group lists.`);
  lines.push(`# 1) Group list number: 1-${CAPACITY.grouplists}`);
  lines.push(`# 2) Name: up to 16 characters, use '_' instead of space`);
  lines.push(`# 3) List of contacts: numbers and ranges (N-M) separated by comma`);
  lines.push(`#`);
  lines.push(`Grouplist Name             Contacts`);
  lines.push(...indent(grouplistRows));
  lines.push(``);

  lines.push(`# Unique DMR ID and name of this radio.`);
  lines.push(`ID: ${dmrId}`);
  lines.push(`Name: ${radioName}`);
  lines.push(``);

  lines.push(`# Text displayed when the radio powers up.`);
  lines.push(`Intro Line 1: ${intro1}`);
  lines.push(`Intro Line 2: ${intro2}`);
  lines.push(``);

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.output) {
    process.stdout.write(usage());
    process.exit(args.help ? 0 : 1);
  }
  if (!RADIO_PROFILES.includes(args.radio)) {
    console.error(`Unknown --radio "${args.radio}". Valid values: ${RADIO_PROFILES.join(", ")}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(args.input), "utf8");
  const data = JSON.parse(raw);

  const conf = convert(data, args.radio);
  fs.writeFileSync(path.resolve(args.output), conf, "utf8");

  console.log(`Wrote ${args.output}`);
  console.log(
    `Channels: ${data.channels.length} (${data.channels.filter((c) => c.type === "Digital").length} digital, ${
      data.channels.filter((c) => c.type !== "Digital").length
    } analog)`
  );
  console.log(`Zones: ${data.zones.length}, Contacts: ${data.contacts.length}, Group lists: ${data.tgLists.length}, Scan lists: ${data.scanLists.length}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  } else {
    console.log(`\nNo warnings.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { convert };
