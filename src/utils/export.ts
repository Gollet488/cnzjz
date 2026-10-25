import type { PoseFrame, Marker } from '../types';
import {JOINTS,POINT_NAMES} from '../config';
export function download(blob:Blob,name:string){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function cell(value:unknown){return `"${String(value??'').replace(/"/g,'""')}"`;}
export function exportCSV(frames:PoseFrame[],markers:Marker[]){
  const header=['time_s','confidence','center_x','center_y','asymmetry_percent','stability_variance','shoulder_height_delta','hip_height_delta','knee_height_delta',...['raw','filtered'].flatMap(prefix=>POINT_NAMES.flatMap(n=>['x','y','z','visibility'].map(k=>`${prefix}_${n}_${k}`))),...JOINTS.flatMap(j=>['left','right'].flatMap(s=>[`${j.key}_${s}_deg`,`${j.key}_${s}_velocity_deg_s`])),'markers'];
  const rows=frames.map((f,i)=>[f.time,f.confidence,f.center?.x,f.center?.y,f.asymmetry,f.stability,f.heightDifference.shoulder,f.heightDifference.hip,f.heightDifference.knee,...[f.rawPoints,f.points].flatMap(points=>POINT_NAMES.flatMap((_,index)=>{const p=points[index];return [p?.x,p?.y,p?.z,p?.visibility];})),...JOINTS.flatMap(j=>(['left','right'] as const).flatMap(s=>[f.angles[j.key][s],f.velocity[j.key][s]])),markers.filter(m=>m.time>=f.time&&(i===frames.length-1?m.time<=f.time+.05:m.time<frames[i+1].time)).map(m=>m.label).join(' / ')]);
  download(new Blob(['\uFEFF'+[header,...rows].map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),`kinetic-${Date.now()}.csv`);
}
export function exportReport(canvas:HTMLCanvasElement,frames:PoseFrame[],isDemo:boolean){
  const report=document.createElement('canvas');report.width=1440;report.height=1160;const ctx=report.getContext('2d')!;
  ctx.fillStyle='#f3f6f5';ctx.fillRect(0,0,1440,1160);ctx.fillStyle='#172e2b';ctx.font='bold 38px sans-serif';ctx.fillText('KINETIC / 动观 · 姿态量化报告',60,76);
  ctx.font='20px sans-serif';ctx.fillStyle='#64807a';ctx.fillText(`${isDemo?'合成演示数据':'本地采集数据'} · ${new Date().toLocaleString('zh-CN')}`,60,118);
  const scale=Math.min(1320/canvas.width,650/canvas.height);ctx.fillStyle='#15272e';ctx.fillRect(60,155,1320,650);ctx.drawImage(canvas,60+(1320-canvas.width*scale)/2,155+(650-canvas.height*scale)/2,canvas.width*scale,canvas.height*scale);
  const avg=(v:number[])=>v.length?v.reduce((s,n)=>s+n,0)/v.length:0;
  const centers=frames.flatMap(f=>f.center?[f.center.y]:[]),asym=frames.flatMap(f=>f.asymmetry===null?[]:[f.asymmetry]);
  const duration=frames.length>1?frames.at(-1)!.time-frames[0].time:0;
  ctx.fillStyle='#172e2b';ctx.font='24px sans-serif';ctx.fillText(`时长 ${duration.toFixed(2)} s    样本 ${frames.length}    平均不对称系数 ${avg(asym).toFixed(2)}%`,60,860);
  ctx.fillText(`重心纵向范围 ${centers.length?(Math.max(...centers)-Math.min(...centers)).toFixed(4):'—'}（归一化坐标）`,60,905);
  ctx.font='18px sans-serif';
  JOINTS.forEach((j,i)=>{const ranges=(['left','right'] as const).flatMap(side=>{const values=frames.flatMap(f=>f.angles[j.key][side]===null?[]:[f.angles[j.key][side]!]);return values.length?[Math.max(...values)-Math.min(...values)]:[];});const speeds=frames.flatMap(f=>[f.velocity[j.key].left,f.velocity[j.key].right].filter((n):n is number=>n!==null));ctx.fillText(`${j.label}   最大 ROM ${ranges.length?Math.max(...ranges).toFixed(1):'—'}°   峰值 ${speeds.length?Math.max(...speeds.map(Math.abs)).toFixed(1):'—'}°/s`,60+(i%3)*445,955+Math.floor(i/3)*40);});
  ctx.fillStyle='#7a8c87';ctx.font='17px sans-serif';ctx.fillText('单人单目 2D 平面投影；髋中点仅为重心近似。数据仅供相对对比，不用于动作对错判定。',60,1118);
  report.toBlob(blob=>{if(blob)download(blob,`kinetic-report-${Date.now()}.png`);},'image/png');
}
