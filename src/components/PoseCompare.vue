<script setup lang="ts">
import {ref,onBeforeUnmount} from 'vue';
import {UploadCloud,Play,Pause,ArrowLeftRight} from 'lucide-vue-next';
import {FilesetResolver,PoseLandmarker} from '@mediapipe/tasks-vision';
import {renderPose} from '../utils/renderer';
import {poseDistance} from '../utils/poseMath';
import type {Settings,Landmark} from '../types';
defineProps<{settings:Settings}>();
const emit=defineEmits<{error:[message:string]}>();
const videos:HTMLVideoElement[]=[];const canvases:HTMLCanvasElement[]=[];const files:HTMLInputElement[]=[];
const names=ref(['','']),running=ref(false),busy=ref(false),distance=ref<number|null>(null),time=ref(0);
const models:PoseLandmarker[]=[];const urls:string[]=[];let raf=0,last=0,disposed=false;
async function load(index:number,event:Event){const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;pause();if(urls[index])URL.revokeObjectURL(urls[index]);urls[index]=URL.createObjectURL(file);videos[index].src=urls[index];names.value[index]=file.name;distance.value=null;}
function pause(){running.value=false;videos.forEach(v=>v.pause());cancelAnimationFrame(raf);}
async function play(){if(running.value){pause();return;}if(!names.value.every(Boolean))return;busy.value=true;try{if(models.length!==2){models.forEach(m=>m.close());models.length=0;const wasm=await FilesetResolver.forVisionTasks('/mediapipe/wasm');for(let i=0;i<2;i++){const model=await PoseLandmarker.createFromOptions(wasm,{baseOptions:{modelAssetPath:'/mediapipe/pose_landmarker_lite.task'},runningMode:'VIDEO',numPoses:1});if(disposed){model.close();return;}models.push(model);}}
    videos.forEach(v=>v.currentTime=0);await Promise.all(videos.map(v=>v.play()));running.value=true;raf=requestAnimationFrame(tick);
  }catch{emit('error','对比模型或视频加载失败，请检查模型资源并使用浏览器支持的 MP4 文件。');pause();}finally{busy.value=false;}}
function tick(now:number){if(!running.value)return;raf=requestAnimationFrame(tick);if(now-last<100)return;last=now;if(videos.some(v=>v.ended)){pause();return;}if(videos.some(v=>v.readyState<2))return;
  if(Math.abs(videos[0].currentTime-videos[1].currentTime)>.12)videos[1].currentTime=videos[0].currentTime;
  const points:Landmark[][]=[];try{for(let i=0;i<2;i++){const result=models[i].detectForVideo(videos[i],now);const p=result.landmarks[0]?.map(v=>({x:v.x,y:v.y,z:v.z,visibility:v.visibility??0}))??[];points.push(p);renderPose(canvases[i],p,{threshold:.5,window:5,skeleton:true,labels:false,trajectory:false},videos[i]);}
  distance.value=poseDistance(points[0],points[1]);time.value=videos[0].currentTime;}catch{emit('error','对比推理失败，请检查视频后重试。');pause();}}
onBeforeUnmount(()=>{disposed=true;pause();models.forEach(m=>m.close());urls.forEach(u=>URL.revokeObjectURL(u));});
</script>
<template>
  <section class="panel comparison-panel"><div class="panel-heading"><div><h3>让两段姿态，在同一时间相遇</h3><p>参考由你选择，系统只计算归一化关键点距离。</p></div><ArrowLeftRight :size="23"/></div>
  <div class="comparison-grid"><div v-for="(_,index) in names" :key="index" class="compare-source"><div class="compare-title"><b>{{index===0?'参考视频':'待测视频'}}</b><span>{{names[index]||'尚未选择'}}</span></div><div class="compare-canvas"><video :ref="el=>{if(el)videos[index]=el as HTMLVideoElement}" playsinline muted hidden/><canvas :ref="el=>{if(el)canvases[index]=el as HTMLCanvasElement}" width="640" height="440"/><button v-if="!names[index]" @click="files[index].click()"><UploadCloud :size="32"/><span>选择本地视频</span></button></div><input :ref="el=>{if(el)files[index]=el as HTMLInputElement}" type="file" accept="video/mp4,video/webm" hidden @change="load(index,$event)"><el-button @click="files[index].click()">{{names[index]?'更换视频':'上传 MP4'}}</el-button></div></div>
  <div class="compare-controls"><el-button type="primary" :disabled="!names.every(Boolean)" :loading="busy" @click="play"><component :is="running?Pause:Play" :size="15"/>{{running?'暂停对比':'从头同步分析'}}</el-button><span>同步时间 <b>{{time.toFixed(2)}} s</b></span><span>归一化距离 <b>{{distance===null?'—':distance.toFixed(4)}}</b></span></div>
  <div class="info-line">距离越小表示两帧几何姿态越接近，不代表动作正确或错误。两段视频应使用接近的视角、比例与起始时刻；任一路结束时停止。</div></section>
</template>
