# OpenGD77 → Baofeng DM-1701 codeplug conversion

One-way conversion from an OpenGD77 CPS JSON codeplug export to a codeplug
you can flash onto a stock-firmware Baofeng DM-1701.

This project doesn't implement any codeplug parsing or DFU/USB protocol
itself — it's a thin translation layer that generates a config file for
[dmrconfig](https://github.com/OpenRTX/dmrconfig), which does the real
work. See "Acknowledgements" below.

> **Disclaimer**: this is a hobbyist tool, not an officially supported
> product of Baofeng, TYT, Retevis, or the OpenGD77 project. Verified as
> far as described in this README (see "How to test") — a generated `.rdt`
> has been confirmed to open cleanly in the real stock Baofeng CPS — but
> **not** by actually flashing it to physical DM-1701 hardware from this
> environment. Always keep a backup of your radio's working codeplug, and
> as with any codeplug change, double-check your frequencies, power
> levels, and duty cycle against your license conditions before
> transmitting.

## Why this works the way it does

The DM-1701's stock firmware and OpenGD77 firmware use completely different,
unrelated binary codeplug formats. There is no direct converter between the
two. Instead, this project targets an intermediate, already-solved path:

```
sample-codeplug.json  --[this converter]-->  dmrconfig .conf  --[dmrconfig]--> radio
(OpenGD77 CPS export)                     (plain text)                     (DM-1701, via USB/DFU)
```

[dmrconfig](https://github.com/OpenRTX/dmrconfig) is an existing, open
source, cross-platform (incl. native Windows build) tool that already knows
how to write a codeplug to the DM-1701. It identifies the DM-1701 by its
`Retevis RT84` device profile — same hardware family, same `uv380.c` driver
as the TYT MD-UV380 (see `uv380.c`, comment: *"Baofeng DM-1701, Retevis
RT84"*). dmrconfig does **not** read JSON; it reads its own flat text format.
This project's job is only that one translation step: JSON → dmrconfig text.

This repo does not touch hardware, USB, or serial ports at all — that part
is entirely dmrconfig's job, and it auto-detects the connected radio itself
(no port-selection flags in its CLI).

dmrconfig already understands the Baofeng `.rdt` file layout natively (it
calls it an "RTD file" internally) — it just doesn't reconstruct that
container when *writing* output; it only ever writes its own plain flat
image format. `converter/build-rdt.js` handles that gap: it uses a real
`.rdt` as a template and splices dmrconfig's output back into that
template's container. This means the whole pipeline can be built and
verified end-to-end on a Windows dev machine with **no radio attached** —
see "How to test" below.

## What's here

- `openGD77/sample-codeplug.json` — sample OpenGD77 CPS export (input)
- `Baofeng/sample-template.rdt` — sample stock-CPS DM-1701 codeplug. Used as the
  **template** `build-rdt.js` builds onto (see below) — never modified in
  place.
- `converter/convert.js` — the JSON → dmrconfig `.conf` converter (Node.js,
  no dependencies)
- `converter/build-rdt.js` — end-to-end pipeline: JSON + a template `.rdt`
  → a new `.rdt` you can open in the stock CPS or flash with dmrconfig.
  Wraps `convert.js` + `dmrconfig -c` + the `.rdt` container reconstruction
  described below.
- `converter/dmrconfig/` — a local clone + Windows build of
  [dmrconfig](https://github.com/OpenRTX/dmrconfig) (see below). Not
  committed to source control (`.gitignore` excludes build output) — it's
  a build artifact, re-buildable from the setup steps here.

## Requirements

- **Node.js** (any reasonably recent version — the script uses only the
  standard library, nothing to install)
- **dmrconfig**, built separately, to turn the `.conf` this tool produces
  into something you can flash. Source: <https://github.com/OpenRTX/dmrconfig>.

  On Windows, this needs **MSYS2** (a MinGW-w64 GCC toolchain) — dmrconfig
  talks to the radio via native Windows HID/DFU APIs on this platform, so
  no libusb is needed. Setup used for this repo:

  ```
  winget install --id MSYS2.MSYS2
  # In the MSYS2 shell (C:\msys64\usr\bin\bash.exe):
  pacman -Sy
  pacman -S --needed mingw-w64-x86_64-gcc make

  git clone --depth 1 https://github.com/OpenRTX/dmrconfig.git converter/dmrconfig
  ```

  **Two known issues in dmrconfig's `Makefile-mingw` as of this writing**,
  both already fixed in `converter/dmrconfig/Makefile-mingw` in this repo
  (so if you re-clone fresh, re-apply these): the upstream file still lists
  `d868uv.o`/`d868uv.c` in `OBJS`, but that source file was renamed to
  `anytone_ht.c` and `dm1801.o` was never added — the build fails with
  *"No rule to make target 'd868uv.c'"* until `OBJS` is updated to reference
  `anytone_ht.o dm1801.o` instead.

  Then, from an **MSYS2 MinGW64** shell (`MSYSTEM=MINGW64`, `/mingw64/bin`
  on `PATH`) in `converter/dmrconfig/`:

  ```
  make -f Makefile-mingw
  ```

  This produces `dmrconfig.exe`. `git` isn't required for the build itself
  (it's only used for a cosmetic version string) — if it's missing you'll
  see harmless `make: git: No such file or directory` warnings and the
  binary reports its version as `.`.

- A USB programming cable for the DM-1701, and the radio in bootloader/DFU
  mode (same procedure as using the stock CPS) — only needed for the final
  `dmrconfig -w` step, not for anything else in this repo.

## How to use it

The end-to-end script is `build-rdt.js`. It needs a **template `.rdt`** —
either a factory-default codeplug (like the sample in this repo) or,
better, a fresh backup of your own radio's current codeplug — and produces
a new `.rdt` with your OpenGD77 channels/zones/contacts baked in. A real
backup is preferable because `build-rdt.js` only ever touches the
channel/zone/contact/scanlist/grouplist/general-settings tables this
converter knows about; everything else in the template (button
assignments, menu behaviour, any other stock-firmware setting) passes
through unchanged, and you'd rather that be *your* radio's current setup
than generic factory defaults:

```
node converter/build-rdt.js <opengd77.json> <template.rdt> <output.rdt>
```

Example, using the sample files in this repo:

```
node converter/build-rdt.js openGD77/sample-codeplug.json Baofeng/sample-template.rdt Baofeng/sample-converted.rdt
```

This prints the JSON→conf conversion summary and **warnings** (anything
dropped, guessed, or approximated — read these, they're not noise), then
runs dmrconfig against a temporary copy of the template and writes the
final `.rdt`. It never modifies the template file itself.

Under the hood this is three steps, which you can also run by hand (useful
for debugging, or if you want to inspect the intermediate `.conf`):

```
node converter/convert.js openGD77/sample-codeplug.json dm1701.conf
```

produces the plain-text dmrconfig config (`converter/convert.js` alone,
no dmrconfig or template needed — see that file's own comments for the
field mappings). Then:

```
dmrconfig -c template.img dm1701.conf     # bakes onto template.img -> device.img
```

applies it to a copy of the template (`dmrconfig`'s own flat image format
only, not a `.rdt` — see the container note below), and finally the
`.rdt` container (DfuSe header + inter-segment bytes) is spliced back
around the result — this last part is exactly what `build-rdt.js`
automates, because getting it wrong produces a file that *looks* the right
size but is corrupt (see "A subtlety" below).

`dmrconfig -c` (and therefore `build-rdt.js`) will reject anything it
doesn't like (bad CTCSS tone, bad frequency, unresolved reference, etc.)
with a specific error pointing at the offending row — treat that as
validation, not just conversion.

Do **not** use `dmrconfig -z file.conf` to validate — see the known-bug
note below, it doesn't work for this radio regardless of whether the
`.conf` is correct.

## To actually flash a real radio

`build-rdt.js`'s output is a `.rdt` file. From here you have two options:

- **Open it in the stock Baofeng/TYT CPS** and use its own DFU-flashing
  function — this is the path you'd use to keep using the vendor tool and
  its DFU workflow you're already familiar with. A generated `.rdt` has
  been confirmed to open cleanly in the real stock CPS with no apparent
  issues; the actual flash-to-radio step hasn't been separately confirmed.
- **Or flash directly with dmrconfig**, bypassing the stock CPS entirely,
  using dmrconfig's own flat image format (not the `.rdt`):
  ```
  dmrconfig -r backup.img          # back up the radio first
  dmrconfig -c backup.img dm1701.conf   # -> device.img
  dmrconfig -w device.img          # write to the radio (bootloader/DFU mode)
  ```

Either way, **back up the radio's current codeplug first** (`dmrconfig -r`,
or the stock CPS's own read-from-radio function).

## A subtlety: dmrconfig's image format ≠ the stock CPS's `.rdt` format

This tripped up an earlier version of this tool, worth understanding if
you're editing `build-rdt.js` or debugging a bad output file. dmrconfig
has its own flat raw image format (`uv380.c`, `MEMSZ = 0xd0000` =
851,968 bytes) that it both reads *and writes*. It also knows how to
**read** the stock CPS's `.rdt`/"RTD" format (852,533 bytes =
`MEMSZ + 0x225 + 0x10`), which wraps that same flash content in a DfuSe
header, splits it across two segments with a 16-byte gap in between, and
pads the end — see `uv380_read_image` in `uv380.c`. But `uv380_save_image`
**always writes the plain flat format**, even when it read an `.rdt` in.
So naively feeding dmrconfig's raw output back out with a `.rdt` extension
(even after padding it to the "right" size) produces a file that is the
correct size but has its content at the wrong offsets — dmrconfig itself
will misread it (confirmed: it printed `ID: 0`, an empty name, and almost
no channels from a file that size-checked as valid). `build-rdt.js` avoids
this by splicing dmrconfig's flat output back into the *original*
template's header/segment-gap bytes, verified by reading the result back
through dmrconfig and confirming all 97 channels, the DMR ID, and the
callsign are intact, and that only the flash-content region differs from
the template byte-for-byte.

## How to test / validate without a radio

This has been verified end-to-end in this repo, with no radio attached,
using the sample `Baofeng/sample-template.rdt` as the template:

```
node converter/build-rdt.js openGD77/sample-codeplug.json Baofeng/sample-template.rdt Baofeng/sample-converted.rdt
converter/dmrconfig/dmrconfig.exe Baofeng/sample-converted.rdt   # read it back and inspect
```

The read-back confirms all 97 channels, 10 zones, 1 scan list, 35
contacts, 6 group lists, the DMR ID, and the callsign from
`sample-codeplug.json` landed correctly, and a byte-diff against the original
template confirms only the flash-content region changed (the DfuSe header,
segment gap, and file size are identical) — this is genuinely tested, not
just plausible-looking.

What this does **not** prove: that the resulting `.rdt` will be accepted
by the real stock Baofeng/TYT CPS application, or that it will flash
successfully to a physical DM-1701 — both need the actual CPS software
and/or hardware to confirm, neither of which is available in this
environment.

The field grammar this converter targets (column order, valid value sets,
capacity limits, and — importantly — that every table data row must start
with at least one leading space, or dmrconfig's line classifier mistakes
it for a header/parameter line and rejects it as "Invalid line") was
verified directly against dmrconfig's current `uv380.c`/`radio.c` source
(`parse_digital_channel`, `parse_analog_channel`, `parse_zones`,
`parse_scanlist`, `parse_contact`, `parse_grouplist`,
`uv380_parse_parameter`, `radio_parse_config`) and confirmed against a real
build, not inferred from example files (which vary in column layout
between dmrconfig versions and would have been actively misleading here).

### Known dmrconfig bug: `-z` can't identify this radio

`dmrconfig -z file.conf` is meant to validate a `.conf` completely
standalone (no image, no hardware) by guessing the radio type from the
`Radio:` line. For the DM-1701/RT84 profile specifically, this is broken
upstream: the guesser matches the substring `"DM-1701"` against the
`Radio:` line, but the *only* value that later passes the actual
compatibility check for this profile is the exact string `"Retevis RT84"`
— which doesn't contain `"DM-1701"`. No value can satisfy both checks, so
`-z` always fails with `Couldn't idenfity radio type from config file` for
this radio, regardless of whether the `.conf` content is valid. Confirmed
by reading `radio_tab[]` and `radio_is_compatible()` in `radio.c`.

This doesn't block real usage: `dmrconfig -c file.conf` (writing straight
to a connected radio) and `dmrconfig -c existing.img file.conf` (offline,
against a real or sample image) both identify the device a different way
(live USB handshake, or the image's file size) and work fine — that's the
path documented above.

## What converts cleanly

| OpenGD77 JSON | dmrconfig / DM-1701 |
|---|---|
| Channels (analogue + digital) | Digital / Analog channel tables |
| Contacts | Contact table |
| Talkgroup lists (`tgLists`) | Group list table |
| Zones | Zone table |
| Scan lists | Scan list table |
| Radio DMR ID / callsign | `ID:` / `Name:` |
| Boot info lines | `Intro Line 1/2:` |

The sample codeplug (97 channels, 35 contacts, 6 group lists, 10 zones, 1
scan list) is well within the DM-1701's capacity (3000 channels / 10000
contacts / 250 zones / 250 group lists / 250 scan lists), so size is not a
concern for typical ham use.

## Limitations (lossy by necessity)

The stock DM-1701 firmware simply doesn't have some things OpenGD77 has, so
these are silently dropped (the converter's warning output will confirm
counts, but there's nothing to map them to):

- Force DMO, No-beep, No-eco
- TS1/TS2 talker alias transmit
- APRS configuration, satellite list, GPS/location fields, "use location"
- Zone skip / all-skip flags
- Theme/display customisation
- DTMF settings
- Per-contact receive-timeslot override (`tsOverride`) — the radio's
  contact table has no timeslot field; timeslot is set per-channel

And some fields are **approximated** rather than dropped — the converter
warns every time it does this, per channel:

- **Power**: OpenGD77's `"Master"` preset → `High`; any other (e.g. a
  reduced-power hotspot preset) → `Low`. The DM-1701 only has
  High/Mid/Low, with no exact equivalent to OpenGD77's per-channel mW
  values.
- **Analogue squelch**: OpenGD77 in this export always reports
  `"Disabled"` (global squelch, not per-channel); the converter defaults
  every analogue channel to squelch level `1`.
- **Admit criteria**: not present in the OpenGD77 schema at all — digital
  channels default to `Color` (only transmit on color-code match), analogue
  channels default to `-` (always). Edit `dm1701.conf` by hand afterwards
  if you want different behaviour on specific channels.

## A data issue this converter surfaces (not a converter bug)

Running the converter against the sample file in this repo produces
warnings that the `Experimental` group list references contact names
(`TG2350 UK Centra`, `TG91 WW`, etc.) that don't exist anywhere in the
`contacts` array — they look like leftovers from before those contacts were
renamed (to the current `FDMR ...` / `BM ...` names). That's a pre-existing
inconsistency in the OpenGD77 codeplug itself, not something introduced by
this tool — worth cleaning up in the OpenGD77 CPS regardless of whether you
convert it.

## Acknowledgements

This project stands entirely on the reverse-engineering and tooling work of
others. It doesn't parse the DM-1701's codeplug format or speak DFU/USB
itself — it generates input for an existing tool, and that tool does the
real work.

- **[dmrconfig](https://github.com/OpenRTX/dmrconfig)** — the tool that
  actually understands the TYT MD-UV380 / Baofeng DM-1701 / Retevis RT84
  codeplug format and talks to the radio. Originally written by
  **Serge Vakulenko, KK6ABQ**; this project uses the actively maintained
  [OpenRTX](https://github.com/OpenRTX) fork. Licensed under the
  **BSD 3-Clause License** — see its own `LICENSE` file once cloned
  (`converter/dmrconfig/`, not vendored into this repo — see
  [Requirements](#requirements)). This repo's `converter/build-rdt.js`
  also documents (and works around) two dmrconfig quirks found while
  building this: a stale `Makefile-mingw` `OBJS` list, and the `-z`
  validator's inability to identify the DM-1701/RT84 profile — see the
  relevant sections above. Neither is a criticism of dmrconfig, which
  otherwise did exactly what its own source promises; both are the kind of
  small gaps you'd expect in a community-maintained multi-radio tool, and
  are noted here in case they help another user or a future upstream fix.

- **[OpenGD77](https://opengd77.com)** — the open source firmware this
  project reads codeplugs from. Originally conceived by **Kai, DG4KLU**,
  with major ongoing development by **Roger, VK3KYY** (project lead),
  **Daniel, F1RMB**, **Alex, DL4LEX**, **Colin, G4EML**, and many other
  contributors. Licensed under **GPLv2**. This project only consumes its
  CPS's JSON export format; no OpenGD77 source or binaries are included
  here.

- **The DM-1701's stock codeplug format itself** was not reverse-engineered
  by this project — that work is entirely dmrconfig's (and, before it,
  the broader TYT/MD-UV380 reverse-engineering community's, including
  projects like [md380-tools](https://github.com/travisgoodspeed/md380tools)).
  This project only reads dmrconfig's own source to generate correctly
  formatted input for it.

## License

This repository's own code (`converter/convert.js`, `converter/build-rdt.js`)
is licensed under the [MIT License](LICENSE).

That does **not** cover the third-party projects above — dmrconfig
(BSD-3-Clause) and OpenGD77 (GPLv2) each carry their own license, unaffected
by this repo's. Neither is redistributed here: dmrconfig is cloned and
built locally as a documented setup step (see
[Requirements](#requirements); excluded from this repo via `.gitignore`),
and OpenGD77 is used only as the source of the JSON export format this
tool reads, not as included code.

The sample files (`openGD77/sample-codeplug.json`, `Baofeng/sample-template.rdt`)
are a real codeplug (DMR ID replaced with a placeholder before publishing;
callsign left as-is) provided for testing/demonstration, and aren't covered
by the MIT license above — treat them as reference fixtures, not reusable
code.
