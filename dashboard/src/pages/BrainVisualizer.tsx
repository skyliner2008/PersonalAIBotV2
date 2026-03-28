import React, { useEffect, useState, useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Stars, Html, Line as DreiLine, Edges, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { useSocket } from '../hooks/useSocket';
import { api } from '../services/api';

// ─── Visual Settings ──────────────────────────────────────────────────────────
export interface VisualSettings {
  nodeColor: string;        // node override crystal color
  nodeOpacity: number;      // 0-1
  linkColor: string;
  linkOpacity: number;      // 0-1
  leftHemColor: string;
  leftHemOpacity: number;
  rightHemColor: string;
  rightHemOpacity: number;
  leftCloudColor: string;
  leftCloudOpacity: number;
  rightCloudColor: string;
  rightCloudOpacity: number;
}
const DEFAULT_SETTINGS: VisualSettings = {
  nodeColor: '#ffffff',
  nodeOpacity: 0.93,
  linkColor: '#99eeff',
  linkOpacity: 0.38,
  leftHemColor: '#c026d3',
  leftHemOpacity: 0.043,
  rightHemColor: '#0891b2',
  rightHemOpacity: 0.043,
  leftCloudColor: '#e879f9',
  leftCloudOpacity: 1.0,
  rightCloudColor: '#22d3ee',
  rightCloudOpacity: 1.0,
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface BrainNode {
  id: string; summary: string; label?: string; rowCount?: number;
  layer?: string; x: number; y: number; z: number;
  color: string; activity: number; status?: string; isAgent?: boolean;
}
interface BrainLink { source: string; target: string; type: string; weight: number; }
interface TokenPulseData { id: string; type: 'in' | 'out'; startTime: number; }

// ─── Brain ellipsoid axes (shared by shell geometry AND internal cloud) ────────
const BRX = 6.8;   // lateral half-width
const BRY = 5.6;   // vertical half-height
const BRZ = 8.8;   // front-back half-depth
const FILL = 0.82; // cloud fills this fraction of each axis (leaves margin from wall)

// ─── Seeded PRNG ──────────────────────────────────────────────────────────────
function sr(seed: number, idx: number): number {
  let h = ((seed * 2654435761) ^ (idx * 0x517cc1b7)) >>> 0;
  h = ((h >> 16) ^ h) * 0x45d9f3b; h = ((h >> 16) ^ h) * 0x45d9f3b; h = (h >> 16) ^ h;
  return (h & 0x7fffffff) / 0x7fffffff;
}

// ─── Electric discharge arcs (white sparks on active node) ───────────────────
const ElectricArcs = ({ active, radius }: { active: number; radius: number }) => {
  const ref = useRef<THREE.Group>(null);
  const arcPts = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const base = (i / 7) * Math.PI * 2;
    const pts: [number, number, number][] = [];
    for (let s = 0; s <= 9; s++) {
      const t = s / 9, a = base + t * 1.3 - 0.65;
      const jx = (Math.random() - 0.5) * radius * 0.5, jy = (Math.random() - 0.5) * radius * 0.5;
      const r = radius * (0.5 + t * 0.65);
      pts.push([Math.cos(a) * r + jx, Math.sin(a) * r + jy, (Math.random() - 0.5) * 0.4]);
    }
    return pts;
  }), [radius]);

  useFrame((s) => {
    if (!ref.current) return;
    const show = active > 0.25;
    ref.current.visible = show;
    if (show) {
      ref.current.rotation.z = s.clock.getElapsedTime() * 9;
      ref.current.children.forEach((c: any, i) => {
        if (c.material) c.material.opacity = active * (0.45 + Math.sin(s.clock.getElapsedTime() * 22 + i * 1.3) * 0.45);
      });
    }
  });

  return (
    <group ref={ref}>
      {arcPts.map((pts, i) => (
        <DreiLine key={i} points={pts} color="#ffffff" lineWidth={1.1} transparent opacity={0} />
      ))}
    </group>
  );
};

