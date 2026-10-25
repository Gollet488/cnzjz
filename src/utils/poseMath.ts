import type { Landmark, Angles, PoseFrame, Joint } from '../types.ts';

// Monocular coordinates yield 2D projection angles, not anatomical 3D measurements.
export function angle(a: Landmark, b: Landmark, c: Landmark, aspect = 1): number | null {
  const ux=(a.x-b.x)*aspect, uy=a.y-b.y, vx=(c.x-b.x)*aspect, vy=c.y-b.y;
  const denominator=Math.hypot(ux,uy)*Math.hypot(vx,vy);
  return denominator < 1e-10 ? null : Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/denominator)))*180/Math.PI;
}
const midpoint=(a:Landmark,b:Landmark):Landmark=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2,visibility:Math.min(a.visibility,b.visibility)});
export function emptyAngles(): Angles { return Object.fromEntries(['shoulder','elbow','hip','knee','ankle','spine','wrist'].map(k=>[k,{left:null,right:null}])) as Angles; }
export function jointAngles(p: Landmark[], threshold = 0.5, aspect = 1): Angles {
  const result=emptyAngles();
  if(p.length!==33) return result;
  const triples:Record<Exclude<Joint,'spine'>,[number,number,number][]>={shoulder:[[13,11,23],[14,12,24]],elbow:[[11,13,15],[12,14,16]],hip:[[11,23,25],[12,24,26]],knee:[[23,25,27],[24,26,28]],ankle:[[25,27,31],[26,28,32]],wrist:[[13,15,19],[14,16,20]]};
  for(const [key,pairs] of Object.entries(triples)) pairs.forEach(([a,b,c],i)=>{result[key as Joint][i===0?'left':'right'] = [a,b,c].every(n=>p[n].visibility>=threshold)?angle(p[a],p[b],p[c],aspect):null;});
  const spinePoints=[midpoint(p[11],p[12]),midpoint(p[23],p[24]),midpoint(p[27],p[28])];
  const spine=spinePoints.every(v=>v.visibility>=threshold)?angle(spinePoints[0],spinePoints[1],spinePoints[2],aspect):null;
  result.spine={left:spine,right:spine}; return result;
}
export function centerOfMass(p:Landmark[],threshold=0.5): {x:number;y:number}|null {
  if(p.length!==33||p[23].visibility<threshold||p[24].visibility<threshold) return null;
  const a=p[23],b=p[24],w=a.visibility+b.visibility;
  return w?{x:(a.x*a.visibility+b.x*b.visibility)/w,y:(a.y*a.visibility+b.y*b.visibility)/w}:null;
}
export class LandmarkFilter {
  private history:Landmark[][]=[];
  apply(points:Landmark[],window:number):Landmark[] {
    this.history.push(points.map(p=>({...p}))); this.history=this.history.slice(-Math.max(1,Math.round(window)));
    // Low confidence samples must not fabricate reliable coordinates by averaging.
    return points.map((p,i)=>{const samples=this.history.map(f=>f[i]);return {x:samples.reduce((s,v)=>s+v.x,0)/samples.length,y:samples.reduce((s,v)=>s+v.y,0)/samples.length,z:samples.reduce((s,v)=>s+v.z,0)/samples.length,visibility:Math.min(p.visibility,samples.reduce((s,v)=>s+v.visibility,0)/samples.length)};});
  }
  clear(){this.history=[];}
}
export function stabilityVariance(history:Landmark[][],threshold=0.5):number|null {
  if(history.length<2)return null;
  const variances:number[]=[];
  for(let i=0;i<33;i++){const samples=history.map(f=>f[i]).filter(p=>p?.visibility>=threshold);if(samples.length<2)continue;const mx=samples.reduce((s,p)=>s+p.x,0)/samples.length,my=samples.reduce((s,p)=>s+p.y,0)/samples.length;variances.push(samples.reduce((s,p)=>s+(p.x-mx)**2+(p.y-my)**2,0)/samples.length);}
  return variances.length?variances.reduce((s,v)=>s+v,0)/variances.length:null;
}
export function measureFrame(points:Landmark[],time:number,previous:PoseFrame|undefined,history:Landmark[][],threshold=0.5,aspect=1,rawPoints:Landmark[]=points):PoseFrame {
  if(points.length!==33) return {time,rawPoints:[],points:[],angles:emptyAngles(),velocity:emptyAngles(),center:null,confidence:0,asymmetry:null,heightDifference:{shoulder:null,hip:null,knee:null},stability:null};
  const angles=jointAngles(points,threshold,aspect),velocity=emptyAngles(),delta=previous?time-previous.time:0;
  for(const key of Object.keys(angles) as Joint[]) for(const side of ['left','right'] as const){const a=angles[key][side],b=previous?.angles[key][side];velocity[key][side]=a!==null&&b!==null&&b!==undefined&&delta>0?(a-b)/delta:null;}
  // Spine is one midline angle; exclude it from bilateral asymmetry.
  const diffs=(Object.keys(angles) as Joint[]).filter(k=>k!=='spine').flatMap(k=>{const {left,right}=angles[k];return left!==null&&right!==null?[Math.abs(left-right)/180*100]:[];});
  const height=(a:number,b:number)=>points[a].visibility>=threshold&&points[b].visibility>=threshold?Math.abs(points[a].y-points[b].y):null;
  return {time,rawPoints,points,angles,velocity,center:centerOfMass(points,threshold),confidence:rawPoints.reduce((s,p)=>s+p.visibility,0)/rawPoints.length,asymmetry:diffs.length?diffs.reduce((s,v)=>s+v,0)/diffs.length:null,heightDifference:{shoulder:height(11,12),hip:height(23,24),knee:height(25,26)},stability:stabilityVariance(history,threshold)};
}
// Translation/scale normalized mean Euclidean distance. Similarity is descriptive,
// never a correctness score; reference selection belongs to the user.
export function poseDistance(a:Landmark[],b:Landmark[],threshold=0.5):number|null {
  if(a.length!==33||b.length!==33||[a,b].some(p=>[11,12,23,24].some(i=>p[i].visibility<threshold)))return null;
  const normalize=(p:Landmark[])=>{const c=midpoint(p[23],p[24]),s=midpoint(p[11],p[12]),scale=Math.hypot(s.x-c.x,s.y-c.y);return scale<1e-8?null:p.map(v=>({...v,x:(v.x-c.x)/scale,y:(v.y-c.y)/scale}));};
  const na=normalize(a),nb=normalize(b); if(!na||!nb)return null;
  const distances=na.flatMap((p,i)=>p.visibility>=threshold&&nb[i].visibility>=threshold?[Math.hypot(p.x-nb[i].x,p.y-nb[i].y)]:[]);
  return distances.length?distances.reduce((s,v)=>s+v,0)/distances.length:null;
}
