# Manual checklist: YouTube

Build with `npm run build` and load `dist/` unpacked. Only save videos you have the right to save.

- [ ] Open a regular video (`/watch?v=...`). The popup lists it with several qualities and an audio track.
- [ ] Download 1080p: the file plays with audio (video-only plus audio are merged by the engine).
- [ ] Navigate to another video without reloading (SPA navigation). The list updates to the new video.
- [ ] A live stream, a premium or age-gated video and a video that only offers ciphered formats list nothing and say why.
- [ ] A large download uses chunks, shows progress, and resumes after the link expires.
- [ ] Audio only gives an M4A with sound.
- [ ] `dist/manifest.json` lists the youtube.com and googlevideo.com hosts.
