# video-composer

Composes selected images into a captioned, Ken-Burns-animated 16:9 video via a bundled ffmpeg —
no dependency on Filer's own `FfmpegProvisioner`/`MediaService`.

## Build

1. Publish the .NET host:
   ```
   dotnet publish src/VideoComposer.PluginHost -c Release -r win-x64 --self-contained -p:PublishAot=true -o bin
   ```
2. Place a static ffmpeg build at `bin/ffmpeg/ffmpeg.exe`. The published
   `VideoComposer.PluginHost.exe` looks for it at
   `<its own directory>/ffmpeg/ffmpeg.exe` (see `Program.cs`'s `ffmpegBinaryFolder`).

## Bundled ffmpeg — exact pin

The `ffmpeg.exe` committed at `bin/ffmpeg/ffmpeg.exe` is the win-x64 "essentials" build from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/), which includes every filter this plugin needs
(`zoompan`, `concat`, `subtitles`/`libass`):

- **Version:** 8.1.2
- **Source URL:** `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip`
- **SHA-256 of the zip:** `db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec`
- **Archive path of the binary:** `ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe`

To re-verify or re-source this binary, download the zip from the URL above, confirm its SHA-256
matches the checksum above, then extract `bin/ffmpeg.exe` from it into `bin/ffmpeg/ffmpeg.exe`
here. Do not replace this file with an unverified build — a checksum mismatch means the download
is corrupted or the upstream artifact changed, and should be treated as a blocker, not worked
around.
