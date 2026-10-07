# audio-to-video

A `watch` input picks up every `.mp3` dropped in `./inbox`. A `transform: exec` node runs `ffmpeg` to loop `./cover.jpg` over the track and write `./out/<name>.mp4`. The output appends one JSON line per video (exit code, time taken, the file) to `./out/videos.jsonl`.

Needs `ffmpeg` on the machine (`brew install ffmpeg`, `apt install ffmpeg`). Without it, the pipeline refuses to start and says so.

```sh
bun pipo check examples/audio-to-video
bun pipo run examples/audio-to-video/audio-to-video.pipo
cp song.mp3 examples/audio-to-video/inbox/
tail -f examples/audio-to-video/out/videos.jsonl
```

Swap `cover.jpg` for your own image. `inbox/` and `out/` are git-ignored.
