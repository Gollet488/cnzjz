<script setup lang="ts">
import {ref,watch,onMounted,onBeforeUnmount} from 'vue';
import {UploadCloud,Video,ScanLine} from 'lucide-vue-next';
import type {Landmark,Settings,Source} from '../types';
import {demoPose} from '../utils/demo';
import {renderPose} from '../utils/renderer';
import {getPoseEngine} from '../utils/poseEngine';
const props=defineProps<{source:Source;playing:boolean;settings:Settings;selectedPoints?:Landmark[];seekTime?:number}>();
const emit=defineEmits<{frame:[points:Landmark[],time:number,aspect:number];status:[message:string];ready:[name:string];ended:[];busy:[value:boolean]}>();
const canvas=ref<HTMLCanvasElement>(),video=ref<HTMLVideoElement>(),input=ref<HTMLInputElement>();
const filename=ref(''),loading=ref(false),modelReady=ref(false);
let stream:MediaStream|undefined,objectURL='',raf=0,lastSample=0,lastTrailSample=0,lastVideo=-1,demoTime=8,previousNow=0,points:Landmark[]=[],trail:{x:number;y:number}[]=[],generation=0,inferenceTime=0,lastDetection:boolean|null=null;
let engine:Awaited<ReturnType<typeof getPoseEngine>>|undefined;
async function prepare(){const token=generation;loading.value=true;emit('busy',true);try{engine=await getPoseEngine();if(token===generation){modelReady.value=true;emit('status','本地推理已就绪');}}catch{emit('status','模型加载失败，请检查 public/mediapipe 资源或运行 prepare:assets。');emit('ended');}finally{if(token===generation){loading.value=false;emit('busy',false);}}}
async function start(){const token=generation;if(props.source==='demo')return;
  if(props.source==='camera'&&!stream){try{stream=await navigator.mediaDevices.getUserMedia({video:{width:1280,height:720},audio:false});if(token!==generation){stream.getTracks().forEach(t=>t.stop());stream=undefined;return;}video.value!.srcObject=stream;await video.value!.play();emit('ready','实时摄像头');}catch{emit('status','无法访问摄像头：请允许权限，并使用 localhost 或 HTTPS。');emit('ended');return;}}
  if(props.source==='file'&&!filename.value){emit('status','请先选择一个本地 MP4 视频。');emit('ended');return;}
  if(!modelReady.value)await prepare();if(token!==generation||!props.playing)return;
  if(video.value&&modelReady.value){try{await video.value.play();}catch{emit('status','视频无法播放，请重新选择浏览器支持的 MP4 文件。');emit('ended');}}
}
async function loadFile(file?:File){if(!file)return;if(file.size>500*1024*1024){emit('status','视频超过 500 MB，请先截取较短片段。');return;}if(!/video\/(mp4|webm|quicktime)/.test(file.type)&&!(/\.(mp4|webm|mov)$/i.test(file.name))){emit('status','请选择 MP4 / WebM 视频文件。');return;}
  generation++;emit('ended');stream?.getTracks().forEach(t=>t.stop());stream=undefined;video.value!.srcObject=null;loading.value=true;
  try{const data=await new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=reject;reader.readAsArrayBuffer(file);});if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(new Blob([data],{type:file.type||'video/mp4'}));filename.value=file.name;video.value!.src=objectURL;video.value!.load();lastVideo=-1;points=[];trail=[];emit('ready',file.name);emit('status','视频已就绪，点击「开始分析」。');}catch{emit('status','本地文件读取失败。');}finally{loading.value=false;}}
