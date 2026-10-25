import type { Joint, Settings } from './types';
export const DEFAULT_SETTINGS: Settings = { threshold: 0.5, window: 5, skeleton: true, labels: true, trajectory: true };
export const JOINTS: {key: Joint; label: string}[] = [{key:'shoulder',label:'肩关节'},{key:'elbow',label:'肘关节'},{key:'hip',label:'髋关节'},{key:'knee',label:'膝关节'},{key:'ankle',label:'踝关节'},{key:'spine',label:'脊柱'},{key:'wrist',label:'腕关节'}];
export const COLORS = {left:'#508cf1',right:'#ee9952',bone:'#5ce8bd'};
export const MAX_FRAMES = 18000;
export const CONNECTIONS = [[0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10],[11,12],[11,13],[13,15],[15,17],[15,19],[17,19],[15,21],[12,14],[14,16],[16,18],[16,20],[18,20],[16,22],[11,23],[12,24],[23,24],[23,25],[25,27],[27,29],[29,31],[27,31],[24,26],[26,28],[28,30],[30,32],[28,32]];
export const POINT_NAMES = ['nose','left_eye_inner','left_eye','left_eye_outer','right_eye_inner','right_eye','right_eye_outer','left_ear','right_ear','mouth_left','mouth_right','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist','left_pinky','right_pinky','left_index','right_index','left_thumb','right_thumb','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle','left_heel','right_heel','left_foot_index','right_foot_index'];