// ─── Node — pure white diamond, electric on activity ─────────────────────────
const Node = React.forwardRef<THREE.Group, {
  node: BrainNode; onHover: (n: BrainNode | null) => void; onClick?: (e: any) => void;
  visualSettings: VisualSettings;
}>(({ node, onHover, onClick, visualSettings }, ref) => {
  const coreRef = useRef<THREE.Mesh>(null);
  const sw1Ref = useRef<THREE.Mesh>(null);
  const sw2Ref = useRef<THREE.Mesh>(null);
  const phase = useRef(Math.random() * Math.PI * 2);
  const [hov, setHov] = useState(false);
  const act = node.activity || 0;

  useFrame((s) => {
    const t = s.clock.getElapsedTime();
    if (coreRef.current) {
      const base = node.rowCount ? Math.max(0.35, Math.min(1.8, Math.log10(node.rowCount + 1) * 0.38)) : 0.45;
      const sc = base + Math.sin(t * 2.5 + phase.current) * 0.042 + act * 0.55;
      coreRef.current.scale.set(sc, sc, sc);
      coreRef.current.rotation.y += 0.014; coreRef.current.rotation.x += 0.006;
      const m = coreRef.current.material as THREE.MeshPhysicalMaterial;
      m.emissiveIntensity = 1.1 + act * 15;
      m.opacity = 0.93 + act * 0.07;
    }
    if (sw1Ref.current) {
      const m = sw1Ref.current.material as THREE.MeshBasicMaterial;
      if (act > 0.25) {
        const p = (t * (2.2 + act * 3)) % 1;
        sw1Ref.current.scale.set(p * 2.8 + 0.2, p * 2.8 + 0.2, 1);
        m.opacity = (1 - p) * act * 0.72;
      } else m.opacity = 0;
    }
    if (sw2Ref.current) {
      const m = sw2Ref.current.material as THREE.MeshBasicMaterial;
      if (act > 0.45) {
        const p = ((t * (2.2 + act * 3)) + 0.5) % 1;
        sw2Ref.current.scale.set(p * 2.0 + 0.2, p * 2.0 + 0.2, 1);
        m.opacity = (1 - p) * act * 0.52;
      } else m.opacity = 0;
    }
  });

  const isAgentNode = Boolean(node.isAgent) || node.status !== undefined
    || node.id.toLowerCase().includes('-bot') || node.id.toLowerCase().includes('-cli')
    || node.id.toLowerCase().includes('agent');

  const statusColor = (st?: string) => st === 'active' ? '#6bcb77' : st === 'degraded' ? '#ffd93d' : st === 'offline' ? '#ff6b9d' : node.color || '#888';
  const dColor = node.isAgent ? statusColor(node.status) : node.color;

  return (
    <group ref={ref} position={[node.x, node.y, node.z]}>
      {/* Shockwave rings */}
      <mesh ref={sw1Ref} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.75, 0.95, 32]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={sw2Ref} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.75, 0.95, 32]} />
        <meshBasicMaterial color="#c8f0ff" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {/* Electric arcs */}
      {!isAgentNode && <ElectricArcs active={act} radius={0.88} />}
      {/* Core crystal */}
      {!isAgentNode && (
        <mesh ref={coreRef}
          onPointerOver={(e) => { e.stopPropagation(); onHover(node); setHov(true); }}
          onPointerOut={(e) => { e.stopPropagation(); onHover(null); setHov(false); }}
          onPointerDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => { e.stopPropagation(); onClick?.(e); }}>
          <octahedronGeometry args={[0.7, 0]} />
          <meshPhysicalMaterial color={visualSettings.nodeColor} emissive={visualSettings.nodeColor} emissiveIntensity={1.1}
            transparent opacity={visualSettings.nodeOpacity} roughness={0.0} metalness={0.05} depthWrite={false} />
          <Edges threshold={15} lineWidth={2.5} color={visualSettings.nodeColor} />
        </mesh>
      )}
      {/* Hover label */}
      {(hov || node.isAgent || node.status !== undefined) && (
        <Html position={[0, node.isAgent ? 0 : 1.5, 0]} center zIndexRange={[100, 0]} transform sprite>
          <div className="pointer-events-none select-none text-center">
            <div className="px-3 py-1.5 rounded-lg border backdrop-blur-md"
              style={{ background: 'rgba(0,0,0,0.84)', border: '1px solid rgba(255,255,255,0.22)', boxShadow: '0 0 14px rgba(255,255,255,0.1)', fontFamily: 'monospace' }}>
              <span className="text-[12px] font-black tracking-wider text-white">{node.label || node.id}</span>
              {node.isAgent && node.status && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${node.status === 'offline' ? 'bg-red-400' : node.status === 'degraded' ? 'bg-yellow-400' : 'bg-green-400'}`} />
                  <span className={`text-[9px] font-bold uppercase ${node.status === 'offline' ? 'text-red-400' : node.status === 'degraded' ? 'text-yellow-400' : 'text-green-400'}`}>{node.status}</span>
                </div>
              )}
            </div>
          </div>
        </Html>
      )}
      {/* Row count */}
      {node.rowCount !== undefined && !isAgentNode && (
        <Html position={[0, 0, 0]} center zIndexRange={[100, 0]} transform sprite>
          <div className="pointer-events-none select-none text-center drop-shadow-[0_0_8px_rgba(0,0,0,1)]">
            <span style={{ color: act > 0.25 ? '#ffffff' : 'rgba(210,245,255,0.78)', fontSize: 11, fontWeight: 900, fontFamily: 'monospace', textShadow: act > 0.25 ? '0 0 10px #fff,0 0 24px #fff' : 'none' }}>
              {node.rowCount.toLocaleString()}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
});
Node.displayName = 'Node';

// ─── Link ─────────────────────────────────────────────────────────────────────
const Link = ({ link, nodesMap, visualSettings }: { link: BrainLink; nodesMap: Map<string, BrainNode>; visualSettings: VisualSettings }) => {
  const s = nodesMap.get(link.source), e = nodesMap.get(link.target);
  const lRef = useRef<any>(null), pRef = useRef<THREE.Mesh>(null);
  const isFlow = link.type === 'flows', act = Math.max(s?.activity || 0, e?.activity || 0);
  useFrame((st) => {
    if (!s || !e) return;
    const t = st.clock.getElapsedTime();
    if (lRef.current?.material) lRef.current.material.opacity = (isFlow ? 0.45 : 0.22) * (visualSettings.linkOpacity / 0.38) + act * 0.38 + Math.sin(t * 4) * 0.05;
    if (pRef.current && act > 0) {
      const p = (t * (1.5 + act * 2.5)) % 1;
      pRef.current.position.set(s.x + (e.x - s.x) * p, s.y + (e.y - s.y) * p, s.z + (e.z - s.z) * p);
      const sc = 0.14 + act * 0.26; pRef.current.scale.set(sc, sc, sc);
    }
  });
  if (!s || !e) return null;
  return (
    <group>
      <DreiLine ref={lRef} points={[[s.x, s.y, s.z], [e.x, e.y, e.z]]}
        color={act > 0 ? '#ffffff' : visualSettings.linkColor}
        lineWidth={isFlow || act > 0 ? 1.4 : 0.45} transparent opacity={visualSettings.linkOpacity} />
      {act > 0 && <mesh ref={pRef}><sphereGeometry args={[0.22, 8, 8]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.95} blending={THREE.AdditiveBlending} /></mesh>}
    </group>
  );
};

// ─── Token Wave ───────────────────────────────────────────────────────────────
const TokenWave = ({ node, type, onComplete }: { node: BrainNode; type: 'in' | 'out'; startTime: number; onComplete: () => void }) => {
  const r1 = useRef<THREE.Mesh>(null), r2 = useRef<THREE.Mesh>(null), t0 = useRef(-1), dur = 0.9;
  useFrame((s) => {
    if (!r1.current) return;
    if (t0.current < 0) t0.current = s.clock.getElapsedTime();
    const t = Math.min(1, (s.clock.getElapsedTime() - t0.current) / dur);
    if (t >= 1) { r1.current.visible = false; if (r2.current) r2.current.visible = false; onComplete(); return; }
    const sc = type === 'out' ? 0.3 + t * 2.2 : 2.2 - t * 1.9;
    r1.current.scale.set(sc, sc, sc);
    (r1.current.material as THREE.MeshBasicMaterial).opacity = type === 'out' ? (1 - t) * 0.65 : t * 0.65;
    if (r2.current) {
      const s2 = type === 'out' ? 0.1 + t * 1.2 : 1.2 - t * 1.0;
      r2.current.scale.set(s2, s2, s2);
      (r2.current.material as THREE.MeshBasicMaterial).opacity = type === 'out' ? (1 - t) * 0.35 : t * 0.35;
    }
  });
  return (
    <group position={[node.x, node.y, node.z]}>
      <mesh ref={r1} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.4, 0.022, 16, 64]} /><meshBasicMaterial color={type === 'in' ? '#00ffff' : '#ffcc00'} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
      <mesh ref={r2}><torusGeometry args={[0.3, 0.015, 16, 48]} /><meshBasicMaterial color={type === 'in' ? '#88ffff' : '#ffee88'} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
    </group>
  );
};

// ─── Internal Cloud — strictly local-space inside hemisphere ellipsoid ─────────
const SHAPES = [
  () => new THREE.BoxGeometry(1, 1, 1),
  () => new THREE.TetrahedronGeometry(1, 0),
  () => new THREE.IcosahedronGeometry(1, 0),
  () => new THREE.DodecahedronGeometry(1, 0),
  () => new THREE.OctahedronGeometry(1, 0),
];

const StarryCloud = ({ pts, color, opacity = 0.22 }: { pts: { p: [number, number, number]; s: number }[]; color: string; opacity?: number }) => {
  const data = useMemo(() => {
    const c = new Float32Array(pts.length * 3), sz = new Float32Array(pts.length);
    pts.forEach((x, i) => { c[i * 3] = x.p[0]; c[i * 3 + 1] = x.p[1]; c[i * 3 + 2] = x.p[2]; sz[i] = x.s; });
    return { c, sz };
  }, [pts]);
  const sh = useMemo(() => ({
    uniforms: { uC: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
    vertexShader: `attribute float size; void main(){vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*(300.0/-mv.z); gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `uniform vec3 uC; uniform float uOpacity; void main(){float d=distance(gl_PointCoord,vec2(0.5)); if(d>0.5)discard; gl_FragColor=vec4(uC,(1.0-d*2.0)*uOpacity);}`,
  }), [color, opacity]);
  if (!pts.length) return null;
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[data.c, 3]} />
        <bufferAttribute attach="attributes-size" args={[data.sz, 1]} />
      </bufferGeometry>
      <shaderMaterial args={[sh]} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
};

const CrystalCloud = ({ geom, count, pts, color, opacity = 0.03 }: { geom: THREE.BufferGeometry; count: number; pts: { p: [number, number, number]; s: number }[]; color: string; opacity?: number }) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    if (!ref.current || !pts.length) return;
    pts.forEach((x, i) => { dummy.position.set(x.p[0], x.p[1], x.p[2]); dummy.scale.setScalar(x.s); dummy.rotation.set(i * 0.7, i * 1.1, i * 0.4); dummy.updateMatrix(); ref.current!.setMatrixAt(i, dummy.matrix); });
    ref.current.instanceMatrix.needsUpdate = true;
  }, [pts, dummy]);
  if (!count) return null;
  return (
    <instancedMesh ref={ref} args={[geom, undefined, count]}>
      <meshBasicMaterial color={color} transparent opacity={opacity} wireframe blending={THREE.AdditiveBlending} depthWrite={false} />
    </instancedMesh>
  );
};

// Points generated in LOCAL hemisphere space (origin = hemisphere center)
// using the EXACT same ellipsoid dimensions as the shell geometry.
const HemisphereInternalCloud = ({ tableNodes, isRight, baseColor, cloudOpacity }: {
  tableNodes: { id: string; rowCount: number }[]; isRight: boolean; baseColor: string; cloudOpacity: number;
}) => {
  const geoms = useMemo(() => SHAPES.map(f => f()), []);
  const MAX_RX = BRX * FILL, MAX_RY = BRY * FILL, MAX_RZ = BRZ * FILL;

  const data = useMemo(() => {
    const crystalGroups: { geom: THREE.BufferGeometry; pts: { p: [number, number, number]; s: number }[]; color: string }[] = [];
    const starGroups: { pts: { p: [number, number, number]; s: number }[]; color: string }[] = [];

    tableNodes.forEach((tbl, ti) => {
      const raw = tbl.rowCount || 0;
      const seed = tbl.id.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
      const cn = Math.min(700, raw), sn = Math.min(3500, Math.max(0, raw - 700));
      const cs = Math.max(0.06, Math.min(0.18, 0.32 / (1 + Math.log10(raw + 1))));
      const ss = Math.max(0.09, Math.min(0.54, 1.1 / (1 + Math.log10(raw + 1))));

      const gen = (i: number, off: number): [number, number, number] | null => {
        for (let a = 0; a < 60; a++) {
          const x = (sr(seed + a + off, i * 3) * 2 - 1) * MAX_RX;
          const y = (sr(seed + a + off, i * 3 + 1) * 2 - 1) * MAX_RY;
          const z = (sr(seed + a + off, i * 3 + 2) * 2 - 1) * MAX_RZ;
          // Ellipsoid rejection
          if ((x / MAX_RX) ** 2 + (y / MAX_RY) ** 2 + (z / MAX_RZ) ** 2 > 1.0) continue;
          // Keep on correct lateral half (with small medial gap)
          if (isRight && x < -MAX_RX * 0.06) continue;
          if (!isRight && x > MAX_RX * 0.06) continue;
          // Clip inferior edge (brainstem gap)
          if (y < -MAX_RY * 0.84) continue;
          return [x, y, z];
        }
        return null;
      };

      const cPts: { p: [number, number, number]; s: number }[] = [];
      const sPts: { p: [number, number, number]; s: number }[] = [];
      for (let i = 0; i < cn; i++) { const p = gen(i, 0); if (p) cPts.push({ p, s: cs }); }
      for (let i = 0; i < sn; i++) { const p = gen(i, 100); if (p) sPts.push({ p, s: ss }); }
      if (cPts.length) crystalGroups.push({ geom: geoms[ti % SHAPES.length], pts: cPts, color: baseColor });
      if (sPts.length) starGroups.push({ pts: sPts, color: baseColor });
    });
    return { crystalGroups, starGroups };
  }, [tableNodes, isRight, geoms, baseColor, MAX_RX, MAX_RY, MAX_RZ]);

  return (
    <>
      {data.crystalGroups.map((c, i) => <CrystalCloud key={`c${i}`} geom={c.geom} count={c.pts.length} pts={c.pts} color={c.color} opacity={cloudOpacity * 0.03} />)}
      {data.starGroups.map((s, i) => <StarryCloud key={`s${i}`} pts={s.pts} color={s.color} opacity={cloudOpacity * 0.22} />)}
    </>
  );
};

