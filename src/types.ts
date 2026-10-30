export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}
export type Joint = 'shoulder' | 'elbow' | 'hip' | 'knee' | 'ankle' | 'spine' | 'wrist';
export type Side = 'left' | 'right';
export type Channel = Side | 'midline';
export type Angles = Record<Exclude<Joint, 'spine'>, Record<Side, number | null>> & {
  spine: { midline: number | null };
};
export interface AnalysisParameters {
  threshold: number;
  window: number;
  aspect: number;
  metricVersion: '2.0';
}
export interface VarianceSummary {
  value: number | null;
  unit: 'normalized_coordinate²';
  windowFrames: number;
  validPoints: number;
  validSamples: number;
  minSamplesPerPoint: number;
  maxSamplesPerPoint: number;
}
export interface PoseFrame {
  time: number;
  rawPoints: Landmark[];
  points: Landmark[];
  angles: Angles;
  velocity: Angles;
  rawAngles: Angles;
  rawVelocity: Angles;
  variance: { raw: VarianceSummary; filtered: VarianceSummary };
  windowInterval: [number, number];
  center: { x: number; y: number } | null;
  confidence: number;
  asymmetry: number | null;
  heightDifference: { shoulder: number | null; hip: number | null; knee: number | null };
  stability: number | null;
}
export interface Marker {
  time: number;
  label: string;
}
export interface Settings {
  threshold: number;
  window: number;
  skeleton: boolean;
  labels: boolean;
  labelJoints?: Joint[];
  trajectory: boolean;
}
export type Source = 'demo' | 'camera' | 'file';
