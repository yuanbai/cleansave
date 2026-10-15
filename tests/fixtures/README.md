# Synthetic codec fixture

`av-packets.json` contains ten generated solid-red 128×128 H.264 frames and
48 silent AAC-LC packets. It contains no platform content or credentials.
Video packets were generated once with Chrome's WebCodecs encoder; tests replay
encoded packets using Node.js and do not require an encoder or browser.

The six-byte mono AAC silence payload is documented in the
[hls.js AAC helper](https://github.com/video-dev/hls.js/blob/master/src/remux/aac-helper.ts)
(hls.js, Apache-2.0). No hls.js implementation is incorporated into the app.
AAC configuration is LC, 48 kHz, mono; the track is 1.024 seconds long.
