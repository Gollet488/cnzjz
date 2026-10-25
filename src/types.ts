export interface Landmark { x: number; y: number; z: number; visibility: number }
export type Joint = 'shoulder' | 'elbow' | 'hip' | 'knee' | 'ankle' | 'spine' | 'wrist';
export type Side = 'left' | 'right';
export type Angles = Record<Joint, { left: number | null; right: number | null }>;
export interface PoseFrame { time: number; rawPoints: Landmark[]; points: Landmark[]; angles: Angles; velocity: Angles; center: {x: number; y: number} | null; confidence: number; asymmetry: number | null; heightDifference: {shoulder: number | null; hip: number | null; knee: number | null}; stability: number | null }
export interface Marker { time: number; label: string }
export interface Settings { threshold: number; window: number; skeleton: boolean; labels: boolean; trajectory: boolean }
export type Source = 'demo' | 'camera' | 'file';
