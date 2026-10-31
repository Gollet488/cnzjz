# 任务 4 的合成 MP4 固件

这些微型视频由 FFmpeg 7.1/libx264 的 `testsrc2` 生成，只有合成色块，不含个人视频或第三方图片。JSON 中的 `ptsSeconds` 来自 FFmpeg `showinfo` 的真实解码输出，是 MP4Box 之外的独立 oracle。默认编码包含 B 帧、尾部 moov；不能把解码顺序当呈现顺序。

在此目录中用 FFmpeg 重建（测试本身无需 FFmpeg）：

```sh
ffmpeg -f lavfi -i testsrc2=size=64x48:rate=30 -frames:v 30 -an -c:v libx264 -bf 2 -g 15 30fps.mp4
ffmpeg -f lavfi -i testsrc2=size=64x48:rate=60 -frames:v 60 -an -c:v libx264 -bf 2 -g 15 60fps.mp4
ffmpeg -f lavfi -i testsrc2=size=64x48:rate=30 -vf "settb=1/30000,setpts='if(lt(N,15),N*1000,15000+(N-15)*2000)'" -frames:v 30 -fps_mode vfr -enc_time_base 1:30000 -video_track_timescale 30000 -an -c:v libx264 -bf 2 -g 15 vfr.mp4
ffmpeg -display_rotation 90 -i 30fps.mp4 -c copy rotate.mp4
ffmpeg -i 30fps.mp4 -c copy -movflags frag_keyframe+empty_moov fragmented.mp4
ffmpeg -i 30fps.mp4 -vf showinfo -fps_mode passthrough -f null -
```

末条对各输入重复运行，读取每帧 `n`/`pts_time`，再保存 JSON。30 fps 为 30 帧、0–0.966667 s；60 fps 为 60 帧、0–0.983333 s；VFR 为 30 帧、0–1.433333 s（前 15 帧 1/30 s 间隔，后 15 帧 1/15 s 间隔）。旋转声明为逆时针 90°，等于流水线的顺时针 270°。fragmented 用于明确拒绝测试。

F 阶段正式浏览器入口 `pnpm test:browser` 直接上传本目录素材，运行真实 MediaPipe 和打包 Worker；不再依赖 `.qa` 视频或测试页面。`browser-manifest.json` 固定来源、synthetic=true、字节数与 SHA-256，`node scripts/check-browser-fixtures.mjs` 可独立核验。上传时勾选生成素材标签，CSV/工具/PNG 保留 synthetic。这里验证解码、PTS、缺失和导出，不以小色块推理宣称人体准确率或真实运动已验收。详见 [正式入口](../../docs/browser-regression.md)。