function fileChange(event:Event){void loadFile((event.target as HTMLInputElement).files?.[0]);(event.target as HTMLInputElement).value='';}
function drop(event:DragEvent){event.preventDefault();if(props.source==='file')void loadFile(event.dataTransfer?.files[0]);}
function stop(){generation++;stream?.getTracks().forEach(t=>t.stop());stream=undefined;if(video.value){video.value.pause();video.value.srcObject=null;}points=[];trail=[];lastVideo=-1;lastDetection=null;modelReady.value=!!engine;loading.value=false;emit('busy',false);}
function tick(now:number){raf=requestAnimationFrame(tick);const dt=previousNow?Math.min((now-previousNow)/1000,.15):0;previousNow=now;
  if(props.source==='demo'){if(props.playing)demoTime+=dt;points=props.playing?demoPose(demoTime):(props.selectedPoints??demoPose(demoTime));if(props.playing&&now-lastSample>=50){lastSample=now;emit('frame',points,demoTime,850/590);}}
  else if(props.playing&&engine&&modelReady.value&&video.value&&video.value.readyState>=2&&now-lastSample>=50&&video.value.currentTime!==lastVideo){
    lastSample=now;lastVideo=video.value.currentTime;
    try{inferenceTime=Math.max(inferenceTime+1,performance.now());const result=engine.detectForVideo(video.value,inferenceTime);points=result.landmarks[0]?.map(p=>({x:p.x,y:p.y,z:p.z,visibility:p.visibility??0}))??[];emit('frame',points,props.source==='file'?video.value.currentTime:now/1000,video.value.videoWidth/video.value.videoHeight);if(!!points.length!==lastDetection){lastDetection=!!points.length;emit('status',points.length?'':'未检测到完整人体，请保证单人全身入镜。');}}catch{emit('status','当前帧推理失败，请重置后重试。');emit('ended');}
  }
  if(canvas.value){const displayed=props.selectedPoints??points;if(props.settings.trajectory&&displayed.length&&props.playing&&lastTrailSample!==lastSample){lastTrailSample=lastSample;trail.push({x:(displayed[23].x+displayed[24].x)/2,y:(displayed[23].y+displayed[24].y)/2});trail=trail.slice(-180);}renderPose(canvas.value,displayed,props.settings,props.source==='demo'?undefined:video.value,trail);}
}
watch(()=>props.playing,value=>{if(value)void start();else video.value?.pause();});
watch(()=>props.source,()=>{stop();if(props.source==='demo'){demoTime=8;filename.value='';}if(props.playing)void start();});
watch(()=>props.seekTime,time=>{if(time!==undefined){if(props.source==='demo')demoTime=time;else if(props.source==='file'&&video.value&&filename.value){video.value.currentTime=time;lastVideo=-1;}}});
onMounted(()=>{raf=requestAnimationFrame(tick);});onBeforeUnmount(()=>{cancelAnimationFrame(raf);stop();if(objectURL)URL.revokeObjectURL(objectURL);});
defineExpose({canvas,isEnded:()=>video.value?.ended??false,chooseFile:()=>input.value?.click(),reset:()=>{demoTime=0;trail=[];lastVideo=-1;lastDetection=null;points=[];if(video.value&&props.source==='file')video.value.currentTime=0;}});
</script>
<template>
  <div class="pose-stage" @dragover.prevent @drop="drop">
    <canvas ref="canvas" width="1100" height="650" aria-label="人体姿态骨骼与关键点可视化画布" />
    <video ref="video" playsinline muted @ended="emit('ended')" @error="emit('status','视频解码失败，请尝试 H.264 编码的 MP4 文件。')" />
    <input ref="input" type="file" accept="video/mp4,video/webm,video/quicktime" hidden @change="fileChange">
    <div class="stage-top"><span class="stage-chip"><i :class="{live:playing}" />{{ source==='demo'?'合成姿态演示':source==='camera'?'CAMERA · 本地摄像头':'VIDEO · 本地文件' }}</span><span class="stage-chip subtle">{{ source==='demo'?'SYNTHETIC DATA':'LOCAL INFERENCE' }}</span></div>
    <div v-if="source==='demo'" class="stage-axis"><span>Y</span><div>↟</div><small>↗ X</small></div>
    <div v-if="source!=='demo'&&!points.length" class="stage-empty"><component :is="source==='camera'?Video:UploadCloud" :size="38"/><h3>{{source==='camera'?'连接你的摄像头':'将视频拖到这里'}}</h3><p>{{source==='camera'?'点击开始分析，允许浏览器使用摄像头':filename||'支持 MP4 / WebM，最大 500 MB'}}</p><el-button v-if="source==='file'" @click="input?.click()">{{filename?'重新选择视频':'选择本地视频'}}</el-button></div>
    <div v-if="loading" class="model-loading"><ScanLine class="spin" :size="24"/><span>正在准备本地推理引擎…</span></div>
    <div class="stage-bottom"><span><ScanLine :size="13"/> {{source==='demo'?'33 LANDMARKS · 演示序列':'MEDIAPIPE POSE · 33 LANDMARKS'}}</span><span>2D / SINGLE PERSON</span></div>
    <div class="corner tl"/><div class="corner tr"/><div class="corner bl"/><div class="corner br"/>
  </div>
</template>