// ─── Brain Hemisphere — shell + internal cloud as ONE local group ─────────────
// position is set by parent group; everything inside is in local coords.
const BrainHemisphere = ({ isRight, color, accentColor, tableNodes, shellOpacity, cloudOpacity }: {
  isRight: boolean; color: string; accentColor: string;
  tableNodes: { id: string; rowCount: number }[];
  shellOpacity: number; cloudOpacity: number;
}) => {
  const mRef = useRef<THREE.Mesh>(null), wRef = useRef<THREE.Mesh>(null);
  const iRef = useRef<THREE.Mesh>(null), rRef = useRef<THREE.Mesh>(null);
  const ph = isRight ? 0 : Math.PI;

  useFrame((s) => {
    const t = s.clock.getElapsedTime();
    if (mRef.current) {
      const m = mRef.current.material as THREE.MeshPhysicalMaterial;
      m.emissiveIntensity = 0.038 + Math.sin(t * 0.88 + ph) * 0.022;
      m.opacity = shellOpacity + Math.sin(t * 1.05) * 0.007;
    }
    if (wRef.current) (wRef.current.material as THREE.MeshBasicMaterial).opacity = shellOpacity + Math.sin(t * 0.6 + 1.4) * 0.016;
    if (iRef.current) (iRef.current.material as THREE.MeshBasicMaterial).opacity = 0.013 + Math.sin(t * 0.75) * 0.006;
    if (rRef.current) {
      rRef.current.rotation.y += 0.004; rRef.current.rotation.z = Math.sin(t * 0.45) * 0.14;
      (rRef.current.material as THREE.MeshBasicMaterial).opacity = 0.07 + Math.sin(t * 1.7 + ph) * 0.035;
    }
  });

  // Shell geometry in local space (NO xOffset, NO yOffset)
  const geom = useMemo(() => {
    const g = new THREE.SphereGeometry(1, 96, 72);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const nx = pos.getX(i), ny = pos.getY(i), nz = pos.getZ(i);
      let x = nx * BRX, y = ny * BRY, z = nz * BRZ;
      const mN = isRight ? -nx : nx;
      if (mN > 0.05) { const f = Math.pow((mN - 0.05) / 0.95, 0.7); x *= (1 - f * 0.88); }
      if (ny < -0.35) { const d = (-ny - 0.35) / 0.65; y *= (1 - d * 0.55); if (Math.abs(nx) < 0.4 && Math.abs(nz) < 0.4) y -= d * 1.0; }
      const lat = isRight ? Math.max(0, nx - 0.1) : Math.max(0, -nx - 0.1);
      if (lat > 0 && ny < 0.1 && nz > -0.5 && nz < 0.6) { y -= lat * Math.max(0, 0.2 - ny) * 2.2; z += lat * 0.8; }
      if (nz < -0.5) { const o = (-nz - 0.5) / 0.5; z *= (1 + o * 0.15); x *= (1 - o * 0.2); }
      const bm = Math.min(1, (1 - mN * 1.2) * (1 - Math.max(0, (-ny - 0.2) * 1.5)));
      const gx = x * 0.14, gy = y * 0.17, gz = z * 0.12;
      const gyri = bm * (
        Math.sin(gx * 2.1 + gz * 1.6 + 1.1) * Math.cos(gz * 1.9 + gy * 0.8) * 0.75
        + Math.sin(gy * 2.5 + gx * 1.0 + 2.7) * Math.cos(gx * 1.5 + gz * 0.7) * 0.55
        + Math.cos(gz * 1.8 + gy * 2.1 + 0.4) * Math.sin(gy * 1.4 + gx * 0.5) * 0.38
        + Math.sin(gx * 3.8 + gy * 3.0 + gz * 2.5) * 0.18
      );
      const len = Math.sqrt(x * x + y * y + z * z) || 1, b = gyri * 0.62;
      pos.setXYZ(i, x + (x / len) * b, y + (y / len) * b, z + (z / len) * b);
    }
    g.computeVertexNormals(); return g;
  }, [isRight]);

  // Surface sparkle in local coords (slightly inside surface)
  const surf = useMemo(() => {
    const n = 700; const p = new Float32Array(n * 3); const sz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const phi = Math.acos(2 * Math.random() - 1), th = Math.random() * Math.PI * 2;
      const r = 0.90 + Math.random() * 0.07;
      p[i * 3] = Math.sin(phi) * Math.cos(th) * BRX * r * 0.94;
      p[i * 3 + 1] = Math.sin(phi) * Math.sin(th) * BRY * r * 0.94;
      p[i * 3 + 2] = Math.cos(phi) * BRZ * r * 0.94;
      sz[i] = 0.44 + Math.random() * 1.4;
    }
    return { p, sz };
  }, []);

  return (
    <group>
      {/* ① INTERNAL CLOUD — rendered BEFORE shell, stays inside because
           it's in local space and uses FILL fraction of the same ellipsoid axes */}
      <HemisphereInternalCloud tableNodes={tableNodes} isRight={isRight} baseColor={accentColor} cloudOpacity={cloudOpacity} />

      {/* ② Translucent shell surface */}
      <mesh ref={mRef} geometry={geom}>
        <meshPhysicalMaterial color={color} emissive={color} emissiveIntensity={0.038}
          transparent opacity={shellOpacity} roughness={0.15} metalness={0.2}
          depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {/* ③ Wireframe cortex */}
      <mesh ref={wRef} geometry={geom}>
        <meshBasicMaterial color={color} transparent opacity={shellOpacity} wireframe depthWrite={false} />
      </mesh>
      {/* ④ Back-face inner glow (Aurora - Disabled per user request) */}
      {/* <mesh ref={iRef} geometry={geom}>
        <meshBasicMaterial color={accentColor} transparent opacity={0.019}
          blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.BackSide} />
      </mesh> */}

      {/* ⑤ Orbital pulse ring (Disabled per user request) */}
      {/* <mesh ref={rRef} rotation={[Math.PI / 5, 0, 0]}>
        <torusGeometry args={[BRZ * 0.88, 0.065, 8, 128]} />
        <meshBasicMaterial color={accentColor} transparent opacity={0.10} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh> */}

      {/* ⑥ Surface circuit sparkles (Disabled per user request) */}
      {/* <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[surf.p, 3]} />
          <bufferAttribute attach="attributes-size" args={[surf.sz, 1]} />
        </bufferGeometry>
        <shaderMaterial args={[{
          uniforms: { uC: { value: new THREE.Color(accentColor) } },
          vertexShader: `attribute float size; void main(){vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=size*(192.0/-mv.z); gl_Position=projectionMatrix*mv;}`,
          fragmentShader: `uniform vec3 uC; void main(){float d=distance(gl_PointCoord,vec2(0.5)); if(d>0.5)discard; gl_FragColor=vec4(uC,(1.0-d*2.0)*0.50);}`,
        }]} transparent blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </points> */}
    </group>
  );
};

