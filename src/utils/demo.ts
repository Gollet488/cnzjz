import type { Landmark } from '../types';
// Synthetic 33-point sequence. It represents no sport and is never model output.
export function demoPose(t:number):Landmark[] {
  const sway=Math.sin(t*0.9)*0.015, bob=Math.sin(t*1.8)*0.018;
  const p=Array.from({length:33},()=>({x:0.5+sway,y:0.18+bob,z:0,visibility:0.98}));
  const set=(i:number,x:number,y:number)=>{p[i]={x:x+sway,y:y+bob,z:0,visibility:0.96+Math.sin(t+i)*0.025};};
  set(0,.5,.158);for(let i=1;i<=10;i++)set(i,.5+(i<=3?-1:1)*(.009+(i%3)*.009),.148+(i>6?.025:0));
  set(7,.455,.168);set(8,.545,.168);set(9,.489,.19);set(10,.511,.19);
  set(11,.422,.285);set(12,.578,.285);
  const wave=Math.sin(t*1.6),wave2=Math.sin(t*1.6+.25);
  set(13,.34-.05*wave,.425-.04*wave);set(14,.665+.05*wave2,.415-.06*wave2);
  set(15,.27-.07*wave,.325-.11*wave);set(16,.74+.06*wave2,.305-.1*wave2);
  for(const [i,w] of [[17,15],[19,15],[21,15],[18,16],[20,16],[22,16]]){const sign=i%2?-1:1;set(i,p[w].x-sway+sign*(.012+(i%3)*.007),p[w].y-bob-.025-(i%3)*.005);}
  set(23,.455,.54);set(24,.545,.54);set(25,.40+.02*Math.sin(t*1.8),.715);set(26,.61+.025*Math.sin(t*1.8+.4),.71);
  set(27,.36,.88);set(28,.65,.875);set(29,.348,.902);set(30,.655,.902);set(31,.305,.915);set(32,.705,.91);
  return p;
}
