# media-redactor

Pixelates a fixed rectangular region of an image or video — for hiding a visible username, address,
or other sensitive detail before sharing a screenshot or screen recording. No motion tracking: the
redacted region is one fixed rectangle applied for the whole applicable time range.

## Actions

- **Redact Region...** — pick x/y/width/height (and, for video, an optional `startTime`/`endTime`
  range), get back a redacted copy of the file with that region permanently pixelated.
- **Detect Region (AI)...** — describe what to hide in plain language and get back pixel coordinates
  inferred by a vision-capable model, written to a `<name>.detect-region.json` file next to the
  source. Needs a remote OpenAI-compatible model configured; fails with a specific, non-generic
  message when one isn't.

**Not wired together via a "Generate" button, and not writing straight into "Redact Region..."'s
fields.** `video-composer`'s AI-assisted-captions action populates a sibling action's field directly
via Filer's action-form "Generate" button — that mechanism only supports one populated field, fed from
one specific kind of tool result shape, neither of which matches `detect_region`'s four independent
numeric fields. Filer's action-invocation path also doesn't display a tool's raw result inline (it
shows only a success/failure notification), so even without the "Generate" button there's nowhere on
screen to read the four numbers back from. `detect-region` therefore ships as its own standalone,
directly-invokable action, and writes its result to a sidecar `<name>.detect-region.json` file next to
the source file — open that file, then type the four numbers into "Redact Region..." by hand. Revisit
only if Filer's action UI grows a way to show/populate a multi-field result generically (a change
affecting every plugin, out of scope here).

## Building the host

Mirrors `video-composer`'s exact `runtime:"process"` shape — own NativeAOT `.csproj`, a
`PackageReference` to `PulsaRedact.SDK`, and a bundled ffmpeg the same (undecided-but-working) way
`video-composer` bundles its own: a `bin/ffmpeg/` folder next to the published executable, placed
there manually during dev.

```
dotnet publish src/MediaRedactor.PluginHost -c Release -r win-x64 --self-contained -p:PublishAot=true -o bin
```

Then place a static ffmpeg build at `bin/ffmpeg/ffmpeg.exe` — the published
`MediaRedactor.PluginHost.exe` looks for it at `<its own directory>/ffmpeg/ffmpeg.exe`. See
`video-composer/README.md`'s "Bundled ffmpeg — exact pin" section for the currently-trusted
win-x64 build/checksum; use the same one here unless a reason to diverge comes up.