// ─── Brain Sulci (world-space, offset by hemisphere world pos) ────────────────
const BrainSulci = ({ isRight, color, hemPos }: { isRight: boolean; color: string; hemPos: [number, number, number] }) => {
  const ref = useRef<THREE.Group>(null);
  useFrame((s) => {
    const t = s.clock.getElapsedTime();
    ref.current?.children.forEach((c, i) => { const m = (c as any).material; if (m) m.opacity = 0.10 + Math.sin(t * 0.45 + i * 0.85) * 0.055; });
  });
  const lines = useMemo(() => {
    const defs = [{ phi: 0.28, st: -0.6, sp: 1.5 }, { phi: 0.55, st: -0.2, sp: 1.8 }, { phi: 0.18, st: 0.5, sp: 1.2 },
    { phi: -0.30, st: -1.1, sp: 1.0 }, { phi: 0.65, st: 0.2, sp: 1.4 }, { phi: 0.32, st: -0.2, sp: 1.0 }];
    return defs.map(({ phi, st, sp }) => {
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= 32; i++) {
        const t = i / 32, th = st + t * sp, r = 0.86;
        pts.push([hemPos[0] + BRX * r * Math.cos(phi) * Math.cos(th), hemPos[1] + BRY * r * Math.sin(phi), hemPos[2] + BRZ * r * Math.cos(phi) * Math.sin(th)]);
      }
      return pts;
    });
  }, [hemPos]);
  return <group ref={ref}>{lines.map((p, i) => <DreiLine key={i} points={p} color={color} lineWidth={0.65} transparent opacity={0.10} />)}</group>;
};

// ─── Corpus Callosum — draggable central axis ─────────────────────────────────
// Rendered as child of a group positioned at corpusPos.
// Receives left/right positions relative to its own group origin.
const CorpusCallosum = ({ leftRel, rightRel }: { leftRel: [number, number, number]; rightRel: [number, number, number] }) => {
  const ref = useRef<THREE.Group>(null);
  const arcs = useMemo(() => {
    const out = [];
    for (let i = 0; i < 18; i++) {
      const t = i / 18, ang = t * Math.PI * 2, R = BRZ * 0.8;
      const lx = leftRel[0] + R * Math.cos(ang) * 0.44, ly = leftRel[1] + R * Math.sin(ang) * 0.50, lz = leftRel[2] + R * Math.sin(ang) * 0.34;
      const rx = rightRel[0] + R * Math.cos(ang + Math.PI * 0.27) * 0.44, ry = rightRel[1] + R * Math.sin(ang + Math.PI * 0.27) * 0.50, rz = rightRel[2] + R * Math.sin(ang + Math.PI * 0.27) * 0.34;
      const h = 4.2 + Math.sin(ang * 3) * 2.8;
      const pts: [number, number, number][] = [];
      for (let s = 0; s <= 24; s++) { const u = s / 24; pts.push([lx + (rx - lx) * u, ly + (ry - ly) * u + Math.sin(u * Math.PI) * h, lz + (rz - lz) * u]); }
      out.push({ pts, color: `hsl(${Math.round(t * 310 + 160)},92%,66%)`, ph: i * 0.42 });
    }
    return out;
  }, [leftRel, rightRel]);

  useFrame((s) => {
    const t = s.clock.getElapsedTime();
    ref.current?.children.forEach((c: any, i) => { if (c.material) c.material.opacity = Math.max(0.018, 0.085 + Math.sin(t * 0.62 + (arcs[i]?.ph || 0)) * 0.062); });
  });

  return (
    <>
      <group ref={ref}>{arcs.map((a, i) => <DreiLine key={i} points={a.pts} color={a.color} lineWidth={0.5} transparent opacity={0.07} />)}</group>
      {/* Central midline torus — visual "axis" marker */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.6, 0.055, 8, 64]} />
        <meshBasicMaterial color="#c084fc" transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </>
  );
};

// ─── Brain Stem ───────────────────────────────────────────────────────────────
const BrainStem = () => {
  const sRef = useRef<THREE.Mesh>(null), gRef = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    const t = s.clock.getElapsedTime();
    if (sRef.current) (sRef.current.material as THREE.MeshPhysicalMaterial).emissiveIntensity = 0.28 + Math.sin(t * 2.1) * 0.13;
    if (gRef.current) (gRef.current.material as THREE.MeshBasicMaterial).opacity = 0.055 + Math.sin(t * 1.4) * 0.032;
  });
  return (
    <group>
      <mesh ref={sRef} position={[0, -7.2, 1.4]}><cylinderGeometry args={[0.5, 1.1, 5, 12]} /><meshPhysicalMaterial color="#6d28d9" emissive="#a78bfa" emissiveIntensity={0.28} transparent opacity={0.58} roughness={0.25} metalness={0.7} /></mesh>
      <mesh ref={gRef} position={[0, -7.2, 1.4]}><cylinderGeometry args={[1.3, 2.4, 5.5, 12]} /><meshBasicMaterial color="#7c3aed" transparent opacity={0.055} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
      {[0, 1, 2, 3].map(i => <SRing key={i} y={-5.4 + i * -1.2} r={0.68 + i * 0.13} ph={i * 0.8} col={i % 2 === 0 ? '#22d3ee' : '#a78bfa'} />)}
    </group>
  );
};
const SRing = ({ y, r, ph, col }: { y: number; r: number; ph: number; col: string }) => {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((s) => {
    if (!ref.current) return;
    const t = s.clock.getElapsedTime();
    (ref.current.material as THREE.MeshBasicMaterial).opacity = 0.17 + Math.sin(t * 2.4 + ph) * 0.15;
    ref.current.position.y = y + Math.sin(t * 1.5 + ph) * 0.44;
  });
  return <mesh ref={ref} position={[0, y, 1.4]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[r, 0.038, 8, 24]} /><meshBasicMaterial color={col} transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>;
};

// ─── Global aura rings ────────────────────────────────────────────────────────
const GlobalBrainAura = () => {
  const refs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  useFrame((s) => {
    const t = s.clock.getElapsedTime();
    refs.forEach((r, i) => {
      if (r.current) {
        r.current.rotation.y = t * 0.08 * (i % 2 ? -1 : 1); r.current.rotation.x = t * 0.05 + i * 0.7;
        (r.current.material as THREE.MeshBasicMaterial).opacity = 0.02 + Math.sin(t * 0.6 + i * 2.1) * 0.012;
      }
    });
  });
  return (
    <group position={[0, 2, 0]}>
      <mesh ref={refs[0]}><torusGeometry args={[22, 0.09, 6, 128]} /><meshBasicMaterial color="#c026d3" transparent opacity={0.02} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
      <mesh ref={refs[1]} rotation={[Math.PI / 3, 0, 0]}><torusGeometry args={[20, 0.075, 6, 128]} /><meshBasicMaterial color="#0891b2" transparent opacity={0.02} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
      <mesh ref={refs[2]} rotation={[Math.PI / 6, Math.PI / 4, 0]}><torusGeometry args={[18, 0.055, 6, 128]} /><meshBasicMaterial color="#7c3aed" transparent opacity={0.016} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
    </group>
  );
};

