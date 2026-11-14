---
version: alpha
name: Kinetic 动观
description: 浏览器端人体姿态量化分析工作台的浅色与深色主题
colors:
  page: '#e9efeb'
  surface: '#fcfefa'
  dark-page: '#0e120f'
  dark-surface: '#191e1b'
  action: '#bef28c'
  chart-left: '#2869c4'
  chart-right: '#af5316'
typography:
  sans:
    fontFamily: "Inter, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
rounded:
  panel: 14px
  control: 8px
omitted:
  - section: spacing
    reason: 沿用现有页面和组件的间距
components:
  button: {}
  navigation: {}
  panel: {}
  chart: {}
---

# Kinetic 动观

## 概览

姿态分析时，视频、关节数据和曲线是主要阅读对象。浅色和深色主题覆盖采集、时序、对比、Agent 和导出，初次访问跟随系统，用户可通过顶栏切换并保存偏好。

## 配色

- 浅色使用灰绿背景与白色卡片，深色使用近黑背景与深灰卡片。亮绿用于主按钮、选中导航图标和进度。
- 关节数据面板在浅色使用淡紫青绿渐变，深色使用深蓝与暗紫渐变。
- 折线与图例使用左侧蓝、右侧橙和重心绿，各主题分别调整明度。姿态画布使用深青色底，骨骼使用绿色，低置信度标记使用红色。

## 布局与组件

沿用原有模块顺序、网格、字号、圆角、控件尺寸与动画。新增组件可复用现有的面板、Element Plus 控件和图标按钮样式。

## 样式来源

`src/style.css` 中的 CSS 变量是主题来源。Element Plus 使用根变量和按钮状态变量，ECharts 在主题切换后重新读取颜色。姿态画布与站点图标使用固定配色。
