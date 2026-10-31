# 本地视频逐帧分析

实现：`src/video/mp4.ts`、timeline、job、protocol、offline.worker，以及 PoseStage。

MP4Box 读取容器索引；WebCodecs 按解码顺序处理，结果按源显示时间审计。MediaPipe 在 Worker 内本地推理，预览帧回到主线程绘制。视频和图像帧不上传。

导入层 `src/video/prepare.ts` 不以扩展名拒绝文件，单视频和双视频对比共用。MP4Box 与 WebCodecs 能直接读取的文件保持原数据；其他容器、编码、碎片化 MP4 或轨道变换先由浏览器本地单线程 FFmpeg WebAssembly 转为 H.264/yuv420p 普通 MP4。资源从本站 `/ffmpeg/` 读取，通过 `pnpm prepare:assets` 从锁定依赖复制并校验，纯静态部署也可使用，不要求跨源隔离或 CDN。

常见容器包括 MP4/MOV/MKV/AVI/WebM/FLV/WMV/MPEG/TS/3GP/OGV/MXF 等，实际解码能力以随附 FFmpeg 核心为准。损坏、加密、无视频轨道或仍无法解码的文件明确报错，不宣称支持所有可能的编码。输入最大 500 MB；转换需要 WASM 内存中的输入和输出，设备内存不足仍可能失败。转换最多运行 10 分钟，可主动取消；换源、替换文件或卸载组件会终止转换 Worker 并释放内存。

转换选取第一条视频轨道，应用旋转、像素比例和尺寸规范化，输出不超过 1920×1080 的偶数尺寸，去掉音频和字幕；使用 passthrough 帧同步保留可变帧率间隔，不按固定播放频率抽帧。转换后再次验证 MP4 索引和 WebCodecs 支持。由于重编码与时间基转换，完整性核对和时间轴以转换后视频为准，不代表对原文件的无损逐帧审计。会话、工具证据与 CSV 的 `acquisition_mode` 使用 `webcodecs-transcoded` 保留这个区别，原路径仍为 `webcodecs`。

暂停时保持背压，恢复不重复写帧。取消、重置和换源后关闭资源并拒绝迟到写入。会话拒绝帧时解码任务终止，不把已丢失样本计为完成。

采集元数据记录预期/已处理帧数、状态、编码、旋转和时间偏移，随工具证据及 CSV 导出。合成素材来源由用户明确标记。

必要回归素材位于 tests/fixtures，含固定哈希和独立时间戳 oracle；这些素材不证明真实运动视频精度。当前验证见 [项目评估](project-assessment.md)。
