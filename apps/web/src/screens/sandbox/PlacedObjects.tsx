import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import type { PlacedObject } from "@myroom/schema";
import {
  distancesToWalls,
  footprintsOverlap,
  snapObject,
  snapToWallRun,
  type ShellGeometry,
  type SnapWall,
} from "@myroom/geometry";
import { getCategory, placeholderParts, type PlaceholderPart } from "@myroom/catalog";
import { haptic } from "../../theme/tokens.js";

/** Default colours per material slot, so a fresh object never renders grey mush. */
const SLOT_COLORS: Record<string, string> = {
  upholstery: "#8C8578",
  body: "#A89C8C",
  frame: "#3B3733",
  legs: "#4A4038",
  seat: "#8C8578",
  top: "#B08B60",
  shelves: "#B08B60",
  doors: "#C6BCAE",
  drawers: "#C6BCAE",
  handles: "#6E6A64",
  base: "#4A4038",
  shade: "#F0E7D8",
  foliage: "#5C7F53",
  pot: "#9C6B4F",
  glass: "#7FA5B8",
  face: "#2B2F36",
  screen: "#20242B",
  pile: "#9A8C7A",
  fabric: "#9A8C7A",
  bedding: "#E8E2D8",
  mattress: "#E8E2D8",
  blades: "#C9BFB2",
  motor: "#6E6A64",
  grille: "#3B3733",
  canvas: "#D8D2C6",
  print: "#D8D2C6",
  board: "#E4E0D6",
  rail: "#6E6A64",
  hooks: "#6E6A64",
  basin: "#EDEDEA",
  counter: "#CFC7B8",
  surface: "#B0A99C",
  panels: "#B0A99C",
  slats: "#CFC7B8",
  rod: "#6E6A64",
  keys: "#EDEDEA",
  shells: "#8C5A3C",
  hardware: "#6E6A64",
  lights: "#F5E9C8",
  cord: "#3B3733",
  track: "#6E6A64",
  heads: "#C9BFB2",
  weights: "#3B3733",
  deck: "#3B3733",
  mat: "#9A8C7A",
  pad: "#E8E2D8",
  covers: "#8C5A3C",
  firebox: "#20242B",
  surround: "#C6BCAE",
  jug: "#BFD4DC",
  stand: "#4A4038",
  cushion: "#8C8578",
};

const slotColor = (slot: string) => SLOT_COLORS[slot] ?? "#A89C8C";

/** Rounded boxes read as furniture; sharp boxes read as debug geometry. */
function partGeometry(part: PlaceholderPart, size: { w: number; d: number; h: number }) {
  const sx = part.size[0] * size.w;
  const sy = part.size[1] * size.h;
  const sz = part.size[2] * size.d;
  if (part.shape === "cylinder") {
    return <cylinderGeometry args={[Math.max(sx, sz) / 2, Math.max(sx, sz) / 2, sy, 16]} />;
  }
  if (part.shape === "sphere") {
    return <sphereGeometry args={[Math.max(sx, sy, sz) / 2, 16, 12]} />;
  }
  return <boxGeometry args={[sx, sy, sz]} />;
}

export interface DragFeedback {
  objectId: string;
  distances: { label: string; distance: number }[];
  colliding: boolean;
  snapped: string | null;
}

interface Props {
  objects: readonly PlacedObject[];
  shell: ShellGeometry;
  editing: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, patch: Partial<PlacedObject>, commit: boolean) => void;
  onDragFeedback: (feedback: DragFeedback | null) => void;
}

