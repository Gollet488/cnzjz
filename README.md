
# Kinetic 动观 · 人体姿态量化分析 Demo

按同目录 `requiremen.md` 实现的纯前端项目。使用 Vue 3 组合式 API / `<script setup>`、TypeScript、Vite、Element Plus、ECharts 和 MediaPipe Pose Landmarker。没有后端，不上传视频或帧。

## 启动

需要 Node.js 22.18+（推荐 Node.js 24）及 pnpm 或 npm。

当前机器的依赖与模型已准备好，双击 `启动Demo.cmd` 即可启动后台服务并自动打开 `http://127.0.0.1:5173/`。重复启动会复用已有服务；关闭浏览器或启动窗口不会结束服务。需要结束时双击 `停止Demo.cmd`。脚本在系统 Node 不可用时会使用这台机器已有的 Codex Node 运行时，日志保存在 `.demo/server.log`。

```sh
pnpm install
pnpm prepare:assets
pnpm dev
```

也可以使用 `npm install`、`npm run prepare:assets`、`npm run dev`。打开终端打印的 localhost 地址。摄像头只在 localhost / HTTPS 下可用，并需要浏览器权限。

本目录已准备 MediaPipe WASM 与 Lite 模型，`prepare:assets` 重复执行会跳过已有模型。首次准备需要访问 Google 官方模型下载地址；之后模型、WASM、页面、推理都在本机提供，不依赖 CDN。模型来源见下文。

## 体验路径

1. 默认打开**演示模式**：使用明确标记的合成 33 点序列，模拟通用关节运动；画布中的人形为程序绘制示意，不是真实视频或模型输出。无需摄像头即可体验图表、打点、截取与导出。
2. **实时摄像头**：点击开始分析授权摄像头，MediaPipe 在浏览器中推理。支持单人，建议全身入镜，避免遮挡。
3. **上传视频**：选择或拖入本地 MP4 / WebM（最大 500 MB），读取到浏览器内，逐个已解码播放帧推理。当前实现按约 20 FPS 采样，实际取决于硬件；它不是穷尽源视频每一帧的离线批处理器。暂停后拖动时间轴查看已分析帧，继续时保留已有记录，跳过重复时间戳。
4. **手动打点**记录当前时刻；导出页可以重命名、删除节点。**截取片段**第一次记起点，第二次记终点。暂停时也能拖动时间轴选择两端。截取影响图表和导出，不删除原始采集数据。
5. **时序可视化**：选择关节，滚轮缩放或拖动底部区间滑块；查看左右角度、活动幅度、角速度热力图、重心时序和轨迹。
6. **姿态对比**：自行上传参考与待测视频，两路从头同步播放，本地双模型推理，显示当前帧归一化欧氏距离。距离小表示几何姿态更接近，不代表正确。请自行对齐起始时刻、拍摄比例和视角；当前没有动态时间规整或动作阶段匹配。
7. **导出**：CSV 包含时间、33 点 x/y/z/visibility、左右角度、角速度、近似重心、不对称、肩髋膝高度差、稳定性方差、手动标记。PNG 包含当前画布、时长、平均不对称、重心纵向范围、各关节活动幅度和峰值角速度。

## 计算定义与边界

- 默认 5 帧滑动平均，窗口与置信阈值可配置；阈值默认 0.5。低置信度点标红，相关角度留空，不制造可靠读数。
- 没有检测到人体的采样帧仍保留时间戳，置信度为 0，关键点与相关指标为空；滤波窗口会清空，避免缺失数据污染后续坐标。
- 关节：肩、肘、髋、膝、踝、腕与脊柱。三点向量夹角 0–180°，已按视频宽高比修正。脊柱用肩中点 / 髋中点 / 踝中点形成的中线角定义；腕角用肘 / 腕 / 食指。都是可复现的几何代理量，不是临床关节定义。
- **原始关键点**（未滤波）与**滤波后用于计算的关键点**分别保留。CSV 的 `raw_*` 字段为模型原始值，`filtered_*` 字段为计算输入。
- 角速度 = 相邻有效帧角差 / 实际时间差，单位 °/s。有符号，热力图使用绝对值。缺失角度或零间隔不会生成速度。
- 近似重心 = 左右髋的置信度加权坐标。不是人体质量分段模型。
- 不对称系数 = 6 组双侧关节绝对角差 / 180° 的平均百分比。中线脊柱不计入；另存肩、髋、膝的归一化高度差。
- 稳定性 = 滑动窗口内可靠关键点 x/y 坐标方差之和的逐点平均。主动运动也会使方差增加；不将其解释为动作质量。
- 单目 2D 投影不是真实三维角度，不等同专业动捕；只支持单人。光照、遮挡与视角会影响结果。
- 不识别运动种类、不内置专项规则、不评分、不判动作对错；没有运动类型枚举、YOLO、3D 重建或本地大模型。
- 默认分析最多 18,000 帧，达到后暂停，提示导出。刷新清空内存。设置变更影响后续数据，需要统一口径时请重置会话后重录。
- 可选 LLM 辅助解读未启用。核心功能完全不依赖 LLM。

## 项目结构

```text
src/
  App.vue                    会话、采集、指标面板、设置与导出界面
  components/PoseStage.vue    摄像头 / FileReader 文件、视频帧推理循环
  components/TimeChart.vue    ECharts 时序、重心与热力图
  components/PoseCompare.vue 双视频同步与本地姿态距离
  utils/poseMath.ts           向量夹角、滤波、重心、方差、距离
  utils/poseEngine.ts         本地 WASM / 单人推理模型初始化
  utils/renderer.ts           Canvas 骨骼、关键点、角度、轨迹绘制
  utils/demo.ts               明确标注的合成演示序列
  utils/export.ts             逐帧 CSV、PNG 图片报告
  config.ts                  可调默认值、关节、颜色与骨骼连接
  types.ts                   帧、关键点、标记与设置结构
public/mediapipe/             本地模型与 WASM 资源
tests/poseMath.test.ts        几何与时序计算边界测试
scripts/prepare-assets.mjs    从已安装包复制 WASM，下载官方 Lite 模型
```

## 验证与构建

```sh
pnpm test
pnpm build
pnpm preview
```

生产构建输出到 `dist/`，可部署到任意静态托管。导出值使用归一化坐标；CSV 缺失值留空。摄像头真实采集需要使用者自行授权和完成实机测试。

MediaPipe 官方文档：https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js

Lite 模型：https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task

MediaPipe Tasks Vision 按其 Apache-2.0 许可使用。其余依赖保留各自许可。