// ─── Main 3-D Scene ───────────────────────────────────────────────────────────
const NeuralNetwork = ({
  data, activityMap, tokenPulses, onPulseComplete,
  isEditMode, overrides, onOverrideChange,
  hemOverrides, onHemOverrideChange,
  corpusOverride, onCorpusOverrideChange,
  visualSettings,
}: {
  data: { nodes: any[]; links: any[] };
  activityMap: Record<string, number>;
  tokenPulses: TokenPulseData[];
  onPulseComplete: (id: string) => void;
  isEditMode: boolean;
  overrides: Record<string, { x: number; y: number; z: number }>;
  onOverrideChange: (id: string, pos: { x: number; y: number; z: number }) => void;
  hemOverrides: Record<string, [number, number, number]>;
  onHemOverrideChange: (id: string, pos: [number, number, number]) => void;
  corpusOverride: [number, number, number];
  onCorpusOverrideChange: (pos: [number, number, number]) => void;
  visualSettings: VisualSettings;
}) => {
  const [hovered, setHovered] = useState<BrainNode | null>(null);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selHem, setSelHem] = useState<string | null>(null);
  const [selCorpus, setSelCorpus] = useState(false);
  const nodeRefs = useRef<Map<string, THREE.Group>>(new Map());
  const hemRefs = useRef<Map<string, THREE.Group>>(new Map());
  const corpusRef = useRef<THREE.Group>(null);
  const posCache = useRef<Map<string, { x: number; y: number; z: number }>>(new Map());
  const dNode = useRef(false), dHem = useRef(false), dCorpus = useRef(false);

  const LP = hemOverrides['left'] || [-7, 2, 0] as [number, number, number];
  const RP = hemOverrides['right'] || [7, 2, 0] as [number, number, number];
  // Corpus default = midpoint of hemispheres (only use override if it's been set)
  const CP: [number, number, number] = (corpusOverride[0] !== 0 || corpusOverride[1] !== 0 || corpusOverride[2] !== 0)
    ? corpusOverride : [(LP[0] + RP[0]) / 2, (LP[1] + RP[1]) / 2, (LP[2] + RP[2]) / 2];

  const botAnchor = useMemo<BrainNode>(() => ({
    id: 'bot-manager', summary: 'BotManager',
    x: (overrides['bot-manager'] || { x: 10, y: 12, z: -8 }).x,
    y: (overrides['bot-manager'] || { x: 10, y: 12, z: -8 }).y,
    z: (overrides['bot-manager'] || { x: 10, y: 12, z: -8 }).z,
    color: '#a855f7', activity: 1,
  }), [overrides]);

  const activeTbl = useMemo(() => (data?.nodes || []).filter((n: any) => n.layer === 'active' || (n.layer === 'infra' && !n.isAgent)).map((n: any) => ({ id: n.id, rowCount: n.rowCount || 0 })), [data]);
  const dataTbl = useMemo(() => (data?.nodes || []).filter((n: any) => n.layer === 'data').map((n: any) => ({ id: n.id, rowCount: n.rowCount || 0 })), [data]);

  const processedNodes = useMemo(() => {
    if (!data?.nodes?.length) return [];
    const place = (list: any[], base: [number, number, number], defColor: string) => {
      const total = list.reduce((a, n) => a + (n.rowCount || 0), 0);
      const vf = 1 + Math.log10(total + 1) * 0.18;
      const Rx = BRX * vf * 0.88, Ry = BRY * vf * 0.88, Rz = BRZ * vf * 0.88;
      const N = Math.max(1, list.length);
      const sh = list.map((_, i) => i).sort((a, b) => (a * 1.618 % 1) - (b * 1.618 % 1));
      return list.map((n, i) => {
        let x: number, y: number, z: number;
        if (overrides[n.id]) ({ x, y, z } = overrides[n.id]);
        else if (posCache.current.has(n.id)) ({ x, y, z } = posCache.current.get(n.id)!);
        else {
          const si = sh[i], r = Math.pow((si + 0.5) / N, 1 / 3);
          const phi = Math.acos(1 - 2 * (si + 0.5) / N), th = Math.PI * (3 - Math.sqrt(5)) * si;
          x = Rx * r * Math.sin(phi) * Math.cos(th) + base[0];
          y = Ry * r * Math.cos(phi) + base[1];
          z = Rz * r * Math.sin(phi) * Math.sin(th) + base[2];
        }
        posCache.current.set(n.id, { x, y, z });
        return { id: n.id, summary: n.summary, label: n.label, rowCount: n.rowCount, layer: n.layer, x, y, z, color: n.color || defColor, activity: activityMap[n.id] || 0, status: n.status, isAgent: n.isAgent };
      });
    };
    return [...place(data.nodes.filter(n => n.layer === 'active' || (n.layer === 'infra' && !n.isAgent)), LP, '#ff33ff'),
    ...place(data.nodes.filter(n => n.layer === 'data'), RP, '#00ffff')];
  }, [data, activityMap, LP, RP, overrides]);

  const nodesMap = useMemo(() => { const m = new Map<string, BrainNode>(); processedNodes.forEach(n => m.set(n.id, n)); return m; }, [processedNodes]);
  const stopO = () => { (window as any).orbitControls?.let?.((o: any) => o.enabled = false) || ((window as any).orbitControls && ((window as any).orbitControls.enabled = false)); };
  const startO = () => { (window as any).orbitControls && ((window as any).orbitControls.enabled = true); };

  return (
    <>
      {/* Left hemisphere — whole group is the draggable unit */}
      <group ref={el => { if (el) hemRefs.current.set('left', el); }} position={LP}>
        <BrainHemisphere isRight={false} color={visualSettings.leftHemColor} accentColor={visualSettings.leftCloudColor}
          tableNodes={activeTbl} shellOpacity={visualSettings.leftHemOpacity} cloudOpacity={visualSettings.leftCloudOpacity} />
        {isEditMode && <mesh renderOrder={-1}
          onClick={e => { e.stopPropagation(); setSelHem(selHem === 'left' ? null : 'left'); setSelNode(null); setSelCorpus(false); }}>
          <sphereGeometry args={[9.5, 16, 16]} />
          <meshBasicMaterial color={visualSettings.leftHemColor} transparent opacity={selHem === 'left' ? 0.07 : 0.014} depthWrite={false} side={THREE.BackSide} />
        </mesh>}
      </group>

      {/* Right hemisphere */}
      <group ref={el => { if (el) hemRefs.current.set('right', el); }} position={RP}>
        <BrainHemisphere isRight={true} color={visualSettings.rightHemColor} accentColor={visualSettings.rightCloudColor}
          tableNodes={dataTbl} shellOpacity={visualSettings.rightHemOpacity} cloudOpacity={visualSettings.rightCloudOpacity} />
        {isEditMode && <mesh renderOrder={-1}
          onClick={e => { e.stopPropagation(); setSelHem(selHem === 'right' ? null : 'right'); setSelNode(null); setSelCorpus(false); }}>
          <sphereGeometry args={[9.5, 16, 16]} />
          <meshBasicMaterial color={visualSettings.rightHemColor} transparent opacity={selHem === 'right' ? 0.07 : 0.014} depthWrite={false} side={THREE.BackSide} />
        </mesh>}
      </group>

      {/* TransformControls — hemisphere */}
      {isEditMode && selHem && hemRefs.current.get(selHem) && (
        <TransformControls object={hemRefs.current.get(selHem)}
          onMouseDown={() => { dHem.current = true; stopO(); }}
          onMouseUp={() => { dHem.current = false; startO(); }}
          onObjectChange={(e: any) => { if (!dHem.current) return; const p = e.target.object.position; onHemOverrideChange(selHem, [p.x, p.y, p.z]); }} />
      )}

      {/* Corpus Callosum + Brain Stem — single draggable group at CP */}
      <group ref={corpusRef} position={CP}>
        <CorpusCallosum
          leftRel={[LP[0] - CP[0], LP[1] - CP[1], LP[2] - CP[2]]}
          rightRel={[RP[0] - CP[0], RP[1] - CP[1], RP[2] - CP[2]]} />
        <BrainStem />
        {/* Click target */}
        {isEditMode && <mesh onClick={e => { e.stopPropagation(); setSelCorpus(!selCorpus); setSelHem(null); setSelNode(null); }}>
          <sphereGeometry args={[2.8, 12, 12]} />
          <meshBasicMaterial color="#a78bfa" transparent opacity={selCorpus ? 0.14 : 0.028} depthWrite={false} />
        </mesh>}
        {/* Always-visible axis dot */}
        <mesh>
          <sphereGeometry args={[0.35, 12, 12]} />
          <meshBasicMaterial color="#c084fc" transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      </group>

      {/* TransformControls — corpus/brainstem */}
      {isEditMode && selCorpus && corpusRef.current && (
        <TransformControls object={corpusRef.current}
          onMouseDown={() => { dCorpus.current = true; stopO(); }}
          onMouseUp={() => { dCorpus.current = false; startO(); }}
          onObjectChange={(e: any) => { if (!dCorpus.current) return; const p = e.target.object.position; onCorpusOverrideChange([p.x, p.y, p.z]); }} />
      )}

      {/* Sulci (world-space, follow hemisphere positions) */}
      <BrainSulci isRight={false} color="#f0abfc" hemPos={LP} />
      <BrainSulci isRight={true} color="#67e8f9" hemPos={RP} />

      {/* Labels */}
      <Html position={[LP[0] - 1, LP[1] - 9, LP[2]]} center transform sprite>
        <div className="pointer-events-none select-none text-center">
          <div className="px-5 py-2 rounded-xl backdrop-blur-md" style={{ background: 'linear-gradient(135deg,rgba(88,28,135,0.75),rgba(134,25,143,0.55))', border: '1px solid rgba(240,171,252,0.45)', boxShadow: '0 0 24px rgba(192,38,211,0.5)' }}>
            <div className="text-white text-sm font-black tracking-widest" style={{ fontFamily: 'monospace', textShadow: '0 0 12px #e879f9' }}>FIRST BRAIN</div>
            <div className="text-fuchsia-300 text-[9px] tracking-wider">◈ CORE PROCESSING SYSTEM ◈</div>
          </div>
        </div>
      </Html>
      <Html position={[RP[0] + 1.8, RP[1] - 9, RP[2]]} center transform sprite>
        <div className="pointer-events-none select-none text-center">
          <div className="px-5 py-2 rounded-xl backdrop-blur-md" style={{ background: 'linear-gradient(135deg,rgba(8,59,90,0.75),rgba(6,82,110,0.55))', border: '1px solid rgba(103,232,249,0.45)', boxShadow: '0 0 24px rgba(8,145,178,0.5)' }}>
            <div className="text-white text-sm font-black tracking-widest" style={{ fontFamily: 'monospace', textShadow: '0 0 12px #22d3ee' }}>SECOND BRAIN</div>
            <div className="text-cyan-300 text-[9px] tracking-wider">◈ SELF-UPGRADE INTELLIGENCE ◈</div>
          </div>
        </div>
      </Html>

      {/* White nodes (rendered last = on top of cloud) */}
      {processedNodes.map(node => (
        <Node key={node.id} node={node} onHover={setHovered}
          visualSettings={visualSettings}
          ref={el => { if (el) nodeRefs.current.set(node.id, el); else nodeRefs.current.delete(node.id); }}
          onClick={isEditMode ? (e: any) => {
            setSelNode(node.id === selNode ? null : node.id);
            setSelHem(null); setSelCorpus(false);
          } : undefined} />
      ))}

      {/* TransformControls — node */}
      {isEditMode && selNode && nodeRefs.current.get(selNode) && (
        <TransformControls object={nodeRefs.current.get(selNode)}
          onMouseDown={() => { dNode.current = true; stopO(); }}
          onMouseUp={() => { dNode.current = false; startO(); }}
          onObjectChange={(e: any) => { if (!dNode.current) return; const p = e.target.object.position; onOverrideChange(selNode, { x: p.x, y: p.y, z: p.z }); }} />
      )}

      {Array.isArray(data?.links) && data.links.map((l, i) => <Link key={i} link={l} nodesMap={nodesMap} visualSettings={visualSettings} />)}
      {tokenPulses.map(p => <TokenWave key={p.id} node={botAnchor} type={p.type} startTime={p.startTime} onComplete={() => onPulseComplete(p.id)} />)}

      {hovered && (
        <Html position={[hovered.x, hovered.y + 2.2, hovered.z]} center>
          <div className="p-2 rounded-xl text-white text-xs whitespace-nowrap pointer-events-none backdrop-blur-md"
            style={{ background: 'rgba(0,0,0,0.88)', border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 0 22px rgba(255,255,255,0.09)', fontFamily: 'monospace' }}>
            <div className="font-bold mb-0.5 text-white" style={{ textShadow: '0 0 8px #fff' }}>{hovered.id.split('/').pop()}</div>
            <div className="opacity-55 text-[10px]">{hovered.summary?.substring(0, 48)}…</div>
            {hovered.rowCount !== undefined && <div className="text-cyan-300 text-[10px] mt-0.5 font-bold">{hovered.rowCount.toLocaleString()} rows</div>}
          </div>
        </Html>
      )}
    </>
  );
};

// ─── Settings UI Helpers ──────────────────────────────────────────────────────
const SettingsSection = ({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) => (
  <div>
    <div className="text-[10px] font-black tracking-widest uppercase mb-2" style={{ fontFamily: 'monospace', color: accent }}>
      {title}
    </div>
    <div className="flex flex-col gap-2 pl-1">
      {children}
    </div>
  </div>
);

const ColorOpacityRow = <K extends keyof VisualSettings>({
  label, colorKey, opacityKey, settings, update, min, max, step,
}: {
  label: string;
  colorKey: K;
  opacityKey: K;
  settings: VisualSettings;
  update: <KK extends keyof VisualSettings>(key: KK, val: VisualSettings[KK]) => void;
  min: number; max: number; step: number;
}) => {
  const colorVal = settings[colorKey] as string;
  const opacityVal = settings[opacityKey] as number;
  const pct = Math.round(((opacityVal - min) / (max - min)) * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="text-white/40 text-[10px] w-10 shrink-0" style={{ fontFamily: 'monospace' }}>{label}</span>
      {/* Color picker */}
      <label className="relative cursor-pointer shrink-0">
        <div className="w-6 h-6 rounded-md border border-white/20 shadow-inner overflow-hidden" style={{ background: colorVal }}>
          <input type="color" value={colorVal} onChange={e => update(colorKey, e.target.value as any)}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
        </div>
      </label>
      {/* Opacity slider */}
      <div className="flex-1 flex items-center gap-2">
        <input type="range" min={min} max={max} step={step} value={opacityVal}
          onChange={e => update(opacityKey, parseFloat(e.target.value) as any)}
          className="flex-1 h-1 appearance-none rounded-full cursor-pointer"
          style={{ accentColor: colorVal }} />
        <span className="text-white/35 text-[10px] w-8 text-right shrink-0" style={{ fontFamily: 'monospace' }}>
          {opacityVal <= 1 && max <= 1 ? Math.round(opacityVal * 100) + '%' : opacityVal.toFixed(3)}
        </span>
      </div>
    </div>
  );
};

// ─── Page Component ───────────────────────────────────────────────────────────
const BrainVisualizer: React.FC = () => {
  const [data, setData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] });
  const [activityMap, setActivityMap] = useState<Record<string, number>>({});
  const [tokenPulses, setTokenPulses] = useState<TokenPulseData[]>([]);
  const [isEditMode, setIsEditMode] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [visualSettings, setVisualSettings] = useState<VisualSettings>(() => {
    try { const s = localStorage.getItem('brain_visual_settings'); if (s) return { ...DEFAULT_SETTINGS, ...JSON.parse(s) }; } catch { }
    return DEFAULT_SETTINGS;
  });
  const updateVisualSetting = <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => {
    setVisualSettings(prev => {
      const next = { ...prev, [key]: value };
      localStorage.setItem('brain_visual_settings', JSON.stringify(next));
      return next;
    });
  };
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistToServer = (ovs: any, hems: any, corp: any) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      api.saveBrainOverrides({ overrides: ovs, hemOverrides: hems, corpusOverride: corp })
        .catch(err => console.error('[BV] Sync Error:', err));
    }, 1000);
  };

  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number; z: number }>>(() => {
    try { const s = localStorage.getItem('brain_visualizer_overrides'); if (s) return JSON.parse(s); } catch { }
    return {
      'bot-manager': { x: 8, y: 10, z: -6 }, 'jarvis-root-admin': { x: -18, y: 8, z: 10 },
      'aider-cli': { x: -14, y: -3, z: 10 }, 'claude-cli': { x: -10, y: -6, z: -8 },
      'gemini-cli': { x: -7, y: 6, z: -10 }, 'codex-cli': { x: -16, y: -5, z: -8 },
      'openai-cli': { x: -13, y: -12, z: 4 }, 'qwen-cli': { x: -6, y: 5, z: -12 },
      'opencode-cli': { x: -8, y: -10, z: 8 }, 'ollama-cli': { x: -3, y: -12, z: 5 },
      'llm-cli': { x: -11, y: -8, z: 11 }, 'line-bot': { x: -7, y: 10, z: 5 },
      'telegram-bot': { x: -8, y: 11, z: -6 }, 'fb-extension': { x: -6, y: 8, z: -8 },
      'codebase_embeddings': { x: 9, y: 3, z: 4 }, 'codebase_edges': { x: 7, y: 2, z: 1 },
      'codebase_map': { x: 10, y: -1, z: 1 }, 'codebase_calls': { x: 8, y: -2, z: 3 },
      'upgrade_proposals': { x: 6, y: -4, z: -5 }, 'upgrade_scan_log': { x: 5, y: 1, z: -6 },
      'evolution_log': { x: 4, y: -1, z: 1 }, 'goals': { x: -6, y: -3, z: -5 },
      'knowledge_edges': { x: -8, y: 4, z: 3 }, 'episodes': { x: -9, y: 0, z: -3 },
      
      // Additional Active/Brain 1 nodes
      'conversations': { x: -10, y: 1, z: 5 }, 'messages': { x: -8, y: -2, z: 6 },
      'core_memory': { x: -12, y: 2, z: 2 }, 'archival_memory': { x: -14, y: 0, z: -2 },
      'knowledge': { x: -11, y: 5, z: 0 }, 'knowledge_nodes': { x: -13, y: 3, z: -4 },
      'user_profiles': { x: -15, y: -3, z: 3 }, 'learning_journal': { x: -12, y: -5, z: -4 },
      'agent_plans': { x: -9, y: -8, z: 0 }, 'activity_logs': { x: -16, y: 1, z: 6 },
      'usage_tracking': { x: -11, y: -10, z: -6 }, 'persistent_queue': { x: 0, y: -12, z: 8 },
      'cron_jobs': { x: 2, y: -13, z: 5 },
    };
  });

  const [hemOverrides, setHemOverrides] = useState<Record<string, [number, number, number]>>(() => {
    try { const s = localStorage.getItem('brain_hem_overrides'); if (s) return JSON.parse(s); } catch { }
    return { left: [-7, 2, 0], right: [7, 2, 0] };
  });

  const [corpusOverride, setCorpusOverride] = useState<[number, number, number]>(() => {
    try { const s = localStorage.getItem('brain_corpus_override'); if (s) return JSON.parse(s); } catch { }
    return [0, 0, 0];
  });

  // Load overrides from server on component mount
  useEffect(() => {
    api.getBrainOverrides().then(res => {
      if (res && res.overrides && Object.keys(res.overrides).length > 0) {
        setOverrides(res.overrides);
        if (res.hemOverrides) setHemOverrides(res.hemOverrides);
        if (res.corpusOverride) setCorpusOverride(res.corpusOverride);
        // Fallback sync to local storage
        localStorage.setItem('brain_visualizer_overrides', JSON.stringify(res.overrides));
        if (res.hemOverrides) localStorage.setItem('brain_hem_overrides', JSON.stringify(res.hemOverrides));
        if (res.corpusOverride) localStorage.setItem('brain_corpus_override', JSON.stringify(res.corpusOverride));
      }
    }).catch(err => console.error('[BV] Failed to fetch server overrides:', err));
  }, []);

  const handleOverride = (id: string, pos: { x: number; y: number; z: number }) => {
    setOverrides(p => {
      const n = { ...p, [id]: pos };
      localStorage.setItem('brain_visualizer_overrides', JSON.stringify(n));
      persistToServer(n, hemOverrides, corpusOverride);
      return n;
    });
  };
  const handleHemOverride = (id: string, pos: [number, number, number]) => {
    setHemOverrides(p => {
      const n = { ...p, [id]: pos };
      localStorage.setItem('brain_hem_overrides', JSON.stringify(n));
      persistToServer(overrides, n, corpusOverride);
      return n;
    });
  };
  const handleCorpusOverride = (pos: [number, number, number]) => {
    setCorpusOverride(pos);
    localStorage.setItem('brain_corpus_override', JSON.stringify(pos));
    persistToServer(overrides, hemOverrides, pos);
  };

  const { on } = useSocket();
  const agentStatus = useRef<Record<string, string>>({});

  useEffect(() => {
    let tid: ReturnType<typeof setInterval>;
    const flashNode = (path: string) => {
      if (!path || typeof path !== 'string') return;
      let id = path.trim();
      const al: Record<string, string> = { facebook_messages_v2: 'messages', personas_v2: 'personas', conversations_v2: 'conversations', activity_logs_v2: 'activity_logs', user_profiles_v2: 'user_profiles', knowledge_nodes_v2: 'knowledge_nodes', long_term_memory_v2: 'archival_memory', core_memory_v2: 'core_memory', code_map_v2: 'codebase_map', 'facebook-messenger': 'fb-extension' };
      const a = al[id.toLowerCase()]; if (a) id = a;
      if (id.toLowerCase().includes('telegram')) id = 'telegram-bot';
      if (id.toLowerCase().includes('line')) id = 'line-bot';
      if (id.toLowerCase().includes('facebook') || id.toLowerCase().includes('messenger')) id = 'fb-extension';
      const np = id.replace(/\\/g, '/'), iF = /[\\/]|\.([cm]?tsx?|jsx?|py|go|rs|java|json|md)$/i.test(id);
      const fid = id.startsWith('File:') ? id : `File: ${np}`;
      setActivityMap(p => { const n = { ...p, [id]: 1.0 }; if (iF) n[fid] = 1.0; return n; });
      setTimeout(() => setActivityMap(p => { const n = { ...p }; delete n[id]; if (iF) delete n[fid]; return n; }), 2000);
    };
    const fetch = () => api.getBrainGraph().then(res => {
      if (!res || !Array.isArray(res.nodes)) return;
      const cur = agentStatus.current['bot-manager'] || 'active';
      if (!res.nodes.some((n: any) => n.id === 'bot-manager'))
        res.nodes.push({ id: 'bot-manager', label: 'BotManager', summary: 'Self-Upgrade controller.', layer: 'infra', isAgent: true, status: cur });
      else res.nodes = res.nodes.map((n: any) => n.id === 'bot-manager' ? { ...n, status: cur, layer: 'infra' } : n);
      ['upgrade_proposals', 'upgrade_scan_log', 'codebase_map', 'codebase_embeddings'].forEach(t => {
        if (!res.links.some((l: any) => l.source === 'bot-manager' && l.target === t))
          res.links.push({ source: 'bot-manager', target: t, type: 'flows', weight: 0.5 });
      });
      setData(res);
    }).catch(e => console.error('[BV]', e));

    fetch(); tid = setInterval(fetch, 5000);
    const cu = on('agent:toolStarted', (d: any) => { if (d.filePath) flashNode(d.filePath); if (d.agentId) flashNode(d.agentId); if (d.agentName) flashNode(d.agentName); });
    const ce = on('evolution:started', (d: any) => {
      if (d.filePath) flashNode(d.filePath);
      const st = d.actionType === 'scanning' ? 'Scanning...' : 'Coding...';
      agentStatus.current['bot-manager'] = st;
      setData(p => ({ ...p, nodes: p.nodes.map((n: any) => n.id === 'bot-manager' ? { ...n, status: st } : n) })); flashNode('bot-manager');
    });
    const cef = on('evolution:finished', () => {
      agentStatus.current['bot-manager'] = 'active';
      setData(p => ({ ...p, nodes: p.nodes.map((n: any) => n.id === 'bot-manager' ? { ...n, status: 'active' } : n) }));
    });
    const ca = on('agent:active', (d: any) => { if (d.agentId) flashNode(d.agentId); });
    const cd = on('db:access', (d: any) => { if (d.table) flashNode(d.table); });
    const ct = on('agent:tokenUsage', (d: any) => {
      const now = performance.now() / 1000, ps: TokenPulseData[] = [];
      if (d.promptTokens > 0) ps.push({ id: `in-${Math.random()}`, type: 'in', startTime: now });
      if (d.completionTokens > 0) ps.push({ id: `out-${Math.random()}`, type: 'out', startTime: now });
      if (ps.length) setTokenPulses(p => [...p.slice(-10), ...ps]); flashNode('bot-manager');
    });
    return () => { clearInterval(tid); cu(); ce(); cef(); ca(); cd(); ct(); };
  }, [on]);

  // Simulation Logic: Randomly activate 1-2 nodes periodically
  useEffect(() => {
    if (!isSimulating) return;
    const interval = setInterval(() => {
      const nodeList = data?.nodes || [];
      if (nodeList.length === 0) return;
      
      const count = Math.floor(Math.random() * 2) + 1;
      for (let i = 0; i < count; i++) {
        const node = nodeList[Math.floor(Math.random() * nodeList.length)];
        if (!node) continue;
        const id = node.id;
        
        setActivityMap(p => ({ ...p, [id]: 1.0 }));
        setTimeout(() => {
          setActivityMap(p => { const n = { ...p }; delete n[id]; return n; });
        }, 1200);
      }
    }, 1800);
    return () => clearInterval(interval);
  }, [isSimulating, data.nodes]);

  const activeInfra = useMemo(() => {
    const PRI: Record<string, number> = { 'jarvis-root-admin': 1, 'bot-manager': 2, 'telegram-bot': 3, 'line-bot': 4, 'fb-extension': 5 };
    return (data?.nodes || []).filter((n: any) => (n.layer === 'infra' || n.isAgent || n.status !== undefined) && n.status && n.status !== 'offline')
      .map((n: any) => ({ ...n, activity: activityMap[n.id] || 0, sort: PRI[n.id] || 100 })).sort((a: any, b: any) => a.sort - b.sort);
  }, [data, activityMap]);

  const filteredData = useMemo(() => {
    const nodes = (data?.nodes || []).filter((n: any) => (n.layer !== 'infra' && !n.isAgent) || (n.layer === 'infra' && !n.isAgent));
    const links = (data?.links || []).filter((l: any) => {
      const s = data?.nodes.find((n: any) => n.id === l.source), t = data?.nodes.find((n: any) => n.id === l.target);
      const sOk = s && (!s.isAgent);
      const tOk = t && (!t.isAgent);
      return sOk && tOk;
    });
    return { nodes, links };
  }, [data]);

  return (
    <div className="w-full h-full relative overflow-hidden font-sans" style={{ background: '#010208' }}>
      <div className="absolute inset-0 z-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 80% 60% at 30% 40%,rgba(120,0,180,0.05) 0%,transparent 60%),radial-gradient(ellipse 70% 50% at 70% 55%,rgba(0,100,180,0.05) 0%,transparent 60%),#010208' }} />
      <div className="absolute inset-0 z-10 pointer-events-none" style={{ backgroundImage: 'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.06) 2px,rgba(0,0,0,0.06) 4px)', mixBlendMode: 'multiply' }} />
      <div className="absolute inset-0 z-10 pointer-events-none" style={{ background: 'radial-gradient(ellipse at center,transparent 48%,rgba(1,2,8,0.94) 100%)' }} />

      <div className="absolute top-0 left-0 w-full z-50 p-2 sm:p-3 pointer-events-none">
        <div className="flex items-center justify-center gap-2 overflow-x-auto no-scrollbar pb-1">
          {activeInfra.map((a: any) => (
            <div key={a.id} className={`flex items-center gap-2 px-3 py-1 rounded-full backdrop-blur-md border whitespace-nowrap pointer-events-auto shadow-sm ${a.status === 'degraded' ? 'bg-yellow-500/10 border-yellow-500/30' : a.id === 'bot-manager' ? 'bg-purple-500/20 border-purple-500/40' : 'bg-blue-500/10 border-blue-500/30'}`} style={{ fontFamily: 'monospace' }}>
              <div className={`w-1.5 h-1.5 rounded-full ${a.status === 'degraded' ? 'bg-yellow-400' : 'bg-green-400'} ${a.activity > 0 ? 'animate-pulse' : ''}`} />
              <span className="text-white text-[10px] font-black tracking-tight uppercase">{a.label || a.id}</span>
              {a.activity > 0 && <div className="w-4 h-0.5 bg-cyan-400/60 rounded-full animate-pulse" />}
            </div>
          ))}
          {activeInfra.length === 0 && <div className="px-4 py-1 rounded-full bg-white/5 border border-white/10 text-white/30 text-[9px] uppercase tracking-widest backdrop-blur-md" style={{ fontFamily: 'monospace' }}>System Standby</div>}
        </div>
      </div>

      <Canvas camera={{ position: [0, 10, 32], fov: 44 }}>
        <color attach="background" args={['#010208']} />
        <ambientLight intensity={0.14} color="#0a0520" />
        <pointLight position={[-18, 15, 8]} intensity={2.1} color="#c026d3" distance={55} decay={2} />
        <pointLight position={[-14, -5, 5]} intensity={1.2} color="#a855f7" distance={40} decay={2} />
        <pointLight position={[18, 15, 8]} intensity={2.1} color="#0891b2" distance={55} decay={2} />
        <pointLight position={[14, -5, 5]} intensity={1.2} color="#22d3ee" distance={40} decay={2} />
        <pointLight position={[0, -8, 5]} intensity={1.2} color="#4f46e5" distance={45} decay={2} />
        <pointLight position={[0, 22, -5]} intensity={0.9} color="#7c3aed" distance={40} decay={2} />
        {/* Bright neutral fill light so white nodes pop against dark cloud */}
        <pointLight position={[0, 5, 15]} intensity={1.2} color="#ffffff" distance={55} decay={2} />
        <Stars radius={120} depth={60} count={5000} factor={5} fade speed={0.5} />
        <GlobalBrainAura />
        <NeuralNetwork
          data={filteredData} activityMap={activityMap}
          tokenPulses={tokenPulses} onPulseComplete={id => setTokenPulses(p => p.filter(x => x.id !== id))}
          isEditMode={isEditMode}
          overrides={overrides} onOverrideChange={handleOverride}
          hemOverrides={hemOverrides} onHemOverrideChange={handleHemOverride}
          corpusOverride={corpusOverride} onCorpusOverrideChange={handleCorpusOverride}
          visualSettings={visualSettings}
        />
        <OrbitControls ref={r => { (window as any).orbitControls = r; }} enableDamping dampingFactor={0.05} maxDistance={55} minDistance={4} makeDefault />
      </Canvas>

      <div className="absolute bottom-8 left-8 z-30 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setIsEditMode(!isEditMode)}
            className={`px-4 py-2 rounded-full text-xs font-bold backdrop-blur-md border shadow-lg transition-all ${isEditMode ? 'bg-orange-500/80 text-white border-orange-400' : 'bg-white/8 text-white/50 border-white/15'}`}
            style={{ fontFamily: 'monospace' }}>
            {isEditMode ? '⬡ EDITOR: ON' : '⬡ EDITOR: OFF'}
          </button>
          <button onClick={() => setIsSimulating(!isSimulating)}
            className={`px-4 py-2 rounded-full text-xs font-bold backdrop-blur-md border shadow-lg transition-all ${isSimulating ? 'bg-cyan-500/80 text-white border-cyan-400' : 'bg-white/8 text-white/50 border-white/15'}`}
            style={{ fontFamily: 'monospace' }}>
            {isSimulating ? '⚡ SIMULATION: ON' : '⚡ SIMULATION: OFF'}
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            className={`px-4 py-2 rounded-full text-xs font-bold backdrop-blur-md border shadow-lg transition-all ${showSettings ? 'bg-indigo-500/80 text-white border-indigo-400' : 'bg-white/8 text-white/50 border-white/15'}`}
            style={{ fontFamily: 'monospace' }}>
            {showSettings ? '⚙ SETTINGS: ON' : '⚙ SETTINGS'}
          </button>
          {isEditMode && (
            <button onClick={() => { if (confirm('Reset all positions to default?')) { ['brain_visualizer_overrides', 'brain_hem_overrides', 'brain_corpus_override'].forEach(k => localStorage.removeItem(k)); window.location.reload(); } }}
              className="px-3 py-2 rounded-full text-xs font-bold bg-red-500/70 text-white border border-red-400 backdrop-blur-md shadow-lg" style={{ fontFamily: 'monospace' }}>
              ↺ RESET
            </button>
          )}
        </div>
        {isEditMode && (
          <div className="px-3 py-2 rounded-xl bg-black/70 border border-white/12 text-white/50 text-[9px] backdrop-blur-md leading-5" style={{ fontFamily: 'monospace' }}>
            <div>◈ <span className="text-fuchsia-400">Click hemisphere shell</span> → drag gizmo (moves brain + cloud together)</div>
            <div>◈ <span className="text-purple-400">Click purple dot (centre)</span> → drag corpus callosum / brainstem</div>
            <div>◈ <span className="text-white">Click white node</span> → drag to reposition inside hemisphere</div>
          </div>
        )}
      </div>

      <div className="absolute bottom-8 right-8 z-20">
        <div className="px-4 py-2 rounded-full text-xs font-medium backdrop-blur-md" style={{ fontFamily: 'monospace', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.36)', color: '#67e8f9', boxShadow: '0 0 18px rgba(6,182,212,0.2)' }}>
          ◉ Neural Activity: Live
        </div>
      </div>

      {/* ─── Settings Panel ─────────────────────────────────────────────────── */}
      {showSettings && (
        <div className="absolute bottom-28 left-8 z-40 w-80 rounded-2xl backdrop-blur-xl border overflow-hidden"
          style={{ background: 'rgba(4,4,20,0.92)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 0 40px rgba(0,0,0,0.8)' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <span className="text-white font-black text-xs tracking-widest uppercase" style={{ fontFamily: 'monospace' }}>⚙ Visual Settings</span>
            <button onClick={() => { setVisualSettings(DEFAULT_SETTINGS); localStorage.removeItem('brain_visual_settings'); }}
              className="text-white/30 hover:text-white/70 text-[10px] font-bold uppercase tracking-wider transition-colors" style={{ fontFamily: 'monospace' }}>
              Reset
            </button>
          </div>
          <div className="p-4 flex flex-col gap-5 max-h-[70vh] overflow-y-auto">

            {/* Node Overrides */}
            <SettingsSection title="◈ Node Overrides" accent="#ffffff">
              <ColorOpacityRow label="Color" colorKey="nodeColor" opacityKey="nodeOpacity"
                settings={visualSettings} update={updateVisualSetting} min={0.1} max={1} step={0.01} />
            </SettingsSection>

            {/* Links */}
            <SettingsSection title="⟵ Connection Lines" accent="#99eeff">
              <ColorOpacityRow label="Color" colorKey="linkColor" opacityKey="linkOpacity"
                settings={visualSettings} update={updateVisualSetting} min={0.0} max={1} step={0.01} />
            </SettingsSection>

            {/* Left Hemisphere */}
            <SettingsSection title="◑ Left Hemisphere (Brain 1)" accent="#e879f9">
              <ColorOpacityRow label="Shell" colorKey="leftHemColor" opacityKey="leftHemOpacity"
                settings={visualSettings} update={updateVisualSetting} min={0.005} max={0.25} step={0.005} />
              <ColorOpacityRow label="Cloud" colorKey="leftCloudColor" opacityKey="leftCloudOpacity"
                settings={visualSettings} update={updateVisualSetting} min={0} max={1} step={0.05} />
            </SettingsSection>

            {/* Right Hemisphere */}
            <SettingsSection title="◐ Right Hemisphere (Brain 2)" accent="#22d3ee">
              <ColorOpacityRow label="Shell" colorKey="rightHemColor" opacityKey="rightHemOpacity"
                settings={visualSettings} update={updateVisualSetting} min={0.005} max={0.25} step={0.005} />
              <ColorOpacityRow label="Cloud" colorKey="rightCloudColor" opacityKey="rightCloudOpacity"
                settings={visualSettings} update={updateVisualSetting} min={0} max={1} step={0.05} />
            </SettingsSection>
          </div>
        </div>
      )}
    </div>
  );
};

export default BrainVisualizer;