export function PlacedObjects({
  objects,
  shell,
  editing,
  selectedId,
  onSelect,
  onMove,
  onDragFeedback,
}: Props) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const dragging = useRef<{ id: string; support: string } | null>(null);
  const lastSnap = useRef<string | null>(null);

  const snapWalls = useMemo<SnapWall[]>(
    () =>
      shell.walls.map((w) => ({
        wallId: w.wallId,
        start: [w.start[0], w.start[2]],
        end: [w.end[0], w.end[2]],
        inwardNormal: [w.inwardNormal[0], w.inwardNormal[2]],
        thickness: w.thickness,
      })),
    [shell],
  );
  const roomCenter: [number, number] = [shell.center[0], shell.center[2]];
  const wallLabel = useMemo(
    () => new Map(shell.walls.map((w) => [w.wallId, w.label])),
    [shell],
  );

  const floorPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
  const raycaster = useRef(new THREE.Raycaster());
  const hit = useRef(new THREE.Vector3());
  const ndc = useRef(new THREE.Vector2());

  /** Screen point → the point on the floor plane under the pointer. */
  const pointerToFloor = (e: PointerEvent | ThreeEvent<PointerEvent>): THREE.Vector3 | null => {
    const rect = gl.domElement.getBoundingClientRect();
    const native = "clientX" in e ? e : (e as ThreeEvent<PointerEvent>).nativeEvent;
    ndc.current.set(
      ((native.clientX - rect.left) / rect.width) * 2 - 1,
      -((native.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.current.setFromCamera(ndc.current, camera);
    return raycaster.current.ray.intersectPlane(floorPlane.current, hit.current);
  };

  const handleDragMove = (event: PointerEvent) => {
    const active = dragging.current;
    if (!active) return;
    const object = objects.find((o) => o.id === active.id);
    if (!object) return;
    const point = pointerToFloor(event);
    if (!point) return;

    const category = object.placeholder ? getCategory(object.placeholder.category) : undefined;

    if (object.support === "wall" || object.support === "ceiling") {
      // Wall items slide along their wall and hop corners; ceiling items keep
      // their height and only move in plan (docs/06 §3).
      if (object.support === "wall") {
        const run = snapToWallRun({ x: point.x, z: point.z }, snapWalls, object.size.w);
        if (run) {
          if (lastSnap.current !== run.wallId) {
            haptic("light"); // corner hop
            lastSnap.current = run.wallId;
          }
          onMove(
            active.id,
            {
              position: { x: run.position.x, y: object.position.y, z: run.position.z },
              rotationY: run.rotationY,
              wallId: run.wallId,
            },
            false,
          );
          onDragFeedback({
            objectId: active.id,
            distances: [],
            colliding: false,
            snapped: `On wall ${wallLabel.get(run.wallId) ?? ""}`.trim(),
          });
        }
        return;
      }
      onMove(active.id, { position: { x: point.x, y: object.position.y, z: point.z } }, false);
      return;
    }

    const snapped = snapObject({
      position: { x: point.x, z: point.z },
      rotationY: object.rotationY,
      size: object.size,
      walls: snapWalls,
      roomCenter,
      exempt: object.collisionExempt,
    });

    const key = snapped.againstWall ?? snapped.parallelToWall ?? snapped.centeredOn;
    if (key && lastSnap.current !== key) {
      haptic("light");
      lastSnap.current = key;
    } else if (!key) {
      lastSnap.current = null;
    }

    const moved: PlacedObject = {
      ...object,
      position: { x: snapped.position.x, y: object.position.y, z: snapped.position.z },
      rotationY: snapped.rotationY,
    };
    onMove(
      active.id,
      { position: moved.position, rotationY: moved.rotationY },
      false,
    );

    // Live measurements to the two nearest walls (docs/06 §3).
    const near = distancesToWalls(snapped.position, snapWalls).slice(0, 2);
    const colliding =
      !object.collisionExempt &&
      objects.some(
        (other) =>
          other.id !== object.id &&
          !other.collisionExempt &&
          other.support === "floor" &&
          footprintsOverlap(
            { position: { x: moved.position.x, z: moved.position.z }, size: moved.size, rotationY: moved.rotationY },
            { position: { x: other.position.x, z: other.position.z }, size: other.size, rotationY: other.rotationY },
          ),
      );

    onDragFeedback({
      objectId: active.id,
      distances: near.map((n) => ({
        label: `Wall ${wallLabel.get(n.wallId) ?? "?"}`,
        distance: n.distance,
      })),
      colliding,
      snapped: snapped.againstWall
        ? `Against wall ${wallLabel.get(snapped.againstWall) ?? ""}`.trim()
        : snapped.centeredOn
          ? "Centred"
          : snapped.parallelToWall
            ? "Parallel"
            : null,
    });
    void category;
  };

  const endDrag = () => {
    const active = dragging.current;
    dragging.current = null;
    lastSnap.current = null;
    onDragFeedback(null);
    window.removeEventListener("pointermove", handleDragMove);
    window.removeEventListener("pointerup", endDrag);
    if (!active) return;
    const object = objects.find((o) => o.id === active.id);
    if (object) {
      // Commit the whole gesture as one undoable command (docs/06 §6).
      onMove(active.id, { position: object.position, rotationY: object.rotationY }, true);
    }
  };

  const startDrag = (object: PlacedObject) => (e: ThreeEvent<PointerEvent>) => {
    if (!editing) return;
    e.stopPropagation();
    onSelect(object.id);
    dragging.current = { id: object.id, support: object.support };
    lastSnap.current = null;
    window.addEventListener("pointermove", handleDragMove);
    window.addEventListener("pointerup", endDrag);
  };

  return (
    <group name="objects">
      {objects.map((object) => {
        const categoryId = object.placeholder?.category ?? "block";
        const parts = placeholderParts(categoryId);
        const selected = object.id === selectedId;
        return (
          <group
            key={object.id}
            name={`object-${object.id}`}
            position={[object.position.x, object.position.y, object.position.z]}
            rotation={[0, object.rotationY, 0]}
            userData={{ kind: "object", objectId: object.id, label: object.label }}
            onPointerDown={startDrag(object)}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(object.id);
            }}
          >
            {parts.map((part, i) => (
              <mesh
                key={i}
                castShadow
                receiveShadow
                position={[
                  part.position[0] * object.size.w,
                  part.position[1] * object.size.h,
                  part.position[2] * object.size.d,
                ]}
              >
                {partGeometry(part, object.size)}
                <meshStandardMaterial
                  color={object.materials[part.slot]?.color ?? slotColor(part.slot)}
                  roughness={part.slot === "glass" || part.slot === "screen" ? 0.25 : 0.75}
                  metalness={part.slot === "handles" || part.slot === "hardware" ? 0.6 : 0.05}
                  emissive={selected ? "#4C8DFF" : "#000000"}
                  emissiveIntensity={selected ? 0.28 : 0}
                />
              </mesh>
            ))}

            {/* Selection footprint — the accent outline of docs/06 §2. */}
            {selected && (
              <lineSegments position={[0, 0.004, 0]} renderOrder={2}>
                <edgesGeometry
                  args={[new THREE.BoxGeometry(object.size.w * 1.04, 0.008, object.size.d * 1.04)]}
                />
                <lineBasicMaterial color="#4C8DFF" depthTest={false} transparent opacity={0.95} />
              </lineSegments>
            )}
          </group>
        );
      })}
    </group>
  );
}
